import { realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ToolExecutionResult } from '../../shared/agent-protocol'
import type { BrowserService } from './browser-service'
import { isDeniedPath } from '../tools/workspace-path-policy'
import type { PermissionService } from '../permissions/permission-service'

const openInput = z.object({
  url: z.string().min(1).max(20_000),
})

const observeInput = z.object({
  textLimit: z.number().int().min(500).max(20_000).optional(),
  maxElements: z.number().int().min(1).max(300).optional(),
})

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ref: z.string().min(1).max(32) }),
  z.object({
    type: z.literal('type'),
    ref: z.string().min(1).max(32),
    text: z.string().max(100_000),
    submit: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('select'),
    ref: z.string().min(1).max(32),
    value: z.string().max(10_000),
  }),
  z.object({
    type: z.literal('press'),
    key: z.string().min(1).max(40),
    ref: z.string().min(1).max(32).optional(),
  }),
  z.object({
    type: z.literal('hover'),
    ref: z.string().min(1).max(32),
  }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.number().int().min(1).max(10_000).optional(),
  }),
  z.object({
    type: z.literal('wait'),
    ms: z.number().int().min(0).max(10_000).optional(),
  }),
])

const actInput = z.object({
  actions: z.array(actionSchema).min(1).max(12),
})

const tabInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('new'),
    url: z.string().min(1).max(20_000).optional(),
  }),
  z.object({
    action: z.literal('select'),
    tabId: z.string().uuid(),
  }),
  z.object({
    action: z.literal('close'),
    tabId: z.string().uuid(),
  }),
])

const uploadInput = z.object({
  ref: z.string().regex(/^e\d+$/),
  path: z.string().min(1).max(4_000),
})

const readInput = z.object({
  maxChars: z.number().int().min(500).max(50_000).optional(),
})

export interface BrowserToolContext {
  workingDirectory?: string | undefined
  sessionId?: string | undefined
}

export interface BrowserToolServiceOptions {
  getBrowser: () => BrowserService | undefined
  workspaceRoot: string
  outputRoot: string
  privateTempRoot: string
  getPermissions: () => Pick<PermissionService, 'request' | 'waitForDecision'> | undefined
}

export class BrowserToolService {
  private readonly defaultRoots: string[]

  constructor(private readonly options: BrowserToolServiceOptions) {
    this.defaultRoots = [options.workspaceRoot, options.outputRoot, options.privateTempRoot]
      .map((root) => realpathSync.native(root))
  }

  async execute(
    toolName: string,
    rawArgs: unknown,
    context: BrowserToolContext = {},
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    try {
      signal?.throwIfAborted()
      const browser = this.requireBrowser()
      signal?.throwIfAborted()
      switch (toolName) {
        case 'browser_open': {
          const input = openInput.parse(rawArgs)
          const state = await browser.loadUrl(input.url)
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                opened: true,
                url: state.url,
                title: state.title,
                loading: state.loading,
              }, null, 2),
            }],
            details: state,
          }
        }
        case 'browser_observe': {
          const input = observeInput.parse(rawArgs)
          const snapshot = await browser.observe({
            textLimit: input.textLimit ?? 8_000,
            maxElements: input.maxElements ?? 120,
          })
          return {
            content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
            details: {
              url: snapshot.url,
              title: snapshot.title,
              elementCount: snapshot.elements.length,
              truncated: snapshot.truncated,
            },
          }
        }
        case 'browser_act': {
          const input = actInput.parse(rawArgs)
          const classification = await browser.classifyActions(input.actions)
          if (classification.consequential) {
            const permissions = this.options.getPermissions()
            if (permissions === undefined) throw new Error('Browser action approvals are unavailable')
            const outcome = permissions.request({
              kind: 'external-write',
              title: 'Approve browser action',
              summary: classification.summary,
              details: classification.details,
            })
            if (outcome.decision === 'denied') return errorResult(outcome.reason)
            if (outcome.decision === 'approval_required') {
              const decision = await permissions.waitForDecision(outcome.approval.id, signal)
              if (decision === 'denied') return errorResult('The browser action was denied.')
            }
          }
          const result = await browser.performActions(input.actions)
          return {
            content: [{ type: 'text', text: JSON.stringify({ ...result, approval: classification.consequential ? 'approved' : 'not-required' }, null, 2) }],
            details: { ...result, approval: classification.consequential ? 'approved' : 'not-required' },
          }
        }
        case 'browser_tab': {
          const input = tabInput.parse(rawArgs)
          let state = browser.getState()
          if (input.action === 'new') {
            state = input.url === undefined ? browser.newTab() : await browser.newTabAndLoad(input.url)
          } else if (input.action === 'select') {
            state = browser.activateTab(input.tabId)
          } else if (input.action === 'close') {
            state = browser.closeTab(input.tabId)
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                activeTabId: state.activeTabId,
                tabs: state.tabs,
              }, null, 2),
            }],
            details: { activeTabId: state.activeTabId, tabs: state.tabs },
          }
        }
        case 'browser_read': {
          const input = readInput.parse(rawArgs)
          const page = await browser.readText(input.maxChars ?? 12_000)
          return {
            content: [{ type: 'text', text: JSON.stringify(page, null, 2) }],
            details: { url: page.url, title: page.title, truncated: page.truncated },
          }
        }
        case 'browser_upload': {
          const input = uploadInput.parse(rawArgs)
          const filePath = await this.resolveUploadPath(input.path, context.workingDirectory)
          const result = await browser.setFileInput(input.ref, filePath)
          await new Promise<void>((finish) => setTimeout(finish, 160))
          return {
            content: [{ type: 'text', text: JSON.stringify({ uploaded: true, ...result }, null, 2) }],
            details: result,
          }
        }
        case 'browser_screenshot': {
          const capture = await browser.capturePng()
          const state = browser.getState()
          return {
            content: [
              { type: 'text', text: JSON.stringify({ url: state.url, title: state.title }) },
              { type: 'image', data: capture.data, mimeType: capture.mimeType },
            ],
            details: { url: state.url, title: state.title, width: capture.width, height: capture.height },
          }
        }
        default:
          return errorResult(`Unknown browser tool: ${toolName}`)
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  }

  private async resolveUploadPath(input: string, workingDirectory: string | undefined): Promise<string> {
    const defaultRoot = workingDirectory ?? this.options.workspaceRoot
    const candidate = isAbsolute(input) ? input : resolve(defaultRoot, input)
    const canonical = await realpath(candidate)
    if (!(await stat(canonical)).isFile()) throw new Error(`Not a file: ${input}`)
    if (isDeniedPath(canonical)) throw new Error('Access to this file is denied')
    const roots = workingDirectory === undefined
      ? this.defaultRoots
      : [await realpath(workingDirectory), ...this.defaultRoots]
    const allowed = roots.some((root) => {
      const rel = relative(root, canonical)
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
    })
    if (!allowed) throw new Error('File is outside the authorized workspace')
    return canonical
  }

  private requireBrowser(): BrowserService {
    const browser = this.options.getBrowser()
    if (browser === undefined) throw new Error('Browser is unavailable')
    return browser
  }
}

function errorResult(message: string): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: message }],
    details: { error: message },
    isError: true,
  }
}
