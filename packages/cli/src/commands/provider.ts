/**
 * rivetos <provider> <action>
 *
 * Provider-specific commands:
 *   rivetos anthropic setup      — OAuth login
 *   rivetos anthropic status     — check auth
 *   rivetos xai status           — check connectivity
 *   rivetos google status        — check connectivity
 *   rivetos ollama status        — check connectivity
 *   rivetos ollama models        — list models
 *   rivetos ollama pull <model>  — pull a model
 */

interface OllamaModel {
  name: string
  size: number
  modified_at?: string
}

interface OllamaTagsResponse {
  models: OllamaModel[]
}

export default async function provider(providerName: string): Promise<void> {
  const action = process.argv[3]

  if (!action || action === 'help') {
    showProviderHelp(providerName)
    return
  }

  switch (providerName) {
    case 'anthropic':
      await handleAnthropic(action)
      break
    case 'xai':
      await handleSimpleProvider('xai', 'https://api.x.ai/v1', 'XAI_API_KEY', action)
      break
    case 'google':
      await handleSimpleProvider(
        'google',
        'https://generativelanguage.googleapis.com/v1beta',
        'GOOGLE_API_KEY',
        action,
      )
      break
    case 'ollama':
      await handleOllama(action)
      break
    default:
      console.error(`Unknown provider: ${providerName}`)
      process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function handleAnthropic(action: string): Promise<void> {
  switch (action) {
    case 'setup':
    case 'login': {
      const { saveTokens, detectAuthMode } = await import('@rivetos/provider-anthropic')
      const { createInterface } = await import('node:readline')

      console.log('🔐 Anthropic Setup\n')
      console.log('Paste your Anthropic API key or Claude subscription token.\n')
      console.log('  API key:    sk-ant-api03-...  (from console.anthropic.com)')
      console.log('  Sub token:  sk-ant-oat01-...  (from Claude Pro/Max subscription)\n')

      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const token = await new Promise<string>((resolve) => {
        rl.question('Paste key or token: ', (answer) => {
          rl.close()
          resolve(answer.trim())
        })
      })

      if (!token) {
        console.error('Nothing provided.')
        process.exit(1)
      }

      const mode = detectAuthMode(token)

      if (mode === 'oauth') {
        // Store as OAuth token — provider will use Bearer auth + beta headers
        await saveTokens({
          accessToken: token,
          refreshToken: '', // No refresh for pasted tokens — re-paste when expired
          expiresAt: 0, // Unknown expiry
        })
        console.log('\n✅ Claude subscription token saved')
        console.log('   Auth mode: OAuth (Bearer + claude-code beta headers)')
        console.log('   Note: If this token expires, just run setup again with a fresh one.')
      } else {
        // Store as API key
        await saveTokens({
          accessToken: token,
          refreshToken: '',
          expiresAt: Number.MAX_SAFE_INTEGER, // API keys don't expire
        })
        console.log('\n✅ Anthropic API key saved')
        console.log('   Auth mode: API key (x-api-key header)')
      }
      break
    }

    case 'status': {
      const { loadTokens } = await import('@rivetos/provider-anthropic')
      const tokens = await loadTokens()

      if (!tokens) {
        console.log('❌ Not authenticated')
        console.log('   Run: rivetos anthropic setup')
        return
      }

      const expired = Date.now() >= tokens.expiresAt
      const hasRefresh = !!tokens.refreshToken

      console.log('Anthropic Auth Status:')
      console.log(`  Access token: ${tokens.accessToken.slice(0, 15)}...`)
      console.log(
        `  Expires: ${new Date(tokens.expiresAt).toLocaleString()} ${expired ? '(EXPIRED)' : '(valid)'}`,
      )
      console.log(
        `  Refresh token: ${hasRefresh ? '✅ available (auto-refresh enabled)' : '❌ none'}`,
      )

      if (expired && hasRefresh) {
        console.log('\n  Token expired but will auto-refresh on next API call.')
      } else if (expired && !hasRefresh) {
        console.log('\n  ❌ Token expired with no refresh token.')
        console.log('  Run: rivetos anthropic setup')
      }
      break
    }

    default:
      showProviderHelp('anthropic')
  }
}

// ---------------------------------------------------------------------------
// Simple providers (xAI, Google) — just check connectivity
// ---------------------------------------------------------------------------

async function handleSimpleProvider(
  name: string,
  baseUrl: string,
  envVar: string,
  action: string,
): Promise<void> {
  switch (action) {
    case 'status': {
      const key = process.env[envVar]
      if (!key) {
        console.log(`❌ ${envVar} not set`)
        return
      }

      console.log(`${name} Status:`)
      console.log(`  API key: ${key.slice(0, 12)}...`)

      try {
        const headers: Record<string, string> = {}
        if (name === 'xai') {
          headers.Authorization = `Bearer ${key}`
          const res = await fetch(`${baseUrl}/models`, {
            headers,
            signal: AbortSignal.timeout(5000),
          })
          console.log(`  Connectivity: ${res.ok ? '✅' : '❌'} (${res.status})`)
        } else if (name === 'google') {
          const res = await fetch(`${baseUrl}/models?key=${key}`, {
            signal: AbortSignal.timeout(5000),
          })
          console.log(`  Connectivity: ${res.ok ? '✅' : '❌'} (${res.status})`)
        }
      } catch (err: any) {
        console.log(`  Connectivity: ❌ (${err.message})`)
      }
      break
    }

    default:
      showProviderHelp(name)
  }
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

async function handleOllama(action: string): Promise<void> {
  const baseUrl = process.env.OLLAMA_HOST ?? 'http://localhost:11434'

  switch (action) {
    case 'status': {
      console.log('Ollama Status:')
      console.log(`  Host: ${baseUrl}`)
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          const data = (await res.json()) as OllamaTagsResponse
          const models = data.models ?? []
          console.log(`  Connectivity: ✅`)
          console.log(`  Models loaded: ${models.length}`)
          for (const m of models.slice(0, 5)) {
            const sizeMB = Math.round(m.size / 1024 / 1024)
            console.log(`    - ${m.name} (${sizeMB}MB)`)
          }
          if (models.length > 5) console.log(`    ... and ${models.length - 5} more`)
        } else {
          console.log(`  Connectivity: ❌ (${res.status})`)
        }
      } catch (err: any) {
        console.log(`  Connectivity: ❌ (${err.message})`)
      }
      break
    }

    case 'models': {
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })
        const data = (await res.json()) as OllamaTagsResponse
        const models = data.models ?? []
        if (models.length === 0) {
          console.log('No models found. Pull one: rivetos ollama pull <model>')
          return
        }
        console.log('Available models:')
        for (const m of models) {
          const sizeMB = Math.round(m.size / 1024 / 1024)
          console.log(`  ${m.name}  (${sizeMB}MB, modified ${m.modified_at?.split('T')[0] ?? '?'})`)
        }
      } catch (err: any) {
        console.error(`Failed to connect: ${err.message}`)
      }
      break
    }

    case 'pull': {
      const model = process.argv[4]
      if (!model) {
        console.error('Usage: rivetos ollama pull <model>')
        process.exit(1)
      }

      console.log(`Pulling ${model}...`)
      try {
        const res = await fetch(`${baseUrl}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, stream: true }),
        })

        if (!res.ok || !res.body) {
          console.error(`Failed: ${res.status}`)
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let lastStatus = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean)
          for (const line of lines) {
            try {
              const data = JSON.parse(line)
              if (data.status && data.status !== lastStatus) {
                console.log(`  ${data.status}`)
                lastStatus = data.status
              }
            } catch {}
          }
        }
        console.log('✅ Done')
      } catch (err: any) {
        console.error(`Failed: ${err.message}`)
      }
      break
    }

    default:
      showProviderHelp('ollama')
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showProviderHelp(name: string): void {
  const commands: Record<string, string[]> = {
    anthropic: [
      'rivetos anthropic setup      OAuth login for Claude subscription',
      'rivetos anthropic status     Check auth status',
    ],
    xai: ['rivetos xai status           Check connectivity'],
    google: ['rivetos google status        Check connectivity'],
    ollama: [
      'rivetos ollama status        Check connectivity + list models',
      'rivetos ollama models        List available models',
      'rivetos ollama pull <model>  Pull a model',
    ],
  }

  console.log(`\nUsage: rivetos ${name} <action>\n`)
  for (const line of commands[name] ?? []) {
    console.log(`  ${line}`)
  }
  console.log()
}
