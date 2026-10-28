import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SandboxMode, SandboxPolicy } from './types'

export interface PolicyInput {
  mode: SandboxMode
  workspaceRoot: string
  outputRoot: string
  privateTempRoot: string
  timeoutMs?: number
  maxOutputBytes?: number
}

export function resolveSandboxPolicy(input: PolicyInput): SandboxPolicy {
  const workspaceRoot = canonicalPath(input.workspaceRoot)
  const outputRoot = canonicalPath(input.outputRoot)
  const privateTempRoot = canonicalPath(input.privateTempRoot)
  const writeRoots = [privateTempRoot]

  if (input.mode === 'output-write') writeRoots.push(outputRoot)
  if (input.mode === 'workspace-write') writeRoots.push(outputRoot, workspaceRoot)

  return {
    mode: input.mode,
    workspaceRoot,
    outputRoot,
    privateTempRoot,
    readRoots: [workspaceRoot, outputRoot],
    writeRoots,
    denyPaths: [
      canonicalPath(resolve(homedir(), 'Library', 'Keychains')),
      canonicalPath(resolve(homedir(), '.ssh')),
      canonicalPath(resolve(homedir(), '.aws')),
      canonicalPath(resolve(homedir(), '.config', 'gcloud')),
      canonicalPath(resolve(homedir(), '.docker')),
    ],
    network: 'deny',
    timeoutMs: input.timeoutMs ?? 120_000,
    maxOutputBytes: input.maxOutputBytes ?? 1_000_000,
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}
