import type { SkillSummary } from '../shared/models'
import type { PromptCommand } from './components/beui/components/agents/prompt-input'

export interface SkillPromptCommand extends PromptCommand {
  skillId: string
  providerLabel: string
}

export function buildSkillCommands(skills: readonly SkillSummary[]): SkillPromptCommand[] {
  const used = new Map<string, number>()
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => {
      const fallback = sanitize(skill.id.split(':').at(-1) ?? skill.id).slice(0, 8)
      const base = commandSlug(skill.name) || `skill-${fallback}`
      const count = (used.get(base) ?? 0) + 1
      used.set(base, count)
      const slug = count === 1 ? base : `${base}-${count}`
      return {
        skillId: skill.id,
        providerLabel: skill.providerLabel,
        value: `/${slug}`,
        label: `/${slug}`,
        description: skill.description || skill.name,
        keywords: `${skill.name} ${skill.description} ${skill.providerLabel}`,
      }
    })
    .toSorted((left, right) => left.label.localeCompare(right.label))
}

export function commandForSkill(
  skill: SkillSummary,
  commands: readonly SkillPromptCommand[],
): SkillPromptCommand | undefined {
  return commands.find((command) => command.skillId === skill.id)
}

function commandSlug(value: string): string {
  return sanitize(value).slice(0, 64).replace(/^-+|-+$/gu, '')
}

function sanitize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
}
