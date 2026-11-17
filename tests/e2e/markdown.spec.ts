import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('renders streamdown tables and code blocks without overlapping controls', async () => {
  const markdown = `## 已提取

| 字段 | 值 | 依据 |
| --- | --- | --- |
| 项目 | Atlas | 第1页 |
| 截止日期 | 2026-11-02 | 项目计划 |

需要您确认的问题（按影响排序）

1. 缺负责人
2. 缺预算确认

\`\`\`json
{
  "project": "Atlas",
  "owner": "待确认"
}
\`\`\`
`
  const server = await startMarkdownServer(markdown)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Mock server did not bind')
  const userData = await mkdtemp(join(tmpdir(), 'barn-markdown-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'en',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (baseUrl) => {
      await window.barn.models.saveCustomProvider({
        id: 'markdown-provider',
        name: 'Markdown Provider',
        baseUrl,
        api: 'openai-responses',
        models: [{
          id: 'markdown-model',
          name: 'Markdown Model',
          contextWindow: 128_000,
          maxTokens: 8_000,
          reasoning: false,
          reasoningEfforts: [],
          input: ['text'],
        }],
      })
      await window.barn.models.saveCredential({ providerId: 'markdown-provider', apiKey: 'test-key' })
      await window.barn.models.setDefault({ providerId: 'markdown-provider', modelId: 'markdown-model' })
    }, `http://127.0.0.1:${address.port}/v1`)

    const composer = page.getByLabel('Message Barn')
    await composer.fill('Render the extracted project information.')
    await composer.press('Enter')

    await expect(page.locator('.markdown-table-wrap')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.assistant-markdown h2')).toBeVisible()
    await expect(page.locator('.assistant-markdown pre')).toBeVisible()

    const tableBox = await page.locator('.markdown-table-wrap').boundingBox()
    const followupBox = await page.getByText('需要您确认的问题（按影响排序）', { exact: true }).boundingBox()
    if (tableBox === null || followupBox === null) throw new Error('Missing markdown layout boxes')
    expect(followupBox.y).toBeGreaterThanOrEqual(tableBox.y + tableBox.height - 1)

    const assistantBox = await page.locator('.assistant-markdown').boundingBox()
    const preBox = await page.locator('.assistant-markdown pre').boundingBox()
    if (assistantBox === null || preBox === null) throw new Error('Missing code layout boxes')
    expect(preBox.x).toBeGreaterThanOrEqual(assistantBox.x)
    expect(preBox.x + preBox.width).toBeLessThanOrEqual(assistantBox.x + assistantBox.width + 1)
    await expect(page.locator('.assistant-markdown pre button')).toHaveCount(0)
    await expect(page.getByText('需要您确认的问题（按影响排序）', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/barn-markdown.png', fullPage: true })
  } finally {
    await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function startMarkdownServer(markdown: string): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const item = {
        id: 'msg-markdown',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: markdown, annotations: [] }],
      }
      sendEvent(response, {
        type: 'response.created',
        response: { id: 'resp-markdown', status: 'in_progress', output: [] },
      })
      sendEvent(response, {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      })
      sendEvent(response, {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: markdown,
      })
      sendEvent(response, { type: 'response.output_item.done', output_index: 0, item })
      sendEvent(response, {
        type: 'response.completed',
        response: {
          id: 'resp-markdown',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 20, output_tokens: 50, total_tokens: 70 },
        },
      })
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

function sendEvent(response: import('node:http').ServerResponse, event: Record<string, unknown>): void {
  response.write(`event: ${String(event.type)}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
