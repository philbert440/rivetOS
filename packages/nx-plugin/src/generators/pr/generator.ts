/**
 * nx g @rivetos/nx:pr --type=feat --description="Add Slack channel"
 *
 * Interactive PR wizard:
 *   1. Create branch with conventional naming
 *   2. Detect affected packages
 *   3. Run quality gates (lint, build, test)
 *   4. Generate PR description with checklist
 *   5. Create PR via gh CLI
 */

import { Tree, logger } from '@nx/devkit'
import { gitCreateBranch, gitCurrentBranch, toBranchName } from '../../utils/git.js'
import { ghAvailable, gitPush, createPR, buildPRBody, typeToLabels } from '../../utils/github.js'
import { runValidation, getAffectedPackages } from '../../utils/validation.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface PRGeneratorSchema {
  type: 'feat' | 'fix' | 'refactor' | 'chore' | 'docs' | 'plugin' | 'test' | 'perf'
  description: string
  issue?: string
  breaking?: boolean
  draft?: boolean
  skipValidation?: boolean
  dryRun?: boolean
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function prGenerator(_tree: Tree, schema: PRGeneratorSchema): void {
  const { type, description, issue, breaking, draft, skipValidation, dryRun } = schema

  logger.info('')
  logger.info('🚀 RivetOS PR Generator')
  logger.info('─'.repeat(50))
  logger.info('')

  // -------------------------------------------------------------------------
  // Step 1: Check prerequisites
  // -------------------------------------------------------------------------

  if (!ghAvailable()) {
    logger.warn('⚠️  GitHub CLI (gh) not found or not authenticated.')
    logger.warn('   Install: https://cli.github.com/')
    logger.warn('   Auth:    gh auth login')
    logger.warn('')
    logger.warn('   Continuing without PR creation — will generate description only.')
    logger.warn('')
  }

  // -------------------------------------------------------------------------
  // Step 2: Branch
  // -------------------------------------------------------------------------

  const currentBranch = gitCurrentBranch()
  const branchName = toBranchName(type, description)
  const title = `${type}${breaking ? '!' : ''}: ${description}`

  if (currentBranch === 'main') {
    if (dryRun) {
      logger.info(`📌 Would create branch: ${branchName}`)
    } else {
      logger.info(`📌 Creating branch: ${branchName}`)
      gitCreateBranch(branchName)
    }
  } else {
    logger.info(`📌 Using current branch: ${currentBranch}`)
  }

  // -------------------------------------------------------------------------
  // Step 3: Detect affected packages
  // -------------------------------------------------------------------------

  logger.info('')
  const affectedPackages = getAffectedPackages()
  if (affectedPackages.length > 0) {
    logger.info(`📦 Affected packages (${affectedPackages.length}):`)
    for (const pkg of affectedPackages) {
      logger.info(`   • ${pkg}`)
    }
  } else {
    logger.info('📦 No affected packages detected (clean diff from main)')
  }

  // -------------------------------------------------------------------------
  // Step 4: Quality gates
  // -------------------------------------------------------------------------

  let validationResults = { lint: true, build: true, test: true }

  if (skipValidation) {
    logger.warn('')
    logger.warn('⚠️  Skipping validation (--skipValidation). Not recommended!')
  } else if (dryRun) {
    logger.info('')
    logger.info('🔍 Would run: nx affected -t lint build test')
  } else {
    validationResults = runValidation()

    const allPass = validationResults.lint && validationResults.build && validationResults.test
    if (!allPass) {
      logger.error('')
      logger.error('❌ Quality gates failed. Fix the issues above before creating a PR.')
      logger.error('   Run `nx affected -t lint build test` to see details.')
      logger.error('')
      return
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Build PR description
  // -------------------------------------------------------------------------

  const body = buildPRBody({
    type,
    description,
    affectedPackages,
    issue,
    breaking,
    validationResults,
  })

  logger.info('')
  logger.info('📝 PR Preview:')
  logger.info('─'.repeat(50))
  logger.info(`  Title: ${title}`)
  logger.info(`  Branch: ${currentBranch === 'main' ? branchName : currentBranch} → main`)
  if (issue) logger.info(`  Closes: #${issue.replace('#', '')}`)
  if (draft) logger.info(`  Draft: yes`)
  logger.info('─'.repeat(50))
  logger.info('')
  logger.info(body)
  logger.info('')

  // -------------------------------------------------------------------------
  // Step 6: Create PR
  // -------------------------------------------------------------------------

  if (dryRun) {
    logger.info('🏁 Dry run complete. No PR created.')
    return
  }

  if (!ghAvailable()) {
    logger.info('📋 PR description generated above. Create manually with:')
    logger.info(`   gh pr create --title "${title}" --body "..."`)
    return
  }

  const activeBranch = currentBranch === 'main' ? branchName : currentBranch

  try {
    logger.info('📤 Pushing branch...')
    gitPush(activeBranch)

    logger.info('🔗 Creating pull request...')
    const pr = createPR({
      title,
      body,
      branch: activeBranch,
      draft,
      labels: typeToLabels(type),
    })

    logger.info('')
    logger.info(`✅ Created PR #${pr.number}`)
    logger.info(`   ${pr.url}`)
    logger.info('')
  } catch (err) {
    logger.error(`Failed to create PR: ${err instanceof Error ? err.message : String(err)}`)
    logger.info('')
    logger.info('📋 You can create it manually:')
    logger.info(`   git push -u origin ${activeBranch}`)
    logger.info(`   gh pr create --title "${title}"`)
  }
}

export default prGenerator
