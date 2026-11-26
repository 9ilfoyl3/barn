import type { Task } from '../../shared/models'
import type { TaskRunStore } from './task-run-store'
import type { TaskService } from './task-service'

export interface TaskGuardRunner {
  isActive(taskId: string): boolean
  activeSnapshot(): Array<{ taskId: string; sessionId: string; runId: string }>
  nudge(taskId: string, text: string): Promise<boolean>
  guardPause(taskId: string, detail: string): Promise<boolean>
}

export interface TaskGuardOptions {
  intervalMs?: number
  silentMs?: number
  graceMs?: number
  now?: () => Date
}

export interface TaskGuardReport {
  checked: number
  nudged: number
  paused: number
  closedRuns: number
}

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_SILENT_MS = 10 * 60_000
const DEFAULT_GRACE_MS = 5 * 60_000

/**
 * Deterministic outer watchdog for durable Task runs. It detects orphaned
 * ownership and silent Workers, asks once for a result, then pauses the Task
 * for the person instead of claiming success or failure.
 */
export class TaskGuardService {
  private readonly intervalMs: number
  private readonly silentMs: number
  private readonly graceMs: number
  private readonly now: () => Date
  private timer: NodeJS.Timeout | undefined
  private running = false
  private started = false

  constructor(
    private readonly tasks: Pick<TaskService, 'list' | 'updateStatus'>,
    private readonly runs: Pick<TaskRunStore, 'latest' | 'listRunning' | 'guard' | 'finishLatest'>,
    private readonly runner: TaskGuardRunner,
    options: TaskGuardOptions = {},
  ) {
    this.intervalMs = Math.max(250, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.silentMs = Math.max(1_000, options.silentMs ?? DEFAULT_SILENT_MS)
    this.graceMs = Math.max(1_000, options.graceMs ?? DEFAULT_GRACE_MS)
    this.now = options.now ?? (() => new Date())
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.timer = setInterval(() => void this.inspectNow(), this.intervalMs)
    this.timer.unref()
    void this.inspectNow()
  }

  stop(): void {
    this.started = false
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  async inspectNow(): Promise<TaskGuardReport> {
    if (this.running) return { checked: 0, nudged: 0, paused: 0, closedRuns: 0 }
    this.running = true
    const report: TaskGuardReport = { checked: 0, nudged: 0, paused: 0, closedRuns: 0 }
    try {
      const now = this.now()
      const tasks = this.tasks.list()
      const byId = new Map(tasks.map((task) => [task.id, task]))

      for (const task of tasks) {
        if (task.status !== 'running' || task.kind === 'reminder') continue
        report.checked++
        try {
          const run = this.runs.latest(task.id)
          if (run === undefined || run.status !== 'running') {
            const detail = 'Guard paused this task because its execution run record is missing. Run it again when ready.'
            if (this.runner.isActive(task.id)) await this.runner.guardPause(task.id, detail)
            else this.pauseOrphan(task, detail)
            report.paused++
            continue
          }
          if (!this.runner.isActive(task.id)) {
            this.pauseOrphan(task, 'Guard paused this task because no worker owns the run. Run it again when ready.')
            report.paused++
            continue
          }
          const silentFor = now.getTime() - Date.parse(run.lastProgressAt)
          if (!Number.isFinite(silentFor) || silentFor < this.silentMs) continue

          if (run.guardState === 'watching') {
            const nudged = await this.runner.nudge(task.id, guardNudgeText())
            if (nudged) {
              const current = this.runs.latest(task.id) ?? run
              this.runs.guard(current.id, 'nudged', now)
              report.nudged++
            }
            continue
          }

          if (run.guardState === 'nudged') {
            const guardAt = Date.parse(run.guardUpdatedAt ?? run.heartbeatAt)
            if (!Number.isFinite(guardAt) || now.getTime() - guardAt < this.graceMs) continue
            const paused = await this.runner.guardPause(
              task.id,
              'Guard paused this task after the worker made no progress following a status request. Add instructions or run it again when ready.',
            )
            if (paused) {
              this.runs.guard(run.id, 'escalated', now)
              report.paused++
            }
            continue
          }

          if (run.guardState === 'escalated') {
            this.pauseOrphan(task, 'Guard paused this task because its run remained active after escalation. Run it again when ready.')
            report.paused++
          }
        } catch {
          // One broken Task must not stop the guard from checking the others.
        }
      }

      for (const run of this.runs.listRunning()) {
        const task = byId.get(run.taskId)
        if (task === undefined) {
          this.runs.finishLatest(run.taskId, 'failed', 'The Task was removed while its run was active.', now)
          report.closedRuns++
          continue
        }
        if (task.status === 'running') continue
        const status = task.status === 'completed'
          ? 'completed'
          : task.status === 'failed'
            ? 'failed'
            : task.status === 'cancelled'
              ? 'cancelled'
              : 'waiting'
        this.runs.finishLatest(task.id, status, task.detail, now)
        report.closedRuns++
      }

      return report
    } finally {
      this.running = false
    }
  }

  private pauseOrphan(task: Task, detail: string): void {
    this.tasks.updateStatus(task.id, { status: 'waiting', waitingReason: 'input', detail })
    this.runs.finishLatest(task.id, 'failed', detail, this.now())
  }
}

function guardNudgeText(): string {
  return [
    'Guard check: this run has made no observable progress for a while.',
    'Publish exactly one concise result if the task is complete.',
    'If it is not complete, state what you are waiting for and stop.',
    'Do not repeat an external action that may already have succeeded.',
  ].join(' ')
}
