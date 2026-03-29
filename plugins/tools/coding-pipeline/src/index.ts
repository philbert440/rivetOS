/**
 * @rivetos/tool-coding-pipeline
 *
 * Autonomous coding pipeline:
 *   1. Opus delegates to Grok with spec + requirements
 *   2. Grok builds code, reads files, runs tests
 *   3. Grok self-reviews against requirements
 *   4. If issues → Grok fixes and re-loops
 *   5. If clean → sends to Opus for validation
 *   6. Opus approves or sends back with findings
 *   7. On approval → commit + push
 *
 * Uses the sub-agent system for Grok ↔ Opus communication.
 * Exposed as a single tool: `coding_pipeline`
 */

import type { Tool, ToolContext } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CodingPipelineConfig {
  /** Agent that builds code (default: 'grok') */
  builderAgent?: string;

  /** Max build→review loops before escalating (default: 3) */
  maxBuildLoops?: number;

  /** Working directory for code operations */
  workingDir?: string;
  /** Auto-commit on approval (default: true) */
  autoCommit?: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline State
// ---------------------------------------------------------------------------

type PipelinePhase = 'BUILD' | 'SELF_REVIEW' | 'RETURN_FOR_VALIDATION' | 'FIX' | 'COMMIT' | 'DONE' | 'FAILED';

interface PipelineContext {
  spec: string;
  files: string[];
  workingDir: string;
  buildOutput: string;
  reviewFindings: string;
  validationFindings: string;
  buildLoops: number;
  validationLoops: number;
  logs: string[];
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const BUILDER_SYSTEM = `You are an expert software engineer. You have access to shell and file tools.
Your job is to implement code changes according to the spec provided.

Process:
1. Read existing code to understand patterns and architecture
2. Implement the changes
3. Run any relevant tests
4. Report what you did and any issues found

Be precise. Follow existing patterns. Write production-quality code.`;

const SELF_REVIEW_PROMPT = (spec: string, buildLog: string) => `
## Self-Review

Review the code changes you just made against the original spec.

### Original Spec
${spec}

### What was done
${buildLog}

### Review Checklist
- Does the implementation match the spec exactly?
- Are there any bugs, edge cases, or missing error handling?
- Do tests pass?
- Are there any security issues?

If everything looks clean, respond with exactly: LGTM
If there are issues, list them as numbered items and fix them.`;



// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class CodingPipeline {
  private config: Required<CodingPipelineConfig>;
  private subagentSpawn: ((args: Record<string, unknown>) => Promise<string>) | null = null;
  private subagentSend: ((args: Record<string, unknown>) => Promise<string>) | null = null;
  private subagentKill: ((args: Record<string, unknown>) => Promise<string>) | null = null;
  private shellExec: ((args: Record<string, unknown>) => Promise<string>) | null = null;
  private onProgress?: (message: string) => void;

  constructor(config?: CodingPipelineConfig) {
    this.config = {
      builderAgent: config?.builderAgent ?? 'grok',
      validatorAgent: config?.validatorAgent ?? 'opus',
      maxBuildLoops: config?.maxBuildLoops ?? 3,
      maxValidationLoops: config?.maxValidationLoops ?? 2,
      workingDir: config?.workingDir ?? process.cwd(),
      autoCommit: config?.autoCommit ?? true,
    };
  }

  /**
   * Inject tool executors. Called by boot.ts after all tools are registered.
   */
  setToolExecutors(tools: {
    subagentSpawn: (args: Record<string, unknown>) => Promise<string>;
    subagentSend: (args: Record<string, unknown>) => Promise<string>;
    subagentKill: (args: Record<string, unknown>) => Promise<string>;
    shellExec: (args: Record<string, unknown>) => Promise<string>;
  }): void {
    this.subagentSpawn = tools.subagentSpawn;
    this.subagentSend = tools.subagentSend;
    this.subagentKill = tools.subagentKill;
    this.shellExec = tools.shellExec;
  }

  setProgressHandler(handler: (message: string) => void): void {
    this.onProgress = handler;
  }

  private log(ctx: PipelineContext, message: string): void {
    ctx.logs.push(message);
    this.onProgress?.(message);
  }

  // -----------------------------------------------------------------------
  // Main Pipeline
  // -----------------------------------------------------------------------

  async run(spec: string, files: string[] = []): Promise<string> {
    if (!this.subagentSpawn || !this.subagentSend || !this.shellExec) {
      return 'Error: Pipeline not initialized — tool executors not set.';
    }

    const ctx: PipelineContext = {
      spec,
      files,
      workingDir: this.config.workingDir,
      buildOutput: '',
      reviewFindings: '',
      validationFindings: '',
      buildLoops: 0,
      validationLoops: 0,
      logs: [],
    };

    let phase: PipelinePhase = 'BUILD';

    while (phase !== 'DONE' && phase !== 'FAILED') {
      this.log(ctx, `📋 Phase: ${phase}`);

      switch (phase) {
        case 'BUILD':
          phase = await this.build(ctx);
          break;
        case 'SELF_REVIEW':
          phase = await this.selfReview(ctx);
          break;
        case 'RETURN_FOR_VALIDATION':
          // Don't spawn a validator — return to the calling agent with the diff
          // The architect (who has full context) validates in their own turn
          return this.buildValidationReport(ctx);
        case 'FIX':
          phase = await this.fix(ctx);
          break;
        case 'COMMIT':
          phase = await this.commit(ctx);
          break;
      }
    }

    const summary = [
      `## Pipeline ${phase === 'DONE' ? '✅ Complete' : '❌ Failed'}`,
      `Build loops: ${ctx.buildLoops}`,
      `Validation loops: ${ctx.validationLoops}`,
      '',
      '### Log',
      ...ctx.logs,
    ].join('\n');

    return summary;
  }

  // -----------------------------------------------------------------------
  // Phase: BUILD — Grok implements the spec
  // -----------------------------------------------------------------------

  private async build(ctx: PipelineContext): Promise<PipelinePhase> {
    this.log(ctx, `🔨 Spawning ${this.config.builderAgent} to build...`);

    const filesContext = ctx.files.length > 0
      ? `\n\nRelevant files: ${ctx.files.join(', ')}`
      : '';

    const task = `${BUILDER_SYSTEM}\n\n## Spec\n${ctx.spec}${filesContext}\n\nWorking directory: ${ctx.workingDir}`;

    try {
      const result = await this.subagentSpawn!({
        agent: this.config.builderAgent,
        task,
        mode: 'run',
        timeout_ms: 300000, // 5 min
      });

      ctx.buildOutput = result;
      ctx.buildLoops++;
      this.log(ctx, `✅ Build complete (loop ${ctx.buildLoops})`);
      return 'SELF_REVIEW';
    } catch (err: any) {
      this.log(ctx, `❌ Build failed: ${err.message}`);
      return 'FAILED';
    }
  }

  // -----------------------------------------------------------------------
  // Phase: SELF_REVIEW — Grok reviews its own work
  // -----------------------------------------------------------------------

  private async selfReview(ctx: PipelineContext): Promise<PipelinePhase> {
    this.log(ctx, `🔍 ${this.config.builderAgent} self-reviewing...`);

    const reviewPrompt = SELF_REVIEW_PROMPT(ctx.spec, ctx.buildOutput);

    try {
      const result = await this.subagentSpawn!({
        agent: this.config.builderAgent,
        task: reviewPrompt,
        mode: 'run',
        timeout_ms: 120000,
      });

      ctx.reviewFindings = result;

      if (result.toUpperCase().includes('LGTM')) {
        this.log(ctx, `✅ Self-review passed`);
        return 'RETURN_FOR_VALIDATION';
      }

      this.log(ctx, `⚠️ Self-review found issues`);
      if (ctx.buildLoops >= this.config.maxBuildLoops) {
        this.log(ctx, `⚠️ Max build loops (${this.config.maxBuildLoops}) reached, sending to validator anyway`);
        return 'RETURN_FOR_VALIDATION';
      }
      return 'FIX';
    } catch (err: any) {
      this.log(ctx, `❌ Self-review failed: ${err.message}`);
      return 'RETURN_FOR_VALIDATION'; // Skip review on error, let validator catch issues
    }
  }

  // -----------------------------------------------------------------------
  // Return to calling agent for validation
  // -----------------------------------------------------------------------

  private async buildValidationReport(ctx: PipelineContext): Promise<string> {
    let diff = '';
    try {
      diff = await this.shellExec!({ command: `cd ${ctx.workingDir} && git diff --stat && git diff` });
    } catch {
      diff = ctx.buildOutput;
    }

    return [
      `## 🔬 Ready for Your Review`,
      '',
      `### Spec`,
      ctx.spec,
      '',
      `### Build Summary (${ctx.buildLoops} loops)`,
      ctx.buildOutput.slice(0, 2000),
      '',
      ctx.reviewFindings ? `### Self-Review Result\n${ctx.reviewFindings.slice(0, 1000)}` : '',
      '',
      `### Diff`,
      '```',
      diff.slice(0, 3000),
      '```',
      '',
      `### Your Call`,
      `If approved, I'll commit and push.`,
      `If issues found, tell me what to fix and I'll run the pipeline again.`,
      '',
      ...ctx.logs,
    ].filter(Boolean).join('\n');
  }

  // -----------------------------------------------------------------------
  // Phase: FIX — Grok fixes issues from review or validation
  // -----------------------------------------------------------------------

  private async fix(ctx: PipelineContext): Promise<PipelinePhase> {
    const findings = ctx.validationFindings || ctx.reviewFindings;
    this.log(ctx, `🔧 ${this.config.builderAgent} fixing issues...`);

    const task = `${BUILDER_SYSTEM}

## Original Spec
${ctx.spec}

## Issues Found
${findings}

Fix all issues listed above. Working directory: ${ctx.workingDir}`;

    try {
      const result = await this.subagentSpawn!({
        agent: this.config.builderAgent,
        task,
        mode: 'run',
        timeout_ms: 300000,
      });

      ctx.buildOutput = result;
      ctx.buildLoops++;
      this.log(ctx, `✅ Fix complete (loop ${ctx.buildLoops})`);

      // After a fix from validation findings, go back to validate
      if (ctx.validationFindings) {
        ctx.validationFindings = '';
        return 'RETURN_FOR_VALIDATION';
      }
      // After a fix from self-review, re-review
      return 'SELF_REVIEW';
    } catch (err: any) {
      this.log(ctx, `❌ Fix failed: ${err.message}`);
      return 'FAILED';
    }
  }

  // -----------------------------------------------------------------------
  // Phase: COMMIT — auto-commit and push
  // -----------------------------------------------------------------------

  private async commit(ctx: PipelineContext): Promise<PipelinePhase> {
    if (!this.config.autoCommit) {
      this.log(ctx, `✅ Pipeline complete (auto-commit disabled)`);
      return 'DONE';
    }

    this.log(ctx, `📦 Committing...`);

    try {
      const commitMsg = `feat: ${ctx.spec.split('\n')[0].slice(0, 72)}`;
      const result = await this.shellExec!({
        command: `cd ${ctx.workingDir} && git add -A && git diff --cached --stat && git commit -m "${commitMsg.replace(/"/g, '\\"')}" && git push`,
      });

      this.log(ctx, `✅ Committed and pushed`);
      this.log(ctx, result.slice(0, 200));
      return 'DONE';
    } catch (err: any) {
      this.log(ctx, `⚠️ Commit failed: ${err.message} (code is valid, commit manually)`);
      return 'DONE'; // Code is valid even if commit fails
    }
  }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export function createCodingPipelineTool(pipeline: CodingPipeline): Tool {
  return {
    name: 'coding_pipeline',
    description:
      'Run the autonomous coding pipeline. Grok builds code from a spec, ' +
      'self-reviews, Opus validates, fixes loop until clean, then commits. ' +
      'Use for: building features, fixing bugs, refactoring code.',
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'Detailed spec of what to build or fix',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relevant file paths for context (optional)',
        },
        working_dir: {
          type: 'string',
          description: 'Working directory for code operations (optional)',
        },
        auto_commit: {
          type: 'boolean',
          description: 'Auto-commit on approval (default: true)',
        },
      },
      required: ['spec'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      if (args.working_dir) {
        (pipeline as any).config.workingDir = args.working_dir as string;
      }
      if (args.auto_commit !== undefined) {
        (pipeline as any).config.autoCommit = args.auto_commit as boolean;
      }
      return pipeline.run(
        args.spec as string,
        (args.files as string[]) ?? [],
      );
    },
  };
}
