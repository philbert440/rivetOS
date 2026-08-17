/** Household app settings persisted locally. */
const KEY = 'rivet-team.app-settings'

export interface TeamAppSettings {
  wikiUrl: string
  denUrl: string
}

export function loadTeamAppSettings(): TeamAppSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { wikiUrl: '', denUrl: '' }
    const parsed = JSON.parse(raw) as Partial<TeamAppSettings>
    return { wikiUrl: parsed.wikiUrl ?? '', denUrl: parsed.denUrl ?? '' }
  } catch {
    return { wikiUrl: '', denUrl: '' }
  }
}

export function saveTeamAppSettings(next: TeamAppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(next))
}
