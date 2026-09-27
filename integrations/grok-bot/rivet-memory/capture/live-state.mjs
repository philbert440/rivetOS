// Shared live-capture state helpers. Watcher size:mtime keys are
// `${agentId}${SESSION_SUFFIX}` so a copied unsuffixed state.json cannot
// skip -v3 ingest. run-once stuck-policy files are a different shape.
export function captureStateKey(id, suffix = '') {
  return `${id}${suffix ?? ''}`
}

export function shouldIngest(state, id, suffix, sig) {
  return state[captureStateKey(id, suffix)] !== sig
}

export function isWatcherStateMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const vals = Object.values(obj)
  if (vals.length === 0) return false
  return vals.every((v) => typeof v === 'string' && /^\d+:\d+$/.test(v))
}

export function isStuckPolicyState(obj) {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    ('lastStatus' in obj || 'sessionId' in obj),
  )
}

export function oldStuckPolicyPath(oldDir, sessionId, suffix) {
  const unsuffixed =
    suffix && sessionId.endsWith(suffix) ? sessionId.slice(0, -suffix.length) : sessionId
  return `${oldDir.replace(/\/$/, '')}/${unsuffixed}.json`
}
