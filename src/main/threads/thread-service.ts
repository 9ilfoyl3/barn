import type {
  AppendVisibleMessageInput,
  PrincipalThreadSnapshot,
  ThreadLiveEvent,
  VisibleMessage,
} from '../../shared/models'
import type { ListVisibleMessagesOptions, ThreadStore } from './thread-store'

/** Application-facing Principal Thread commands and live updates. */
export class ThreadService {
  private readonly listeners = new Set<(event: ThreadLiveEvent) => void>()

  constructor(private readonly store: ThreadStore) {}

  getSnapshot(): PrincipalThreadSnapshot {
    return {
      thread: this.store.getPrimaryThread(),
      messages: this.store.listPrimaryMessages(),
    }
  }

  listMessages(options: ListVisibleMessagesOptions = {}): VisibleMessage[] {
    return this.store.listPrimaryMessages(options)
  }

  appendMessage(input: AppendVisibleMessageInput): VisibleMessage {
    const message = this.store.appendPrimaryMessage(input)
    this.notifyMessage(message)
    return message
  }

  appendMessageInTransaction(input: AppendVisibleMessageInput): VisibleMessage {
    return this.store.appendPrimaryMessageInTransaction(input)
  }

  notifyMessage(message: VisibleMessage): void {
    const event: ThreadLiveEvent = { type: 'thread.message-appended', message }
    for (const listener of this.listeners) listener(event)
  }

  getMessage(messageId: string): VisibleMessage {
    return this.store.getPrimaryMessage(messageId)
  }

  onEvent(listener: (event: ThreadLiveEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
