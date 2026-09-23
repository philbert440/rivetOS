/**
 * Pure helpers that turn a harness capability sheet into Select options.
 * A model's own `efforts` wins over harness-wide `efforts`.
 */

import type { EffortOption, HarnessCapabilities, HarnessId } from '@rivetos/types'
import type { SelectOption } from '../components/select.js'

export type HarnessSheet = Pick<
  HarnessCapabilities,
  'models' | 'efforts' | 'modelFlag' | 'effortFlag'
>

const HARNESS_LABEL: Record<HarnessId | 'pi', string> = {
  'claude-code': 'Claude Code',
  'grok-build': 'grok Build',
  'kimi-code': 'Kimi Code',
  opencode: 'opencode',
  hermes: 'Hermes',
  codex: 'Codex',
  pi: 'pi',
  'qwen-code': 'Qwen Code',
}

/** Client-side Codex sheet — same lists as den `codexSheet()` (no spawn flags). */
export const CODEX_SHEET: HarnessSheet = {
  models: [{ id: 'default', label: 'Default', default: true }],
  efforts: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium', default: true },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'X-High' },
  ],
}

export function harnessLabel(harnessId?: string): string {
  if (!harnessId) return ''
  return (HARNESS_LABEL as Record<string, string>)[harnessId] ?? harnessId
}

function toOptions(rows: { id: string; label: string }[] | undefined): SelectOption[] {
  return (rows ?? []).map((r) => ({ value: r.id, label: r.label }))
}

export function modelOptionsFor(sheet: HarnessSheet | undefined): SelectOption[] {
  return toOptions(sheet?.models)
}

export function effortListFor(sheet: HarnessSheet | undefined, modelId: string): EffortOption[] {
  const model = sheet?.models?.find((m) => m.id === modelId)
  return model?.efforts ?? sheet?.efforts ?? []
}

export function effortOptionsFor(sheet: HarnessSheet | undefined, modelId: string): SelectOption[] {
  return toOptions(effortListFor(sheet, modelId))
}

export function defaultModel(sheet: HarnessSheet | undefined): string {
  const models = sheet?.models ?? []
  return models.find((m) => m.default)?.id ?? models.at(0)?.id ?? ''
}

export function defaultEffort(sheet: HarnessSheet | undefined, modelId: string): string {
  const efforts = effortListFor(sheet, modelId)
  return efforts.find((e) => e.default)?.id ?? efforts.at(0)?.id ?? ''
}

/**
 * Conversation-row pill text: session summary model, else the preset's
 * model, else the harness label.
 */
export function rowPillText(
  summary: { model?: string } | undefined,
  preset: { model?: string } | undefined,
  harnessId?: string,
): string {
  const fromSummary = summary?.model?.trim()
  if (fromSummary) return fromSummary
  const fromPreset = preset?.model?.trim()
  if (fromPreset) return fromPreset
  return harnessLabel(harnessId)
}

/**
 * POST /term `model` / `effort` for a thread.
 *
 * Preset threads (`harnessId` set) are unchanged: a non-empty model is sent
 * as stored, and effort comes from the preset. A thread without a harnessId
 * sends `model` only when the trimmed id is one of `vettedModelIds` — the
 * ids on the conversation's resolved `launchModel` sheet, the same list
 * `launchModelOptions` returns. Pass `undefined` (registry pending, errored,
 * or no row) to send no model: the harness default launches. `effort` stays
 * preset-only either way.
 */
export function spawnModelEffort(
  settings:
    | {
        harnessId?: string
        model?: string
        harnessEffort?: string
        effort?: string
      }
    | undefined,
  vettedModelIds?: readonly string[],
): { model?: string; effort?: string } {
  const trimmed = settings?.model?.trim() || undefined
  // No harnessId → the id must be on this conversation's own sheet. Anything
  // else (off-sheet, malformed, registry not settled) is omitted so a stored
  // token cannot turn a default spawn into HTTP 400.
  const model = settings?.harnessId
    ? trimmed
    : trimmed && vettedModelIds?.includes(trimmed)
      ? trimmed
      : undefined
  const effort = settings?.harnessId
    ? settings.harnessEffort?.trim() ||
      (settings.effort && settings.effort !== 'off' ? settings.effort : undefined) ||
      undefined
    : undefined
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}
