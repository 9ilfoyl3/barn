import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type {
  HostToWorkerMessage,
  WorkerToHostMessage,
} from '../../shared/agent-protocol'
import type { ModelSelection } from '../../shared/models'

export interface ModelStreamSource {
  streamSimple(
    selection: ModelSelection,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream
}

type ModelStartMessage = Extract<WorkerToHostMessage, { type: 'model.start' }>

export class ModelStreamBroker {
  private readonly active = new Map<string, AbortController>()

  constructor(
    private readonly models: ModelStreamSource,
    private readonly post: (message: HostToWorkerMessage) => void,
  ) {}

  start(message: ModelStartMessage): void {
    this.abort(message.requestId)
    const controller = new AbortController()
    this.active.set(message.requestId, controller)

    try {
      const stream = this.models.streamSimple(
        message.selection,
        message.context as Context,
        {
          ...(message.options as SimpleStreamOptions | undefined),
          signal: controller.signal,
        },
      )
      void this.forward(message.requestId, stream, controller)
    } catch (error) {
      this.active.delete(message.requestId)
      this.post({
        type: 'model.error',
        requestId: message.requestId,
        error: toError(error).message,
      })
    }
  }

  abort(requestId: string): void {
    const controller = this.active.get(requestId)
    if (controller === undefined) return
    thatAbort(controller)
    this.active.delete(requestId)
  }

  abortAll(): void {
    for (const controller of this.active.values()) thatAbort(controller)
    this.active.clear()
  }

  private async forward(
    requestId: string,
    stream: AssistantMessageEventStream,
    controller: AbortController,
  ): Promise<void> {
    let terminal = false
    try {
      for await (const event of stream) {
        if (controller.signal.aborted) break
        this.post({ type: 'model.event', requestId, event })
        if (event.type === 'done' || event.type === 'error') {
          terminal = true
          break
        }
      }
      if (!terminal && !controller.signal.aborted) {
        throw new Error('Model stream ended without a terminal event')
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.post({
          type: 'model.error',
          requestId,
          error: toError(error).message,
        })
      }
    } finally {
      if (this.active.get(requestId) === controller) this.active.delete(requestId)
    }
  }
}

function thatAbort(controller: AbortController): void {
  if (!controller.signal.aborted) controller.abort()
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export type { AssistantMessageEvent }
