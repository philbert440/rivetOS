/**
 * Phase 3: Agent configuration — provider, model, API key, thinking level.
 */

import * as p from '@clack/prompts'
import type { WizardAgent } from './types.js'

function bail<T>(v: T | symbol): asserts v is T {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
}

/** Default models per provider */
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  xai: 'grok-4-1-fast-reasoning',
  google: 'gemini-2.5-pro',
  ollama: 'qwen2.5:32b',
  'openai-compat': 'gpt-4o',
}

/** Environment variable name for each provider's API key */
export const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  'openai-compat': 'OPENAI_API_KEY',
}

export async function configureAgents(): Promise<WizardAgent[]> {
  const agents: WizardAgent[] = []
  let addMore = true

  while (addMore) {
    const isFirst = agents.length === 0
    const agentNum = agents.length + 1

    if (!isFirst) {
      p.log.info('')
    }

    // Agent name
    const nameResult = await p.text({
      message: `Agent ${agentNum} name`,
      placeholder: isFirst ? 'rivet' : `agent-${agentNum}`,
      defaultValue: isFirst ? 'rivet' : undefined,
      validate: (val) => {
        if (!val || !val.trim()) return 'Agent name is required'
        if (!/^[a-z0-9-]+$/.test(val)) return 'Use lowercase letters, numbers, and hyphens only'
        if (agents.some((a) => a.name === val)) return `Agent "${val}" already exists`
        return undefined
      },
    })
    bail(nameResult)
    const name: string = nameResult

    // Provider
    const providerResult = await p.select({
      message: 'AI provider',
      options: [
        { value: 'anthropic' as const, label: 'Anthropic', hint: 'Claude' },
        { value: 'xai' as const, label: 'xAI', hint: 'Grok' },
        { value: 'google' as const, label: 'Google', hint: 'Gemini' },
        { value: 'ollama' as const, label: 'Ollama', hint: 'local models' },
        {
          value: 'openai-compat' as const,
          label: 'OpenAI Compatible',
          hint: 'OpenRouter, Together, etc.',
        },
      ],
    })
    bail(providerResult)
    const provider: string = providerResult

    // API key or base URL
    let apiKey: string | undefined
    let baseUrl: string | undefined

    if (provider === 'ollama') {
      const urlResult = await p.text({
        message: 'Ollama base URL',
        placeholder: 'http://localhost:11434',
        defaultValue: 'http://localhost:11434',
      })
      bail(urlResult)
      baseUrl = urlResult
    } else if (provider === 'openai-compat') {
      const urlResult = await p.text({
        message: 'API base URL',
        placeholder: 'https://openrouter.ai/api/v1',
      })
      bail(urlResult)
      baseUrl = urlResult

      const keyResult = await p.password({
        message: 'API key',
        validate: (val) => (val && val.trim() ? undefined : 'API key is required'),
      })
      bail(keyResult)
      apiKey = keyResult
    } else {
      // Standard providers with API keys
      const envKey = PROVIDER_ENV_KEYS[provider]
      const existingKey = envKey ? process.env[envKey] : undefined

      if (existingKey) {
        p.log.info(`Using existing ${envKey} from environment.`)
        apiKey = existingKey
      } else {
        const providerLabel =
          provider === 'anthropic' ? 'Anthropic' : provider === 'xai' ? 'xAI' : 'Google'
        const keyResult = await p.password({
          message: `${providerLabel} API key`,
          validate: (val) =>
            val && val.trim() ? undefined : 'API key is required (or set via environment variable)',
        })
        bail(keyResult)
        apiKey = keyResult
      }
    }

    // Model
    const defaultModel = DEFAULT_MODELS[provider] ?? 'default'
    const modelResult = await p.text({
      message: 'Model',
      placeholder: defaultModel,
      defaultValue: defaultModel,
    })
    bail(modelResult)
    const model: string = modelResult

    // Thinking level
    const thinkingResult = await p.select({
      message: 'Thinking level',
      options: [
        { value: 'off' as const, label: 'Off', hint: 'no extended thinking' },
        { value: 'low' as const, label: 'Low' },
        { value: 'medium' as const, label: 'Medium', hint: 'recommended' },
        { value: 'high' as const, label: 'High', hint: 'slower, more thorough' },
      ],
      initialValue: 'medium' as const,
    })
    bail(thinkingResult)
    const thinking: string = thinkingResult

    agents.push({ name, provider, model, thinking, apiKey, baseUrl })

    p.log.success(`Agent "${name}" configured (${provider} / ${model})`)

    // Add another?
    const moreResult = await p.confirm({
      message: 'Add another agent?',
      initialValue: false,
    })
    bail(moreResult)
    addMore = moreResult
  }

  return agents
}
