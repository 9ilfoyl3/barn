import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron, expect, test } from '@playwright/test'

test.setTimeout(60_000)

test('builds employee drafts from a file, validates and commits them to Barn Cloud', async () => {
  const tenantId = `tenant-e2e-${randomUUID()}`
  const controlPort = await freePort()
  const hrPort = await freePort()
  const authProcess = await startAuthApi(controlPort, tenantId)
  const hrProcess = await startHrApi(hrPort, controlPort)
  const workerProcess = await startHrWorker()
  const modelRequests: Array<Record<string, unknown>> = []
  const userData = await mkdtemp(join(tmpdir(), 'barn-intake-e2e-'))
  const workspace = join(userData, 'workspace')
  const rosterPath = join(workspace, 'roster.txt')
  await mkdir(workspace, { recursive: true })
  await writeFile(rosterPath, 'E3001,Alice,alice@example.com\nE3002,李四,lisi@example.com\n')

  const mockModel = await startMockModelServer(modelRequests, rosterPath)
  const modelAddress = mockModel.address()
  if (modelAddress === null || typeof modelAddress === 'string') throw new Error('Mock model did not bind')
  const modelBaseUrl = `http://127.0.0.1:${modelAddress.port}/v1`
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_HR_API_URL: `http://127.0.0.1:${hrPort}`,
      BARN_AUTH_BASE_URL: `http://127.0.0.1:${controlPort}`,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ shell }) => {
      ;(globalThis as typeof globalThis & { __barnAuthUrl?: string | undefined }).__barnAuthUrl = undefined
      shell.openExternal = async (url: string) => {
        ;(globalThis as typeof globalThis & { __barnAuthUrl?: string | undefined }).__barnAuthUrl = url
      }
    })
    await signIn(page, app, controlPort)
    await page.evaluate(async (baseUrl) => {
      await window.barn.models.saveCustomProvider({
        id: 'mock-provider',
        name: 'Mock Provider',
        baseUrl,
        api: 'openai-responses',
        models: [{
          id: 'mock-model',
          name: 'Mock Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'mock-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'mock-provider', modelId: 'mock-model' })
    }, modelBaseUrl)

    await page.getByRole('button', { name: /New session/i }).click()
    const composer = page.getByLabel('Message Barn')
    await composer.fill(`Read ${rosterPath} and create employee records.`)
    await composer.press('Enter')

    await expect(page.getByLabel('Employee intake')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.tool-group')).toHaveCount(1)
    await expect(page.locator('.thinking-block')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Found', { exact: true })).toBeVisible({ timeout: 15_000 })
    const assistantPartOrder = await page
      .locator('.chat-message.assistant .conversation-part')
      .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-part')))
    expect(assistantPartOrder).toEqual(['tool-group', 'thinking', 'text'])
    const toolGroup = page.locator('.chat-message.assistant .tool-group')
    await expect(toolGroup.locator('.tool-group-summary')).toContainText('已读取文件')
    await toolGroup.locator('.tool-group-summary').click()
    await expect(toolGroup.locator('.tool-row')).toHaveCount(2)
    await page.getByRole('button', { name: 'Close employee intake' }).click()
    await expect(page.getByLabel('Employee intake')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Review draft/ })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-review-draft-trigger.png', fullPage: true })
    await page.getByRole('button', { name: /Review draft/ }).click()
    await expect(page.getByLabel('Employee intake')).toBeVisible()
    await expect(page.getByText('2', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('1', { exact: true }).first()).toBeVisible()

    await page.getByRole('button', { name: /Unnamed employee/i }).click()
    await page.getByLabel('Display name').fill('李四')
    await page.getByRole('button', { name: 'Save employee changes' }).click()
    await expect(page.getByRole('button', { name: /李四/i })).toBeVisible()

    await page.getByRole('button', { name: 'Validate with Cloud' }).click()
    await expect(page.getByText('2 ready · 0 blocked')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Create 2 employees' }).click()
    await expect(page.getByText('Created 2 employees.')).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: 'test-results/barn-employee-intake.png', fullPage: true })

    await page.getByRole('button', { name: 'Workspace', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible()
    await expect(page.getByText('Employee intake in progress')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Employees', exact: true })).toBeVisible()
    await expect(page.getByText('Alice', { exact: true }).last()).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-workspace-drawer.png', fullPage: true })
    await page.getByRole('button', { name: 'Close workspace' }).click()

    await page.getByRole('button', { name: 'Employees', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible()
    await expect(page.locator('.workspace-tabs button', { hasText: 'Employees' })).toHaveClass(/active/)
    await page.getByLabel('Search employees').fill('研发部')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('button', { name: /李四.*Backend Engineer/ })).toBeVisible({ timeout: 15_000 })
    await page.locator('.workspace-drawer').getByRole('button', { name: /李四.*Backend Engineer/ }).click()
    await expect(page.getByRole('heading', { name: 'Employee details' })).toBeVisible()
    await expect(page.locator('.employee-detail').getByText('研发部', { exact: true })).toBeVisible()
    await expect(page.locator('.employee-detail').getByText('Alice', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-employee-details.png', fullPage: true })
    await page.getByRole('button', { name: 'Back to employees' }).click()
    await page.getByRole('button', { name: 'Close workspace' }).click()

    await composer.fill('研发部有哪些员工？')
    await composer.press('Enter')
    await expect(page.getByText('研发部有 Alice 和李四。')).toBeVisible({ timeout: 15_000 })

    await composer.fill('为李四发起离职流程')
    await composer.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Lifecycle transition' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('dialog').getByText('offboarding', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-lifecycle-approval.png', fullPage: true })
    await page.getByRole('button', { name: 'Close lifecycle proposal' }).click()
    await expect(page.getByRole('dialog', { name: 'Lifecycle transition' })).toHaveCount(0)
    await expect(page.getByText('已创建李四的离职提议，等待批准。')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Lifecycle', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Lifecycle cases' })).toBeVisible()
    await expect(page.locator('.lifecycle-case-card').filter({ hasText: '李四' })).toContainText('pending approval')
    await page.screenshot({ path: 'test-results/barn-lifecycle-case-center.png', fullPage: true })
    await page.getByRole('button', { name: 'Review approval' }).click()
    await expect(page.getByRole('dialog', { name: 'Lifecycle transition' })).toBeVisible()
    await page.getByRole('button', { name: 'Approve transition' }).click()
    await expect(page.getByRole('dialog', { name: 'Lifecycle transition' })).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator('.lifecycle-case-card').filter({ hasText: '李四' })).toContainText('completed', { timeout: 15_000 })
    await page.getByRole('button', { name: 'Close workspace' }).click()

    await page.getByRole('button', { name: 'Notifications' }).click()
    await expect(page.getByText('Lifecycle updated for 李四')).toBeVisible({ timeout: 15_000 })
    await page.getByText('Lifecycle updated for 李四').click()
    await page.screenshot({ path: 'test-results/barn-notifications.png', fullPage: true })
    const lifecycleEmployee = await page.evaluate(() => window.barn.hr.getEmployee('E3002'))
    expect(lifecycleEmployee).toMatchObject({ status: 'offboarding', version: 2 })

    const employees = await page.evaluate(() => window.barn.sessions.listEmployees())
    const search = await page.evaluate(() => window.barn.hr.searchEmployees({ q: '研发部', page: 1, pageSize: 25 }))
    expect(search.total).toBe(2)
    expect(employees).toEqual(expect.arrayContaining([
      expect.objectContaining({ employeeNo: 'E3001', displayName: 'Alice' }),
      expect.objectContaining({ employeeNo: 'E3002', displayName: '李四' }),
    ]))
    expect(modelRequests).toHaveLength(7)

    hrProcess.kill('SIGTERM')
    await waitForExit(hrProcess)
    await page.getByRole('button', { name: 'Employees', exact: true }).click()
    await page.getByLabel('Search employees').fill('研发部')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.locator('.workspace-cache-badge').first()).toContainText('Cached', { timeout: 15_000 })
    await expect(page.getByText('Alice', { exact: true }).last()).toBeVisible()
    await page.getByRole('button', { name: 'Close workspace' }).click()

    await page.getByRole('button', { name: /Demo HRBP/ }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('button', { name: /Sign in/ })).toBeVisible()
    const cachedFiles = (await readdir(join(userData, 'accounts'), { recursive: true }))
      .filter((path) => path.endsWith('.bin'))
    expect(cachedFiles).toEqual([])
  } finally {
    await app.close()
    await new Promise<void>((resolveClose) => mockModel.close(() => resolveClose()))
    if (workerProcess.exitCode === null) workerProcess.kill('SIGTERM')
    if (hrProcess.exitCode === null) hrProcess.kill('SIGTERM')
    if (authProcess.exitCode === null) authProcess.kill('SIGTERM')
  }
})

async function startAuthApi(port: number, tenantId: string): Promise<ChildProcess> {
  const cloudRoot = resolve(process.cwd(), '../barn-cloud')
  const child = spawn('pnpm', ['exec', 'tsx', 'src/control-api/main.ts'], {
    cwd: cloudRoot,
    env: {
      ...process.env,
      CONTROL_API_PORT: String(port),
      AUTH_ISSUER: `http://127.0.0.1:${port}`,
      AUTH_DEMO_EMAIL: 'hrbp@barn.local',
      AUTH_DEMO_PASSWORD: 'barn-demo',
      AUTH_DEMO_USER_ID: 'e2e-user',
      AUTH_DEMO_NAME: 'Demo HRBP',
      AUTH_TENANT_ID: tenantId,
      AUTH_TENANT_NAME: 'E2E Tenant',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk) => { output += chunk.toString() })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`)
      if (response.ok) return child
    } catch {
      // Wait for Nest to bind the port.
    }
    if (child.exitCode !== null) throw new Error(`Auth API exited: ${output}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  child.kill('SIGTERM')
  throw new Error(`Auth API did not start: ${output}`)
}

async function signIn(
  page: import('@playwright/test').Page,
  app: import('@playwright/test').ElectronApplication,
  controlPort: number,
): Promise<void> {
  await page.getByRole('button', { name: /Sign in/ }).click()
  let authorizeUrl: string | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    authorizeUrl = await app.evaluate(() => (globalThis as typeof globalThis & { __barnAuthUrl?: string | undefined }).__barnAuthUrl)
    if (authorizeUrl !== undefined) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  if (authorizeUrl === undefined) throw new Error('Auth browser URL was not captured')
  const authorizePage = await fetch(authorizeUrl)
  expect(authorizePage.headers.get('content-type')).toContain('text/html')
  expect(await authorizePage.text()).toContain('<title>Sign in to Barn</title>')
  const authorize = new URL(authorizeUrl)
  const response = await fetch(`http://127.0.0.1:${controlPort}/v1/auth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'hrbp@barn.local',
      password: 'barn-demo',
      clientId: authorize.searchParams.get('client_id'),
      redirectUri: authorize.searchParams.get('redirect_uri'),
      codeChallenge: authorize.searchParams.get('code_challenge'),
      deviceId: authorize.searchParams.get('device_id'),
      state: authorize.searchParams.get('state'),
    }),
  })
  const rawResult = await response.text()
  if (!response.ok) throw new Error(`Auth login failed: ${rawResult}`)
  const result = JSON.parse(rawResult) as { redirectUrl: string }
  const callback = await fetch(result.redirectUrl)
  expect(callback.ok).toBe(true)
  await expect(page.getByRole('button', { name: /Demo HRBP/ })).toBeVisible({ timeout: 15_000 })
}

async function startHrApi(port: number, controlPort: number): Promise<ChildProcess> {
  const cloudRoot = resolve(process.cwd(), '../barn-cloud')
  const child = spawn('pnpm', ['exec', 'tsx', 'src/hr-api/main.ts'], {
    cwd: cloudRoot,
    env: {
      ...process.env,
      HR_API_PORT: String(port),
      HR_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/barn_hr_test',
      HR_AUTH_ISSUER: `http://127.0.0.1:${controlPort}`,
      HR_JWKS_URL: `http://127.0.0.1:${controlPort}/v1/auth/jwks`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk) => { output += chunk.toString() })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/hr/health`)
      if (response.ok) return child
    } catch {
      // Wait for Nest to bind the port.
    }
    if (child.exitCode !== null) throw new Error(`HR API exited: ${output}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  child.kill('SIGTERM')
  throw new Error(`HR API did not start: ${output}`)
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
}

async function startHrWorker(): Promise<ChildProcess> {
  const cloudRoot = resolve(process.cwd(), '../barn-cloud')
  const child = spawn('pnpm', ['exec', 'tsx', 'src/hr-worker/main.ts'], {
    cwd: cloudRoot,
    env: {
      ...process.env,
      HR_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/barn_hr_test',
      HR_WORKER_INTERVAL_MS: '1000',
      HR_APPROVAL_ESCALATION_HOURS: '24',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk) => { output += chunk.toString() })
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_200))
  if (child.exitCode !== null) throw new Error(`HR worker exited: ${output}`)
  return child
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No free port')
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return address.port
}

async function startMockModelServer(
  requests: Array<Record<string, unknown>>,
  rosterPath: string,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (requests.length === 1) {
        sendFunctionCall(response, 'read_file', { path: rosterPath, startLine: 1, lineCount: 20 }, 'call-read')
      } else if (requests.length === 2) {
        sendFunctionCall(response, 'employee_intake_create', {
          employees: [
            {
              fields: {
                employeeNo: { value: 'E3001', source: 'document' },
                displayName: { value: 'Alice', source: 'document' },
                workEmail: { value: 'alice@example.com', source: 'document' },
                orgUnit: { value: '研发部', source: 'document' },
                orgUnitCode: { value: 'RD', source: 'document' },
                jobTitle: { value: 'Engineering Manager', source: 'document' },
                location: { value: 'Shanghai', source: 'document' },
                hireDate: { value: '2026-09-01', source: 'document' },
              },
              sourceFiles: [rosterPath],
            },
            {
              fields: {
                employeeNo: { value: 'E3002', source: 'document' },
                workEmail: { value: 'lisi@example.com', source: 'document' },
                orgUnit: { value: '研发部', source: 'document' },
                orgUnitCode: { value: 'RD', source: 'document' },
                jobTitle: { value: 'Backend Engineer', source: 'document' },
                location: { value: 'Shanghai', source: 'document' },
                hireDate: { value: '2026-10-01', source: 'document' },
                managerEmployeeNo: { value: 'E3001', source: 'document' },
              },
              sourceFiles: [rosterPath],
            },
          ],
        }, 'call-intake')
      } else if (requests.length === 3) {
        sendTextResponse(response, '**Found** 2 employees. Review and confirm them in the intake panel.')
      } else if (requests.length === 4) {
        sendFunctionCall(response, 'employee_list_by_org', { orgUnitCode: 'RD' }, 'call-list-org')
      } else if (requests.length === 5) {
        sendTextResponse(response, '研发部有 Alice 和李四。')
      } else if (requests.length === 6) {
        sendFunctionCall(response, 'lifecycle_propose_transition', {
          employeeId: 'E3002',
          toStatus: 'offboarding',
          effectiveDate: new Date().toISOString().slice(0, 10),
          reason: 'Employee resignation confirmed in conversation',
        }, 'call-lifecycle')
      } else {
        sendTextResponse(response, '已创建李四的离职提议，等待批准。')
      }
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  return server
}

function sendFunctionCall(
  response: import('node:http').ServerResponse,
  name: string,
  args: Record<string, unknown>,
  callId: string,
): void {
  const item = {
    id: `fc-${callId}`,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  }
  sendEvent(response, {
    type: 'response.created',
    response: { id: `resp-${callId}`, status: 'in_progress', output: [] },
  })
  sendEvent(response, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...item, status: 'in_progress', arguments: '' },
  })
  sendEvent(response, {
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    item_id: item.id,
    delta: item.arguments,
  })
  sendEvent(response, {
    type: 'response.function_call_arguments.done',
    output_index: 0,
    item_id: item.id,
    arguments: item.arguments,
  })
  sendEvent(response, {
    type: 'response.output_item.done',
    output_index: 0,
    item,
  })
  sendEvent(response, {
    type: 'response.completed',
    response: {
      id: `resp-${callId}`,
      status: 'completed',
      output: [item],
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    },
  })
  response.end('data: [DONE]\n\n')
}

function sendTextResponse(response: import('node:http').ServerResponse, text: string): void {
  const item = {
    id: 'msg-final',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  sendEvent(response, {
    type: 'response.created',
    response: { id: 'resp-final', status: 'in_progress', output: [] },
  })
  const reasoning = {
    id: 'reasoning-final',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Inspecting roster and preparing employee drafts.' }],
  }
  sendEvent(response, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: reasoning.id, type: 'reasoning', summary: [] },
  })
  sendEvent(response, {
    type: 'response.reasoning_summary_text.delta',
    output_index: 0,
    item_id: reasoning.id,
    summary_index: 0,
    delta: 'Inspecting roster and preparing employee drafts.',
  })
  sendEvent(response, {
    type: 'response.output_item.done',
    output_index: 0,
    item: reasoning,
  })
  sendEvent(response, {
    type: 'response.output_item.added',
    output_index: 1,
    item: { ...item, status: 'in_progress', content: [] },
  })
  sendEvent(response, {
    type: 'response.output_text.delta',
    output_index: 1,
    item_id: item.id,
    content_index: 0,
    delta: text,
  })
  sendEvent(response, { type: 'response.output_item.done', output_index: 1, item })
  sendEvent(response, {
    type: 'response.completed',
    response: {
      id: 'resp-final',
      status: 'completed',
      output: [reasoning, item],
      usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 },
    },
  })
  response.end('data: [DONE]\n\n')
}

function sendEvent(response: import('node:http').ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
