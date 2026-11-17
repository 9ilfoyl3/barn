import { describe, expect, it } from 'vitest'
import { classifyDelegation } from '../../src/main/delegation/delegation-policy'

describe('DelegationPolicy', () => {
  it('answers a bounded factual question directly', () => {
    expect(classifyDelegation({ text: 'What is the capital of France?' })).toMatchObject({
      action: 'answer',
      risk: 'none',
      rationaleCodes: ['bounded_answer'],
    })
  })

  it('always creates a Task for an external write', () => {
    const decision = classifyDelegation({ text: 'Send the prepared update to Alice by email.' })
    expect(decision).toMatchObject({
      action: 'task',
      risk: 'external_write',
      complexity: 'high',
      rationaleCodes: ['side_effect_requires_task'],
    })
    expect(decision.taskContract).toMatchObject({
      risk: 'external_write',
      executionLane: 'background',
    })
    expect(decision.taskContract?.forbiddenActions.length).toBeGreaterThan(0)
  })

  it('asks for a missing attachment before delegating', () => {
    expect(classifyDelegation({ text: 'Summarize the attached document.' })).toMatchObject({
      action: 'clarify',
      missingInformation: ['attachment'],
    })
  })

  it('delegates repository work with capabilities and acceptance criteria', () => {
    const decision = classifyDelegation({
      text: 'Fix the failing repository tests and open a pull request.',
    })
    expect(decision.action).toBe('task')
    expect(decision.requiredCapabilities).toEqual(expect.arrayContaining(['shell']))
    expect(decision.taskContract?.acceptanceCriteria.length).toBeGreaterThan(0)
  })

  it('treats a bounded translation as a direct answer', () => {
    expect(classifyDelegation({ text: 'Translate this sentence into Chinese: Good morning.' })).toMatchObject({
      action: 'answer',
    })
  })

  it('asks for clarification when the request is too ambiguous', () => {
    expect(classifyDelegation({ text: 'Do it' })).toMatchObject({
      action: 'clarify',
      missingInformation: ['objective'],
    })
  })

  it('routes attachment analysis to durable work', () => {
    expect(classifyDelegation({
      text: 'Summarize this document and list its decisions.',
      attachmentNames: ['plan.pdf'],
    })).toMatchObject({
      action: 'task',
      requiredCapabilities: expect.arrayContaining(['filesystem']),
    })
  })
})
