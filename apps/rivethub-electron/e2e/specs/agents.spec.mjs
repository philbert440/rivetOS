import { randomUUID } from 'node:crypto'
import { test, expect, api } from '../fixtures.mjs'

test('agent preset: create, edit, reload and delete only the test preset', async ({ hub }) => {
  const name = `E2E agent ${randomUUID().slice(0, 8)}`
  const renamed = `${name} edited`
  let id
  try {
    await hub.getByRole('button', { name: 'add agent', exact: true }).click()
    const dialog = hub.getByRole('dialog', { name: 'New agent', exact: true })
    await dialog.getByPlaceholder('Agent name').fill(name)
    await dialog
      .getByPlaceholder('Custom system prompt...')
      .fill('E2E preset. Reply without tools.')
    await dialog.getByPlaceholder('#3b82f6').fill('#123456')
    const response = hub.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/agents',
    )
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    const created = await response
    expect(created.status(), await created.text()).toBeLessThan(300)
    const payload = await created.json()
    id = payload.agent?.id ?? payload.id
    expect(id, 'returned preset ID is required for cleanup').toBeTruthy()
    const button = hub.getByRole('button', { name, exact: true })
    await expect(button).toBeVisible()
    await button.hover()
    const row = button.locator('..')
    await row.getByRole('button', { name: 'edit', exact: true }).click()
    await hub
      .getByRole('dialog', { name: 'Edit agent', exact: true })
      .getByPlaceholder('Agent name')
      .fill(renamed)
    await hub.getByRole('button', { name: 'Update', exact: true }).click()
    await hub.reload()
    const updated = hub.getByRole('button', { name: renamed, exact: true })
    await expect(updated).toBeVisible()
    await updated.hover()
    await updated.locator('..').getByRole('button', { name: 'delete', exact: true }).click()
    await hub
      .getByRole('dialog')
      .getByRole('button', { name: /Delete|OK/, exact: true })
      .click()
    await expect(updated).toHaveCount(0)
  } finally {
    if (id) {
      const result = await api(hub, `/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
      expect([200, 204, 404], JSON.stringify(result)).toContain(result.status)
    }
  }
})
