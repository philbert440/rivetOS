import { test, expect, gateway, enable } from '../fixtures.mjs'

test('build matches the requested main commit and desktop version', async ({ hub }) => {
  expect(
    process.env.E2E_EXPECT_SHA,
    'Set E2E_EXPECT_SHA to the main commit being tested',
  ).toBeTruthy()
  await expect(
    hub.getByText(new RegExp(`dist ${process.env.E2E_EXPECT_SHA?.slice(0, 8)}`)),
  ).toBeVisible()
  if (process.env.E2E_EXPECT_VERSION)
    expect(await hub.evaluate(() => window.rivetShell.appVersion())).toBe(
      process.env.E2E_EXPECT_VERSION,
    )
})

test('connection probe succeeds through native mTLS', async ({ hub }) => {
  await hub.getByPlaceholder('https://node-host:5174').first().fill(gateway)
  await hub.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(hub.getByText(/✓ node “.+” — \d+ agents?/)).toBeVisible()
})

for (const url of [
  'bad-url',
  'https://localhost:5174/api',
  'https://user:password@localhost:5174',
]) {
  test(`gateway rejects invalid origin: ${url}`, async ({ hub }) => {
    await hub.getByPlaceholder('https://node-host:5174').first().fill(url)
    await hub.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(hub.getByText(/✗ invalid gateway URL/)).toBeVisible()
    expect(await hub.evaluate(() => localStorage.getItem('rivethub.baseUrl'))).toBe(gateway)
  })
}

for (const theme of ['Light', 'Dark', 'System', 'Omarchy']) {
  test(`appearance: ${theme} persists across reload`, async ({ hub }) => {
    const button = hub
      .getByRole('group', { name: 'Theme', exact: true })
      .getByRole('button', { name: theme, exact: true })
    await expect(button).toBeEnabled()
    await button.click()
    await hub.reload()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(
      await hub.evaluate(() => window.rivetShell.settingsGetAll()).then((s) => s['rivethub.theme']),
    ).toBe(theme.toLowerCase())
  })
}

for (const feature of ['Files', 'Tasks', 'Workflows']) {
  test(`experimental ${feature}: navigation preference persists`, async ({ hub }) => {
    const toggle = hub.getByRole('switch', { name: feature, exact: true })
    await enable(hub, feature)
    await expect(hub.getByRole('link', { name: feature, exact: true })).toBeVisible()
    await toggle.click()
    await expect(hub.getByRole('link', { name: feature, exact: true })).toHaveCount(0)
    await hub.reload()
    await expect(hub.getByRole('link', { name: feature, exact: true })).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
}

test('datahub URL rejects paths and credentials', async ({ hub }) => {
  await hub
    .getByPlaceholder('https://datahub-host:5174')
    .fill('https://user:password@localhost:5174')
  await hub.getByRole('button', { name: 'Save datahub URL' }).click()
  await expect(hub.getByText(/✗ invalid origin/)).toBeVisible()
})

test('terminal font size is clamped and persisted', async ({ hub }) => {
  const size = hub.getByLabel('Font size (8–32)', { exact: true })
  await size.fill('100')
  await size.press('Tab')
  await expect(size).toHaveValue('32')
  await hub.reload()
  await expect(size).toHaveValue('32')
  await hub.getByRole('button', { name: 'Reset to defaults' }).click()
  await expect(size).toHaveValue('13')
})

test('terminal palette selection persists', async ({ hub }) => {
  await hub.getByRole('button', { name: 'Color scheme', exact: true }).click()
  await hub.getByTitle('Terminal color scheme', { exact: true }).click()
  await hub.getByRole('button', { name: 'Dracula', exact: true }).click()
  await hub.reload()
  await expect(hub.getByTitle('Terminal color scheme', { exact: true })).toHaveText('Dracula')
})

test('installed emulator configurations can be imported', async ({ hub }) => {
  await hub.getByRole('button', { name: /Omarchy —/ }).click()
  await expect(hub.getByRole('button', { name: /Apply/ })).toBeVisible()
  await hub.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(hub.getByRole('button', { name: 'Imported', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await hub.reload()
  await expect(hub.getByRole('button', { name: 'Imported', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('saved node can be renamed and survives reload', async ({ hub }) => {
  await hub.getByRole('button', { name: `edit ${new URL(gateway).host}`, exact: true }).click()
  await hub.getByPlaceholder('Name', { exact: true }).fill('E2E local node')
  await hub.getByRole('button', { name: 'Save', exact: true }).last().click()
  await hub.reload()
  await expect(hub.getByRole('button', { name: 'edit E2E local node', exact: true })).toBeVisible()
  expect(await hub.evaluate(() => localStorage.getItem('rivethub.baseUrl'))).toBe(gateway)
})

test('update check finishes with a result or a specific feed error', async ({ hub }) => {
  const button = hub.getByRole('button', { name: 'Check for updates', exact: true })
  await button.click()
  await expect(button).toBeEnabled()
  await expect(button.locator('..')).toContainText(/✓ up to date|v[\d.]+ available|✗ .+/)
})
