/**
 * Tool-call content synthesis for v5 memory-quality pipeline.
 *
 * Async background synthesis of natural-language content for assistant messages that only have tool_name/tool_args (no content).
 * Uses the same hardened undici client and validation as the compactor.
 * Prompt is battle-tested from the backfill script in /rivet-shared/summary-refine/.
 *
 * See pr-spec.md §2.1 for exact requirements.
 */

import { Agent, fetch as undiciFetch } from 'undici'

interface LlmCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null
    } | null
  } | null> | null
}

const TOOL_SYNTH_SYSTEM_PROMPT = `You are indexing an AI assistant's tool-call history for semantic search.
Given a tool name and its JSON arguments, write ONE short natural-language sentence (≤25 words) describing what the assistant was doing.

=== HARD RULES ===
- Use past tense, neutral voice.
- Never start with "The assistant" (or any variant). Just state the action.
- Never use pronouns like "I" or "we".
- Preserve specific identifiers: paths, file names, commands, URLs, search queries, PR numbers, hostnames, port numbers.
- Do NOT quote raw JSON. Translate JSON args into readable prose.
- Do NOT add preambles, markdown, bullets, or explanatory prose. Output ONLY the sentence.

=== PAST-TENSE VERB WHITELIST (pick one that fits) ===
Executed, Ran, Called, Invoked, Read, Wrote, Edited, Created, Deleted, Killed, Started, Polled, Queried, Searched, Fetched, Listed, Checked, Sent, Uploaded, Downloaded, Copied, Moved, Renamed, Restarted, Tailed, Displayed, Computed, Validated, Built, Deployed, Committed, Pushed, Pulled, Merged.

=== FORMATTING ===
- Output a single plain sentence ending with a period.
- If a time/duration is in the args, render it in seconds or minutes (e.g. \`30000ms\` → \`30 seconds\`, not \`30000 seconds\`).
- Keep it factual — if the args are sparse, say less.

=== EXAMPLES ===
- exec {"command":"df -h /; free -h"}
  → Checked disk usage and free memory on the root filesystem.
- read {"path":"/opt/rivetos/plugins/memory/postgres/src/compactor/compactor.ts"}
  → Read the compactor source at \`plugins/memory/postgres/src/compactor/compactor.ts\`.
- memory_search {"query":"rivetos milestone status"}
  → Searched memory for \`rivetos milestone status\`.
- web_fetch {"url":"https://nvidia.com/blog/v100-eol"}
  → Fetched the Nvidia blog post about V100 end-of-life.
- edit {"path":"/etc/foo.conf","old_string":"port=8080","new_string":"port=9090"}
  → Edited \`/etc/foo.conf\` to change port 8080 to 9090.
- gateway {"path":"agents.list"}
  → Called the gateway \`agents.list\` endpoint.

Output ONLY the sentence. No JSON, no markdown, no preamble.`

const httpDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connect: { timeout: 30_000 },
  pipelining: 0,
})

export interface ToolSynthOptions {
  endpoint: string
  model: string
  apiKey?: string
  toolName: string
  toolArgs: unknown
  toolResult?: string | null
  precedingContent?: string | null
  timeoutMs?: number // default 120_000
}

export async function synthesizeToolCallContent(opts: ToolSynthOptions): Promise<string | null> {
  const {
    endpoint,
    model,
    apiKey,
    toolName,
    toolArgs,
    toolResult,
    precedingContent,
    timeoutMs = 120_000,
  } = opts

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  let lastError: Error | null = null
  const maxRetries = 3
  const backoffBase = 2000

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }

      // Build user message with context (no truncation on toolArgs)
      let userMsg = `tool_name: ${toolName}\n`
      userMsg += `tool_args: ${JSON.stringify(toolArgs)}\n`

      if (toolResult) {
        const truncatedResult = toolResult.slice(0, 10000)
        userMsg += `tool_result: ${truncatedResult}\n`
      }

      if (precedingContent) {
        const truncatedPre = precedingContent.slice(0, 4000)
        userMsg += `preceding_message: ${truncatedPre}`
      }

      const response = await undiciFetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: TOOL_SYNTH_SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
          max_tokens: 200,
          temperature: 0.2,
          enable_thinking: false,
        }),
        dispatcher: httpDispatcher,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const statusErr = new Error(`HTTP ${response.status}`)
        if (response.status >= 500 || response.status === 0) {
          lastError = statusErr
          if (attempt < maxRetries) {
            const backoff = (attempt + 1) * backoffBase
            await new Promise((r) => setTimeout(r, backoff))
            continue
          }
        }
        return null
      }

      const data = (await response.json()) as LlmCompletionResponse
      const content = data.choices?.[0]?.message?.content?.trim() ?? null

      if (!content) return null

      // Validation per spec
      if (/^the assistant/i.test(content)) return null
      if (content.length < 10 || content.length > 500) return null
      if (!/[.!?]$/.test(content)) return null

      return content
    } catch (error: unknown) {
      clearTimeout(timeoutId)
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < maxRetries) {
        const backoff = (attempt + 1) * backoffBase
        await new Promise((r) => setTimeout(r, backoff))
        continue
      }
      break
    }
  }

  console.error(`[ToolSynth] Failed after retries: ${lastError?.message}`)
  return null
}
