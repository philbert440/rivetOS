import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  appendModelEffortArgv,
  applySheetOverride,
  claudeSheet,
  codexSheet,
  EFFORT_TOKEN_RE,
  grokSheet,
  hermesSheet,
  kimiSheet,
  opencodeSheet,
  parseOpencodeConfig,
  piSheet,
  MODEL_TOKEN_RE,
  parseKimiToml,
  sanitizeEfforts,
  sanitizeModels,
  sheetForHarness,
} from './model-sheets.js'

const CT116_TOML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/kimi-config-ct116.toml'),
  'utf8',
)

const GROK_CACHE = {
  models: {
    'grok-4.6': {
      info: {
        name: 'Grok 4.6',
        hidden: false,
        reasoning_efforts: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High', default: true },
          { id: 'xhigh', label: 'X-High' },
        ],
      },
    },
    'grok-4.5': {
      info: {
        name: 'Grok 4.5',
        hidden: false,
        reasoning_efforts: [{ id: 'high', label: 'High', default: true }],
      },
    },
    'grok-hidden': {
      info: { name: 'Hidden', hidden: true, reasoning_efforts: [] },
    },
    'grok-no-reason': {
      info: {
        name: 'No reason',
        hidden: false,
        supports_reasoning_effort: false,
        reasoning_efforts: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High', default: true },
        ],
      },
    },
  },
}

describe('claudeSheet', () => {
  it('declares aliases including 1M variants and medium-default efforts', () => {
    const sheet = claudeSheet()
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBe('--effort')
    expect(sheet.models?.map((m) => m.id)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'fable[1m]',
      'opus[1m]',
      'sonnet[1m]',
    ])
    expect(sheet.models?.find((m) => m.default)?.id).toBe('fable')
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('medium')
    expect(sheet.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('grokSheet', () => {
  it('filters hidden, maps efforts, and marks the first visible as default', () => {
    const sheet = grokSheet(() => GROK_CACHE, '/tmp/fake-home')
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBe('--reasoning-effort')
    expect(sheet.models?.map((m) => m.id)).toEqual(['grok-4.6', 'grok-4.5', 'grok-no-reason'])
    expect(sheet.models?.[0]).toMatchObject({
      id: 'grok-4.6',
      label: 'Grok 4.6',
      default: true,
    })
    expect(sheet.models?.[0].efforts?.map((e) => e.id)).toEqual(['low', 'high', 'xhigh'])
    expect(sheet.models?.[0].efforts?.find((e) => e.default)?.id).toBe('high')
    expect(sheet.models?.some((m) => m.id === 'grok-hidden')).toBe(false)
  })

  it('omits efforts when supports_reasoning_effort is false', () => {
    const sheet = grokSheet(() => GROK_CACHE, '/tmp/fake-home')
    const row = sheet.models?.find((m) => m.id === 'grok-no-reason')
    expect(row?.efforts).toBeUndefined()
  })

  it("copies the default model's efforts onto the harness-wide list", () => {
    const sheet = grokSheet(() => GROK_CACHE, '/tmp/fake-home')
    expect(sheet.efforts?.map((e) => e.id)).toEqual(['low', 'high', 'xhigh'])
    expect(sheet.efforts).toEqual(sheet.models?.[0].efforts)
  })

  it('falls back to grok-4.6 when the cache is unreadable', () => {
    const sheet = grokSheet(() => {
      throw new Error('ENOENT')
    })
    expect(sheet.models).toEqual([expect.objectContaining({ id: 'grok-4.6', default: true })])
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('high')
    expect(sheet.effortFlag).toBe('--reasoning-effort')
  })
})

describe('kimiSheet / parseKimiToml', () => {
  const toml = `
# comment
default_model = "k2p5"

[models.k2p5]
provider = "moonshot"

[models.kimi-for-coding]
provider = "moonshot"

[other]
x = 1
`
  it('parses aliases and marks default_model', () => {
    const models = parseKimiToml(toml)
    expect(models.map((m) => m.id)).toEqual(['k2p5', 'kimi-for-coding'])
    expect(models.find((m) => m.default)?.id).toBe('k2p5')
  })

  it('reads the first readable config.toml path', () => {
    const sheet = kimiSheet((path) => {
      if (path.endsWith('.kimi/config.toml')) return toml
      throw new Error('missing')
    }, '/home/tester')
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBeUndefined()
    expect(sheet.efforts).toBeUndefined()
    expect(sheet.models?.map((m) => m.id)).toEqual(['k2p5', 'kimi-for-coding'])
  })

  it('returns models: [] when no config is readable', () => {
    const sheet = kimiSheet(() => {
      throw new Error('ENOENT')
    })
    expect(sheet).toEqual({ models: [], modelFlag: '--model' })
  })

  it('parses the ct116 real config fixture (quoted slash aliases)', () => {
    const models = parseKimiToml(CT116_TOML)
    expect(models.length).toBeGreaterThanOrEqual(3)
    expect(models.find((m) => m.default)?.id).toBe('moonshotai/kimi-k3')
    expect(models.find((m) => m.id === 'moonshotai/kimi-k2-0905-preview')).toMatchObject({
      id: 'moonshotai/kimi-k2-0905-preview',
      label: 'Kimi K2 0905',
    })
    expect(models.every((m) => m.id.startsWith('moonshotai/'))).toBe(true)
    expect(models.some((m) => m.id === 'hooks' || m.id === 'moonshotai')).toBe(false)
    expect(models.some((m) => /hook|provider|SessionStart|\/opt\//i.test(m.id + m.label))).toBe(
      false,
    )
  })
})

describe('MODEL_TOKEN_RE / EFFORT_TOKEN_RE', () => {
  it('accepts slash model ids; rejects slash efforts and traversal/space everywhere', () => {
    expect(MODEL_TOKEN_RE.test('moonshotai/kimi-k3')).toBe(true)
    expect(EFFORT_TOKEN_RE.test('moonshotai/kimi-k3')).toBe(false)
    expect(EFFORT_TOKEN_RE.test('a/b')).toBe(false)
    expect(MODEL_TOKEN_RE.test('../x')).toBe(false)
    expect(EFFORT_TOKEN_RE.test('../x')).toBe(false)
    expect(MODEL_TOKEN_RE.test('a b')).toBe(false)
    expect(EFFORT_TOKEN_RE.test('a b')).toBe(false)
  })
})

describe('hermesSheet', () => {
  it('hermes advertises no models (own picker) and --reasoning efforts', () => {
    const sheet = hermesSheet()
    expect(sheet.models).toEqual([])
    expect(sheet.effortFlag).toBe('--reasoning')
    expect(sheet.modelFlag).toBeUndefined()
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('medium')
  })

  it('deepseek is empty', () => {
  })

  it('pi falls back to the fleet default and --thinking efforts when config is missing', () => {
    const sheet = piSheet(() => {
      throw new Error('ENOENT')
    }, '/no-such-home')
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBe('--thinking')
    expect(sheet.models?.map((m) => m.id)).toEqual(['deepseek/deepseek-v4-flash'])
    expect(sheet.models?.[0]?.default).toBe(true)
    expect(sheet.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(sheet.efforts?.some((e) => e.id === 'off' || e.id === 'minimal')).toBe(false)
    expect(appendModelEffortArgv(['pi'], sheet, 'deepseek/deepseek-v4-flash', 'high')).toEqual([
      'pi',
      '--model',
      'deepseek/deepseek-v4-flash',
      '--thinking',
      'high',
    ])
  })

  it('pi reads settings.json default and models-store.json when present', () => {
    const files: Record<string, unknown> = {
      '/home/rivet/.pi/agent/settings.json': {
        defaultModel: 'deepseek-v4-flash',
      },
      '/home/rivet/.pi/agent/models-store.json': {
        models: [
          { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { provider: 'openai', modelId: 'gpt-4' },
        ],
      },
    }
    const sheet = piSheet((p) => {
      const v = files[p]
      if (!v) throw new Error('ENOENT')
      return v
    }, '/home/rivet')
    expect(sheet.models?.map((m) => m.id)).toEqual(['deepseek/deepseek-v4-flash', 'openai/gpt-4'])
    expect(sheet.models?.[0]?.default).toBe(true)
    expect(sheet.models?.[0]?.label).toBe('DeepSeek V4 Flash')
  })
})

describe('opencodeSheet', () => {
  it('reads a default model from injected opencode.json', () => {
    const sheet = opencodeSheet((path) => {
      if (path.endsWith('opencode.json')) return { model: 'zai/glm-5.3-flash' }
      throw new Error('missing')
    }, '/home/tester')
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBe('--variant')
    expect(sheet.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'max'])
    expect(sheet.models).toEqual([
      { id: 'zai/glm-5.3-flash', label: 'zai/glm-5.3-flash', default: true },
    ])
    expect(sheetForHarness('opencode', { readJson: () => ({ model: 'x' }) }).modelFlag).toBe(
      '--model',
    )
    expect(appendModelEffortArgv(['opencode'], sheet, 'zai/glm-5.3-flash')).toEqual([
      'opencode',
      '--model',
      'zai/glm-5.3-flash',
    ])
    expect(appendModelEffortArgv(['opencode'], sheet, 'zai/glm-5.3-flash', 'low')).toEqual([
      'opencode',
      '--model',
      'zai/glm-5.3-flash',
      '--variant',
      'minimal',
    ])
    expect(appendModelEffortArgv(['opencode'], sheet, 'zai/glm-5.3-flash', 'medium')).toEqual([
      'opencode',
      '--model',
      'zai/glm-5.3-flash',
    ])
    expect(appendModelEffortArgv(['opencode'], sheet, 'zai/glm-5.3-flash', 'max')).toEqual([
      'opencode',
      '--model',
      'zai/glm-5.3-flash',
      '--variant',
      'max',
    ])
  })

  it('also lists provider.<id>.models keys', () => {
    expect(
      parseOpencodeConfig({
        model: 'zai/glm-5.3-flash',
        provider: {
          zai: { models: { 'glm-5.3-flash': {}, 'glm-5': {} } },
        },
      }).map((m) => m.id),
    ).toEqual(['zai/glm-5.3-flash', 'zai/glm-5'])
  })

  it('empty models when config is missing or the model token is junk', () => {
    const empty = opencodeSheet(() => {
      throw new Error('missing')
    }, '/nope')
    expect(empty.models).toEqual([])
    expect(empty.modelFlag).toBe('--model')
    expect(empty.effortFlag).toBe('--variant')
    expect(parseOpencodeConfig({ model: '../x' })).toEqual([])
    expect(parseOpencodeConfig({ model: 1 })).toEqual([])
    expect(parseOpencodeConfig(null)).toEqual([])
  })
})

describe('codexSheet', () => {
  it('advertises default model and #719 reasoning efforts without spawn flags', () => {
    const sheet = codexSheet()
    expect(sheet.models).toEqual([{ id: 'default', label: 'Default', default: true }])
    expect(sheet.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('medium')
    expect(sheet.modelFlag).toBeUndefined()
    expect(sheet.effortFlag).toBeUndefined()
    expect(sheetForHarness('codex')).toEqual(sheet)
    expect(appendModelEffortArgv(['codex'], sheet, 'default', 'high')).toEqual(['codex'])
  })
})

describe('applySheetOverride', () => {
  it('replaces models/efforts when the override carries that key', () => {
    const base = claudeSheet()
    const next = applySheetOverride(base, {
      models: [{ id: 'only', label: 'Only' }, { id: 1 }, { nope: true }],
      efforts: [{ id: 'max', label: 'Max', default: true }, 'bad'],
    })
    expect(next.models).toEqual([{ id: 'only', label: 'Only' }])
    expect(next.efforts).toEqual([{ id: 'max', label: 'Max', default: true }])
    expect(next.modelFlag).toBe('--model')
    expect(next.effortFlag).toBe('--effort')
  })

  it('ignores a non-array override and keeps the sheet list', () => {
    const base = claudeSheet()
    const next = applySheetOverride(base, { models: 'nope', efforts: { id: 'x' } })
    expect(next.models).toEqual(base.models)
    expect(next.efforts).toEqual(base.efforts)
  })

  it('ignores an override that sanitizes to empty and logs', () => {
    const base = claudeSheet()
    const logs: string[] = []
    const next = applySheetOverride(base, { models: [], efforts: [{ id: 'bad id!' }] }, (msg) =>
      logs.push(msg),
    )
    expect(next.models).toEqual(base.models)
    expect(next.efforts).toEqual(base.efforts)
    expect(logs.some((l) => l.includes('empty models override'))).toBe(true)
    expect(logs.some((l) => l.includes('empty efforts override'))).toBe(true)
  })
})

describe('sanitizeModels', () => {
  it('drops malformed entries and keeps nested efforts', () => {
    expect(
      sanitizeModels([
        { id: 'ok', label: 'OK', efforts: [{ id: 'low', label: 'Low' }, { id: '' }] },
        { id: 'bad id!' },
        null,
      ]),
    ).toEqual([{ id: 'ok', label: 'OK', efforts: [{ id: 'low', label: 'Low' }] }])
  })

  it('keeps slash model ids and drops slash effort ids', () => {
    expect(sanitizeModels([{ id: 'moonshotai/kimi-k3', label: 'Kimi K3' }])).toEqual([
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
    ])
    expect(sanitizeEfforts([{ id: 'a/b', label: 'nope' }])).toEqual([])
    expect(sanitizeModels([{ id: '../x' }, { id: 'a b' }])).toEqual([])
    expect(sanitizeEfforts([{ id: '../x' }, { id: 'a b' }])).toEqual([])
  })
})

describe('appendModelEffortArgv', () => {
  const claude = claudeSheet()
  it('appends flags for listed values', () => {
    expect(appendModelEffortArgv(['claude'], claude, 'fable', 'high')).toEqual([
      'claude',
      '--model',
      'fable',
      '--effort',
      'high',
    ])
  })

  it('omits unknown values and when the harness has no flag', () => {
    expect(appendModelEffortArgv(['claude'], claude, 'not-a-model', 'nope')).toEqual(['claude'])
    expect(
      appendModelEffortArgv(
        ['kimi'],
        { models: [{ id: 'k2p5', label: 'k2p5' }], modelFlag: '--model' },
        'k2',
        'high',
      ),
    ).toEqual(['kimi'])
    expect(appendModelEffortArgv(['codex'], sheetForHarness('codex'), 'x', 'y')).toEqual([
      'codex',
    ])
  })

  it('kimi spawn is --model <slash-id> with no effort flag', () => {
    const sheet = kimiSheet(() => CT116_TOML, '/home/tester')
    expect(sheet.effortFlag).toBeUndefined()
    expect(appendModelEffortArgv(['kimi'], sheet, 'moonshotai/kimi-k3', 'high')).toEqual([
      'kimi',
      '--model',
      'moonshotai/kimi-k3',
    ])
  })

  it("uses the model's own efforts when present", () => {
    const grok = grokSheet(() => GROK_CACHE, '/tmp')
    expect(appendModelEffortArgv(['grok'], grok, 'grok-4.6', 'xhigh')).toEqual([
      'grok',
      '--model',
      'grok-4.6',
      '--reasoning-effort',
      'xhigh',
    ])
    // grok-4.5 only lists high
    expect(appendModelEffortArgv(['grok'], grok, 'grok-4.5', 'xhigh')).toEqual([
      'grok',
      '--model',
      'grok-4.5',
    ])
  })
})
