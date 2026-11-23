import type {
  CreateSkillInput,
  SkillDetail,
  SkillLiveEvent,
  SkillSummary,
  UpdateSkillInput,
} from '../../shared/models'
import { SYSTEM_SKILLS } from './catalog'
import type { SkillStore } from './skill-store'

export class SkillService {
  private readonly listeners = new Set<(event: SkillLiveEvent) => void>()

  constructor(private readonly store: SkillStore) {}

  list(): SkillSummary[] {
    return [...SYSTEM_SKILLS.map(toSummary), ...this.store.list()]
  }

  get(skillId: string): SkillDetail {
    return SYSTEM_SKILLS.find((skill) => skill.id === skillId) ?? this.store.get(skillId)
  }

  enabledDetails(): SkillDetail[] {
    return [...SYSTEM_SKILLS, ...this.store.list()
      .filter((skill) => skill.enabled)
      .map((skill) => this.store.get(skill.id))]
  }

  create(input: CreateSkillInput): SkillDetail {
    const skill = this.store.create(input)
    this.emit(skill)
    return skill
  }

  update(skillId: string, input: UpdateSkillInput): SkillDetail {
    if (this.isSystem(skillId)) throw new Error('System skills are read-only')
    const skill = this.store.update(skillId, input)
    this.emit(skill)
    return skill
  }

  setEnabled(skillId: string, enabled: boolean): SkillDetail {
    if (this.isSystem(skillId)) throw new Error('System skills are always enabled')
    const skill = this.store.setEnabled(skillId, enabled)
    this.emit(skill)
    return skill
  }

  remove(skillId: string): void {
    if (this.isSystem(skillId)) throw new Error('System skills cannot be removed')
    const skill = this.store.get(skillId)
    this.store.remove(skillId)
    this.emit(skill)
  }

  onEvent(listener: (event: SkillLiveEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private isSystem(skillId: string): boolean {
    return SYSTEM_SKILLS.some((skill) => skill.id === skillId)
  }

  private emit(skill: SkillSummary): void {
    const event: SkillLiveEvent = { type: 'skill.updated', skill: toSummary(skill) }
    for (const listener of this.listeners) listener(event)
  }
}

function toSummary(skill: SkillDetail | SkillSummary): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    enabled: skill.enabled,
    updatedAt: skill.updatedAt,
  }
}
