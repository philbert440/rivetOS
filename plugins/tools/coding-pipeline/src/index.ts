/**
 * @rivetos/tool-coding-pipeline
 *
 * Autonomous coding loop:
 *   1. Opus delegates to Grok with spec + requirements
 *   2. Grok builds (reads files, writes code, runs tests)
 *   3. Grok self-reviews against requirements, loops if issues found
 *   4. Grok sends to Opus for validation
 *   5. Opus validates, sends back with findings or approves
 *   6. On approval: commit + push
 *
 * Uses sub-agent sessions for the Grok↔Opus back-and-forth.
 * Each agent has full tool access (shell, file, git).
 */

import type { Tool, ToolContext } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CodingPipelineConfig {
  /** Agent that builds (default: 'grok') */
  builderAgent?: string;
  /** Agent that validates (default: 'opus') */
  validatorAgent?: string;
  /** Max build→review cycles before giving up (default: 3) */
  maxBuildCycles?: number;
  /** Max validator rejections before escalating to user (default: 2) */
  maxValidationRejections?: number;
  /** Working directory for git operations */
  workingDir?: string;
  /** Auto-commit on approval (default: true) */
  autoCommit?: boolean;
  /** Auto-push on commit (default: true) */
  autoPush?: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline State
// ---------------------------------------------------------------------------

interface PipelineState {
  spec: string;
  files: string[];
  buildCycle: number;
  validationCycle: number;
  builderOutput: string;
  reviewFindings: string;
  validationFindings: string;
  status: 'building' | 'self-reviewing' | 'validating' | 'fixing' | 'committing' | 'done' | 'failed';
}

// ---------------------------------------------------------------------------
// Types for the sub-agent manager (injected at registration)
// ---------------------------------------------------------------------------

interface SubagentHandle {
  spawn(request: { agent: string; task: string; mode: 'run'; timeoutMs?: number }): Promise<{ response: string; status: string }>;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class CodingPipeline {
  private config: Required<CodingPipelineConfig>;
  private subagents: SubagentHandle;

  constructor(config: CodingPipelineConfig, subagents: SubagentHandle) {
    this.config = {
      builderAgent: config.builderAgent ?? 'grok',
      validatorAgent: config.validatorAgent ?? 'opus',
      maxBuildCycles: config.maxBuildCycles ?? 3,
      maxValidationRejections: config.maxValidationRejections ?? 2,
      workingDir: config.workingDir ?? process.cwd(),
      autoCommit: config.autoCommit ?? true,
      autoPush: config.autoPush ?? true,
    };
    this.subagents = subagents;
  }

  async run(spec: string, files: string[] = [], onProgress?: (msg: string) => void): Promise<string> {
    const state: PipelineState = {
      spec,
      files,
      buildCycle: 0,
      validationCycle: 0,
      builderOutput: '',
      reviewFindings: '',
      validationFindings: '',
      status: 'building',
    };

    while (state.status !== 'done' && state.status !== 'failed') {
      switch (state.status) {
        case 'building':
          await this.build(state, onProgress);
          break;
        case 'self-reviewing':
          await this.selfReview(state, onProgress);
          break;
        case 'validating':
          await this.validate(state, onProgress);
          break;
        case 'fixing':
          await this.fix(state, onProgress);
          break;
        case 'committing':
          await this.commit(state, onProgress);
          break;
      }
    }

    if (state.status === 'failed') {
      return `❌ Pipeline failed after ${state.buildCycle} build cycles and ${state.validationCycle} validation cycles.\n\nLast findings:\n${state.validationFindings || state.reviewFindings || 'Unknown error'}`;
    }

    return `✅ Pipeline completed. ${state.buildCycle} build cycles, ${state.validationCycle} validation cycles.`;
  }

  // -----------------------------------------------------------------------
  // Step 1: Build
  // -----------------------------------------------------------------------

  private async build(state: PipelineState, onProgress?: (msg: string) => void): Promise<void> {
    state.buildCycle++;
    onProgress?.(`🔨 Build cycle ${state.buildCycle}...`);

    const filesContext = state.files.length > 0
      ? `\n\nRelevant files to read first: ${state.files.join(', ')}`
      : '';

    const prevFindings = state.validationFindings
      ? `\n\n## Previous Validation Findings (fix these):\n${state.validationFindings}`
      : state.reviewFindings
        ? `\n\n## Previous Self-Review Findings (fix these):\n${state.reviewFindings}`
        : '';

    const task = `You are a senior software engineer. Build the following feature.

## Spec
${state.spec}
${filesContext}
${prevFindings}

## Instructions
1. Read the relevant files to understand the codebase patterns and architecture
2. Write clean, production-quality code following existing conventions
3. Run any tests that exist to verify your changes
4. When done, output a summary of what you built and what files you changed

DO NOT explain your thought process. Just build it.`;

    try {
      const result = await this.subagents.spawn({
        agent: this.config.builderAgent,
        task,
        mode: 'run',
        timeoutMs: 300000, // 5 min
      });

      state.builderOutput = result.response;
      state.status = 'self-reviewing';
    } catch (err: any) {
      state.status = 'failed';
      state.reviewFindings = `Build failed: ${err.message}`;
    }
  }

  // -----------------------------------------------------------------------
  // Step 2: Self-Review
  // -----------------------------------------------------------------------

  private async selfReview(state: PipelineState, onProgress?: (msg: string) => void): Promise<void> {
    onProgress?.(`🔍 Self-reviewing...`);

    const task = `You are a senior code reviewer. Review the changes that were just made.

## Original Spec
${state.spec}

## What Was Built
${state.builderOutput}

## Review Instructions
1. Check: Does the code meet ALL requirements in the spec?
2. Check: Are there bugs, edge cases, or missing error handling?
3. Check: Does it follow the codebase's existing patterns and conventions?
4. Run tests if they exist

If everything is clean, respond with exactly: LGTM
If there are issues, list them as numbered findings with severity (P0/P1/P2).`;

    try {
      const result = await this.subagents.spawn({
        agent: this.config.builderAgent, // builder reviews own work
        task,
        mode: 'run',
        timeoutMs: 120000, // 2 min
      });

      if (result.response.trim().toUpperCase().includes('LGTM')) {
        state.reviewFindings = '';
        state.status = 'validating';
      } else {
        state.reviewFindings = result.response;
        if (state.buildCycle >= this.config.maxBuildCycles) {
          onProgress?.(`⚠️ Max build cycles (${this.config.maxBuildCycles}) reached, sending to validator anyway`);
          state.status = 'validating';
        } else {
          state.status = 'fixing';
        }
      }
    } catch (err: any) {
      // Skip review on error, let validator catch issues
      state.status = 'validating';
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Validate (different agent)
  // -----------------------------------------------------------------------

  private async validate(state: PipelineState, onProgress?: (msg: string) => void): Promise<void> {
    state.validationCycle++;
    onProgress?.(`✅ Validation cycle ${state.validationCycle}...`);

    const task = `You are a principal engineer performing a final validation review. You are READ ONLY — do not modify any files.

## Original Spec
${state.spec}

## What Was Built
${state.builderOutput}

${state.reviewFindings ? `## Self-Review Findings (already addressed or accepted)\n${state.reviewFindings}` : ''}

## Validation Instructions
1. Read the actual files that were changed (use shell tool to cat them)
2. Verify the code meets ALL requirements in the spec
3. Check for: correctness, architectural concerns, missing tests, security issues
4. Run tests if they exist

If everything passes, respond with exactly: VALIDATED
If there are issues, list them as numbered findings with severity (P0 = blocking, P1 = should fix, P2 = minor).
Only P0 findings should block — P1/P2 can be addressed later.`;

    try {
      const result = await this.subagents.spawn({
        agent: this.config.validatorAgent,
        task,
        mode: 'run',
        timeoutMs: 180000, // 3 min
      });

      if (result.response.trim().toUpperCase().includes('VALIDATED')) {
        state.validationFindings = '';
        state.status = 'committing';
      } else {
        state.validationFindings = result.response;
        if (state.validationCycle >= this.config.maxValidationRejections) {
          onProgress?.(`⚠️ Max validation rejections (${this.config.maxValidationRejections}), escalating to user`);
          state.status = 'failed';
        } else {
          onProgress?.(`🔄 Validator found issues, sending back to builder`);
          state.status = 'building'; // Full rebuild with findings
        }
      }
    } catch (err: any) {
      state.status = 'failed';
      state.validationFindings = `Validation failed: ${err.message}`;
    }
  }

  // -----------------------------------------------------------------------
  // Step 2b: Fix (builder addresses self-review findings)
  // -----------------------------------------------------------------------

  private async fix(state: PipelineState, onProgress?: (msg: string) => void): Promise<void> {
    onProgress?.(`🔧 Fixing self-review findings...`);

    const task = `You are a senior software engineer fixing code based on review feedback.

## Original Spec
${state.spec}

## Findings to Fix
${state.reviewFindings}

## Instructions
1. Address every finding listed above
2. Read the current code, make targeted fixes
3. Run tests to verify
4. Output a summary of what you fixed

DO NOT explain your thought process. Just fix it.`;

    try {
      const result = await this.subagents.spawn({
        agent: this.config.builderAgent,
        task,
        mode: 'run',
        timeoutMs: 180000,
      });

      state.builderOutput = result.response;
      state.status = 'self-reviewing';
    } catch (err: any) {
      // If fix fails, try to validate what we have
      state.status = 'validating';
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Commit
  // -----------------------------------------------------------------------

  private async commit(state: PipelineState, onProgress?: (msg: string) => void): Promise<void> {
    if (!this.config.autoCommit) {
      state.status = 'done';
      return;
    }

    onProgress?.(`📦 Committing...`);

    const commitMsg = state.spec.split('\n')[0].slice(0, 72);

    const task = `Run these shell commands in order:

1. \`cd ${this.config.workingDir} && git add -A\`
2. \`git diff --cached --stat\` — show what's being committed
3. \`git commit -m "feat: ${commitMsg}"\`
${this.config.autoPush ? `4. \`git push\`` : ''}

Output the commit hash and diff stat.`;

    try {
      const result = await this.subagents.spawn({
        agent: this.config.builderAgent,
        task,
        mode: 'run',
        timeoutMs: 30000,
      });

      onProgress?.(`📦 ${result.response.slice(0, 200)}`);
      state.status = 'done';
    } catch {
      // Commit failure doesn't fail the pipeline — code is validated
      state.status = 'done';
    }
  }
}

// ---------------------------------------------------------------------------
// Tool Factory
// ---------------------------------------------------------------------------

export function createCodingPipelineTool(
  config: CodingPipelineConfig,
  subagents: SubagentHandle,
): Tool {
  const pipeline = new CodingPipeline(config, subagents);

  return {
    name: 'coding_pipeline',
    description:
      'Run the autonomous coding pipeline. Grok builds from a spec, self-reviews, ' +
      'Opus validates, fix loop until clean, then commits. Use for significant ' +
      'features or changes that benefit from build→review→validate rigor.',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'Detailed spec for what to build. Be specific about requirements.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relevant file paths the builder should read first',
        },
      },
      required: ['spec'],
    },
    async execute(args: Record<string, unknown>, signal?: AbortSignal, context?: ToolContext): Promise<string> {
      const progressLines: string[] = [];

      const result = await pipeline.run(
        args.spec as string,
        args.files as string[] | undefined,
        (msg) => progressLines.push(msg),
      );

      return progressLines.length > 0
        ? `${progressLines.join('\n')}\n\n${result}`
        : result;
    },
  };
}
