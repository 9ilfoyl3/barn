import { utilityProcess } from 'electron'
import type { HostToWorkerMessage } from '../../shared/agent-protocol'
import type { WorkerTransport } from './worker-supervisor'

export function createElectronWorkerTransport(
  modulePath: string,
  environment: NodeJS.ProcessEnv,
): WorkerTransport {
  const child = utilityProcess.fork(modulePath, [], {
    env: environment,
    serviceName: 'Barn Agent Worker',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (chunk) => process.stdout.write(`[agent-worker] ${chunk.toString()}`))
  child.stderr?.on('data', (chunk) => process.stderr.write(`[agent-worker] ${chunk.toString()}`))

  return {
    postMessage(message: HostToWorkerMessage) {
      child.postMessage(message)
    },
    kill() {
      child.kill()
    },
    onMessage(listener) {
      const handler = (message: unknown): void => listener(message)
      child.on('message', handler)
      return () => child.off('message', handler)
    },
    onExit(listener) {
      const handler = (code: number | null): void => listener(code)
      child.on('exit', handler)
      return () => child.off('exit', handler)
    },
  }
}
