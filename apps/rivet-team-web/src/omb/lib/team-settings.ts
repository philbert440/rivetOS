/** Household app settings persisted locally. */
const KEY = 'rivet-team.app-settings'

export interface TeamAppSettings {
  wikiUrl: string
  denUrl: string
  /** One household Ubuntu desktop all personas share (noVNC / Selkies / xrdp web). */
  desktopUrl: string
}

export function loadTeamAppSettings(): TeamAppSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { wikiUrl: '', denUrl: '', desktopUrl: '' }
    const parsed = JSON.parse(raw) as Partial<TeamAppSettings>
    return {
      wikiUrl: parsed.wikiUrl ?? '',
      denUrl: parsed.denUrl ?? '',
      desktopUrl: parsed.desktopUrl ?? '',
    }
  } catch {
    return { wikiUrl: '', denUrl: '', desktopUrl: '' }
  }
}

export function saveTeamAppSettings(next: TeamAppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(next))
}
