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
    const event: ThreadLiveEvent = { type: 'thread.message-appended', message }
    for (const listener of this.listeners) listener(event)
    return message
  }

  onEvent(listener: (event: ThreadLiveEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
