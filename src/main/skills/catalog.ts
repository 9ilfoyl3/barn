import type { SkillDetail } from '../../shared/models'

const SYSTEM_SKILL_UPDATED_AT = '2026-11-23T00:00:00.000Z'

export const SYSTEM_SKILLS: readonly SkillDetail[] = [
  {
    id: 'system-meeting-notes',
    name: 'Meeting notes to actions',
    description: 'Turn raw meeting notes into decisions, owners, due dates, and open questions.',
    source: 'system',
    enabled: true,
    updatedAt: SYSTEM_SKILL_UPDATED_AT,
    instructions: `# Meeting notes to actions

Use this skill when the user provides meeting notes, a transcript, or a recording summary.

## Output contract

1. Start with a one-paragraph summary of the meeting's purpose and outcome.
2. List **Decisions** separately from discussion.
3. List **Action items** with owner, due date, and source context when available. Mark missing fields as "Unknown" rather than inventing them.
4. List **Open questions** and anything that needs confirmation.
5. Preserve names, dates, numbers, and commitments exactly. Do not turn tentative discussion into a decision.
6. Keep the result concise and scan-friendly.`,
  },
  {
    id: 'system-research-brief',
    name: 'Research brief',
    description: 'Produce a balanced research brief with sources, confidence, and open questions.',
    source: 'system',
    enabled: true,
    updatedAt: SYSTEM_SKILL_UPDATED_AT,
    instructions: `# Research brief

Use this skill when the user asks for research, a comparison, or a decision brief.

## Process

1. Clarify the decision or question being researched.
2. Prefer primary and recent sources. Record source titles, dates, and links.
3. Separate verified facts, interpretation, and recommendation.
4. Note disagreement, missing evidence, and freshness limits.
5. Use a compact structure: Executive summary, Findings, Comparison, Risks, Recommendation, Sources.
6. Never invent citations or present an unsupported claim as fact.`,
  },
  {
    id: 'system-email-drafting',
    name: 'Email drafting',
    description: 'Draft clear professional emails while preserving the user’s intent and constraints.',
    source: 'system',
    enabled: true,
    updatedAt: SYSTEM_SKILL_UPDATED_AT,
    instructions: `# Email drafting

Use this skill when the user asks to draft, reply to, or rewrite an email.

## Rules

1. Match the requested audience, formality, and language.
2. Keep the subject specific and the opening direct.
3. State the purpose, necessary context, requested action, and deadline.
4. Remove filler, repetition, and vague phrases.
5. Do not invent commitments, facts, recipients, or attachments.
6. When sending through a connector, show the draft and use the approval-backed send path.`,
  },
]
