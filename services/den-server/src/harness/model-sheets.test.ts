import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  __resetClaudeCacheMemoForTests,
  __resetDiscoveryCacheForTests,
  appendModelEffortArgv,
  applySheetOverride,
  backgroundDiscovery,
  claudeGlobalConfigPath,
  claudeSheet,
  codexHome,
  codexSheet,
  EFFORT_TOKEN_RE,
  parseCodexCatalog,
  parseCodexConfigModel,
  resolveModelsMode,
  grokSheet,
  hermesSheet,
  parseHermesModelConfig,
  __resetHermesEndpointCacheForTests,
  kimiSheet,
  opencodeSheet,
  parseOpencodeConfig,
  piSheet,
  qwenCodeSheet,
  MODEL_TOKEN_RE,
  parseKimiToml,
  sanitizeEfforts,
  sanitizeModels,
  sheetForHarness,
} from './model-sheets.js'
import type { ReadJson, RunCommand } from './model-sheets.js'

const SAMPLE_TOML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/kimi-config-sample.toml'),
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

const CLAUDE_JSON = {
  additionalModelOptionsCache: [
    { value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 · Most capable' },
    { value: 'cc-update-required-1', label: 'Opus 5.5 (disabled)', disabled: true },
  ],
}

const BASE_CLAUDE_IDS = ['fable', 'opus', 'sonnet', 'haiku', 'fable[1m]', 'opus[1m]', 'sonnet[1m]']

/** A reader that has no ~/.claude.json — keeps claudeSheet() on the base list. */
const noClaudeJson: ReadJson = () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

describe('claudeSheet', () => {
  it('declares aliases including 1M variants and medium-default efforts', () => {
    const sheet = claudeSheet(noClaudeJson, '/tmp/fake-home')
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBe('--effort')
    expect(sheet.models?.map((m) => m.id)).toEqual(BASE_CLAUDE_IDS)
    expect(sheet.models?.find((m) => m.default)?.id).toBe('fable')
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('medium')
    expect(sheet.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
  it('advertises launch-time model selection (#814)', () => {
    expect(claudeSheet().launchModel).toBe(true)
    // Sheets whose launch model is config-owned or flag-less stay silent:
    // a `models` + `modelFlag` sheet does NOT imply `launchModel`.
    expect(codexSheet(NO_CODEX).launchModel).toBe(true)
    expect(grokSheet(() => GROK_CACHE, '/tmp/fake-home').launchModel).toBeUndefined()
    expect(kimiSheet(() => '', '/tmp/fake-home').launchModel).toBeUndefined()
  })

  it('appends non-disabled cache models and skips gated ones', () => {
    const sheet = claudeSheet(() => CLAUDE_JSON, '/tmp/fake-home')
    expect(sheet.models?.map((m) => m.id)).toEqual([...BASE_CLAUDE_IDS, 'claude-fable-5-1[1m]'])
    const fable = sheet.models?.find((m) => m.id === 'claude-fable-5-1[1m]')
    expect(fable).toMatchObject({ id: 'claude-fable-5-1[1m]', label: 'Fable' })
    // Per-model efforts are left off so the sheet's Claude effort set applies.
    expect(fable?.efforts).toBeUndefined()
    // The update-gated row is never offered.
    expect(sheet.models?.some((m) => m.id === 'cc-update-required-1')).toBe(false)
    expect(sheet.models?.find((m) => m.default)?.id).toBe('fable')
  })

  it('resolves the global config path from CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeGlobalConfigPath('/h', {})).toBe('/h/.claude.json')
    expect(claudeGlobalConfigPath('/h', { CLAUDE_CONFIG_DIR: '/cfg' })).toBe('/cfg/.claude.json')
    expect(claudeGlobalConfigPath('/h', { CLAUDE_CONFIG_DIR: '   ' })).toBe('/h/.claude.json')
  })

  it('merges cache rows from $CLAUDE_CONFIG_DIR/.claude.json when set', () => {
    const paths: string[] = []
    const sheet = claudeSheet(
      (path) => {
        paths.push(path)
        return CLAUDE_JSON
      },
      '/h',
      { CLAUDE_CONFIG_DIR: '/cfg' },
    )
    expect(paths).toEqual(['/cfg/.claude.json'])
    expect(sheet.models?.map((m) => m.id)).toEqual([...BASE_CLAUDE_IDS, 'claude-fable-5-1[1m]'])
  })

  it('drops a cache row whose id already exists in the base list', () => {
    const sheet = claudeSheet(
      () => ({ additionalModelOptionsCache: [{ value: 'opus', label: 'Dup Opus' }] }),
      '/tmp/fake-home',
    )
    expect(sheet.models?.map((m) => m.id)).toEqual(BASE_CLAUDE_IDS)
    expect(sheet.models?.find((m) => m.id === 'opus')?.label).toBe('Opus 5')
  })

  it('drops malformed and invalid-id cache rows', () => {
    const sheet = claudeSheet(
      () => ({
        additionalModelOptionsCache: [
          { value: '../evil', label: 'Traversal' },
          { value: 42 },
          { label: 'no value' },
          'not-an-object',
          { value: 'claude-new-model', label: '' },
        ],
      }),
      '/tmp/fake-home',
    )
    // Only the last, valid row survives; empty label falls back to the id.
    expect(sheet.models?.map((m) => m.id)).toEqual([...BASE_CLAUDE_IDS, 'claude-new-model'])
    expect(sheet.models?.find((m) => m.id === 'claude-new-model')?.label).toBe('claude-new-model')
  })

  it('keeps the base list when the cache is missing or unshaped', () => {
    expect(claudeSheet(() => ({}), '/tmp/fake-home').models?.map((m) => m.id)).toEqual(
      BASE_CLAUDE_IDS,
    )
    expect(
      claudeSheet(() => ({ additionalModelOptionsCache: 'nope' }), '/tmp/fake-home').models?.map(
        (m) => m.id,
      ),
    ).toEqual(BASE_CLAUDE_IDS)
  })

  it('memoizes cache rows per path and refreshes when mtime/size change', () => {
    __resetClaudeCacheMemoForTests()
    const dir = mkdtempSync(join(tmpdir(), 'claude-sheet-'))
    try {
      const path = join(dir, '.claude.json')
      const env = { CLAUDE_CONFIG_DIR: dir }
      const write = (value: string, seconds: number): void => {
        writeFileSync(path, JSON.stringify({ additionalModelOptionsCache: [{ value }] }))
        utimesSync(path, seconds, seconds)
      }

      write('claude-first', 1_000_000)
      const first = claudeSheet(undefined, dir, env)
      expect(first.models?.map((m) => m.id)).toEqual([...BASE_CLAUDE_IDS, 'claude-first'])

      // Different content plus a bumped mtime invalidates the memoized rows.
      write('claude-second', 2_000_000)
      const second = claudeSheet(undefined, dir, env)
      expect(second.models?.map((m) => m.id)).toEqual([...BASE_CLAUDE_IDS, 'claude-second'])

      // An unchanged file returns the memoized rows without re-reading.
      expect(claudeSheet(undefined, dir, env).models).toEqual(second.models)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    }, '/home/user')
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBeUndefined()
    expect(sheet.efforts).toBeUndefined()
    expect(sheet.models?.map((m) => m.id)).toEqual(['k2p5', 'kimi-for-coding'])
  })

  it('returns models: [] when no config is readable', () => {
    const sheet = kimiSheet(() => {
      throw new Error('ENOENT')
    })
    expect(sheet).toEqual({ models: [], modelsSource: 'static', modelFlag: '--model' })
  })

  it('parses the sample config fixture (quoted slash aliases)', () => {
    const models = parseKimiToml(SAMPLE_TOML)
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

  it('accepts a non-leading ~ (OpenRouter aliases) and rejects a leading ~', () => {
    expect(MODEL_TOKEN_RE.test('openrouter/~z-ai/glm-latest')).toBe(true)
    expect(MODEL_TOKEN_RE.test('openrouter/~deepseek/deepseek-flash-latest')).toBe(true)
    expect(MODEL_TOKEN_RE.test('~z-ai/glm-latest')).toBe(false)
    expect(MODEL_TOKEN_RE.test('~')).toBe(false)
    expect(MODEL_TOKEN_RE.test('a~' + 'b'.repeat(62))).toBe(true)
    expect(MODEL_TOKEN_RE.test('a~' + 'b'.repeat(63))).toBe(false)
    expect(MODEL_TOKEN_RE.test('openrouter/~z-ai/../x')).toBe(false)
    expect(MODEL_TOKEN_RE.test('a:~b')).toBe(true)
  })
})

describe('hermesSheet', () => {
  const HERMES_YAML = [
    '# comment',
    'model:',
    '  default: qwen-27b',
    '  provider: custom',
    "  base_url: 'http://10.0.0.5:8003/v1' # local vLLM",
    'auxiliary:',
    '  vision:',
    '    model: other',
    '',
  ].join('\n')

  it('parses the top-level model block and ignores nested model keys', () => {
    expect(parseHermesModelConfig(HERMES_YAML)).toEqual({
      default: 'qwen-27b',
      provider: 'custom',
      baseUrl: 'http://10.0.0.5:8003/v1',
    })
    expect(parseHermesModelConfig('model: "anthropic/claude-x"\n')).toEqual({
      default: 'anthropic/claude-x',
    })
    expect(parseHermesModelConfig('agent:\n  model: x\n')).toEqual({})
  })

  it('no config: no models, but -m and --reasoning flags', () => {
    const sheet = hermesSheet(() => {
      throw new Error('ENOENT')
    }, '/no-such-home')
    expect(sheet.models).toEqual([])
    expect(sheet.modelFlag).toBe('-m')
    expect(sheet.effortFlag).toBe('--reasoning')
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('medium')
  })

  it('lists the config default, then endpoint ids once the background fetch lands', async () => {
    __resetHermesEndpointCacheForTests()
    const calls: string[] = []
    const fetchIds = (base: string): Promise<string[]> => {
      calls.push(base)
      return Promise.resolve(['qwen-27b', 'aggressive', 'bad id!'])
    }
    const first = hermesSheet(() => HERMES_YAML, '/h', fetchIds, 0)
    expect(first.models).toEqual([{ id: 'qwen-27b', label: 'qwen-27b', default: true }])
    expect(first.launchModel).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    const second = hermesSheet(() => HERMES_YAML, '/h', fetchIds, 1)
    expect(second.models?.map((m) => m.id)).toEqual(['qwen-27b', 'aggressive'])
    expect(calls).toEqual(['http://10.0.0.5:8003/v1'])
    expect(appendModelEffortArgv(['hermes'], second, 'aggressive', 'high')).toEqual([
      'hermes',
      '-m',
      'aggressive',
      '--reasoning',
      'high',
    ])
  })

  it('keeps the config default when the endpoint is down', async () => {
    __resetHermesEndpointCacheForTests()
    const fetchIds = (): Promise<string[]> => Promise.reject(new Error('ECONNREFUSED'))
    hermesSheet(() => HERMES_YAML, '/h', fetchIds, 0)
    await new Promise((r) => setTimeout(r, 0))
    expect(hermesSheet(() => HERMES_YAML, '/h', fetchIds, 1).models?.map((m) => m.id)).toEqual([
      'qwen-27b',
    ])
  })

  it('deepseek is empty', () => {})

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

describe('qwenCodeSheet', () => {
  it('is empty with -m and no effort flag when settings.json is missing', () => {
    const sheet = qwenCodeSheet(() => {
      throw new Error('ENOENT')
    }, '/no-such-home')
    expect(sheet.modelFlag).toBe('-m')
    expect(sheet.effortFlag).toBeUndefined()
    expect(sheet.models).toEqual([])
    expect(sheet.efforts).toBeUndefined()
    expect(appendModelEffortArgv(['qwen'], sheet, 'qwen-27b')).toEqual(['qwen'])
  })

  it('reads modelProviders entries and only attaches efforts when declared', () => {
    // Sample settings shape (baseUrl scrubbed to RFC5737) plus one reasoning entry.
    const settings = {
      modelProviders: {
        openai: [
          {
            id: 'qwen-27b',
            name: 'qwen-27b (local vLLM)',
            baseUrl: 'http://192.0.2.10:8003/v1',
            envKey: 'OPENAI_API_KEY',
          },
          {
            id: 'qwen-think',
            name: 'qwen-think',
            capabilities: {
              reasoning: {
                profile: 'qwen-chat-template',
                efforts: ['low', 'medium', 'high'],
                defaultEffort: 'medium',
              },
            },
          },
        ],
      },
      model: { name: 'qwen-27b' },
    }
    const sheet = qwenCodeSheet((p) => {
      if (p === '/home/example/.qwen/settings.json') return settings
      throw new Error('ENOENT')
    }, '/home/example')
    expect(sheet.modelFlag).toBe('-m')
    expect(sheet.effortFlag).toBeUndefined()
    expect(sheet.models?.map((m) => m.id)).toEqual(['qwen-27b', 'qwen-think'])
    expect(sheet.models?.[0]).toMatchObject({
      id: 'qwen-27b',
      label: 'qwen-27b (local vLLM)',
      default: true,
    })
    expect(sheet.models?.[0]?.efforts).toBeUndefined()
    expect(sheet.models?.[1]?.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high'])
    expect(sheet.models?.[1]?.efforts?.find((e) => e.default)?.id).toBe('medium')
    expect(appendModelEffortArgv(['qwen'], sheet, 'qwen-27b')).toEqual(['qwen', '-m', 'qwen-27b'])
    expect(appendModelEffortArgv(['qwen'], sheet, 'qwen-think', 'high')).toEqual([
      'qwen',
      '-m',
      'qwen-think',
    ])
    expect(
      sheetForHarness('qwen-code', { readJson: () => settings, home: '/home/example' }).modelFlag,
    ).toBe('-m')
  })
})

describe('opencodeSheet', () => {
  it('reads a default model from injected opencode.json', () => {
    const sheet = opencodeSheet((path) => {
      if (path.endsWith('opencode.json')) return { model: 'zai/glm-5.3-flash' }
      throw new Error('missing')
    }, '/home/user')
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

  it('keeps OpenRouter ~ aliases in the sheet and on argv', () => {
    expect(
      parseOpencodeConfig({
        provider: { openrouter: { models: { '~z-ai/glm-latest': {} } } },
      }),
    ).toEqual([{ id: 'openrouter/~z-ai/glm-latest', label: 'openrouter/~z-ai/glm-latest' }])
    const sheet = opencodeSheet((path) => {
      if (path.endsWith('opencode.json')) {
        return { provider: { openrouter: { models: { '~z-ai/glm-latest': {} } } } }
      }
      throw new Error('missing')
    }, '/home/user')
    expect(appendModelEffortArgv(['opencode'], sheet, 'openrouter/~z-ai/glm-latest')).toEqual([
      'opencode',
      '--model',
      'openrouter/~z-ai/glm-latest',
    ])
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

/** The shape `codex debug models` renders and `models_cache.json` stores. */
const CODEX_CATALOG = {
  models: [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      visibility: 'list',
      priority: 12,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
      ],
      input_modalities: ['text', 'image'],
    },
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      visibility: 'list',
      priority: 1,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' },
        { effort: 'ultra' },
      ],
      input_modalities: ['text', 'image'],
    },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 3 },
    { slug: 'bad id!', display_name: 'Bad', visibility: 'list', priority: 0 },
  ],
}

const noJson: ReadJson = () => {
  throw new Error('ENOENT')
}
const noText = (): string => {
  throw new Error('ENOENT')
}
/** A listing that never answers: the sheet must not wait for it. */
const hangs: RunCommand = () => new Promise<string>(() => undefined)
/** No cache file, no config.toml, a hung CLI → the static floor. */
const NO_CODEX = {
  readJson: noJson,
  readText: noText,
  home: '/h',
  env: {},
  runCommand: hangs,
  now: 0,
}

describe('parseCodexCatalog / parseCodexConfigModel', () => {
  it('keeps listed rows in priority order with per-model efforts and modalities', () => {
    const rows = parseCodexCatalog(CODEX_CATALOG)
    expect(rows.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5'])
    expect(rows[0].label).toBe('GPT-6-Astra')
    expect(rows[0].efforts?.map((e) => e.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
    expect(rows[0].efforts?.find((e) => e.default)?.id).toBe('medium')
    expect(rows[0].efforts?.find((e) => e.id === 'ultra')?.label).toBe('Ultra')
    expect(rows[0].inputModalities).toEqual(['text', 'image'])
    expect(parseCodexCatalog({ models: 'nope' })).toEqual([])
    expect(parseCodexCatalog(null)).toEqual([])
  })

  it('reads the top-level model of config.toml and ignores table-scoped keys', () => {
    expect(
      parseCodexConfigModel('approvals = "user"\nmodel = "gpt-5.5"\n[tui]\nmodel = "x"\n'),
    ).toBe('gpt-5.5')
    expect(parseCodexConfigModel('[tui]\nmodel = "x"\n')).toBeUndefined()
    expect(parseCodexConfigModel('')).toBeUndefined()
  })

  it('codexHome honors CODEX_HOME', () => {
    expect(codexHome('/h', {})).toBe('/h/.codex')
    expect(codexHome('/h', { CODEX_HOME: '/cfg' })).toBe('/cfg')
  })
})

describe('codexSheet', () => {
  it('static floor when nothing is discoverable — and a hung listing never blocks', () => {
    __resetDiscoveryCacheForTests()
    const sheet = codexSheet(NO_CODEX)
    expect(sheet.models).toEqual([])
    expect(sheet.modelsSource).toBe('static')
    expect(sheet.modelFlag).toBe('--model')
    expect(sheet.effortFlag).toBe('-c')
    expect(sheet.effortArgPrefix).toBe('model_reasoning_effort=')
    expect(sheet.launchModel).toBe(true)
    expect(sheet.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(sheet.efforts?.find((e) => e.default)?.id).toBe('medium')
    expect(sheetForHarness('codex', { ...NO_CODEX })).toEqual(sheet)
    // An unlisted model is dropped visibly (the log names the harness and the
    // list's source); the sheet-wide effort still applies to the CLI's own default.
    const logs: string[] = []
    expect(
      appendModelEffortArgv(['codex'], sheet, 'gpt-5.5', 'high', (m) => logs.push(m), 'codex'),
    ).toEqual(['codex', '-c', 'model_reasoning_effort=high'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('for codex')
    expect(logs[0]).toContain('static model list')
  })

  it('reads the CLI catalog cache: visibility, priority, per-model efforts, config default', () => {
    __resetDiscoveryCacheForTests()
    const paths: string[] = []
    const readJson: ReadJson = (path) => {
      paths.push(path)
      return CODEX_CATALOG
    }
    const sheet = codexSheet({
      ...NO_CODEX,
      readJson,
      readText: () => 'approvals_reviewer = "user"\nmodel = "gpt-5.5"\n[tui]\nmodel = "x"\n',
      env: { CODEX_HOME: '/cfg' },
    })
    expect(paths).toEqual(['/cfg/models_cache.json'])
    expect(sheet.modelsSource).toBe('discovered')
    expect(sheet.models?.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5'])
    expect(sheet.models?.find((m) => m.default)?.id).toBe('gpt-5.5')
    // Per-model efforts drive the -c form; `ultra` only where the catalog lists it.
    expect(appendModelEffortArgv(['codex'], sheet, 'gpt-6-astra', 'ultra')).toEqual([
      'codex',
      '--model',
      'gpt-6-astra',
      '-c',
      'model_reasoning_effort=ultra',
    ])
    expect(appendModelEffortArgv(['codex'], sheet, 'gpt-5.5', 'ultra')).toEqual([
      'codex',
      '--model',
      'gpt-5.5',
    ])
  })

  it('a configured model the catalog does not know becomes the default row (custom gateway)', () => {
    __resetDiscoveryCacheForTests()
    const sheet = codexSheet({
      ...NO_CODEX,
      readJson: () => CODEX_CATALOG,
      readText: () => 'model = "my-gateway/model-x"\n',
    })
    expect(sheet.models?.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5', 'my-gateway/model-x'])
    expect(sheet.models?.find((m) => m.default)?.id).toBe('my-gateway/model-x')
    expect(sheet.models?.filter((m) => m.default)).toHaveLength(1)
  })

  it('`codex debug models` lands in the background, once per TTL, on the spawn PATH', async () => {
    __resetDiscoveryCacheForTests()
    const calls: { argv: string[]; path: string | undefined }[] = []
    const runCommand: RunCommand = (argv, opts) => {
      calls.push({ argv, path: opts.env.PATH })
      return Promise.resolve(JSON.stringify(CODEX_CATALOG))
    }
    const first = codexSheet({ ...NO_CODEX, runCommand, env: { PATH: '/usr/bin' }, now: 0 })
    expect(first.models).toEqual([])
    expect(first.modelsSource).toBe('static')
    expect(calls).toEqual([{ argv: ['codex', 'debug', 'models'], path: '/usr/bin:/h/.local/bin' }])
    await new Promise((r) => setTimeout(r, 0))
    const second = codexSheet({ ...NO_CODEX, runCommand, env: { PATH: '/usr/bin' }, now: 1 })
    expect(second.modelsSource).toBe('discovered')
    expect(second.models?.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5'])
    expect(second.models?.find((m) => m.default)?.id).toBe('gpt-6-astra')
    expect(calls).toHaveLength(1)
    // Cache-file rows and CLI rows dedupe by id.
    const both = codexSheet({
      ...NO_CODEX,
      readJson: () => CODEX_CATALOG,
      runCommand,
      env: { PATH: '/usr/bin' },
      now: 2,
    })
    expect(both.models?.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5'])
  })

  it('a failing listing keeps the static sheet and logs once per outage', async () => {
    __resetDiscoveryCacheForTests()
    let calls = 0
    const runCommand: RunCommand = () => {
      calls += 1
      return Promise.reject(new Error('spawn codex ENOENT'))
    }
    const logs: string[] = []
    const log = (m: string): void => {
      logs.push(m)
    }
    expect(codexSheet({ ...NO_CODEX, runCommand, log, now: 0 }).modelsSource).toBe('static')
    await new Promise((r) => setTimeout(r, 0))
    expect(codexSheet({ ...NO_CODEX, runCommand, log, now: 1 }).modelsSource).toBe('static')
    expect(calls).toBe(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('codex:debug-models')
    expect(logs[0]).toContain('ENOENT')
    // Past the TTL it tries again but does not repeat the line while still failing.
    codexSheet({ ...NO_CODEX, runCommand, log, now: 5 * 60_000 + 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(2)
    expect(logs).toHaveLength(1)
  })
})

describe('backgroundDiscovery', () => {
  it('re-arms the outage log after a success', async () => {
    __resetDiscoveryCacheForTests()
    const logs: string[] = []
    const log = (m: string): void => {
      logs.push(m)
    }
    let ok = false
    const run = (): Promise<number> => (ok ? Promise.resolve(1) : Promise.reject(new Error('down')))
    expect(backgroundDiscovery('t', run, { ttlMs: 10, now: 0, log })).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    ok = true
    expect(backgroundDiscovery('t', run, { ttlMs: 10, now: 20, log })).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    expect(backgroundDiscovery('t', run, { ttlMs: 10, now: 21, log })).toBe(1)
    ok = false
    backgroundDiscovery('t', run, { ttlMs: 10, now: 40, log })
    await new Promise((r) => setTimeout(r, 0))
    // last-known value survives the second outage; a second line is logged for it
    expect(backgroundDiscovery('t', run, { ttlMs: 10, now: 41, log })).toBe(1)
    expect(logs).toHaveLength(2)
    expect(logs[1]).toContain('last-known list')
  })
})

describe('resolveModelsMode', () => {
  it('explicit mode wins; otherwise a list means replace and no list means discover', () => {
    expect(resolveModelsMode(undefined)).toBe('discover')
    expect(resolveModelsMode({})).toBe('discover')
    expect(resolveModelsMode({ models: [{ id: 'x' }] })).toBe('replace')
    expect(resolveModelsMode({ efforts: [] })).toBe('replace')
    expect(resolveModelsMode({ models: [{ id: 'x' }], models_mode: 'merge' })).toBe('merge')
    expect(resolveModelsMode({ models: [{ id: 'x' }], models_mode: 'discover' })).toBe('discover')
    expect(resolveModelsMode({ models: [{ id: 'x' }], models_mode: 'bogus' })).toBe('replace')
  })
})

describe('applySheetOverride', () => {
  it('a models list with no models_mode replaces, and the sheet says so', () => {
    const next = applySheetOverride(claudeSheet(noClaudeJson, '/tmp/fake-home'), {
      models: [{ id: 'only', label: 'Only' }],
    })
    expect(next.models).toEqual([{ id: 'only', label: 'Only' }])
    expect(next.modelsSource).toBe('config')
  })

  it('merge: discovered plus config rows, deduped, config wins, config default clears the sheet default', () => {
    const base = claudeSheet(noClaudeJson, '/tmp/fake-home')
    const next = applySheetOverride(base, {
      models_mode: 'merge',
      models: [
        { id: 'opus', label: 'Opus (gateway)', efforts: [{ id: 'max', label: 'Max' }] },
        { id: 'gateway-x', label: 'Gateway X', default: true },
      ],
      efforts: [
        { id: 'xhigh', label: 'Extra' },
        { id: 'ultra', label: 'Ultra' },
      ],
    })
    expect(next.modelsSource).toBe('merged')
    const ids = next.models?.map((m) => m.id) ?? []
    expect(ids.slice(0, 4)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(ids.at(-1)).toBe('gateway-x')
    expect(ids.filter((id) => id === 'opus')).toHaveLength(1)
    expect(next.models?.find((m) => m.id === 'opus')).toEqual({
      id: 'opus',
      label: 'Opus (gateway)',
      efforts: [{ id: 'max', label: 'Max' }],
    })
    expect(next.models?.filter((m) => m.default).map((m) => m.id)).toEqual(['gateway-x'])
    expect(next.efforts?.map((e) => e.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
    expect(next.efforts?.find((e) => e.id === 'xhigh')?.label).toBe('Extra')
    // medium keeps its default: the config efforts named none
    expect(next.efforts?.find((e) => e.default)?.id).toBe('medium')
    // the sheet's own rows were not mutated
    expect(base.models?.find((m) => m.default)?.id).toBe('fable')
  })

  it('discover: a stray list is ignored and logged', () => {
    const base = claudeSheet(noClaudeJson, '/tmp/fake-home')
    const logs: string[] = []
    const next = applySheetOverride(base, { models_mode: 'discover', models: [{ id: 'x' }] }, (m) =>
      logs.push(m),
    )
    expect(next.models).toEqual(base.models)
    expect(next.modelsSource).toBe('static')
    expect(logs).toEqual([
      '[den-server] harness sheet: models_mode is discover — ignoring the models/efforts override',
    ])
  })

  it('replaces models/efforts when the override carries that key', () => {
    const base = claudeSheet(noClaudeJson, '/tmp/fake-home')
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
    const base = claudeSheet(noClaudeJson, '/tmp/fake-home')
    const next = applySheetOverride(base, { models: 'nope', efforts: { id: 'x' } })
    expect(next.models).toEqual(base.models)
    expect(next.efforts).toEqual(base.efforts)
  })

  it('ignores an override that sanitizes to empty and logs', () => {
    const base = claudeSheet(noClaudeJson, '/tmp/fake-home')
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
  const claude = claudeSheet(noClaudeJson, '/tmp/fake-home')
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
    expect(appendModelEffortArgv(['codex'], sheetForHarness('codex', NO_CODEX), 'x', 'y')).toEqual([
      'codex',
    ])
  })

  it('kimi spawn is --model <slash-id> with no effort flag', () => {
    const sheet = kimiSheet(() => SAMPLE_TOML, '/home/user')
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

  it('splits a hermes named provider and leaves another harness colon model unchanged', () => {
    const hermes = applySheetOverride(
      hermesSheet(() => {
        throw new Error('ENOENT')
      }, '/no-such-home'),
      {
        models: [
          { id: 'custom:p:m', label: 'named' },
          { id: 'qwen-27b', label: 'plain' },
          { id: 'custom:local:qwen3.5:27b', label: 'colons' },
        ],
      },
    )
    expect(MODEL_TOKEN_RE.test('custom:p:m')).toBe(true)
    expect(MODEL_TOKEN_RE.test('custom:local:qwen3.5:27b')).toBe(true)
    expect(appendModelEffortArgv(['hermes'], hermes, 'custom:p:m')).toEqual([
      'hermes',
      '--provider',
      'p',
      '-m',
      'm',
    ])
    expect(appendModelEffortArgv(['hermes'], hermes, 'custom:local:qwen3.5:27b')).toEqual([
      'hermes',
      '--provider',
      'local',
      '-m',
      'qwen3.5:27b',
    ])
    expect(appendModelEffortArgv(['hermes'], hermes, 'qwen-27b')).toEqual(['hermes', '-m', 'qwen-27b'])

    // qwen-code also uses `-m`; a colon model, including the named-provider shape, stays one flag.
    const qwen = applySheetOverride(
      qwenCodeSheet(() => {
        throw new Error('ENOENT')
      }, '/no-such-home'),
      { models: [{ id: 'custom:p:m', label: 'colon' }] },
    )
    expect(qwen.namedCustomProvider).toBeUndefined()
    expect(appendModelEffortArgv(['qwen'], qwen, 'custom:p:m')).toEqual(['qwen', '-m', 'custom:p:m'])
  })
})
