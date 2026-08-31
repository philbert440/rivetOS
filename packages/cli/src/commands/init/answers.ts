/**
 * `--answers-file` parsing for `rivetos init`.
 *
 * A JSON object supplies every prompt that would fire on this run. Missing
 * keys are a hard error naming the key — no silent defaults. A value of
 * `{ "default": true }` opts into that prompt's interactive default.
 */

import { readFile } from 'node:fs/promises'
import { DEFAULT_MODELS, PROVIDER_ENV_KEYS } from './agents.js'
import type { DeploymentTarget, EnvDetection, WizardAgent, WizardMeshJoin } from './types.js'
import { parseUserHost, validateNodeName } from '../../lib/mesh-enroll.js'

const PROVIDERS = new Set(Object.keys(DEFAULT_MODELS))
const THINKING = new Set(['off', 'low', 'medium', 'high'])
const DEPLOYMENTS = new Set(['docker', 'proxmox', 'manual'])
const EXISTING_ACTIONS = new Set(['deploy', 'reconfigure', 'validate', 'overwrite', 'cancel'])

export class MissingAnswerError extends Error {
  readonly key: string
  constructor(key: string) {
    super(`answers-file missing required key "${key}"`)
    this.name = 'MissingAnswerError'
    this.key = key
  }
}

export function isDefaultMarker(value: unknown): value is { default: true } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { default?: unknown }).default === true &&
    Object.keys(value as object).length === 1
  )
}

export function parseAnswersJson(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`answers-file is not valid JSON: ${detail}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('answers-file must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export async function loadAnswersFile(path: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    throw new Error(`answers-file not readable: ${path}`)
  }
  return parseAnswersJson(raw)
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function requireValue(obj: Record<string, unknown>, key: string, path: string): unknown {
  if (!hasKey(obj, key)) throw new MissingAnswerError(path)
  return obj[key]
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`answers-file key "${path}" must be an object`)
  }
  return value as Record<string, unknown>
}

function noDefault(path: string): never {
  throw new Error(`answers-file key "${path}" requested default but this prompt has no default`)
}

function readString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  fallback?: string,
): string {
  const value = requireValue(obj, key, path)
  if (isDefaultMarker(value)) {
    if (fallback === undefined) noDefault(path)
    return fallback
  }
  if (typeof value !== 'string') {
    throw new Error(`answers-file key "${path}" must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`answers-file key "${path}" must be a non-empty string`)
  }
  return trimmed
}

function readStringAllowEmpty(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  fallback?: string,
): string {
  const value = requireValue(obj, key, path)
  if (isDefaultMarker(value)) {
    if (fallback === undefined) noDefault(path)
    return fallback
  }
  if (typeof value !== 'string') {
    throw new Error(`answers-file key "${path}" must be a string`)
  }
  return value.trim()
}

function readBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  fallback?: boolean,
): boolean {
  const value = requireValue(obj, key, path)
  if (isDefaultMarker(value)) {
    if (fallback === undefined) noDefault(path)
    return fallback
  }
  if (typeof value !== 'boolean') {
    throw new Error(`answers-file key "${path}" must be a boolean`)
  }
  return value
}

function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  if (!hasKey(obj, key)) return undefined
  const value = obj[key]
  if (isDefaultMarker(value) || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`answers-file key "${path}" must be a string`)
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export type ExistingConfigAction = 'deploy' | 'reconfigure' | 'validate' | 'overwrite' | 'cancel'

export interface AnsweredInit {
  existingAction?: ExistingConfigAction
  overwriteConfirm?: boolean
  deployment: DeploymentTarget
  agents: WizardAgent[]
  postgresUrl?: string
  meshJoin?: WizardMeshJoin
  ownerId: string
  confirm: boolean
  deployNow?: boolean
}

function interpretAgent(raw: unknown, index: number, usedNames: Set<string>): WizardAgent {
  const path = `agents[${String(index)}]`
  const obj = asRecord(raw, path)
  const isFirst = index === 0
  const name = readString(obj, 'name', `${path}.name`, isFirst ? 'rivet' : undefined)
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(
      `answers-file key "${path}.name" must be lowercase letters, numbers, and hyphens`,
    )
  }
  if (usedNames.has(name)) {
    throw new Error(`answers-file key "${path}.name" duplicates agent "${name}"`)
  }
  usedNames.add(name)

  const provider = readString(obj, 'provider', `${path}.provider`)
  if (!PROVIDERS.has(provider)) {
    throw new Error(
      `answers-file key "${path}.provider" must be one of: ${[...PROVIDERS].join(', ')}`,
    )
  }

  let apiKey: string | undefined
  let baseUrl: string | undefined

  if (provider === 'claude-cli') {
    // no credentials
  } else if (provider === 'ollama') {
    baseUrl = readString(obj, 'baseUrl', `${path}.baseUrl`, 'http://localhost:11434')
  } else if (provider === 'vllm') {
    baseUrl = readString(obj, 'baseUrl', `${path}.baseUrl`, 'http://localhost:8000')
    if (hasKey(obj, 'apiKey')) {
      const key = readStringAllowEmpty(obj, 'apiKey', `${path}.apiKey`, '')
      apiKey = key || undefined
    }
  } else if (provider === 'llama-server') {
    baseUrl = readString(obj, 'baseUrl', `${path}.baseUrl`, 'http://localhost:8080')
    if (hasKey(obj, 'apiKey')) {
      const key = readStringAllowEmpty(obj, 'apiKey', `${path}.apiKey`, '')
      apiKey = key || undefined
    }
  } else {
    const envKey = PROVIDER_ENV_KEYS[provider]
    const existing = envKey ? process.env[envKey] : undefined
    apiKey = readString(obj, 'apiKey', `${path}.apiKey`, existing)
  }

  const model = readString(obj, 'model', `${path}.model`, DEFAULT_MODELS[provider] ?? 'default')
  const thinking = readString(obj, 'thinking', `${path}.thinking`, 'medium')
  if (!THINKING.has(thinking)) {
    throw new Error(`answers-file key "${path}.thinking" must be one of: off, low, medium, high`)
  }

  return { name, provider, model, thinking, apiKey, baseUrl }
}

function interpretMeshJoin(answers: Record<string, unknown>): WizardMeshJoin | undefined {
  const join = readBoolean(answers, 'joinMesh', 'joinMesh', false)
  if (!join) return undefined
  const hub = readString(answers, 'meshHub', 'meshHub')
  try {
    parseUserHost(hub)
  } catch (err) {
    throw new Error(`answers-file key "meshHub" is not a valid user@host: ${(err as Error).message}`)
  }
  const name = readString(answers, 'meshName', 'meshName')
  if (!validateNodeName(name)) {
    throw new Error(
      'answers-file key "meshName" must match [a-z0-9]([a-z0-9-]*[a-z0-9])? (max 63)',
    )
  }
  const advertise = readOptionalString(answers, 'meshAdvertise', 'meshAdvertise')
  return { hub, name, advertise }
}

/**
 * Interpret a parsed answers object against the prompts that would fire for
 * this environment. Conditional keys (postgresUrl, meshHub, …) are required
 * only when that prompt would be asked.
 */
export function interpretAnswers(
  answers: Record<string, unknown>,
  ctx: Pick<EnvDetection, 'configExists' | 'dockerAvailable'>,
): AnsweredInit {
  let existingAction: ExistingConfigAction | undefined
  let overwriteConfirm: boolean | undefined
  if (ctx.configExists) {
    const action = readString(answers, 'existingConfig', 'existingConfig')
    if (!EXISTING_ACTIONS.has(action)) {
      throw new Error(
        `answers-file key "existingConfig" must be one of: ${[...EXISTING_ACTIONS].join(', ')}`,
      )
    }
    existingAction = action as ExistingConfigAction
    if (existingAction === 'validate' || existingAction === 'cancel') {
      // These actions skip the rest of the wizard — do not require later keys.
      return {
        existingAction,
        deployment: 'manual',
        agents: [],
        ownerId: 'owner',
        confirm: existingAction !== 'cancel',
      }
    }
    if (existingAction === 'deploy') {
      return {
        existingAction,
        deployment: 'manual',
        agents: [],
        ownerId: 'owner',
        confirm: true,
        deployNow: readBoolean(answers, 'deployNow', 'deployNow', true),
      }
    }
    if (existingAction === 'overwrite') {
      overwriteConfirm = readBoolean(answers, 'overwriteConfirm', 'overwriteConfirm', false)
      if (!overwriteConfirm) {
        return {
          existingAction,
          overwriteConfirm,
          deployment: 'manual',
          agents: [],
          ownerId: 'owner',
          confirm: false,
        }
      }
    }
  }

  const deploymentRaw = readString(answers, 'deployment', 'deployment')
  if (!DEPLOYMENTS.has(deploymentRaw)) {
    throw new Error('answers-file key "deployment" must be one of: docker, proxmox, manual')
  }
  const deployment = deploymentRaw as DeploymentTarget

  if (deployment === 'docker' && !ctx.dockerAvailable) {
    const cont = readBoolean(answers, 'dockerContinue', 'dockerContinue')
    if (!cont) {
      throw new Error('answers-file key "dockerContinue" is false and Docker was not detected')
    }
  }

  const agentsRaw = requireValue(answers, 'agents', 'agents')
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) {
    throw new Error('answers-file key "agents" must be a non-empty array')
  }
  const usedNames = new Set<string>()
  const agents = agentsRaw.map((entry, i) => interpretAgent(entry, i, usedNames))

  let postgresUrl: string | undefined
  if (deployment === 'manual') {
    postgresUrl = readString(answers, 'postgresUrl', 'postgresUrl')
    if (!/^postgres(ql)?:\/\/.+/.test(postgresUrl)) {
      throw new Error('answers-file key "postgresUrl" must be a postgres:// connection string')
    }
  }

  const meshJoin = interpretMeshJoin(answers)
  const ownerId = readString(answers, 'ownerId', 'ownerId', 'owner')
  const confirm = readBoolean(answers, 'confirm', 'confirm', true)

  let deployNow: boolean | undefined
  if (deployment === 'docker') {
    deployNow = readBoolean(answers, 'deployNow', 'deployNow', true)
  }

  return {
    existingAction,
    overwriteConfirm,
    deployment,
    agents,
    postgresUrl,
    meshJoin,
    ownerId,
    confirm,
    deployNow,
  }
}
