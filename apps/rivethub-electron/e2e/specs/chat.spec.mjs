import { randomUUID } from 'node:crypto'
import { test, expect, api } from '../fixtures.mjs'

async function draft(hub) {
  await hub.goto('app://bundle/')
  await hub.getByRole('button', { name: '+ new', exact: true }).click()
  const composer = hub.getByPlaceholder('Message Rivet… (Enter to send, Shift+Enter for newline)')
  await expect(composer).toBeVisible()
  return composer
}

test('conversation draft: rename, filter and discard', async ({ hub }) => {
  await draft(hub)
  const pane = hub.locator('#conversations-pane')
  const name = `E2E ${randomUUID()}`
  await pane.getByRole('button', { name: 'new conversation', exact: true }).first().hover()
  await pane.getByRole('button', { name: 'rename conversation', exact: true }).first().click()
  await pane.locator('form input').fill(name)
  await pane.locator('form input').press('Enter')
  await expect(pane.getByRole('button', { name, exact: true })).toBeVisible()
  const filter = pane.getByRole('textbox', { name: 'filter conversations', exact: true })
  for (let i = 0; i < 6 && !(await filter.isVisible()); i++)
    await pane.getByRole('button', { name: '+ new', exact: true }).click()
  await filter.fill(name)
  await expect(pane.getByRole('button', { name, exact: true })).toBeVisible()
  await pane.getByRole('button', { name, exact: true }).hover()
  await pane.getByRole('button', { name: 'discard draft', exact: true }).click()
  await expect(pane.getByRole('button', { name, exact: true })).toHaveCount(0)
})

test('composer: empty send disabled and Shift+Enter inserts a newline', async ({ hub }) => {
  const composer = await draft(hub)
  await expect(hub.getByRole('button', { name: 'send', exact: true })).toBeDisabled()
  await composer.fill('line one')
  await composer.press('Shift+Enter')
  await composer.pressSequentially('line two')
  await expect(composer).toHaveValue('line one\nline two')
  await expect(hub.getByRole('button', { name: 'send', exact: true })).toBeEnabled()
})

test('composer auto-speak toggle can be enabled and disabled', async ({ hub }) => {
  await draft(hub)
  await hub.getByRole('button', { name: 'enable auto-speak', exact: true }).click()
  await expect(hub.getByRole('button', { name: 'disable auto-speak', exact: true })).toBeVisible()
  await hub.getByRole('button', { name: 'disable auto-speak', exact: true }).click()
  await expect(hub.getByRole('button', { name: 'enable auto-speak', exact: true })).toBeVisible()
})

test('agent creation dialog validates the name and cancels', async ({ hub }) => {
  await hub.getByRole('button', { name: 'add agent', exact: true }).click()
  await expect(hub.getByRole('dialog', { name: 'New agent', exact: true })).toBeVisible()
  await expect(hub.getByPlaceholder('Agent name')).toBeVisible()
  await hub.getByRole('button', { name: 'cancel', exact: true }).click()
  await expect(hub.getByRole('dialog', { name: 'New agent', exact: true })).toHaveCount(0)
})

test('all advertised harnesses have working session-list endpoints', async ({ hub }) => {
  const registry = await api(hub, '/api/harnesses')
  expect(registry.status).toBe(200)
  expect(registry.body.harnesses.length).toBeGreaterThan(0)
  for (const harness of registry.body.harnesses) {
    if (!harness.capabilities.listSessions) continue
    await test.step(harness.harnessId, async () => {
      const sessions = await api(
        hub,
        `/api/harnesses/${encodeURIComponent(harness.harnessId)}/sessions`,
      )
      expect(sessions.status, JSON.stringify(sessions.body)).toBe(200)
      expect(Array.isArray(sessions.body.sessions)).toBe(true)
    })
  }
})

function isTermSpawnUrl(url) {
  try {
    const path = new URL(url).pathname
    return path === '/api/terminal' || path === '/api/term'
  } catch {
    return false
  }
}

test('terminal opens, accepts input and returns to chat', async ({ hub }) => {
  await draft(hub)
  const marker = `RIVETHUB_E2E_${randomUUID().slice(0, 8)}`
  // Conversation Terminal otherwise spawns the node default (usually a harness
  // TUI). Force the den `shell` roster entry so `echo` is a real observable.
  const forceShell = async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const body = route.request().postDataJSON() ?? {}
    await route.continue({ postData: JSON.stringify({ ...body, command: 'shell' }) })
  }
  await hub.route(isTermSpawnUrl, forceShell)
  const ptyChunks = []
  const onSocket = (ws) => {
    ws.on('framereceived', ({ payload }) => {
      ptyChunks.push(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'))
    })
  }
  hub.on('websocket', onSocket)
  const response = hub.waitForResponse(
    (r) => r.request().method() === 'POST' && isTermSpawnUrl(r.url()),
  )
  let ptyId
  try {
    await hub.getByRole('button', { name: 'Terminal', exact: true }).click()
    const res = await response
    expect(res.status(), await res.text()).toBeLessThan(300)
    const payload = await res.json()
    ptyId = payload.ptyId ?? payload.id ?? payload.session?.ptyId
    expect(ptyId, 'PTY id is required for test cleanup').toBeTruthy()
    expect(payload.command, 'spawn must use the shell roster command').toBe('shell')
    await expect(hub.locator('.xterm')).toBeVisible()
    // Input is dropped while the socket is not OPEN; wait until attached.
    await expect(hub.getByText('connecting', { exact: true })).toHaveCount(0)
    const terminal = hub.locator('.xterm-helper-textarea')
    await terminal.focus()
    await terminal.pressSequentially(`echo ${marker}`)
    await terminal.press('Enter')
    await expect
      .poll(
        async () => {
          const rendered = await hub.evaluate(() => {
            const host = document.querySelector('[data-term-host]')
            if (!host) return ''
            const rows = host.querySelector('.xterm-rows')
            const text = rows?.innerText || rows?.textContent || host.innerText || ''
            return text.replace(/\u00a0/g, ' ')
          })
          if (rendered.includes(marker)) return rendered
          return ptyChunks.join('')
        },
        { timeout: 20_000 },
      )
      .toContain(marker)
    await hub.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(hub.getByRole('button', { name: 'send', exact: true })).toBeVisible()
  } finally {
    hub.off('websocket', onSocket)
    await hub.unroute(isTermSpawnUrl, forceShell)
    if (ptyId) {
      const result = await api(hub, `/api/terminal?id=${encodeURIComponent(ptyId)}`, {
        method: 'DELETE',
      })
      expect([200, 404], 'Close only the PTY created by this test').toContain(result.status)
    }
  }
})

test('live chat sends a turn and receives a persisted assistant reply', async ({ hub }) => {
  test.setTimeout(120_000)
  const composer = await draft(hub)
  const marker = `RIVETHUB_E2E_${randomUUID().slice(0, 8)}`
  // A bounded response-only request; no shell commands, files or external side effects.
  await composer.fill(`Automated UI test. Do not use tools. Reply with exactly ${marker}`)
  const accepted = hub.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/messages$|\/turns$|\/terminal\/inject$/.test(new URL(r.url()).pathname),
    { timeout: 25_000 },
  )
  await hub.getByRole('button', { name: 'send', exact: true }).click()
  const response = await accepted
  expect(response.status(), await response.text()).toBeLessThan(300)
  await expect(hub.locator('.group\\/msg.items-start').filter({ hasText: marker })).toBeVisible({
    timeout: 90_000,
  })
  await hub.reload()
  await expect(hub.locator('.group\\/msg.items-start').filter({ hasText: marker })).toBeVisible()
})
