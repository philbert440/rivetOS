import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

const browser = await chromium.connectOverCDP(process.env.E2E_CDP ?? 'http://127.0.0.1:19222')
try {
  const page = browser.contexts()[0].pages().find((p) => p.url().startsWith('app://bundle'))
  if (!page) throw new Error('No RivetHub window found')
  const settings = await page.evaluate(() => window.rivetShell.settingsGetAll())
  if (settings['rivethub.e2eProfile'] !== true)
    throw new Error('Refusing to inspect an unmarked personal profile')
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`)
  })
  if (process.argv.includes('--connect')) {
    await page.goto('app://bundle/settings')
    await page
      .getByPlaceholder('https://node-host:5174')
      .first()
      .fill(process.env.E2E_GATEWAY ?? 'https://localhost:5174')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    for (const name of ['Files', 'Tasks', 'Workflows']) {
      const toggle = page.getByRole('switch', { name, exact: true })
      if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
    }
  }
  await mkdir('artifacts/inspection', { recursive: true })
  if (process.argv.includes('--draft')) {
    await page.goto('app://bundle/')
    await page.getByRole('button', { name: '+ new', exact: true }).click()
    await page.waitForTimeout(1500)
    console.log(await page.locator('body').innerText())
    console.log(
      await page.locator('input,textarea,button').evaluateAll((els) =>
        els.map((e) => ({
          text: e.innerText,
          placeholder: e.getAttribute('placeholder'),
          label: e.getAttribute('aria-label'),
          title: e.getAttribute('title'),
        })),
      ),
    )
  }
  for (const route of process.argv.slice(2).filter((x) => x.startsWith('/'))) {
    await page.goto(`app://bundle${route}`)
    await page.waitForTimeout(4000)
    const data = {
      route,
      url: page.url(),
      text: await page.locator('body').innerText(),
      controls: await page.locator('input,select,textarea,button').evaluateAll((els) =>
        els.map((e) => ({
          tag: e.tagName,
          text: e.innerText,
          placeholder: e.getAttribute('placeholder'),
          label: e.getAttribute('aria-label'),
          role: e.getAttribute('role'),
          type: e.getAttribute('type'),
        })),
      ),
      errors: errors.splice(0),
    }
    const name = route.replace(/[^a-z0-9]/gi, '_') || 'home'
    await writeFile(`artifacts/inspection/${name}.json`, JSON.stringify(data, null, 2))
    await page.screenshot({ path: `artifacts/inspection/${name}.png` })
    console.log(JSON.stringify(data))
  }
} finally {
  await browser.close()
}
