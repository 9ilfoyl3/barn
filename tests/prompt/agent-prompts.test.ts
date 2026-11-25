import { describe, expect, it } from 'vitest'
import { composeRouterSystemPrompt, composeTaskRouterSystemPrompt, composeWorkerSystemPrompt, formatTaskBrief } from '../../src/shared/agent-prompts'

function positions(prompt: string, headings: string[]): number[] {
  return headings.map((heading) => {
    const index = prompt.indexOf(heading)
    expect(index, `missing heading: ${heading}`).toBeGreaterThanOrEqual(0)
    return index
  })
}

describe('agent prompt composition', () => {
  it('keeps Router sections in a stable role-first order', () => {
    const prompt = composeRouterSystemPrompt({ connectorToolsAvailable: true, locale: 'zh-CN' })
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
    expect(prompt).toContain('one bounded read-only connector lookup')
    expect(prompt).toContain('Do not create a Task only because a connector is involved')
    expect(prompt).toContain('connector.read')
    expect(prompt).toContain('Preferred UI language: Simplified Chinese')
  })

  it('omits the direct connector protocol when no connector gateway is available', () => {
    const prompt = composeRouterSystemPrompt({ connectorToolsAvailable: false })
    expect(prompt).not.toContain('connector.read')
    expect(prompt).toContain('Create a Task when work needs connectors')
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
