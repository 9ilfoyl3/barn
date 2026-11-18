export function routerTaskDecisionJson(
  title: string,
  objective: string,
  risk: 'none' | 'local_write' | 'external_write' | 'destructive' = 'none',
): string {
  return JSON.stringify({
    tool: 'task.create',
    arguments: {
      title,
      objective,
      deliverable: 'Complete the requested task.',
      constraints: [],
      acceptanceCriteria: ['The requested task is completed.'],
      forbiddenActions: [],
      risk,
      expectedArtifacts: [],
    },
    confidence: 0.95,
    rationaleCodes: ['e2e_router_task'],
  })
}
