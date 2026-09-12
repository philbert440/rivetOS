import { test, expect, gateway, navigate, api } from '../fixtures.mjs'

test('local memory is discoverable without a datahub override', async ({ hub }) => {
  const result = await api(hub, '/api/memory/stats')
  expect(result.status, 'Local memory API prerequisite').toBe(200)
  await hub.getByPlaceholder('https://datahub-host:5174').fill('')
  await hub.getByRole('button', { name: 'Save datahub URL' }).click()
  expect(
    await hub.evaluate(() => localStorage.getItem('rivethub.wikiUrl') ?? ''),
    'Datahub override must be empty so local fallback can be selected',
  ).toBe('')
  const localPort = await hub.evaluate(
    async (gw) => String(await window.rivetShell.mtlsProxyPort(gw)),
    gateway,
  )
  const fromLocal = hub.waitForResponse((r) => {
    let parsed
    try {
      parsed = new URL(r.url())
    } catch {
      return false
    }
    if (parsed.hostname !== '127.0.0.1' || parsed.port !== localPort) return false
    return parsed.pathname.startsWith('/api/memory') || parsed.pathname.startsWith('/api/wiki')
  })
  await navigate(hub, 'Memory')
  await expect(hub.getByPlaceholder('Search messages and summaries…')).toBeVisible()
  const memory = await fromLocal
  expect(memory.status(), await memory.text()).toBe(200)
  expect(new URL(memory.url()).port, 'Memory requests must use the local node').toBe(localPort)
})

async function localMemory(hub, tab) {
  await hub
    .getByPlaceholder('https://datahub-host:5174')
    .fill(process.env.E2E_MEMORY_GATEWAY ?? gateway)
  await hub.getByRole('button', { name: 'Save datahub URL' }).click()
  await navigate(hub, 'Memory')
  await hub.locator('main nav').getByRole('button', { name: tab, exact: true }).click()
}

test('memory search submits a query and renders a result or an honest empty state', async ({
  hub,
}) => {
  await localMemory(hub, 'Search')
  const input = hub.getByPlaceholder('Search messages and summaries…')
  await input.fill('RivetHub')
  const response = hub.waitForResponse((r) => r.url().includes('/api/memory/search?'))
  await input.press('Enter')
  expect((await response).status()).toBe(200)
  await expect(
    hub
      .locator('.hits .hit')
      .or(hub.getByText(/No matches for/))
      .first(),
  ).toBeVisible()
  await expect(hub.locator('main .banner.bad')).toHaveCount(0)
})

test('memory browse filters by an agent and refreshes', async ({ hub }) => {
  await localMemory(hub, 'Browse')
  await hub.getByPlaceholder('agent (optional)').fill('rivethub-e2e-nonexistent-agent')
  await expect(hub.getByText('No messages match these filters', { exact: true })).toBeVisible()
  const response = hub.waitForResponse((r) => r.url().includes('/api/memory/browse?'))
  await hub.getByRole('button', { name: 'Refresh', exact: true }).click()
  expect((await response).status()).toBe(200)
})

test('memory stats renders health and actual counts', async ({ hub }) => {
  await localMemory(hub, 'Stats')
  await expect(hub.getByRole('heading', { name: 'Pipeline diagnostics' })).toBeVisible()
  await expect(hub.locator('.stat-grid').first()).not.toContainText('—')
  await expect(hub.locator('main .banner.bad')).toHaveCount(0)
})

test('wiki home loads and search works', async ({ hub }) => {
  await localMemory(hub, 'Wiki')
  const search = hub.getByPlaceholder('Search memory…').filter({ visible: true })
  await expect(search).toBeVisible()
  const query = 'RivetHub'
  const pending = hub.waitForResponse((r) => {
    let parsed
    try {
      parsed = new URL(r.url())
    } catch {
      return false
    }
    const path = parsed.pathname.replace(/\/$/, '')
    return path === '/api/wiki' && parsed.searchParams.get('q') === query
  })
  await search.fill(query)
  const response = await pending
  expect(response.status(), await response.text()).toBe(200)
  await expect(hub.getByRole('heading', { name: /Results for/ })).toBeVisible()
  await expect(
    hub
      .getByText('Nothing matched — try Gaps, or a broader term.')
      .or(hub.locator('main ul li button'))
      .first(),
  ).toBeVisible()
})
