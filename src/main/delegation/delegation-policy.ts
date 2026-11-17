import type {
  DelegationDecision,
  DelegationInput,
  DelegationRisk,
  TaskContract,
} from '../../shared/models'

const EXTERNAL_WRITE = /\b(send|email|message|post|publish|submit|share|invite|upload|comment|reply|purchase|buy|order|book|pay|transfer)\b/i
const DESTRUCTIVE = /\b(delete|remove|erase|wipe|drop|reset|revoke|archive|cancel|deploy|release|merge|close)\b/i
const MULTI_STEP = /\b(research|investigate|review|analy[sz]e|compare|prepare|create|draft|write|build|implement|debug|fix|test|browse|navigate|collect|extract|organi[sz]e|summari[sz]e|plan)\b/i
const REQUIRED_ATTACHMENT = /\b(this file|the file|attached|attachment|document|spreadsheet|pdf)\b/i
const DIRECT_ANSWER = /^(what|who|when|where|why|how|is|are|can|could|should|explain|translate|rewrite|summari[sz]e)\b/i
const CAPABILITY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(web|search|research|browse|website|url|page)\b/i, 'web'],
  [/\b(file|folder|document|pdf|spreadsheet|workspace)\b/i, 'filesystem'],
  [/\b(code|repository|repo|branch|commit|test|build|debug|shell|command)\b/i, 'shell'],
  [/\b(email|gmail|slack|feishu|lark|message|calendar|notion|linear|github)\b/i, 'connector'],
]
const TASK_VERBS = /\b(research|investigate|review|prepare|create|draft|write|build|implement|debug|fix|test|browse|collect|extract|organi[sz]e|compare|plan)\b/i

export function classifyDelegation(input: DelegationInput): DelegationDecision {
  const text = input.text.replace(/\s+/g, ' ').trim()
  const attachments = input.attachmentNames ?? []
  const risk = detectRisk(text)
  const requiredCapabilities = detectCapabilities(text)
  const missingInformation: string[] = []

  if (text.length === 0) {
    return decision('clarify', 0.99, 'low', 'none', [], ['empty_request'], undefined, ['A request is required.'])
  }
  if (REQUIRED_ATTACHMENT.test(text) && attachments.length === 0) {
    missingInformation.push('attachment')
  }
  if (missingInformation.length > 0) {
    return decision('clarify', 0.95, 'low', risk, requiredCapabilities, ['missing_required_input'], undefined, missingInformation)
  }
  if (risk !== 'none' || DESTRUCTIVE.test(text)) {
    return decision('task', 0.97, 'high', risk, requiredCapabilities, ['side_effect_requires_task'], taskContract(text, risk, requiredCapabilities), [])
  }
  if (attachments.length > 0 || text.length > 600 || MULTI_STEP.test(text) || TASK_VERBS.test(text)) {
    return decision('task', 0.9, text.length > 200 ? 'high' : 'medium', 'none', requiredCapabilities, ['durable_work'], taskContract(text, 'none', requiredCapabilities), [])
  }
  if (DIRECT_ANSWER.test(text) && text.length <= 400) {
    return decision('answer', 0.88, 'low', 'none', requiredCapabilities, ['bounded_answer'], undefined, [])
  }
  if (text.split(/\s+/).length <= 4) {
    return decision('clarify', 0.72, 'medium', 'none', requiredCapabilities, ['request_too_ambiguous'], undefined, ['objective'])
  }
  return decision('task', 0.65, 'medium', 'none', requiredCapabilities, ['needs_execution_or_unknown_scope'], taskContract(text, 'none', requiredCapabilities), [])
}

function detectRisk(text: string): DelegationRisk {
  if (DESTRUCTIVE.test(text)) return 'destructive'
  if (EXTERNAL_WRITE.test(text)) return 'external_write'
  if (/\b(change|edit|write|save|create|move|rename|replace)\b/i.test(text)) return 'local_write'
  return 'none'
}

function detectCapabilities(text: string): string[] {
  return CAPABILITY_PATTERNS.flatMap(([pattern, capability]) => pattern.test(text) ? [capability] : [])
}

function taskContract(text: string, risk: DelegationRisk, capabilities: string[]): TaskContract {
  return {
    objective: text,
    deliverable: `Complete the requested work: ${text.slice(0, 180)}`,
    constraints: ['Use only authorized sources and tools.'],
    inputRefs: [],
    sourceRefs: [],
    acceptanceCriteria: ['The requested outcome is complete, supported by available evidence, and reports any unresolved limitation.'],
    forbiddenActions: risk === 'none'
      ? []
      : ['No external effect without the required permission or approval.'],
    risk,
    executionLane: 'background',
    expectedArtifacts: capabilities.includes('filesystem') ? ['deliverable'] : [],
  }
}

function decision(
  action: DelegationDecision['action'],
  confidence: number,
  complexity: DelegationDecision['complexity'],
  risk: DelegationRisk,
  requiredCapabilities: string[],
  rationaleCodes: string[],
  contract: TaskContract | undefined,
  missingInformation: string[],
): DelegationDecision {
  return {
    action,
    confidence,
    complexity,
    risk,
    requiredCapabilities,
    missingInformation,
    rationaleCodes,
    ...(contract === undefined ? {} : { taskContract: contract }),
  }
}
