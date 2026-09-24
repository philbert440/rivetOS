import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultDirectoryFor, directoryWarnings, slugify, validateDirectory } from './validate.js'

describe('slugify', () => {
  it.each([
    ['Hello World', 'hello-world'],
    ['  Foo__Bar!! ', 'foo-bar'],
    ['Hello---World', 'hello-world'],
    ['123 Agent', '123-agent'],
    ['---', 'agent'],
    ['', 'agent'],
    ['...', 'agent'],
    ['A'.repeat(80), 'a'.repeat(48)],
    ['a'.repeat(48) + 'b', 'a'.repeat(48)],
  ])('slugify(%j) → %j', (name, expected) => {
    expect(slugify(name)).toBe(expected)
  })
})

describe('defaultDirectoryFor', () => {
  it('joins the root and the slug', () => {
    expect(defaultDirectoryFor('/home/agents', 'Hello World')).toBe('/home/agents/hello-world')
  })
})

describe('validateDirectory', () => {
  it('rejects a relative path and a bare ..', () => {
    expect(validateDirectory('agents/reviewer')).toBeUndefined()
    expect(validateDirectory('..')).toBeUndefined()
    expect(validateDirectory('../etc')).toBeUndefined()
  })

  it('normalises duplicate and trailing slashes', () => {
    expect(validateDirectory('/a//b/')).toBe('/a/b')
    expect(validateDirectory('  /tmp/ok  ')).toBe('/tmp/ok')
  })

  it('resolves .. that normalisation removes and rejects a segment that survives', () => {
    expect(validateDirectory('/a/b/../c')).toBe('/a/c')
    expect(validateDirectory('/tmp/\0hidden')).toBeUndefined()
    expect(validateDirectory(12)).toBeUndefined()
  })

  it('rejects a path longer than 512 characters', () => {
    expect(validateDirectory(`/${'a'.repeat(512)}`)).toBeUndefined()
    expect(validateDirectory(`/${'a'.repeat(511)}`)).toBe(`/${'a'.repeat(511)}`)
  })

  it('rejects the filesystem root', () => {
    expect(validateDirectory('/')).toBeUndefined()
    expect(validateDirectory('//')).toBeUndefined()
    expect(validateDirectory('/.')).toBeUndefined()
  })
})

describe('directoryWarnings', () => {
  it('warns only when the directory is inside the shared directory', () => {
    expect(directoryWarnings('/home/agents/reviewer', '/rivet-shared')).toEqual([])
    expect(directoryWarnings('/rivet-shared-other/reviewer', '/rivet-shared')).toEqual([])
    expect(directoryWarnings('/tmp/a')).toEqual([])
    const warned = directoryWarnings('/rivet-shared/agents/reviewer', '/rivet-shared/')
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(/rivet-shared/)
    expect(warned[0]).toMatch(/ancestor/)
    expect(directoryWarnings('/rivet-shared', '/rivet-shared')).toHaveLength(1)
  })

  it('compares real paths when a shared directory is a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-registry-warn-'))
    try {
      const real = join(root, 'real-shared')
      const viaLink = join(root, 'link-shared')
      mkdirSync(real)
      symlinkSync(real, viaLink)
      const directory = join(real, 'agents', 'reviewer')
      mkdirSync(directory, { recursive: true })
      expect(directoryWarnings(directory, viaLink)).toHaveLength(1)
      expect(directoryWarnings(join(viaLink, 'agents', 'reviewer'), real)).toHaveLength(1)
      const outside = join(root, 'other')
      mkdirSync(outside)
      expect(directoryWarnings(outside, viaLink)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
