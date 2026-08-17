import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStubGateway } from './lib/stub-gateway.js'
import { setGateway } from './lib/gateway.js'
import { bootTeam, useTeam } from './stores/team.js'
import { resetLocalUsers } from './lib/users.js'
import { resetMemory } from './lib/memory.js'
import { nodeIdForBot, probeNodeComputer } from './omb/lib/node-computer.js'
import { Speaker } from './omb/lib/tts/index.js'
import { attachmentsFromDroppedFiles } from './omb/lib/composer-attachments.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('node computer / voice / memory surfaces', () => {
  afterEach(() => {
    resetLocalUsers()
    resetMemory()
    useTeam.setState({
      userId: 'local-user',
      userHandle: 'local',
      userName: 'Local',
      deviceToken: null,
      live: false,
      personas: [],
      selectedId: null,
      messages: [],
      memoryNotes: 0,
      lastError: null,
    })
    vi.restoreAllMocks()
  })

  it('probeNodeComputer hits the team gateway node, not Box', async () => {
    const g = createStubGateway({ baseUrl: 'http://den.test:5174' })
    setGateway(g)
    await bootTeam()
    const persona = g.listPersonas(useTeam.getState().userId)[0]
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      expect(url).not.toMatch(/box\.ascii|composio|elevenlabs/i)
      if (url.endsWith('/healthz')) return new Response('ok', { status: 200 })
      if (url.includes('/api/terminal/config')) {
        return new Response(JSON.stringify({ enabled: true, active: 0, maxPtys: 4, commands: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('no', { status: 404 })
    })
    const status = await probeNodeComputer(persona.id)
    expect(nodeIdForBot(persona.id)).toBe(persona.nodeId)
    expect(status.baseUrl).toBe('http://den.test:5174')
    expect(status.reachable).toBe(true)
    expect(status.term?.enabled).toBe(true)
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('Speaker never calls ElevenLabs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
    const speaker = new Speaker()
    await speaker.speak('hello', { messageId: 'm1' })
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toMatch(/elevenlabs/i)
    }
  })

  it('attaches pathless browser files by name or inlined text', async () => {
    const text = await attachmentsFromDroppedFiles(
      [{ name: 'notes.txt', size: 5, type: 'text/plain', text: async () => 'hello' }],
      () => '',
    )
    expect(text.attachments[0]?.kind).toBe('paste')
    const pic = await attachmentsFromDroppedFiles(
      [{ name: 'pic.png', size: 12, type: 'image/png', text: async () => 'x' }],
      () => '',
    )
    expect(pic.attachments[0]).toMatchObject({ kind: 'file', name: 'pic.png', path: 'pic.png' })
  })

  it('composer shows attach and dictate, call is a real phone button', () => {
    const composer = readFileSync(join(root, 'src/omb/components/Composer.tsx'), 'utf8')
    const call = readFileSync(join(root, 'src/omb/components/CallView.tsx'), 'utf8')
    const sidebar = readFileSync(join(root, 'src/omb/components/Sidebar.tsx'), 'utf8')
    expect(composer).toMatch(/Paperclip/)
    expect(composer).toMatch(/Attach files/)
    expect(composer).toMatch(/Start dictation/)
    expect(composer).not.toMatch(/capabilities\.dictation\.available && \(/)
    expect(call).toMatch(/export function CallButton/)
    expect(call).toMatch(/<Phone /)
    expect(call).not.toMatch(/export function CallButton\([^)]*\): null/)
    expect(sidebar).toMatch(/size=\{40\}/)
    expect(sidebar).not.toMatch(/size=\{56\}/)
  })

  it('PluginsPanel is memory/wiki, ComputerPanel is node-bound', () => {
    const plugins = readFileSync(join(root, 'src/omb/components/PluginsPanel.tsx'), 'utf8')
    const computer = readFileSync(join(root, 'src/omb/components/ComputerPanel.tsx'), 'utf8')
    const probe = readFileSync(join(root, 'src/omb/lib/node-computer.ts'), 'utf8')
    const avatar = readFileSync(join(root, 'src/omb/components/Avatar.tsx'), 'utf8')
    expect(plugins).toMatch(/Household notes \+ wiki/)
    expect(plugins).not.toMatch(/\/api\/connectors/)
    expect(computer).toMatch(/nodeIdForBot/)
    expect(probe).toMatch(/\/api\/terminal/)
    expect(avatar).toMatch(/rivet-mascot/)
    expect(avatar).not.toMatch(/import .*CursorAvatar/)
  })
})
