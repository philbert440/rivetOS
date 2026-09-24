/**
 * T3 Code rivet-memory prototype tests.
 *
 * 1. Tool mapping matches the real sidecar names.
 * 2. Registration artifacts match T3's documented surfaces.
 * 3. Recall client formats memory_search into agent context.
 * 4. When workspace packages are installed, stand up the real RivetOS MCP
 *    HTTP mount and call memory_search end to end.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const REPO = path.join(ROOT, '../..')

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.error(`✗ ${name}${detail ? `: ${detail}` : ''}`)
    failed++
  }
}

const { INTENT_TO_MCP, resolveIntent, SUMMARIZE_NOTE, RECALL_TOOLS } = await import(
  pathToFileURL(path.join(ROOT, 'src/tool-map.mjs')).href
)
const { T3_SURFACE, t3HttpMcpServer, t3PluginEntry } = await import(
  pathToFileURL(path.join(ROOT, 'src/t3-surface.mjs')).href
)
const { formatMemoriesAsContext, recallIntoContext, invokeIntent } = await import(
  pathToFileURL(path.join(ROOT, 'src/recall-client.mjs')).href
)
const { buildRegistration, PLUGIN_NAME } = await import(
  pathToFileURL(path.join(ROOT, 'src/register.mjs')).href
)

check('recall maps to memory_search', INTENT_TO_MCP.recall === 'memory_search')
check('store maps to memory_append', INTENT_TO_MCP.store === 'memory_append')
check('summarize has no MCP tool', INTENT_TO_MCP.summarize === null)
check('resolveIntent(summarize) is null', resolveIntent('summarize') === null)
check(
  'recall tools are the sidecar read names',
  JSON.stringify([...RECALL_TOOLS]) ===
    JSON.stringify(['memory_search', 'memory_browse', 'memory_get_full', 'memory_stats']),
)
try {
  resolveIntent('not-a-tool')
  check('unknown intent throws', false)
} catch (err) {
  check('unknown intent throws', err instanceof Error && /unknown memory intent/.test(err.message))
}

check('T3 has no first-class plugin API', T3_SURFACE.firstClassPluginApi === false)
check('T3 has no context-injection hooks', T3_SURFACE.contextInjectionHooks === false)
check('closest working surface is harness MCP', T3_SURFACE.closestWorking === 'harness-native-mcp')
check(
  'built-in MCP is type http /mcp',
  T3_SURFACE.builtInMcp.type === 'http' && T3_SURFACE.builtInMcp.path === '/mcp',
)
check(
  'Claude settingSources include user/project/local',
  T3_SURFACE.claudeSettingSources.join(',') === 'user,project,local',
)

const http = t3HttpMcpServer('http://127.0.0.1:5700/mcp')
check('T3 HTTP MCP has type+url only (no headers)', http.type === 'http' && !('headers' in http))
try {
  t3PluginEntry({ name: 'Bad_Name', url: 'http://127.0.0.1/', mcpUrl: 'http://127.0.0.1/mcp' })
  check('plugin name rejects uppercase/underscore', false)
} catch {
  check('plugin name rejects uppercase/underscore', true)
}

const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 't3-plugin.json'), 'utf8'))
check('shipped t3-plugin.json name is rivetos-memory', shipped.name === 'rivetos-memory')
check('shipped t3-plugin.json has /mcp url', String(shipped.mcpUrl).endsWith('/mcp'))

const mcpHttp = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp-http.json'), 'utf8'))
check('mcp-http.json type is http', mcpHttp.mcpServers.rivetos.type === 'http')
check('mcp-http.json has no headers', mcpHttp.mcpServers.rivetos.headers === undefined)

const pluginMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
check('plugin.json records no first-class API', pluginMeta.t3code.firstClassPluginApi === false)
check('plugin.json records no context hooks', pluginMeta.t3code.contextInjectionHooks === false)
check(
  'plugin.json records automatic sqlite capture',
  pluginMeta.t3code.capture?.automatic === true &&
    pluginMeta.t3code.capture?.requiresToolCall === false &&
    pluginMeta.t3code.capture?.sidecar === 'bin/t3code-memory-capture.sh',
)

const formatted = formatMemoriesAsContext('we decided on stdio MCP', 'how does T3 register?')
check('context block has heading', formatted.startsWith('## RivetOS memory'))
check('context block includes query', formatted.includes('how does T3 register?'))
check('context block includes hit', formatted.includes('we decided on stdio MCP'))
check('empty recall is honest', formatMemoriesAsContext('  ', 'x').includes('No memories matched'))

const fakeCall = async (name, args) => {
  if (name === 'memory_search') return `hit for ${String(args.query)}`
  if (name === 'memory_append') return `stored ${String(args.content)}`
  throw new Error(`unexpected tool ${name}`)
}
const recalled = await recallIntoContext(fakeCall, 'authorship')
check('recallIntoContext calls memory_search', recalled.includes('hit for authorship'))
const stored = await invokeIntent(fakeCall, 'store', { content: 'note' })
check(
  'store intent calls memory_append',
  stored.tool === 'memory_append' && String(stored.text).includes('note'),
)
const summarized = await invokeIntent(fakeCall, 'summarize', {})
check(
  'summarize intent returns mapping note',
  summarized.tool === null && summarized.text === SUMMARIZE_NOTE,
)

const reg = buildRegistration({ pluginRoot: '/opt/rivetos/integrations/t3code-rivetos-memory' })
check('register name matches T3 pattern', PLUGIN_NAME === 'rivetos-memory')
check('register mcpUrl is streamable HTTP /mcp', reg.mcpUrl === 'http://127.0.0.1:5700/mcp')
check('register Claude entry is stdio bash launcher', reg.claudeStdio.mcpServers.rivetos.command === 'bash')
check('register T3 HTTP has no headers', !('headers' in reg.t3Http.mcpServers.rivetos))

const launch = path.join(ROOT, 'bin/rivet-memory-mcp.sh')
const printed = spawnSync('bash', [launch], {
  env: {
    ...process.env,
    RIVETOS_ROOT: REPO,
    RIVETOS_ENV_FILE: path.join(ROOT, 'test/no.env'),
    RIVETOS_PG_URL: 'postgres://fixture.example/db',
    RIVETOS_MCP_LAUNCH_PRINT: '1',
  },
  encoding: 'utf8',
})
check('stdio launcher print writes nothing to stdout', printed.stdout === '')
const sidecarBuilt = fs.existsSync(path.join(REPO, 'services/mcp-sidecar/dist/cli.js'))
if (sidecarBuilt) {
  check(
    'stdio launcher print names checkout or npx',
    printed.status === 0 && /^(checkout |npx)/.test(printed.stderr.trim()),
    printed.stderr,
  )
} else {
  check(
    'stdio launcher print fails loud when sidecar is unbuilt',
    printed.status !== 0 && printed.stdout === '',
    printed.stderr,
  )
}

let ranLiveMcp = false
try {
  const { connectV2, createV2McpServer } = await import('@rivetos/mcp-v2')
  const { z } = await import('zod')
  ranLiveMcp = true
  const server = createV2McpServer({
    host: '127.0.0.1',
    port: 0,
    tools: [
      {
        name: 'memory_search',
        description: 'Search RivetOS persistent memory (conversation history + summaries).',
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true, idempotentHint: true },
        execute(args) {
          return Promise.resolve(
            JSON.stringify({
              hits: [{ id: 'mem-1', content: `prior decision about ${String(args.query)}` }],
            }),
          )
        },
      },
    ],
  })
  await server.start()
  const client = await connectV2({
    name: 't3code-rivetos-memory-test',
    url: `http://127.0.0.1:${String(server.port)}/mcp`,
  })
  try {
    const names = (await client.listTools()).map((t) => t.name)
    check('live MCP lists memory_search', names.includes('memory_search'))
    const context = await recallIntoContext((name, args) => client.callTool(name, args), 'T3 plugin API')
    check('live recall returns context heading', context.startsWith('## RivetOS memory'))
    check('live recall includes the query', context.includes('T3 plugin API'))
    check('live recall includes sidecar hit', context.includes('prior decision about T3 plugin API'))
  } finally {
    await client.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (!ranLiveMcp && /Cannot find (package|module)/.test(message)) {
    check('live MCP skipped (workspace packages not installed)', true)
  } else {
    check('live MCP recall round-trip', false, message)
  }
}

if (failed > 0) {
  console.error(`\n${String(failed)} failed`)
  process.exit(1)
}
console.log('\nok')
