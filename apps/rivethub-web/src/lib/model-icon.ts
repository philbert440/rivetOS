/**
 * Which brand logo an agent shows (components/model-icon.tsx draws it, from
 * the bundled @lobehub/icons-static-svg set). The model says the most — a
 * `opencode` agent may run GLM, Nemotron or DeepSeek — so the model id is
 * matched first, then the harness. No match keeps the initials tile.
 */

export type ModelIconKey =
  | 'claude'
  | 'claudecode'
  | 'grok'
  | 'zhipu'
  | 'nvidia'
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'gemini'
  | 'geminicli'
  | 'openai'
  | 'codex'
  | 'mistral'
  | 'minimax'
  | 'meta'
  | 'nousresearch'
  | 'hermesagent'
  | 'opencode'
  | 'cursor'
  | 'pi'

/** Model id patterns, most specific vendor first. Matched against the whole
 *  id, so a provider prefix ("openrouter/", "opencode/") never wins. */
const MODEL_RULES: readonly [RegExp, ModelIconKey][] = [
  [/claude|anthropic|\bopus\b|\bsonnet\b|\bhaiku\b/, 'claude'],
  [/grok|\bxai\b|x-ai/, 'grok'],
  [/\bglm|chatglm|zhipu|z-ai|\bzai\b/, 'zhipu'],
  [/nemotron|nvidia/, 'nvidia'],
  [/deepseek/, 'deepseek'],
  [/kimi|moonshot/, 'kimi'],
  [/qwen|qwq/, 'qwen'],
  [/gemini|gemma/, 'gemini'],
  [/codex/, 'codex'],
  [/\bgpt|openai|\bo[1-9]\b|\bo[1-9]-/, 'openai'],
  [/mistral|codestral|devstral|magistral/, 'mistral'],
  [/minimax/, 'minimax'],
  [/llama|\bmeta\b/, 'meta'],
  [/hermes|nous/, 'nousresearch'],
]

/** Harness (or roster command) → its tool's own logo, when no model matched. */
const HARNESS_ICONS: Readonly<Record<string, ModelIconKey>> = {
  'claude-code': 'claudecode',
  claude: 'claudecode',
  'grok-build': 'grok',
  grok: 'grok',
  opencode: 'opencode',
  codex: 'codex',
  gemini: 'geminicli',
  'gemini-cli': 'geminicli',
  cursor: 'cursor',
  hermes: 'hermesagent',
  'qwen-code': 'qwen',
  qwen: 'qwen',
  'kimi-code': 'kimi',
  kimi: 'kimi',
  pi: 'pi',
}

export function modelIconKey(input: {
  model?: string
  harnessId?: string
  command?: string
}): ModelIconKey | undefined {
  const model = input.model?.trim().toLowerCase()
  if (model && model !== 'default') {
    for (const [pattern, key] of MODEL_RULES) if (pattern.test(model)) return key
  }
  for (const id of [input.harnessId, input.command]) {
    const key = id ? HARNESS_ICONS[id.trim().toLowerCase()] : undefined
    if (key) return key
  }
  return undefined
}
