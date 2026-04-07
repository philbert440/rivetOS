/**
 * Git utilities for generators.
 */

import { execSync } from 'node:child_process'

export interface GitStatus {
  branch: string
  isClean: boolean
  staged: string[]
  modified: string[]
  untracked: string[]
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

export function gitStatus(): GitStatus {
  const branch = exec('git branch --show-current')
  const status = exec('git status --porcelain')
  const lines = status ? status.split('\n') : []

  return {
    branch,
    isClean: lines.length === 0,
    staged: lines.filter((l) => /^[MADRC]/.test(l)).map((l) => l.slice(3)),
    modified: lines.filter((l) => /^.[MADRC]/.test(l)).map((l) => l.slice(3)),
    untracked: lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3)),
  }
}

export function gitCreateBranch(branchName: string): void {
  exec(`git checkout -b ${branchName}`)
}

export function gitCurrentBranch(): string {
  return exec('git branch --show-current')
}

export function gitHasRemote(): boolean {
  try {
    exec('git remote get-url origin')
    return true
  } catch {
    return false
  }
}

export function gitDiffStat(): string {
  try {
    return exec('git diff --stat HEAD')
  } catch {
    return ''
  }
}

export function gitAffectedFiles(): string[] {
  try {
    const base = exec('git merge-base HEAD main 2>/dev/null || echo HEAD~1')
    const diff = exec(`git diff --name-only ${base}`)
    return diff ? diff.split('\n') : []
  } catch {
    return []
  }
}

/** Slug a description into a branch-safe name */
export function toBranchName(type: string, description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${type}/${slug}`
}
