import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DingTalkRuntime,
  resolveRuntimeAsset,
  type DingTalkProcessRunner,
} from '../../src/main/connectors/dingtalk-runtime'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function runtimeWithBinary() {
  const root = await mkdtemp(join(tmpdir(), 'barn-dingtalk-runtime-'))
  tempDirs.push(root)
  const binary = join(root, 'dingtalk-runtime', 'v1.0.69', 'dws')
  await mkdir(join(binary, '..'), { recursive: true })
  await writeFile(binary, '#!/bin/sh\n')
  return { root, binary }
}

function fakeRunner(handler: (args: readonly string[]) => { code?: number; stdout?: string; stderr?: string }) {
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const runner: DingTalkProcessRunner = {
    async run(file, args) {
      calls.push({ file, args })
      const answer = handler(args)
      return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
    },
  }
  return { calls, runner }
}

describe('DingTalk runtime', () => {
  it('resolves pinned official assets per platform', () => {
    expect(resolveRuntimeAsset('darwin', 'arm64')).toEqual(expect.objectContaining({ archive: 'dws-darwin-arm64.tar.gz' }))
    expect(resolveRuntimeAsset('win32', 'x64')).toEqual(expect.objectContaining({ archive: 'dws-windows-amd64.zip' }))
    expect(resolveRuntimeAsset('freebsd', 'x64')).toBeUndefined()
  })

  it('reports installation and signed-in identity without exposing command output', async () => {
    const { root, binary } = await runtimeWithBinary()
    const { calls, runner } = fakeRunner((args) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        return { stdout: JSON.stringify({ success: true, authenticated: true }) }
      }
      if (args[0] === 'profile' && args[1] === 'list') {
        return { stdout: JSON.stringify({ profiles: [{ corpName: 'Acme', userName: 'Maya', isOrgCurrent: true }] }) }
      }
      return {}
    })
    const runtime = new DingTalkRuntime(root, { processRunner: runner })

    await expect(runtime.status()).resolves.toEqual({
      installed: true,
      authenticated: true,
      version: '1.0.69',
      organization: 'Acme',
      userName: 'Maya',
    })
    expect(calls[0]?.file).toBe(binary)
    expect(calls[0]?.args).toEqual(['auth', 'status', '--readonly', '--format', 'json'])
  })

  it('signs in and then reports authenticated', async () => {
    const { root } = await runtimeWithBinary()
    const { calls, runner } = fakeRunner((args) => {
      if (args[0] === 'auth' && args[1] === 'login') return {}
      if (args[0] === 'auth' && args[1] === 'status') return { stdout: JSON.stringify({ authenticated: true }) }
      if (args[0] === 'profile') return { stdout: JSON.stringify({ profiles: [] }) }
      return {}
    })
    const runtime = new DingTalkRuntime(root, { processRunner: runner })

    await expect(runtime.login()).resolves.toEqual(expect.objectContaining({ authenticated: true }))
    expect(calls.map((call) => call.args[1])).toContain('login')
  })

  it('runs allowlisted JSON commands only after authentication', async () => {
    const { root } = await runtimeWithBinary()
    const { calls, runner } = fakeRunner((args) => {
      if (args[0] === 'auth' && args[1] === 'status') return { stdout: JSON.stringify({ authenticated: true }) }
      if (args[0] === 'profile') return { stdout: JSON.stringify({ profiles: [] }) }
      return { stdout: JSON.stringify({ ok: true }) }
    })
    const runtime = new DingTalkRuntime(root, { processRunner: runner })

    await expect(runtime.runJson(['todo', 'task', 'list', '--format', 'json'])).resolves.toEqual({ ok: true })
    expect(calls.at(-1)?.args).toEqual(['todo', 'task', 'list', '--format', 'json'])
  })

  it('logs out through the local runtime', async () => {
    const { root } = await runtimeWithBinary()
    const { calls, runner } = fakeRunner(() => ({ stdout: '{}' }))
    const runtime = new DingTalkRuntime(root, { processRunner: runner })

    await runtime.logout()
    expect(calls.at(-1)?.args).toEqual(['auth', 'logout', '--yes', '--format', 'json'])
  })

  it('does not expose runtime names in failures', async () => {
    const { root } = await runtimeWithBinary()
    const { runner } = fakeRunner((args) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        return { stdout: JSON.stringify({ authenticated: true }) }
      }
      if (args[0] === 'profile') return { stdout: JSON.stringify({ profiles: [] }) }
      return { code: 1, stderr: 'dws request failed' }
    })
    const runtime = new DingTalkRuntime(root, { processRunner: runner })

    await expect(runtime.runJson(['todo', 'task', 'list'])).rejects.toThrow('DingTalk request failed')
  })
})
