import type { DelegationAction, DelegationRisk } from '../../shared/models'
import { classifyDelegation } from '../delegation/delegation-policy'

export interface RouterGoldenCase {
  name: string
  text: string
  attachmentNames?: string[]
  hasWorkingDirectory?: boolean
  expected: DelegationAction
  risk?: DelegationRisk
}

export interface RouterEvaluationResult {
  total: number
  correct: number
  accuracy: number
  mismatches: Array<{
    name: string
    expected: DelegationAction
    actual: DelegationAction
    expectedRisk?: DelegationRisk
    actualRisk: DelegationRisk
  }>
}

export const ROUTER_GOLDEN_CASES: readonly RouterGoldenCase[] = [
  {
    name: 'bounded factual question',
    text: 'What is the difference between these two versions?',
    expected: 'answer',
  },
  {
    name: 'short durable instruction',
    text: 'Remember that I prefer direct updates.',
    expected: 'answer',
  },
  {
    name: 'ambiguous request',
    text: 'Fix it',
    expected: 'clarify',
  },
  {
    name: 'required attachment missing',
    text: 'Summarize the attached document.',
    expected: 'clarify',
  },
  {
    name: 'multi-step research',
    text: 'Research three vendors and compare their pricing and support terms.',
    expected: 'task',
  },
  {
    name: 'explicit external write',
    text: 'Send an email to Alice with the approved project update.',
    expected: 'task',
    risk: 'external_write',
  },
  {
    name: 'destructive operation',
    text: 'Delete the old project files after reviewing the duplicates.',
    expected: 'task',
    risk: 'destructive',
  },
  {
    name: 'browser interaction',
    text: 'Open the vendor website, inspect the pricing page, and collect the plan details.',
    expected: 'task',
  },
  {
    name: 'attached workspace review',
    text: 'Review the attached project notes and prepare a decision brief.',
    attachmentNames: ['notes.md'],
    hasWorkingDirectory: true,
    expected: 'task',
  },
]

export function evaluateRouterPolicy(
  classify: typeof classifyDelegation = classifyDelegation,
): RouterEvaluationResult {
  const mismatches: RouterEvaluationResult['mismatches'] = []
  for (const testCase of ROUTER_GOLDEN_CASES) {
    const decision = classify({
      text: testCase.text,
      ...(testCase.attachmentNames === undefined ? {} : { attachmentNames: testCase.attachmentNames }),
      ...(testCase.hasWorkingDirectory === undefined ? {} : { hasWorkingDirectory: testCase.hasWorkingDirectory }),
    })
    if (
      decision.action !== testCase.expected
      || (testCase.risk !== undefined && decision.risk !== testCase.risk)
    ) {
      mismatches.push({
        name: testCase.name,
        expected: testCase.expected,
        actual: decision.action,
        ...(testCase.risk === undefined ? {} : { expectedRisk: testCase.risk }),
        actualRisk: decision.risk,
      })
    }
  }
  const total = ROUTER_GOLDEN_CASES.length
  const correct = total - mismatches.length
  return { total, correct, accuracy: correct / total, mismatches }
}
