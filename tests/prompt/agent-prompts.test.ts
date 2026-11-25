import { describe, expect, it } from 'vitest'
import { composeRouterSystemPrompt, composeTaskRouterSystemPrompt, composeWorkerSystemPrompt, formatTaskBrief } from '../../src/shared/agent-prompts'

const routerTools = [{
  name: 'connector_call',
  description: 'Call one connector capability.',
  inputSchema: { type: 'object', properties: { connectorId: { type: 'string' } } },
}, {
  name: 'read_file',
  description: 'Read a workspace file.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
}]

function positions(prompt: string, headings: string[]): number[] {
  return headings.map((heading) => {
    const index = prompt.indexOf(heading)
    expect(index, `missing heading: ${heading}`).toBeGreaterThanOrEqual(0)
    return index
  })
}

describe('agent prompt composition', () => {
  it('keeps Router sections in a stable role-first order', () => {
    const prompt = composeRouterSystemPrompt({ tools: routerTools, locale: 'zh-CN' })
    const ordered = positions(prompt, [
      '## Identity',
      '## Shared runtime rules',
      '## Router responsibilities',
      '## Task collaboration',
      '## Delivery',
      '## Tool disclosure',
      '## Channel and language',
    ])
    expect(ordered).toEqual(ordered.toSorted((left, right) => left - right))
    expect(prompt).toContain('default executor for ordinary synchronous work')
    expect(prompt).toContain('Do not create a Task merely because the request needs multiple tool calls')
    expect(prompt).toContain('Call ordinary business tools through the single native tool `call`')
    expect(prompt).toContain('connector_call')
    expect(prompt).toContain('read_file')
    expect(prompt).toContain('Preferred UI language: Simplified Chinese')
  })

  it('omits ordinary tool disclosure when no Router tool gateway is available', () => {
    const prompt = composeRouterSystemPrompt({ tools: [] })
    expect(prompt).not.toContain('connector_call')
    expect(prompt).toContain('No ordinary business tools are available')
    expect(prompt).toContain('Create a Task when the request needs tools')
  })

  it('gives the Worker execution rules without Router-only connector authority', () => {
    const prompt = composeWorkerSystemPrompt({
      availableTools: ['read_file', 'connector_list', 'connector_call'],
      skillIndex: '<available_skills>\n- Release notes (local:release)\n</available_skills>',
      locale: 'en',
    })
    expect(prompt).toContain('## Worker responsibilities')
    expect(prompt).toContain('You own the assigned Task')
    expect(prompt).toContain('## Tool disclosure')
    expect(prompt).toContain('connector_list')
    expect(prompt).toContain('## Skill index')
    expect(prompt).toContain('Release notes')
    expect(prompt).toContain('## Channel and language')
    expect(prompt).not.toContain('route_decision')
  })

  it('keeps Task Router coordination separate from execution rules', () => {
    const prompt = composeTaskRouterSystemPrompt({ locale: 'zh-CN' })
    expect(prompt).toContain('## Task coordination')
    expect(prompt).toContain('coordinate_task_message')
    expect(prompt).toContain('worker.dispatch')
    expect(prompt).toContain('## Tool disclosure')
    expect(prompt).toContain('no execution tools')
    expect(prompt).toContain('Preferred UI language: Simplified Chinese')
    expect(prompt).not.toContain('connector_call')
  })

  it('formats a readable Task brief instead of exposing raw contract JSON', () => {
    const brief = formatTaskBrief({
      objective: 'Create the weekly report.',
      deliverable: 'A Markdown report.',
      constraints: ['Use the supplied data only.'],
      inputRefs: [],
      sourceRefs: [],
      acceptanceCriteria: [],
      forbiddenActions: ['Do not send email.'],
      risk: 'local_write',
      executionLane: 'background',
      expectedArtifacts: ['weekly-report.md'],
    })
    expect(brief).toContain('Task goal')
    expect(brief).toContain('Create the weekly report.')
    expect(brief).toContain('Do not send email.')
    expect(brief).not.toContain('{"objective"')
  })
})
