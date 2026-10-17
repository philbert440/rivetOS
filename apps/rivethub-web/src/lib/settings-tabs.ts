/**
 * Settings tabs, in rail order. Each has its own route (`/settings/<id>`);
 * bare `/settings` and an unknown id open General.
 */

export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'node', label: 'Node & Mesh' },
  { id: 'devices', label: 'Devices' },
  { id: 'advanced', label: 'Advanced' },
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general'

export function settingsTab(param: string | undefined): SettingsTabId {
  return SETTINGS_TABS.find((t) => t.id === param)?.id ?? DEFAULT_SETTINGS_TAB
}
