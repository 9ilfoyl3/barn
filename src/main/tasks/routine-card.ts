import type { RoutineCardDraft } from '../../shared/models'

const ROUTINE_CARD_OPEN = '<routine_card>'
const ROUTINE_CARD_CLOSE = '</routine_card>'

/**
 * Instruction appended only to active analysis watches. The block is host
 * metadata for the routine card and is removed before the analysis is stored.
 */
export const ROUTINE_CARD_INSTRUCTION = `After the analysis, end with exactly one ${ROUTINE_CARD_OPEN} block containing strict JSON:
${ROUTINE_CARD_OPEN}
{"title":"a concise imperative description of what I should do next","prompt":"a complete first-person request I can send to Barn to carry out that next step"}
${ROUTINE_CARD_CLOSE}
The title must be at most 100 characters. The prompt must be self-contained, include the concrete project/repository/branch or source reference from the evidence, and must not claim that any external action has already happened. Use the user's language. Put nothing after the closing tag.`

/** Split the Worker's final answer into visible analysis and optional card metadata. */
export function parseRoutineCardAnswer(text: string): {
  summary: string
  routine?: RoutineCardDraft
} {
  const match = new RegExp(`${ROUTINE_CARD_OPEN}([\\s\\S]*?)${ROUTINE_CARD_CLOSE}`, 'iu').exec(text)
  if (match === null) return { summary: text.trim() }

  const summary = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim()
  const payload = match[1]?.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '') ?? ''
  try {
    const value = JSON.parse(payload) as Record<string, unknown>
    const title = typeof value.title === 'string' ? value.title.trim().slice(0, 100) : ''
    const prompt = typeof value.prompt === 'string' ? value.prompt.trim().slice(0, 4_000) : ''
    if (title.length === 0 || prompt.length === 0) return { summary }
    return { summary, routine: { title, prompt } }
  } catch {
    return { summary }
  }
}
