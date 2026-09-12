import { randomUUID } from 'node:crypto'
import { test, expect, navigate, api, enable } from '../fixtures.mjs'

test.beforeEach(async ({ hub }) => {
  await enable(hub, 'Files')
  await navigate(hub, 'Files')
  await expect(hub.getByRole('button', { name: 'New folder', exact: true })).toBeVisible()
})

test('files: listing, filtering and sorting', async ({ hub }) => {
  await expect(hub.getByRole('table')).toBeVisible()
  await hub.getByPlaceholder('Filter…').fill(`no-match-${randomUUID()}`)
  await expect(hub.getByRole('checkbox', { name: /^select / })).toHaveCount(0)
  await hub.getByPlaceholder('Filter…').fill('')
  await hub.getByTitle('sort', { exact: true }).click()
  await hub.getByRole('button', { name: 'sort: size', exact: true }).click()
  await expect(hub.getByTitle('sort', { exact: true })).toHaveText('sort: size')
})

test('new-folder dialog supports keyboard cancellation', async ({ hub }) => {
  await hub.getByRole('button', { name: 'New folder', exact: true }).click()
  await expect(hub.getByRole('dialog', { name: 'New folder name' })).toBeVisible()
  await expect(hub.getByRole('dialog').getByRole('textbox')).toBeFocused()
  await hub.keyboard.press('Escape')
  await expect(hub.getByRole('dialog')).toHaveCount(0)
})

test('files: create folder, upload, preview, rename, copy, delete and refresh', async ({ hub }) => {
  const folder = `rivethub-e2e-${randomUUID()}`
  const text = `RivetHub E2E UTF-8 check: café 日本語 ${folder}\n`
  try {
    await hub.getByRole('button', { name: 'New folder', exact: true }).click()
    await hub.getByRole('dialog').getByRole('textbox').fill(folder)
    await hub.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click()
    await hub.getByRole('button', { name: `▸ ${folder}/`, exact: true }).click()
    await expect(hub).toHaveURL(new RegExp(`path=${folder}`))
    await hub
      .locator('input[type=file]')
      .setInputFiles({ name: 'probe.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })
    const file = hub.getByRole('button', { name: '· probe.txt', exact: true })
    await expect(file).toBeVisible()
    await file.click()
    await expect(hub.getByText(text.trim(), { exact: false })).toBeVisible()
    const edited = `${text}Saved through the desktop editor.\n`
    await hub.locator('.cm-content[contenteditable=true]').fill(edited)
    await hub.getByRole('button', { name: 'Save', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await api(hub, `/api/files/download?path=${encodeURIComponent(`${folder}/probe.txt`)}`))
            .body,
      )
      .toBe(edited)
    await hub.getByRole('checkbox', { name: 'select probe.txt', exact: true }).check()
    await hub.getByRole('button', { name: 'Rename', exact: true }).click()
    await hub.getByRole('dialog').getByRole('textbox').fill('renamed.txt')
    await hub.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click()
    await expect(hub.getByRole('button', { name: '· renamed.txt', exact: true })).toBeVisible()
    await hub.getByRole('checkbox', { name: 'select renamed.txt', exact: true }).check()
    const originalClipboard = await hub.evaluate(() => window.rivetShell.clipboardReadText())
    try {
      await hub.getByRole('button', { name: 'Copy path', exact: true }).click()
      expect(await hub.evaluate(() => window.rivetShell.clipboardReadText())).toContain(
        `${folder}/renamed.txt`,
      )
    } finally {
      await hub.evaluate((text) => window.rivetShell.clipboardWriteText(text), originalClipboard)
    }
    await hub.getByRole('button', { name: /^Delete/, exact: true }).click()
    await hub.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click()
    await expect(hub.getByRole('button', { name: '· renamed.txt', exact: true })).toHaveCount(0)
    await hub.reload()
    await expect(hub).toHaveURL(new RegExp(`path=${folder}`))
    await expect(hub.getByRole('button', { name: '· renamed.txt', exact: true })).toHaveCount(0)
  } finally {
    // Delete only the unique directory owned by this test, even after assertion failure.
    const result = await api(
      hub,
      `/api/files/delete?path=${encodeURIComponent(folder)}&recursive=1`,
      { method: 'DELETE' },
    )
    expect([200, 404], `Test directory cleanup: ${JSON.stringify(result)}`).toContain(result.status)
  }
})
