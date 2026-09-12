import { test as base, expect, chromium } from '@playwright/test'

export const gateway = process.env.E2E_GATEWAY ?? 'https://localhost:5174'
export const test = base.extend({
  app: [
    async ({}, use) => {
      if (!process.env.E2E_CDP)
        throw new Error('Set E2E_CDP to the isolated desktop debugging endpoint; see README.md')
      const browser = await chromium.connectOverCDP(process.env.E2E_CDP)
      try {
        const context = browser.contexts()[0]
        const page = context.pages().find((p) => p.url().startsWith('app://bundle'))
        if (!page) throw new Error('RivetHub app://bundle window not found')
        page.setDefaultTimeout(12_000)
        page.setDefaultNavigationTimeout(20_000)
        const settings = await page.evaluate(() => window.rivetShell.settingsGetAll())
        if (settings['rivethub.e2eProfile'] !== true)
          throw new Error(
            'Refusing to test a personal profile. Launch with the dedicated E2E profile.',
          )
        await use({ browser, context, page })
      } finally {
        await browser.close()
      }
    },
    { scope: 'worker' },
  ],
  hub: async ({ app }, use, info) => {
    const { page, context } = app
    const faults = []
    const responses = []
    const createdPtys = new Set()
    const requestedSessions = new Set()
    const pendingResponses = []
    const existingPtys = new Set(
      (await api(page, '/api/terminal/list')).body.ptys?.map((p) => p.id) ?? [],
    )
    const pageError = (error) => faults.push(error.message)
    const request = (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/terminal') {
        const session = req.postDataJSON()?.session
        if (session) requestedSessions.add(session)
      }
    }
    const response = (res) => {
      if (res.status() >= 400) responses.push({ status: res.status(), url: res.url() })
      if (
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === '/api/terminal' &&
        res.status() === 201
      ) {
        pendingResponses.push(
          res
            .json()
            .then((body) => {
              if (body.id && !existingPtys.has(body.id)) createdPtys.add(body.id)
            })
            .catch(() => {
              /* A closing window can abort the response; match its session below. */
            }),
        )
      }
    }
    const failed = (req) => responses.push({ error: req.failure()?.errorText, url: req.url() })
    page.on('pageerror', pageError)
    context.on('request', request)
    context.on('response', response)
    page.on('requestfailed', failed)
    const snapshot = await page.evaluate(() => window.rivetShell.settingsGetAll())
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    try {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto('app://bundle/settings')
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      await use(page)
      expect(faults, 'Uncaught renderer errors').toEqual([])
    } finally {
      await info.attach('requests.json', {
        body: JSON.stringify(responses, null, 2),
        contentType: 'application/json',
      })
      await info.attach('renderer-errors.json', {
        body: JSON.stringify(faults),
        contentType: 'application/json',
      })
      await info.attach('screen.png', { body: await page.screenshot(), contentType: 'image/png' })
      await context.tracing.stop({ path: info.outputPath('trace.zip') })
      // Leave terminal routes before cleanup so a reload cannot respawn a PTY.
      await page.goto('app://bundle/settings')
      page.off('pageerror', pageError)
      page.off('requestfailed', failed)
      await Promise.all(pendingResponses)
      // Include secondary windows, even when closing one aborted its POST response.
      const remaining = await api(page, '/api/terminal/list')
      for (const pty of remaining.body.ptys ?? [])
        if (!existingPtys.has(pty.id) && requestedSessions.has(pty.denSession))
          createdPtys.add(pty.id)
      context.off('request', request)
      context.off('response', response)
      for (const id of createdPtys) {
        const result = await api(page, `/api/terminal?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        if (![200, 404].includes(result.status))
          throw new Error(`Failed to clean up test PTY ${id}: HTTP ${result.status}`)
      }
      await page.evaluate(async (saved) => {
        const current = await window.rivetShell.settingsGetAll()
        for (const key of Object.keys(current))
          if (!(key in saved)) await window.rivetShell.settingsRemove(key)
        await window.rivetShell.settingsSetAll(saved)
        localStorage.clear()
      }, snapshot)
      await page.reload()
    }
  },
})
export { expect }

export async function navigate(page, name) {
  await page.getByRole('link', { name, exact: true }).click()
}

export async function api(page, path, options = {}) {
  return page.evaluate(
    async ({ gateway, path, options }) => {
      const port = await window.rivetShell.mtlsProxyPort(gateway)
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...options,
        signal: AbortSignal.timeout(15000),
      })
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status: response.status, body }
    },
    { gateway, path, options },
  )
}

export async function enable(page, name) {
  const toggle = page.getByRole('switch', { name, exact: true })
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
}
