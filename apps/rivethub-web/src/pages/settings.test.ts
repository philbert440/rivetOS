/**
 * Wiring pins for the tabbed Settings page: the Node tab's unsaved URL
 * drafts are owned above the tab switch, so changing tabs (which unmounts
 * the sections) does not drop what was typed.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settings = readFileSync(new URL('./settings.tsx', import.meta.url), 'utf8')
const page = settings.slice(
  settings.indexOf('export function SettingsPage('),
  settings.indexOf('function GatewaySection('),
)
const sectionsBody = settings.slice(settings.indexOf('function GatewaySection('))

describe('settings page draft ownership', () => {
  it('holds the gateway and datahub drafts in SettingsPage', () => {
    expect(page).toContain('const [draftUrl, setDraftUrl] = useState(baseUrl)')
    expect(page).toContain('const [draftWiki, setDraftWiki] = useState(')
    expect(page).toContain('<GatewaySection draftUrl={draftUrl} setDraftUrl={setDraftUrl} />')
    expect(page).toContain('<DatahubSection draftWiki={draftWiki} setDraftWiki={setDraftWiki} />')
  })

  it('keeps no draft state inside the tab sections', () => {
    expect(sectionsBody).not.toContain('useState(baseUrl)')
    expect(sectionsBody).not.toContain('useState(wikiBaseUrl)')
  })
})
