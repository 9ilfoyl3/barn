import type { BarnBridge } from '../shared/models'

declare global {
  interface Window {
    barn: BarnBridge
  }
}

export type RendererBridge = BarnBridge
