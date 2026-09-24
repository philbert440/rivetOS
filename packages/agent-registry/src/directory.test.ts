import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureAgentDirectory } from './directory.js'

describe('ensureAgentDirectory', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-registry-dir-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the directory mode 0700 and the shared symlink', () => {
    const shared = join(root, 'shared')
    mkdirSync(shared)
    const directory = join(root, 'agents', 'reviewer')
    const result = ensureAgentDirectory({ directory, sharedLink: true }, { sharedDir: shared })
    expect(result).toEqual({ created: true, linked: true })
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    const link = join(directory, 'rivet-shared')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(shared)
  })

  it('is a no-op the second time, with created false', () => {
    const shared = join(root, 'shared')
    mkdirSync(shared)
    const directory = join(root, 'agent')
    ensureAgentDirectory({ directory }, { sharedDir: shared })
    const again = ensureAgentDirectory({ directory }, { sharedDir: shared })
    expect(again).toEqual({ created: false, linked: true })
  })

  it('leaves a real directory at the link path alone', () => {
    const directory = join(root, 'agent')
    mkdirSync(join(directory, 'rivet-shared'), { recursive: true })
    const marker = join(directory, 'rivet-shared', 'keep')
    writeFileSync(marker, 'stay')
    const result = ensureAgentDirectory({ directory }, { sharedDir: join(root, 'shared') })
    expect(result.created).toBe(false)
    expect(result.linked).toBe(false)
    expect(result.reason).toMatch(/directory/)
    expect(lstatSync(join(directory, 'rivet-shared')).isDirectory()).toBe(true)
    expect(existsSync(marker)).toBe(true)
  })

  it('skips the link when sharedLink is false', () => {
    const directory = join(root, 'agent')
    const result = ensureAgentDirectory(
      { directory, sharedLink: false },
      { sharedDir: join(root, 'shared') },
    )
    expect(result).toEqual({ created: true, linked: false })
    expect(existsSync(join(directory, 'rivet-shared'))).toBe(false)
  })

  it('throws when the directory is empty', () => {
    expect(() => ensureAgentDirectory({ directory: '' })).toThrow('agent directory is empty')
    expect(() => ensureAgentDirectory({ directory: '   ' })).toThrow('agent directory is empty')
  })

  it('rejects a directory that is not an absolute path', () => {
    expect(() => ensureAgentDirectory({})).toThrow('agent directory must be an absolute path')
    expect(() => ensureAgentDirectory({ directory: 'agents/reviewer' })).toThrow(
      'agent directory must be an absolute path',
    )
    expect(() => ensureAgentDirectory({ directory: '../etc' })).toThrow(
      'agent directory must be an absolute path',
    )
    expect(() => ensureAgentDirectory({ directory: '/tmp/\0hidden' })).toThrow(
      'agent directory must be an absolute path',
    )
    expect(() => ensureAgentDirectory({ directory: 123 as unknown as string })).toThrow(
      'agent directory must be an absolute path',
    )
    expect(() => ensureAgentDirectory({ directory: '/' })).toThrow(
      'agent directory must be an absolute path',
    )
  })

  it('leaves an existing symlink with a different target alone', () => {
    const directory = join(root, 'agent')
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(directory)
    const link = join(directory, 'rivet-shared')
    symlinkSync(elsewhere, link)
    const shared = join(root, 'shared')
    mkdirSync(shared)
    const result = ensureAgentDirectory({ directory }, { sharedDir: shared })
    expect(result).toEqual({ created: false, linked: true })
    expect(readlinkSync(link)).toBe(elsewhere)
  })

  it('reports a dangling existing symlink from its own target', () => {
    const directory = join(root, 'agent')
    mkdirSync(directory)
    const missing = join(root, 'gone')
    const link = join(directory, 'rivet-shared')
    symlinkSync(missing, link)
    const shared = join(root, 'shared')
    mkdirSync(shared)
    const result = ensureAgentDirectory({ directory }, { sharedDir: shared })
    expect(result.created).toBe(false)
    expect(result.linked).toBe(true)
    expect(result.reason).toMatch(/dangle/)
    expect(result.reason).toContain(missing)
    expect(result.reason).not.toContain(shared)
    expect(readlinkSync(link)).toBe(missing)
  })

  it('leaves a regular file at the link path alone', () => {
    const directory = join(root, 'agent')
    mkdirSync(directory)
    const link = join(directory, 'rivet-shared')
    writeFileSync(link, 'not-a-directory')
    const result = ensureAgentDirectory({ directory }, { sharedDir: join(root, 'shared') })
    expect(result.created).toBe(false)
    expect(result.linked).toBe(false)
    expect(result.reason).toMatch(/file/)
    expect(readFileSync(link, 'utf8')).toBe('not-a-directory')
    expect(lstatSync(link).isFile()).toBe(true)
  })

  it('does not throw when the shared directory is missing', () => {
    const directory = join(root, 'agent')
    const shared = join(root, 'missing-shared')
    const result = ensureAgentDirectory({ directory }, { sharedDir: shared })
    expect(result.created).toBe(true)
    expect(result.linked).toBe(true)
    expect(result.reason).toMatch(/dangle/)
    expect(lstatSync(join(directory, 'rivet-shared')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(directory, 'rivet-shared'))).toBe(shared)
  })
})
