import { app, BrowserWindow, Menu, nativeImage, Notification, Tray, net } from 'electron'
import { join } from 'node:path'
import type { TaskLiveEvent } from '../../shared/models'
import { nativeCopy, nativeLocale } from '../platform/native-locale'
import {
  shouldNotifyTask,
  shouldResumeAfterNetwork,
  supportsLaunchAtLogin,
  taskNotificationSignature,
} from './lifecycle-policy'

export interface LifecycleHost {
  showWindow(): void
  showTasks(): void
  resumeWork(): void
  quit(): void
}

export interface LifecycleTaskSource {
  onEvent(listener: (event: TaskLiveEvent) => void): () => void
}

export class AlwaysOnLifecycle {
  private tray: Tray | undefined
  private disposers: Array<() => void> = []
  private readonly notified = new Map<string, string>()
  private networkTimer: NodeJS.Timeout | undefined
  private online = net.isOnline()

  constructor(
    private readonly host: LifecycleHost,
    private readonly tasks: LifecycleTaskSource,
  ) {}

  install(): void {
    const copy = nativeCopy(nativeLocale())
    const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'trayTemplate@2x.png'
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', iconName))
    if (process.platform === 'darwin') icon.setTemplateImage(true)
    this.tray = new Tray(icon)
    this.tray.setToolTip(copy.openBarn)
    this.tray.on('click', () => this.host.showWindow())
    this.tray.on('double-click', () => this.host.showWindow())
    this.renderMenu()

    this.disposers.push(this.tasks.onEvent((event) => this.notifyTask(event)))
    if (supportsLaunchAtLogin(process.platform)) {
      this.networkTimer = setInterval(() => {
        const current = net.isOnline()
        if (shouldResumeAfterNetwork(this.online, current)) this.host.resumeWork()
        this.online = current
      }, 15_000)
      this.networkTimer.unref()
    }
  }

  dispose(): void {
    if (this.networkTimer !== undefined) clearInterval(this.networkTimer)
    this.networkTimer = undefined
    for (const dispose of this.disposers.splice(0)) dispose()
    this.tray?.destroy()
    this.tray = undefined
  }

  setLoginItem(enabled: boolean): void {
    if (!supportsLaunchAtLogin(process.platform)) return
    app.setLoginItemSettings({ openAtLogin: enabled })
    this.renderMenu()
  }

  private renderMenu(): void {
    if (this.tray === undefined) return
    const copy = nativeCopy(nativeLocale())
    const loginSupported = supportsLaunchAtLogin(process.platform)
    const openAtLogin = loginSupported ? app.getLoginItemSettings().openAtLogin : false
    const menu = Menu.buildFromTemplate([
      { label: copy.openBarn, click: () => this.host.showWindow() },
      { label: copy.needsYou, click: () => this.host.showTasks() },
      { type: 'separator' },
      ...(loginSupported ? [{
        label: copy.launchAtLogin,
        type: 'checkbox' as const,
        checked: openAtLogin,
        click: (item: { checked: boolean }) => this.setLoginItem(item.checked),
      }] : []),
      { type: 'separator' },
      { label: copy.quitBarn, click: () => this.host.quit() },
    ])
    this.tray.setContextMenu(menu)
  }

  private notifyTask(event: TaskLiveEvent): void {
    const task = event.task
    const focused = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused())
    const previous = this.notified.get(task.id)
    if (!shouldNotifyTask(task, focused, previous)) return
    this.notified.set(task.id, taskNotificationSignature(task))
    if (!Notification.isSupported()) return
    const notification = new Notification({
      title: nativeCopy(nativeLocale()).needsYou,
      body: task.title,
    })
    notification.on('click', () => this.host.showTasks())
    notification.show()
  }
}
