import type { MessageEvent as ElectronMessageEvent, ParentPort } from 'electron'
import { WorkerRuntime } from './worker-runtime'
import type { WorkerPort } from './worker-runtime'
import type { WorkerToHostMessage } from '../shared/agent-protocol'

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (parentPort === undefined) throw new Error('Agent Worker must run as an Electron utility process')

const port: WorkerPort = {
  postMessage(message: WorkerToHostMessage) {
    parentPort.postMessage(message)
  },
  onMessage(listener) {
    const handler = (event: ElectronMessageEvent): void => listener(event.data)
    parentPort.on('message', handler)
    return () => parentPort.off('message', handler)
  },
}

const runtime = new WorkerRuntime(port)
runtime.start()
