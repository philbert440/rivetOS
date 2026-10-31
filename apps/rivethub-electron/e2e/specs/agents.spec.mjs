import { randomUUID } from 'node:crypto'
import { test, expect, api } from '../fixtures.mjs'

/**
 * A roster row's accessible name is the agent name plus its harness label
 * (agents-section.tsx AgentRow renders both inside the button), so match the
 * name span exactly rather than the whole button name.
 */
const rosterRow = (hub, label) =>
  hub.getByRole('button').filter({ has: hub.getByText(label, { exact: true }) })

/**
 * AgentRow's edit/delete controls render only on :hover ("hidden
 * group-hover:flex"). Hover when the window applies it; the invisible
 * session-0 window on the Windows runner does not, so there the hidden
 * control's click handler is invoked directly.
 */
async function clickRowControl(row, name) {
  // includeHidden: a display:none control is outside the accessibility tree.
  const control = row.locator('..').getByRole('button', { name, exact: true, includeHidden: true })
  await row.hover()
  if (await control.isVisible()) await control.click()
  else await control.dispatchEvent('click')
}

test('agent preset: create, edit, reload and delete only the test preset', async ({ hub }) => {
  const name = `E2E agent ${randomUUID().slice(0, 8)}`
  const renamed = `${name} edited`
  let id
  try {
    await hub.getByRole('button', { name: 'add agent', exact: true }).click()
    // Radix names the dialog from its title ("New Agent"), which wins over the
    // content's aria-label ("New agent"); match the title case-insensitively.
    const dialog = hub.getByRole('dialog', { name: /^New Agent$/i })
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
    const button = rosterRow(hub, name)
    await expect(button).toBeVisible()
    await clickRowControl(button, 'edit')
    await hub
      .getByRole('dialog', { name: /^Edit Agent$/i })
      .getByPlaceholder('Agent name')
      .fill(renamed)
    await hub.getByRole('button', { name: 'Update', exact: true }).click()
    await hub.reload()
    const updated = rosterRow(hub, renamed)
    await expect(updated).toBeVisible()
    await clickRowControl(updated, 'delete')
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
