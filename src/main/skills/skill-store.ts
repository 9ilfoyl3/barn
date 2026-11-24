import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CreateSkillInput, SkillDetail, SkillSummary, UpdateSkillInput } from '../../shared/models'
import type { AesGcmEventCipher } from '../session/event-cipher'

interface SkillRow {
  id: string
  name: string
  description: string
  enabled: number
  instructions_ciphertext: Uint8Array
  instructions_nonce: Uint8Array
  instructions_tag: Uint8Array
  created_at: string
  updated_at: string
}

export class SkillStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly cipher: AesGcmEventCipher,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        instructions_ciphertext BLOB NOT NULL,
        instructions_nonce BLOB NOT NULL,
        instructions_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skills_enabled_idx ON skills(enabled, updated_at DESC);
      CREATE TABLE IF NOT EXISTS skill_preferences (
        skill_key TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );
    `)
  }

  list(): SkillSummary[] {
    const rows = this.database.prepare(`
      SELECT id, name, description, enabled, instructions_ciphertext, instructions_nonce,
             instructions_tag, created_at, updated_at
      FROM skills ORDER BY updated_at DESC
    `).all() as unknown as SkillRow[]
    return rows.map((row) => this.toSummary(row))
  }

  get(skillId: string): SkillDetail {
    const row = this.database.prepare(`
      SELECT id, name, description, enabled, instructions_ciphertext, instructions_nonce,
             instructions_tag, created_at, updated_at
      FROM skills WHERE id = ?
    `).get(skillId) as SkillRow | undefined
    if (row === undefined) throw new Error(`Unknown skill: ${skillId}`)
    return this.toDetail(row)
  }

  create(input: CreateSkillInput): SkillDetail {
    const normalized = normalizeCreate(input)
    const id = randomUUID()
    const now = new Date().toISOString()
    const encrypted = this.encryptInstructions(id, normalized.instructions)
    try {
      this.database.prepare(`
        INSERT INTO skills (
          id, name, description, enabled, instructions_ciphertext, instructions_nonce,
          instructions_tag, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        id,
        normalized.name,
        normalized.description,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        now,
        now,
      )
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('A skill with that name already exists', { cause: error })
      throw error
    }
    return this.get(id)
  }

  update(skillId: string, input: UpdateSkillInput): SkillDetail {
    const current = this.get(skillId)
    const next = normalizeUpdate(current, input)
    const encrypted = input.instructions === undefined
      ? undefined
      : this.encryptInstructions(skillId, next.instructions)
    try {
      this.database.prepare(`
        UPDATE skills
        SET name = ?, description = ?, instructions_ciphertext = COALESCE(?, instructions_ciphertext),
            instructions_nonce = COALESCE(?, instructions_nonce), instructions_tag = COALESCE(?, instructions_tag),
            updated_at = ?
        WHERE id = ?
      `).run(
        next.name,
        next.description,
        encrypted?.ciphertext ?? null,
        encrypted?.nonce ?? null,
        encrypted?.tag ?? null,
        new Date().toISOString(),
        skillId,
      )
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('A skill with that name already exists', { cause: error })
      throw error
    }
    return this.get(skillId)
  }

  setEnabled(skillId: string, enabled: boolean): SkillDetail {
    this.get(skillId)
    this.database.prepare('UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), skillId)
    return this.get(skillId)
  }

  getPreference(skillKey: string): boolean | undefined {
    const row = this.database.prepare('SELECT enabled FROM skill_preferences WHERE skill_key = ?')
      .get(skillKey) as { enabled: number } | undefined
    return row === undefined ? undefined : row.enabled === 1
  }

  setPreference(skillKey: string, enabled: boolean): void {
    this.database.prepare(`
      INSERT INTO skill_preferences (skill_key, enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(skill_key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(skillKey, enabled ? 1 : 0, new Date().toISOString())
  }

  remove(skillId: string): void {
    this.get(skillId)
    this.database.prepare('DELETE FROM skills WHERE id = ?').run(skillId)
  }

  private toSummary(row: SkillRow): SkillSummary {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      source: 'custom',
      enabled: row.enabled === 1,
      updatedAt: row.updated_at,
      provider: 'barn',
      providerLabel: 'Barn',
      editable: true,
      fileCount: 0,
    }
  }

  private toDetail(row: SkillRow): SkillDetail {
    return {
      ...this.toSummary(row),
      files: [],
      instructions: this.cipher.decrypt<string>(
        {
          ciphertext: row.instructions_ciphertext,
          nonce: row.instructions_nonce,
          tag: row.instructions_tag,
        },
        skillAssociatedData(row.id),
      ),
    }
  }

  private encryptInstructions(skillId: string, instructions: string) {
    return this.cipher.encrypt(instructions, skillAssociatedData(skillId))
  }
}

function normalizeCreate(input: CreateSkillInput): CreateSkillInput {
  return {
    name: requireText(input.name, 'Skill name', 120),
    description: requireText(input.description, 'Skill description', 500, true),
    instructions: requireText(input.instructions, 'Skill instructions', 100_000),
  }
}

function normalizeUpdate(current: SkillDetail, input: UpdateSkillInput): SkillDetail {
  return {
    ...current,
    name: input.name === undefined ? current.name : requireText(input.name, 'Skill name', 120),
    description: input.description === undefined
      ? current.description
      : requireText(input.description, 'Skill description', 500, true),
    instructions: input.instructions === undefined
      ? current.instructions
      : requireText(input.instructions, 'Skill instructions', 100_000),
  }
}

function requireText(value: string, label: string, maxLength: number, allowEmpty = false): string {
  const normalized = value.trim()
  if (!allowEmpty && normalized.length === 0) throw new Error(`${label} is required`)
  if (normalized.length > maxLength) throw new Error(`${label} is too long`)
  return normalized
}

function skillAssociatedData(skillId: string): string {
  return `skill:${skillId}:instructions`
}
