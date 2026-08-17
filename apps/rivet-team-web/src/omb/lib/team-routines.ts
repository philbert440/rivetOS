import type { Routine, RoutineInput, RoutineRun } from './routines'

const KEY = 'rivet-team.routines'

type Bag = { routines: Routine[]; runs: RoutineRun[] }

function empty(): Bag {
  return { routines: [], runs: [] }
}

function load(): Bag {
  try {
    if (typeof localStorage === 'undefined') return empty()
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const parsed = JSON.parse(raw) as Partial<Bag>
    return {
      routines: Array.isArray(parsed.routines) ? parsed.routines : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    }
  } catch {
    return empty()
  }
}

function save(bag: Bag) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(bag))
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `r${Math.random().toString(36).slice(2)}`
}

function nextRunAt(input: RoutineInput | Routine): number | null {
  if (input.schedule.type === 'once') return input.schedule.at
  const [hour, minute] = input.schedule.time.split(':').map(Number)
  const now = new Date()
  for (let i = 0; i < 8; i++) {
    const day = new Date(now)
    day.setDate(now.getDate() + i)
    day.setHours(hour, minute, 0, 0)
    if (day.getTime() <= Date.now()) continue
    if (input.schedule.weekdays.includes(day.getDay())) return day.getTime()
  }
  return null
}

export function listRoutines(): Bag {
  return load()
}

export function upsertRoutine(input: RoutineInput, existing?: Routine): Routine {
  const bag = load()
  const now = Date.now()
  const routine: Routine = {
    id: existing?.id ?? id(),
    name: input.name.trim(),
    prompt: input.prompt,
    botId: input.botId,
    runOn: input.runOn ?? existing?.runOn ?? 'maus',
    enabled: input.enabled ?? existing?.enabled ?? true,
    schedule: input.schedule,
    durationMinutes: input.durationMinutes ?? existing?.durationMinutes ?? 30,
    nextRunAt: nextRunAt({ ...existing, ...input } as Routine),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const idx = bag.routines.findIndex((r) => r.id === routine.id)
  if (idx >= 0) bag.routines[idx] = routine
  else bag.routines.unshift(routine)
  save(bag)
  return routine
}

export function patchRoutine(routineId: string, patch: Partial<RoutineInput>): Routine {
  const bag = load()
  const existing = bag.routines.find((r) => r.id === routineId)
  if (!existing) throw new Error('routine not found')
  return upsertRoutine(
    {
      name: patch.name ?? existing.name,
      prompt: patch.prompt ?? existing.prompt,
      botId: patch.botId ?? existing.botId,
      runOn: patch.runOn ?? existing.runOn,
      enabled: patch.enabled ?? existing.enabled,
      schedule: patch.schedule ?? existing.schedule,
      durationMinutes: patch.durationMinutes ?? existing.durationMinutes,
    },
    existing,
  )
}

export function deleteRoutine(routineId: string) {
  const bag = load()
  bag.routines = bag.routines.filter((r) => r.id !== routineId)
  save(bag)
}

export function runRoutine(routineId: string): { routine: Routine; run: RoutineRun } {
  const bag = load()
  const routine = bag.routines.find((r) => r.id === routineId)
  if (!routine) throw new Error('routine not found')
  const run: RoutineRun = {
    id: id(),
    routineId: routine.id,
    routineName: routine.name,
    prompt: routine.prompt,
    durationMinutes: routine.durationMinutes,
    botId: routine.botId,
    runOn: routine.runOn,
    scheduledFor: Date.now(),
    status: 'running',
    manual: true,
    triggerSource: 'manual',
    createdAt: Date.now(),
  }
  bag.runs.unshift(run)
  save(bag)
  return { routine, run }
}

export function finishRun(runId: string, patch: Partial<RoutineRun>): RoutineRun {
  const bag = load()
  const run = bag.runs.find((r) => r.id === runId)
  if (!run) throw new Error('run not found')
  Object.assign(run, patch)
  save(bag)
  return run
}

export function cancelRun(runId: string): RoutineRun {
  return finishRun(runId, { status: 'cancelled', finishedAt: Date.now() })
}

export function markRunSeen(runId: string): RoutineRun {
  return finishRun(runId, { seenAt: Date.now() })
}

export function handleRoutineApi(path: string, init?: RequestInit): { ok: true; body: unknown } | null {
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}

  if (path === '/api/routines' && method === 'GET') {
    return { ok: true, body: listRoutines() }
  }
  if (path === '/api/routines' && method === 'POST') {
    return { ok: true, body: { routine: upsertRoutine(body as RoutineInput) } }
  }
  const one = path.match(/^\/api\/routines\/([^/]+)$/)
  if (one && method === 'PATCH') {
    return { ok: true, body: { routine: patchRoutine(one[1], body as Partial<RoutineInput>) } }
  }
  if (one && method === 'DELETE') {
    deleteRoutine(one[1])
    return { ok: true, body: {} }
  }
  const runNow = path.match(/^\/api\/routines\/([^/]+)\/run$/)
  if (runNow && method === 'POST') {
    return { ok: true, body: runRoutine(runNow[1]) }
  }
  const cancel = path.match(/^\/api\/routine-runs\/([^/]+)\/cancel$/)
  if (cancel && method === 'POST') {
    return { ok: true, body: { run: cancelRun(cancel[1]) } }
  }
  const seen = path.match(/^\/api\/routine-runs\/([^/]+)\/seen$/)
  if (seen && method === 'POST') {
    return { ok: true, body: { run: markRunSeen(seen[1]) } }
  }
  return null
}
