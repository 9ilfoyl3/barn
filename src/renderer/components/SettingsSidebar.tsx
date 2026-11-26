import type { ReactNode } from 'react'
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarHeader,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
  AnimatedSidebarProvider,
} from './beui/components/motion/animated-sidebar'

export interface SettingsSidebarItem<Key extends string> {
  key: Key
  label: string
  icon: ReactNode
}

export interface SettingsSidebarGroup<Key extends string> {
  key: string
  label: string
  items: Array<SettingsSidebarItem<Key>>
}

export interface SettingsSidebarProps<Key extends string> {
  activeKey: Key
  ariaLabel: string
  children: ReactNode
  groups: Array<SettingsSidebarGroup<Key>>
  onSelect(key: Key): void
  search: ReactNode
  empty?: ReactNode
}

/**
 * Settings navigation composed from beUI's animated sidebar parts. The
 * settings app keeps the sidebar permanently expanded, while the shared
 * layout pill and menu-item motion still come from the upstream component.
 */
export function SettingsSidebar<Key extends string>({
  activeKey,
  ariaLabel,
  children,
  empty,
  groups,
  onSelect,
  search,
}: SettingsSidebarProps<Key>) {
  return (
    <AnimatedSidebarProvider
      className="settings-page"
      defaultOpen
      style={{
        '--sidebar-width': '240px',
        '--sidebar-width-icon': '64px',
        '--sidebar-width-mobile': '240px',
      }}
    >
      <AnimatedSidebar
        ariaLabel={ariaLabel}
        className="settings-page-nav"
        collapsible="none"
        panelClassName="settings-page-nav-panel"
        variant="sidebar"
      >
        <AnimatedSidebarHeader className="settings-page-nav-header">
          {search}
        </AnimatedSidebarHeader>
        <AnimatedSidebarContent className="settings-page-nav-groups">
          {groups.map((group) => (
            <AnimatedSidebarGroup className="settings-page-nav-group" key={group.key}>
              <AnimatedSidebarGroupLabel className="settings-page-nav-label">
                {group.label}
              </AnimatedSidebarGroupLabel>
              <AnimatedSidebarGroupContent>
                <AnimatedSidebarMenu>
                  {group.items.map((item) => (
                    <AnimatedSidebarMenuItem key={item.key}>
                      <AnimatedSidebarMenuButton
                        icon={item.icon}
                        isActive={item.key === activeKey}
                        onSelect={() => onSelect(item.key)}
                      >
                        {item.label}
                      </AnimatedSidebarMenuButton>
                    </AnimatedSidebarMenuItem>
                  ))}
                </AnimatedSidebarMenu>
              </AnimatedSidebarGroupContent>
            </AnimatedSidebarGroup>
          ))}
          {groups.every((group) => group.items.length === 0) ? empty : null}
        </AnimatedSidebarContent>
      </AnimatedSidebar>
      {children}
    </AnimatedSidebarProvider>
  )
}
