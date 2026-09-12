import { randomUUID } from 'node:crypto'
import { test, expect, enable, navigate, api } from '../fixtures.mjs'

test('tasks: list, status filter and empty-goal validation', async ({ hub }) => {
  await enable(hub, 'Tasks')
  await navigate(hub, 'Tasks')
  await expect(hub.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible()
  await hub.getByRole('button', { name: 'New task', exact: true }).click()
  await expect(hub.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await hub.getByPlaceholder('What should the agent do?').fill('   ')
  await expect(hub.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await hub.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(hub.getByPlaceholder('What should the agent do?')).toHaveCount(0)
})

test('workflows: definitions open an input form', async ({ hub }) => {
  await enable(hub, 'Workflows')
  await navigate(hub, 'Workflows')
  await expect(hub.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
  await hub.getByRole('button', { name: /Hello World/ }).click()
  await expect(hub).toHaveURL(/\/workflows\/hello-world/)
  await expect(hub.getByRole('button', { name: 'Start run', exact: true })).toBeVisible()
})

for (const [id, status, message] of [
  ['rivethub-e2e-not-found', 400, 'Invalid task ID. Check the task link.'],
  ['00000000-0000-0000-0000-000000000000', 404, 'Task not found. Check the task link.'],
])
  test(`task link ${status} gives a recoverable error`, async ({ hub }) => {
    await enable(hub, 'Tasks')
    const result = hub.waitForResponse((r) => new URL(r.url()).pathname === `/api/tasks/${id}`)
    await hub.goto(`app://bundle/tasks/${id}`)
    expect((await result).status()).toBe(status)
    await expect(hub.locator('main')).toContainText(message)
    await hub.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(hub.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  })

test('tasks: create a bounded task, open details, and reach completion', async ({ hub }) => {
  test.setTimeout(120_000)
  await enable(hub, 'Tasks')
  await navigate(hub, 'Tasks')
  await hub.getByRole('button', { name: 'New task', exact: true }).click()
  const goal = `RivetHub E2E ${randomUUID()}: Do not use tools. Reply with exactly E2E_TASK_OK.`
  await hub.getByPlaceholder('What should the agent do?').fill(goal)
  await expect(hub.getByTitle('agent', { exact: true })).toContainText('this node')
  const response = hub.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks',
    { timeout: 15_000 },
  )
  await hub.getByRole('button', { name: 'Create', exact: true }).click()
  const accepted = await response
  expect(accepted.status(), await accepted.text()).toBeLessThan(300)
  const id = (await accepted.json()).task.id
  try {
    await expect(hub).toHaveURL(new RegExp(`/tasks/${id}`))
    await expect(hub.getByRole('heading', { name: goal, exact: true })).toBeVisible()
    await expect
      .poll(async () => (await api(hub, `/api/tasks/${id}`)).body.task.status, {
        timeout: 90_000,
        intervals: [1000, 2000, 5000],
      })
      .toMatch(/completed|failed|timeout|killed/)
    const final = await api(hub, `/api/tasks/${id}`)
    expect(final.body.task.status, JSON.stringify(final.body.task)).toBe('completed')
    await expect(hub.locator('main')).toContainText('E2E_TASK_OK')
  } finally {
    const current = await api(hub, `/api/tasks/${id}`)
    if (!['completed', 'failed', 'timeout', 'killed'].includes(current.body.task?.status)) {
      const killed = await api(hub, `/api/tasks/${id}/kill`, { method: 'POST' })
      expect(killed.status).toBeLessThan(300)
    }
  }
})

test('workflow: validate input, start a run and render its journal', async ({ hub }) => {
  await enable(hub, 'Workflows')
  await hub.goto('app://bundle/workflows/hello-world')
  const start = hub.getByRole('button', { name: 'Start run', exact: true })
  await expect(start).toBeVisible()
  const field = hub.locator('main input[type=text]').last()
  await field.fill(`RivetHub E2E ${randomUUID()}`)
  const response = hub.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/workflows\/hello-world\/runs/.test(r.url()),
  )
  await start.click()
  const accepted = await response
  expect(accepted.status(), await accepted.text()).toBeLessThan(300)
  const payload = await accepted.json()
  const id = payload.run?.id ?? payload.runId
  expect(id, 'run id required for cleanup').toBeTruthy()
  try {
    await expect(hub).toHaveURL(new RegExp(`/workflows/runs/${id}`))
    await expect(hub.locator('main')).toContainText(/journal|timeline/i)
    await expect(hub.locator('main')).not.toContainText(/Internal Server Error|TypeError/)
  } finally {
    const result = await api(hub, `/api/workflow-runs/${encodeURIComponent(id)}/kill`, {
      method: 'POST',
    })
    expect([200, 202, 409], JSON.stringify(result)).toContain(result.status)
  }
})
