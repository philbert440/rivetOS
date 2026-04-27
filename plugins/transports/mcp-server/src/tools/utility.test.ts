/**
 * Integration test for the utility tool surface (Phase 1.A slice 1.B'.1) —
 * `rivetos.shell`, `rivetos.file_read`, `rivetos.file_write`,
 * `rivetos.file_edit`, `rivetos.search_glob`, `rivetos.search_grep`.
 *
 * Uses a temp directory as the playground so we don't pollute workspace
 * state. Verifies:
 *   - all six tools list correctly alongside echo
 *   - shell echo round-trips
 *   - shell `cd` updates the session working directory across calls
 *   - file_write → file_read → file_edit round-trip
 *   - search_glob finds a known file pattern
 *   - search_grep finds a known string in the playground
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createMcpServer, defaultEchoTool, type RivetMcpServer } from '../server.js'
import { createShellTool, type ShellToolHandle } from './shell.js'
import { createFileTools, type FileToolsHandle } from './file.js'
import { createSearchTools, type SearchToolsHandle } from './search.js'

function firstText(content: unknown): string {
  const arr = content as Array<{ type?: string; text?: string }> | undefined
  return arr?.[0]?.text ?? ''
}

describe('utility tools (Phase 1.A slice 1.B-prime.1)', () => {
  let tempDir: string
  let server: RivetMcpServer
  let client: Client
  let shellHandle: ShellToolHandle
  let fileHandle: FileToolsHandle
  let searchHandle: SearchToolsHandle

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rivetos-mcp-utility-'))
    // Seed playground content for search tools to find.
    await mkdir(join(tempDir, 'src'), { recursive: true })
    await writeFile(
      join(tempDir, 'src', 'index.ts'),
      'export const SEEDED_TOKEN = "abc123-utility-seed"\n',
      'utf-8',
    )
    await writeFile(join(tempDir, 'src', 'helper.ts'), 'export const HELPER = 1\n', 'utf-8')
    await writeFile(join(tempDir, 'README.md'), '# Playground\n', 'utf-8')

    shellHandle = createShellTool({ cwd: tempDir })
    fileHandle = createFileTools()
    searchHandle = createSearchTools()

    server = createMcpServer({
      host: '127.0.0.1',
      port: 0,
      tools: [defaultEchoTool(), ...shellHandle.tools, ...fileHandle.tools, ...searchHandle.tools],
      log: () => {
        /* quiet */
      },
    })
    await server.start()

    const url = new URL(`http://${server.address.host}:${String(server.address.port)}/mcp`)
    client = new Client({ name: 'utility-tools-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
  }, 20_000)

  afterAll(async () => {
    await client.close().catch(() => {
      /* swallow */
    })
    await server.stop().catch(() => {
      /* swallow */
    })
    await shellHandle.close().catch(() => {
      /* swallow */
    })
    await fileHandle.close().catch(() => {
      /* swallow */
    })
    await searchHandle.close().catch(() => {
      /* swallow */
    })
    await rm(tempDir, { recursive: true, force: true }).catch(() => {
      /* swallow */
    })
  })

  it('lists all six utility tools alongside echo', async () => {
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('rivetos.shell')
    expect(names).toContain('rivetos.file_read')
    expect(names).toContain('rivetos.file_write')
    expect(names).toContain('rivetos.file_edit')
    expect(names).toContain('rivetos.search_glob')
    expect(names).toContain('rivetos.search_grep')
    expect(names).toContain('rivetos.echo')
  })

  describe('rivetos.shell', () => {
    it('runs echo and returns stdout', async () => {
      const result = await client.callTool({
        name: 'rivetos.shell',
        arguments: { command: 'echo hello-from-mcp' },
      })
      expect(result.isError).not.toBe(true)
      expect(firstText(result.content)).toContain('hello-from-mcp')
    })

    it('cd persists across calls (session cwd)', async () => {
      const cd = await client.callTool({
        name: 'rivetos.shell',
        arguments: { command: 'cd src' },
      })
      expect(firstText(cd.content)).toContain('Changed directory to')

      const pwd = await client.callTool({
        name: 'rivetos.shell',
        arguments: { command: 'pwd' },
      })
      expect(firstText(pwd.content)).toContain('/src')

      // Reset for downstream tests
      shellHandle.shellTool.resetSessionCwd()
    })
  })

  describe('rivetos.file_*', () => {
    it('write → read round-trip', async () => {
      const target = join(tempDir, 'roundtrip.txt')
      const written = await client.callTool({
        name: 'rivetos.file_write',
        arguments: { path: target, content: 'line one\nline two\nline three\n' },
      })
      expect(written.isError).not.toBe(true)

      const read = await client.callTool({
        name: 'rivetos.file_read',
        arguments: { path: target, line_numbers: false },
      })
      expect(read.isError).not.toBe(true)
      expect(firstText(read.content)).toContain('line one')
      expect(firstText(read.content)).toContain('line three')
    })

    it('edit replaces an exact substring on disk', async () => {
      const target = join(tempDir, 'edit-target.txt')
      await writeFile(target, 'before-marker\npersistent\n', 'utf-8')

      const edited = await client.callTool({
        name: 'rivetos.file_edit',
        arguments: { path: target, old_string: 'before-marker', new_string: 'after-marker' },
      })
      expect(edited.isError).not.toBe(true)

      const onDisk = await readFile(target, 'utf-8')
      expect(onDisk).toContain('after-marker')
      expect(onDisk).not.toContain('before-marker')
      expect(onDisk).toContain('persistent')
    })

    it('edit reports an error when old_string is not unique', async () => {
      const target = join(tempDir, 'ambiguous.txt')
      await writeFile(target, 'dup\ndup\n', 'utf-8')

      const result = await client.callTool({
        name: 'rivetos.file_edit',
        arguments: { path: target, old_string: 'dup', new_string: 'unique' },
      })
      // The Rivet tool returns the error as the result string (not throws).
      const text = firstText(result.content).toLowerCase()
      expect(text).toMatch(/multiple|matches|ambig|more than one/i)
    })
  })

  describe('rivetos.search_*', () => {
    it('search_glob finds the seeded ts files', async () => {
      const result = await client.callTool({
        name: 'rivetos.search_glob',
        arguments: { pattern: '**/*.ts', cwd: tempDir },
      })
      expect(result.isError).not.toBe(true)
      const text = firstText(result.content)
      expect(text).toContain('index.ts')
      expect(text).toContain('helper.ts')
    })

    it('search_grep finds the seeded token', async () => {
      const result = await client.callTool({
        name: 'rivetos.search_grep',
        arguments: { pattern: 'SEEDED_TOKEN', path: tempDir },
      })
      expect(result.isError).not.toBe(true)
      const text = firstText(result.content)
      expect(text).toContain('index.ts')
      expect(text).toContain('SEEDED_TOKEN')
    })
  })
})
