import { randomUUID } from 'node:crypto'
import { test, expect, api, enable, navigate } from '../fixtures.mjs'

test('workflow fixture: edit source, run, answer a human gate, and persist completion', async ({
  hub,
}) => {
  const id = `e2e-workflow-${randomUUID()}`
  const dir = `workflows/defs/${id}`
  let runId
  const source = `export default async function run(step, ctx) {
  const answer = await step.human('approval', { prompt: 'Approve the E2E fixture?', fields: ['approved'] });
  await step.done({ name: ctx.input.name, approved: answer.approved });
}\n`
  try {
    // The real definition loader reads the standard local-mode defs directory.
    // Only this test's unique definition is removed; parent directories remain.
    for (const [parent, name] of [
      ['', 'workflows'],
      ['workflows', 'defs'],
      ['workflows/defs', id],
    ]) {
      const result = await api(
        hub,
        `/api/files/mkdir?dir=${encodeURIComponent(parent)}&name=${name}`,
        { method: 'POST' },
      )
      expect([200, 201, 409], JSON.stringify(result)).toContain(result.status)
    }
    const manifest = `id: ${id}\nname: E2E human gate\nversion: "1.0.0"\ninput:\n  - name: name\n    type: string\n    required: true\noutline:\n  - id: approval\n    label: Approve\n    kind: human\n  - id: done\n    label: Done\n    kind: done\n`
    for (const [name, body] of [
      ['workflow.yaml', manifest],
      ['run.ts', source],
    ]) {
      const result = await api(
        hub,
        `/api/files/upload?dir=${encodeURIComponent(dir)}&name=${name}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body },
      )
      expect(result.status, JSON.stringify(result)).toBeLessThan(300)
    }
    await enable(hub, 'Workflows')
    await navigate(hub, 'Workflows')
    await hub.getByRole('button', { name: /E2E human gate/ }).click()
    await hub.getByRole('button', { name: 'Edit', exact: true }).click()
    await hub.getByRole('button', { name: 'run.ts', exact: true }).click()
    const edited = `${source}// Edited and saved through RivetHub E2E.\n`
    await hub.locator('.cm-content[contenteditable=true]').fill(edited)
    await hub.getByRole('button', { name: 'Save', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await api(hub, `/api/files/download?path=${encodeURIComponent(`${dir}/run.ts`)}`)).body,
      )
      .toBe(edited)
    await hub.getByRole('button', { name: 'Run', exact: true }).click()
    await hub.locator('main input[type=text]').last().fill('E2E test')
    const response = hub.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/api/workflows/${id}/runs`,
    )
    await hub.getByRole('button', { name: 'Start run', exact: true }).click()
    const accepted = await response
    expect(accepted.status(), await accepted.text()).toBeLessThan(300)
    runId = (await accepted.json()).run.id
    await expect(hub.getByRole('heading', { name: /Human gate/ })).toBeVisible()
    await hub.locator('#gate-approved').check()
    await hub.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect
      .poll(async () => (await api(hub, `/api/workflow-runs/${runId}`)).body.run?.run?.status)
      .toBe('done')
    await hub.reload()
    await expect(hub.locator('main')).toContainText('done')
    const persisted = await api(hub, `/api/workflow-runs/${runId}`)
    expect(persisted.body.run.run.output).toEqual({ name: 'E2E test', approved: true })
  } finally {
    if (runId) {
      const status = await api(hub, `/api/workflow-runs/${runId}`)
      if (['running', 'paused_human'].includes(status.body.run?.run?.status)) {
        const killed = await api(hub, `/api/workflow-runs/${runId}/kill`, { method: 'POST' })
        expect(killed.status).toBeLessThan(300)
      }
    }
    const deleted = await api(
      hub,
      `/api/files/delete?path=${encodeURIComponent(dir)}&recursive=1`,
      { method: 'DELETE' },
    )
    expect([200, 404], JSON.stringify(deleted)).toContain(deleted.status)
  }
})
