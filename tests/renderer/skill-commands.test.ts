import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '../../src/shared/models'
import { buildSkillCommands, commandForSkill } from '../../src/renderer/skill-commands'

function skill(overrides: Partial<SkillSummary> & Pick<SkillSummary, 'id' | 'name'>): SkillSummary {
  return {
    description: '',
    source: 'local',
    enabled: true,
    updatedAt: '2026-11-24T00:00:00.000Z',
    provider: 'agents',
    providerLabel: 'Agents',
    editable: false,
    fileCount: 0,
    ...overrides,
  }
}

describe('skill commands', () => {
  it('builds stable slash commands from enabled skills and keeps duplicate names unique', () => {
    const commands = buildSkillCommands([
      skill({ id: 'local:agents:launch', name: 'Launch checklist', description: 'Prepare a launch.' }),
      skill({ id: 'local:codex:launch', name: 'Launch checklist', description: 'Another launch copy.', provider: 'codex', providerLabel: 'Codex' }),
      skill({ id: 'disabled', name: 'Disabled skill', enabled: false }),
    ])

    expect(commands.map((command) => command.value)).toEqual(['/launch-checklist', '/launch-checklist-2'])
    expect(commandForSkill(skill({ id: 'local:codex:launch', name: 'Launch checklist' }), commands)?.value)
      .toBe('/launch-checklist-2')
  })

  it('falls back to the skill id for names without ASCII slug characters', () => {
    const command = buildSkillCommands([skill({ id: 'local:custom:12345678-abcd', name: '数据分析' })])[0]
    expect(command?.value).toBe('/skill-12345678')
  })
})
