import { test, expect } from '../fixtures.mjs'

test('native shell bridge is available and renderer remains isolated', async ({ hub }) => {
  expect(
    await hub.evaluate(() => ({
      kind: window.rivetShell.kind,
      require: typeof window.require,
      process: typeof window.process,
    })),
  ).toEqual({ kind: 'electron', require: 'undefined', process: 'undefined' })
})

test('native clipboard round-trips unicode', async ({ hub }) => {
  const before = await hub.evaluate(() => window.rivetShell.clipboardReadText())
  try {
    const value = 'RivetHub E2E — café 日本語 🧪'
    await hub.evaluate((text) => window.rivetShell.clipboardWriteText(text), value)
    expect(await hub.evaluate(() => window.rivetShell.clipboardReadText())).toBe(value)
  } finally {
    await hub.evaluate((text) => window.rivetShell.clipboardWriteText(text), before)
  }
})

test('new window opens the bundled app and closes independently', async ({ hub, app }) => {
  const newPage = app.context.waitForEvent('page')
  await hub.evaluate(() => window.rivetShell.newWindow())
  const window = await newPage
  try {
    await expect(window).toHaveURL(/^app:\/\/bundle\//)
    await expect(window.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
    expect(await window.evaluate(() => window.rivetShell.kind)).toBe('electron')
  } finally {
    await window.close()
  }
  await expect(hub.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
})

test('zoom in, out and reset change rendered scale', async ({ hub }) => {
  const before = await hub.evaluate(() => window.devicePixelRatio)
  await hub.evaluate(() => window.rivetShell.zoomAdjust(1))
  await expect.poll(() => hub.evaluate(() => window.devicePixelRatio)).toBeGreaterThan(before)
  await hub.evaluate(() => window.rivetShell.zoomAdjust(0))
  await expect.poll(() => hub.evaluate(() => window.devicePixelRatio)).toBe(before)
})

test('collapse and expand sidebar keeps navigation usable', async ({ hub }) => {
  await hub.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect(hub.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
  await hub.getByRole('link', { name: 'Memory', exact: true }).click()
  await expect(hub).toHaveURL(/\/memory/)
  await hub.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await expect(hub.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible()
})

test('narrow window opens navigation and closes it with Escape', async ({ hub }) => {
  await hub.setViewportSize({ width: 480, height: 850 })
  await hub.getByRole('button', { name: 'Open menu', exact: true }).click()
  await expect(hub.getByRole('link', { name: 'Memory', exact: true })).toBeVisible()
  await hub.keyboard.press('Escape')
  await expect(hub.getByRole('button', { name: 'Open menu', exact: true })).toBeFocused()
})
