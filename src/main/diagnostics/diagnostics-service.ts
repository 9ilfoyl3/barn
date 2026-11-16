import { app } from 'electron'
import type { DiagnosticsSnapshot, RuntimeCapabilities } from '../../shared/models'
import type { SessionStore } from '../session/session-store'
import type { LocalSourceService } from '../sources/local-source-service'
import type { BrowserService } from '../browser/browser-service'

export class DiagnosticsService {
  constructor(
    private readonly store: SessionStore,
    private readonly sources: Pick<LocalSourceService, 'getAutomationSettings'>,
    private readonly stateDirectory: string,
    private readonly capabilities: () => RuntimeCapabilities,
    private readonly browser: () => Pick<BrowserService, 'getState'> | undefined,
  ) {}

  get(): DiagnosticsSnapshot {
    const capabilities = this.capabilities()
    const shell = capabilities.shell
    const browserState = this.browser()?.getState()
    const snapshot: DiagnosticsSnapshot = {
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.versions.node,
      schemaVersion: this.store.schemaVersion(),
      stateDirectory: this.stateDirectory,
      retentionDays: this.store.getRetentionDays(),
      counts: { ...this.store.diagnosticsCounts(), memoryEntries: this.store.memories.activeCount() },
      automationMode: this.sources.getAutomationSettings().mode,
      browser: {
        open: browserState?.open ?? false,
        tabs: browserState?.tabs.length ?? 0,
        downloads: browserState?.downloads.length ?? 0,
      },
      agentComputer: { providers: capabilities.agentComputer.providers },
      shell,
    }
    const lastMaintenanceAt = this.store.lastMaintenanceAt()
    if (lastMaintenanceAt !== undefined) snapshot.lastMaintenanceAt = lastMaintenanceAt
    return snapshot
  }

  setRetentionDays(days: number): number {
    return this.store.setRetentionDays(days)
  }

  runMaintenance(): ReturnType<SessionStore['runRetention']> {
    return this.store.runRetention()
  }
}
