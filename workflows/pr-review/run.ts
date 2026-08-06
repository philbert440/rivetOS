/**
 * pr-review — load PR → agent review → human verdict gate → done.
 *
 * DETERMINISM RULE: no Date.now(), Math.random(), or I/O outside step.* calls.
 * All nondeterminism lives inside steps (journaled).
 */
import type { Step, RunScriptContext } from '@rivetos/workflows'

export default async function run(step: Step, ctx: RunScriptContext): Promise<void> {
  const repo = String(ctx.input.repo ?? '')
  const pr = Number(ctx.input.pr)
  const focus =
    typeof ctx.input.focus === 'string' && ctx.input.focus.trim()
      ? ctx.input.focus.trim()
      : undefined

  await step.run('load-pr', {
    script: 'scripts/load-pr.sh',
    in: { repo, pr },
  })

  const prJsonPath = `${ctx.caseDir}/pr.json`
  const prDiffPath = `${ctx.caseDir}/pr.diff`

  const focusLine = focus
    ? `\nReviewer focus (prioritize these areas): ${focus}\n`
    : ''

  const review = await step.agent('review', {
    agent: 'reviewer',
    prompt: [
      `Review pull request #${pr} in repository ${repo}.`,
      focusLine,
      `PR metadata (JSON): ${prJsonPath}`,
      `PR diff: ${prDiffPath}`,
      '',
      'Read both files from disk. Produce findings and a final structured JSON object',
      'with keys "verdict" and "summary" as your last message (see agent instructions).',
    ].join('\n'),
    out: ['verdict', 'summary'],
  })

  // Composed mode (gated=false): the parent owns its own merge gate — v1
  // sync-wait children cannot suspend, so derive approved from the verdict
  // instead of pausing. Standalone (default): pause for the human.
  const gated = ctx.input.gated !== false
  let approved: boolean
  if (gated) {
    const gate = await step.human('verdict-gate', {
      prompt: 'Review complete — approve the verdict?',
      fields: ['approved'],
    })
    approved = gate.approved === true
  } else {
    const verdict = String(review.verdict ?? '')
    approved = verdict === 'approve' || verdict === 'approve-with-nits'
  }

  await step.done({
    verdict: review.verdict,
    summary: review.summary,
    approved,
  })
}
