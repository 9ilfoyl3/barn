import { describe, expect, it, vi } from 'vitest'
import { DINGTALK_CONNECTOR } from '../../src/main/connectors/catalog'
import { DingTalkConnectorAdapter } from '../../src/main/connectors/dingtalk-adapter'
import type { DingTalkRuntimeClient } from '../../src/main/connectors/dingtalk-runtime'
import type { ConnectorRecord } from '../../src/main/connectors/types'

const connector: ConnectorRecord = {
  id: 'dingtalk-1',
  kind: 'dingtalk',
  name: 'DingTalk',
  enabled: true,
  config: {},
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
}

function capability(id: string) {
  const match = DINGTALK_CONNECTOR.capabilities.find((entry) => entry.id === id)
  if (match === undefined) throw new Error(`Missing DingTalk capability: ${id}`)
  return match
}

function fakeRuntime(status: Awaited<ReturnType<DingTalkRuntimeClient['status']>> = {
  installed: true,
  authenticated: true,
  version: '1.0.69',
  organization: 'Acme',
  userName: 'Maya',
}) {
  const runJson = vi.fn(async () => ({ ok: true }))
  return {
    runJson,
    runtime: {
      status: vi.fn(async () => status),
      runJson,
    } satisfies DingTalkRuntimeClient,
  }
}

describe('DingTalk connector', () => {
  it('reports the signed-in DingTalk identity', async () => {
    const { runtime } = fakeRuntime()
    const adapter = new DingTalkConnectorAdapter(runtime)

    await expect(adapter.test({ connector, secrets: {} })).resolves.toEqual({
      message: 'Connected to DingTalk as Maya · Acme',
    })
  })

  it('requires installation and sign-in before use', async () => {
    const notInstalled = fakeRuntime({ installed: false, authenticated: false }).runtime
    const notAuthenticated = fakeRuntime({ installed: true, authenticated: false }).runtime

    await expect(new DingTalkConnectorAdapter(notInstalled).test({ connector, secrets: {} }))
      .rejects.toThrow('not installed')
    await expect(new DingTalkConnectorAdapter(notAuthenticated).test({ connector, secrets: {} }))
      .rejects.toThrow('Sign in to DingTalk first')
  })

  it('searches contacts', async () => {
    const { runtime, runJson } = fakeRuntime()
    const adapter = new DingTalkConnectorAdapter(runtime)

    await adapter.call({ connector, secrets: {} }, capability('dingtalk.contactSearch'), { query: 'Maya' })

    expect(runJson).toHaveBeenCalledWith([
      'contact', 'user', 'search',
      '--query', 'Maya',
      '--format', 'json',
    ], undefined)
  })

  it('lists calendar events and todos with bounded pagination', async () => {
    const { runtime, runJson } = fakeRuntime()
    const adapter = new DingTalkConnectorAdapter(runtime)

    await adapter.call({ connector, secrets: {} }, capability('dingtalk.calendarList'), {
      start: '2026-11-23T00:00:00+08:00',
      end: '2026-11-24T00:00:00+08:00',
      limit: 10,
    })
    await adapter.call({ connector, secrets: {} }, capability('dingtalk.todoList'), { page: 2, size: 25 })

    expect(runJson).toHaveBeenNthCalledWith(1, [
      'calendar', 'event', 'list',
      '--start', '2026-11-23T00:00:00+08:00',
      '--end', '2026-11-24T00:00:00+08:00',
      '--limit', '10',
      '--format', 'json',
    ], undefined)
    expect(runJson).toHaveBeenNthCalledWith(2, [
      'todo', 'task', 'list',
      '--page', '2',
      '--size', '25',
      '--format', 'json',
    ], undefined)
  })

  it('searches messages and sends as the connected user after approval', async () => {
    const { runtime, runJson } = fakeRuntime()
    const adapter = new DingTalkConnectorAdapter(runtime)

    await adapter.call({ connector, secrets: {} }, capability('dingtalk.chatSearch'), {
      query: 'release',
      conversationId: 'cid-1',
      limit: 5,
    })
    await adapter.call({ connector, secrets: {} }, capability('dingtalk.send'), {
      conversationId: 'cid-1',
      content: 'Release is ready.',
      title: 'Release',
    })

    expect(runJson).toHaveBeenNthCalledWith(1, [
      'chat', 'message', 'search',
      '--query', 'release',
      '--conversation-id', 'cid-1',
      '--limit', '5',
      '--format', 'json',
    ], undefined)
    expect(runJson).toHaveBeenNthCalledWith(2, [
      'chat', 'message', 'send',
      '--group', 'cid-1',
      '--title', 'Release',
      '--content', 'Release is ready.',
      '--format', 'json',
      '--yes',
    ], undefined)
  })

  it('requires exactly one message target', async () => {
    const { runtime } = fakeRuntime()
    const adapter = new DingTalkConnectorAdapter(runtime)

    await expect(adapter.call({ connector, secrets: {} }, capability('dingtalk.send'), {
      content: 'Missing recipient',
    })).rejects.toThrow('exactly one DingTalk target')
    await expect(adapter.call({ connector, secrets: {} }, capability('dingtalk.send'), {
      userId: 'u1',
      conversationId: 'c1',
      content: 'Two recipients',
    })).rejects.toThrow('exactly one DingTalk target')
  })
})
