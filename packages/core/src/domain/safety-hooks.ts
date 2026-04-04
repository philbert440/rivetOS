/**
 * Safety Hooks — pre-built tool:before hooks for security and safety.
 *
 * Implements M2.2:
 *   - Shell danger blocker: blocks/warns on dangerous shell commands
 *   - Workspace fence: blocks file operations outside allowed directories
 *   - Audit logger: logs all tool invocations to an audit file
 *   - Custom rules: user-defined block/warn patterns per tool
 *
 * All hooks use the existing HookPipeline infrastructure (tool:before event).
 * Pure domain logic — filesystem writes are injected via interfaces.
 */

import type {
  HookRegistration,
  ToolBeforeContext,
  ToolAfterContext,
} from '@rivetos/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SafetyRule {
  /** Unique ID for this rule */
  id: string;
  /** Which tools this rule applies to (empty = all tools) */
  tools?: string[];
  /** Action when matched: 'block' stops execution, 'warn' adds a warning to metadata */
  action: 'block' | 'warn';
  /** Human-readable description of the rule */
  description: string;
  /** Match function — receives tool name and args, returns true if rule triggers */
  match: (toolName: string, args: Record<string, unknown>) => boolean;
}

export interface AuditEntry {
  timestamp: string;
  event: 'tool:before' | 'tool:after';
  toolName: string;
  args: Record<string, unknown>;
  agentId?: string;
  sessionId?: string;
  blocked?: boolean;
  blockReason?: string;
  /** For tool:after entries */
  durationMs?: number;
  isError?: boolean;
}

export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shell Danger Blocker
// ---------------------------------------------------------------------------

/** Patterns that are always blocked — catastrophic commands. */
const BLOCKED_PATTERNS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf *',
  'rm -rf .',
  'mkfs',
  ':(){:|:&};:',         // fork bomb
  'dd if=/dev/zero',
  'dd if=/dev/random',
  '> /dev/sda',
  'chmod -R 777 /',
  'chmod -R 000 /',
  'shutdown -h',
  'shutdown now',
  'reboot',
  'init 0',
  'init 6',
  'kill -9 1',
  'kill -9 -1',
  'pkill -9',
  'npm publish',           // accidental publish
  'npx publish',
  'curl | sh',             // pipe to shell (literal adjacent)
  'curl | bash',
  '| sh',                  // anything piped to sh/bash
  '| bash',
  '| sudo',                // anything piped to sudo
];

/** Patterns that get a warning but proceed. */
const WARN_PATTERNS = [
  { pattern: 'git push --force', reason: 'Force push can overwrite remote history' },
  { pattern: 'git push -f', reason: 'Force push can overwrite remote history' },
  { pattern: 'git reset --hard', reason: 'Hard reset discards uncommitted changes' },
  { pattern: 'git clean -fd', reason: 'Clean removes untracked files permanently' },
  { pattern: 'git checkout -- .', reason: 'Discards all local changes' },
  { pattern: 'git stash drop', reason: 'Stash drop is irreversible' },
  { pattern: 'git branch -D', reason: 'Force-deletes branch without merge check' },
  { pattern: 'docker system prune', reason: 'Removes all unused Docker resources' },
  { pattern: 'npm install -g', reason: 'Global npm install affects system packages' },
  { pattern: 'pip install', reason: 'Installing Python packages — check for conflicts' },
  { pattern: 'apt install', reason: 'System package install — may require sudo' },
  { pattern: 'apt remove', reason: 'System package removal' },
];

/**
 * Creates a tool:before hook that blocks dangerous shell commands
 * and warns on risky ones.
 */
export function createShellDangerHook(): HookRegistration<ToolBeforeContext> {
  return {
    id: 'safety:shell-danger',
    event: 'tool:before',
    handler: (ctx) => {
      const command = String(ctx.args.command ?? '').trim().toLowerCase();
      if (!command) return;

      // Check blocked patterns
      for (const pattern of BLOCKED_PATTERNS) {
        if (command.includes(pattern.toLowerCase())) {
          ctx.blocked = true;
          ctx.blockReason = `Dangerous command blocked: "${pattern}". This command can cause irreversible damage.`;
          return 'abort';
        }
      }

      // Check warn patterns
      for (const { pattern, reason } of WARN_PATTERNS) {
        if (command.includes(pattern.toLowerCase())) {
          ctx.metadata.warnings = ctx.metadata.warnings ?? [];
          (ctx.metadata.warnings as string[]).push(`⚠️ ${reason}`);
        }
      }
    },
    priority: 10, // Run early — safety first
    toolFilter: ['shell'],
    onError: 'abort', // If safety check itself fails, block
    description: 'Blocks dangerous shell commands, warns on risky ones',
  };
}

// ---------------------------------------------------------------------------
// Workspace Fence
// ---------------------------------------------------------------------------

export interface WorkspaceFenceConfig {
  /** Allowed directories — file operations outside these are blocked */
  allowedDirs: string[];
  /** Additional paths to always allow (e.g., /tmp) */
  alwaysAllow?: string[];
  /** Tools this fence applies to (default: file_read, file_write, file_edit) */
  tools?: string[];
}

/**
 * Creates a tool:before hook that blocks file operations outside
 * the workspace boundary.
 */
export function createWorkspaceFenceHook(config: WorkspaceFenceConfig): HookRegistration<ToolBeforeContext> {
  const allowedDirs = [
    ...config.allowedDirs,
    ...(config.alwaysAllow ?? ['/tmp', '/var/tmp']),
  ].map(normalizePath);

  const fencedTools = new Set(config.tools ?? ['file_read', 'file_write', 'file_edit']);

  return {
    id: 'safety:workspace-fence',
    event: 'tool:before',
    handler: (ctx) => {
      if (!fencedTools.has(ctx.toolName)) return;

      // Extract path from args — different tools use different arg names
      const targetPath = String(ctx.args.path ?? ctx.args.file ?? ctx.args.cwd ?? '');
      if (!targetPath) return;

      const normalized = normalizePath(targetPath);

      // Check if path is inside any allowed directory
      const isAllowed = allowedDirs.some((dir) => normalized.startsWith(dir));
      if (!isAllowed) {
        ctx.blocked = true;
        ctx.blockReason = `File operation blocked: "${targetPath}" is outside the allowed workspace. Allowed: ${config.allowedDirs.join(', ')}`;
        return 'abort';
      }
    },
    priority: 15, // After shell danger, before custom rules
    onError: 'abort',
    description: 'Blocks file operations outside workspace boundaries',
  };
}

function normalizePath(p: string): string {
  // Basic normalization — resolve ~ and ensure trailing slash consistency
  const resolved = p.replace(/^~/, process.env.HOME ?? '/root');
  // Remove trailing slashes for consistent comparison
  return resolved.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Audit Logger
// ---------------------------------------------------------------------------

/**
 * Creates a pair of hooks (tool:before + tool:after) that log every tool
 * invocation to an audit writer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuditHooks(writer: AuditWriter): HookRegistration<any>[] {
  const beforeHook: HookRegistration<ToolBeforeContext> = {
    id: 'safety:audit-before',
    event: 'tool:before',
    handler: async (ctx) => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        event: 'tool:before',
        toolName: ctx.toolName,
        args: sanitizeArgs(ctx.args),
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        blocked: ctx.blocked,
        blockReason: ctx.blockReason,
      };
      await writer.write(entry);
    },
    priority: 90, // Run late — after all safety checks so we capture block status
    onError: 'continue', // Audit failure shouldn't block tool execution
    description: 'Logs tool invocation to audit trail (before)',
  };

  const afterHook: HookRegistration<ToolAfterContext> = {
    id: 'safety:audit-after',
    event: 'tool:after',
    handler: async (ctx) => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        event: 'tool:after',
        toolName: ctx.toolName,
        args: sanitizeArgs(ctx.args),
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        durationMs: ctx.durationMs,
        isError: ctx.isError,
      };
      await writer.write(entry);
    },
    priority: 90,
    onError: 'continue',
    description: 'Logs tool result to audit trail (after)',
  };

  return [beforeHook, afterHook];
}

/**
 * Sanitize args for audit logging — truncate long values, redact secrets.
 */
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const secretKeys = new Set(['password', 'token', 'secret', 'api_key', 'apiKey', 'key']);

  for (const [key, value] of Object.entries(args)) {
    if (secretKeys.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 500) {
      sanitized[key] = value.slice(0, 500) + `… [${value.length} chars]`;
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// Custom Safety Rules
// ---------------------------------------------------------------------------

/**
 * Creates a tool:before hook from a set of custom safety rules.
 * Rules are evaluated in order — first match wins.
 */
export function createCustomRulesHook(rules: SafetyRule[]): HookRegistration<ToolBeforeContext> {
  return {
    id: 'safety:custom-rules',
    event: 'tool:before',
    handler: (ctx) => {
      for (const rule of rules) {
        // Skip if rule has a tool filter and current tool doesn't match
        if (rule.tools?.length && !rule.tools.includes(ctx.toolName)) continue;

        if (rule.match(ctx.toolName, ctx.args)) {
          if (rule.action === 'block') {
            ctx.blocked = true;
            ctx.blockReason = rule.description;
            return 'abort';
          }
          if (rule.action === 'warn') {
            ctx.metadata.warnings = ctx.metadata.warnings ?? [];
            (ctx.metadata.warnings as string[]).push(`⚠️ ${rule.description}`);
          }
        }
      }
    },
    priority: 20, // After shell danger (10), after workspace fence (15)
    onError: 'continue', // Custom rule failure shouldn't block
    description: `Custom safety rules (${rules.length} rules)`,
  };
}

// ---------------------------------------------------------------------------
// Pre-built Rules
// ---------------------------------------------------------------------------

/** Block npm publish without --dry-run */
export const RULE_NPM_DRY_RUN: SafetyRule = {
  id: 'npm-dry-run',
  tools: ['shell'],
  action: 'block',
  description: 'npm publish requires --dry-run flag',
  match: (_tool, args) => {
    const cmd = String(args.command ?? '');
    return cmd.includes('npm publish') && !cmd.includes('--dry-run');
  },
};

/** Warn on file_write to config files */
export const RULE_WARN_CONFIG_WRITE: SafetyRule = {
  id: 'warn-config-write',
  tools: ['file_write', 'file_edit'],
  action: 'warn',
  description: 'Modifying a config file — double-check the changes',
  match: (_tool, args) => {
    const path = String(args.path ?? '');
    return /\.(ya?ml|json|toml|env|ini|conf|cfg)$/i.test(path);
  },
};

/** Block deleting .git directories */
export const RULE_NO_DELETE_GIT: SafetyRule = {
  id: 'no-delete-git',
  tools: ['shell'],
  action: 'block',
  description: 'Deleting .git directories is blocked',
  match: (_tool, args) => {
    const cmd = String(args.command ?? '');
    return /rm\s+.*\.git\b/.test(cmd);
  },
};

// ---------------------------------------------------------------------------
// Convenience: register all safety hooks at once
// ---------------------------------------------------------------------------

export interface SafetyHooksConfig {
  /** Enable shell danger blocker (default: true) */
  shellDanger?: boolean;
  /** Workspace fence config (optional — disabled if not provided) */
  workspaceFence?: WorkspaceFenceConfig;
  /** Audit writer (optional — disabled if not provided) */
  auditWriter?: AuditWriter;
  /** Custom rules (optional) */
  customRules?: SafetyRule[];
}

/**
 * Returns all configured safety hooks, ready to register on a HookPipeline.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSafetyHooks(config: SafetyHooksConfig): HookRegistration<any>[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks: HookRegistration<any>[] = [];

  if (config.shellDanger !== false) {
    hooks.push(createShellDangerHook());
  }

  if (config.workspaceFence) {
    hooks.push(createWorkspaceFenceHook(config.workspaceFence));
  }

  if (config.auditWriter) {
    hooks.push(...createAuditHooks(config.auditWriter));
  }

  if (config.customRules?.length) {
    hooks.push(createCustomRulesHook(config.customRules));
  }

  return hooks;
}
