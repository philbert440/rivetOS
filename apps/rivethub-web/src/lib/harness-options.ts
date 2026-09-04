/**
 * Pure helpers that turn a harness capability sheet into Select options.
 * A model's own `efforts` wins over harness-wide `efforts`.
 */

import type { EffortOption, HarnessCapabilities } from '@rivetos/types'
import type { SelectOption } from '../components/select.js'

export type HarnessSheet = Pick<
  HarnessCapabilities,
  'models' | 'efforts' | 'modelFlag' | 'effortFlag'
>

const HARNESS_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  'grok-build': 'grok Build',
  'kimi-code': 'Kimi Code',
  hermes: 'Hermes',
  'deepseek-harness': 'DeepSeek',
}

export function harnessLabel(harnessId?: string): string {
  if (!harnessId) return ''
  return HARNESS_LABEL[harnessId] ?? harnessId
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
 * POST /term `model` / `effort` for a thread. Only a preset-opened thread
 * (settings carry `harnessId`) sends flags; a catalog chat-loop thread
 * must not inherit `--effort medium`.
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
): { model?: string; effort?: string } {
  if (!settings?.harnessId) return {}
  const model = settings.model?.trim() || undefined
  const effort =
    settings.harnessEffort?.trim() ||
    (settings.effort && settings.effort !== 'off' ? settings.effort : undefined) ||
    undefined
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}
