import { describe, expect, it } from 'vitest'
import { parseRoutineCardAnswer } from '../../src/main/tasks/routine-card'

describe('parseRoutineCardAnswer', () => {
  it('removes routine metadata from the visible analysis', () => {
    const parsed = parseRoutineCardAnswer(`The MR is ready for review.

<routine_card>
{"title":"Review MR !233 before merge","prompt":"帮我审查 MR !233 的分页回归风险，并给出是否可合并的结论。"}
</routine_card>`)
    expect(parsed).toEqual({
      summary: 'The MR is ready for review.',
      routine: {
        title: 'Review MR !233 before merge',
        prompt: '帮我审查 MR !233 的分页回归风险，并给出是否可合并的结论。',
      },
    })
  })

  it('accepts a fenced JSON block and strips it even when invalid', () => {
    expect(parseRoutineCardAnswer(`Analysis.\n<routine_card>\n\`\`\`json\n{"title":"x","prompt":"y"}\n\`\`\`\n</routine_card>`))
      .toEqual({ summary: 'Analysis.', routine: { title: 'x', prompt: 'y' } })
    expect(parseRoutineCardAnswer('Analysis.\n<routine_card>not json</routine_card>')).toEqual({ summary: 'Analysis.' })
  })
})
