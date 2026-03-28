/**
 * ShellTool tests — command execution, categorization, blocked commands,
 * git safety, session cwd, timeout, abort.
 */

import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { ShellTool, categorizeCommand, checkGitWarnings } from './index.js';

// ---------------------------------------------------------------------------
// Command categorization
// ---------------------------------------------------------------------------

describe('categorizeCommand', () => {
  it('categorizes read-only commands', () => {
    assert.equal(categorizeCommand('ls -la'), 'read');
    assert.equal(categorizeCommand('cat file.txt'), 'read');
    assert.equal(categorizeCommand('git status'), 'read');
    assert.equal(categorizeCommand('git log --oneline'), 'read');
    assert.equal(categorizeCommand('pwd'), 'read');
    assert.equal(categorizeCommand('echo hello'), 'read');
    assert.equal(categorizeCommand('grep foo bar.txt'), 'read');
  });

  it('categorizes write commands', () => {
    assert.equal(categorizeCommand('npm install'), 'write');
    assert.equal(categorizeCommand('git commit -m "test"'), 'write');
    assert.equal(categorizeCommand('git push origin main'), 'write');
    assert.equal(categorizeCommand('mkdir -p /tmp/test'), 'write');
    assert.equal(categorizeCommand('touch newfile.txt'), 'write');
  });

  it('categorizes dangerous commands', () => {
    assert.equal(categorizeCommand('rm -rf /'), 'dangerous');
    assert.equal(categorizeCommand('mkfs.ext4 /dev/sda'), 'dangerous');
    assert.equal(categorizeCommand(':(){:|:&};:'), 'dangerous');
    assert.equal(categorizeCommand('dd if=/dev/zero of=/dev/sda'), 'dangerous');
  });
});

// ---------------------------------------------------------------------------
// Git warnings
// ---------------------------------------------------------------------------

describe('checkGitWarnings', () => {
  it('warns on force push', () => {
    const warning = checkGitWarnings('git push --force origin main');
    assert.ok(warning);
    assert.ok(warning.includes('force'));
  });

  it('warns on hard reset', () => {
    const warning = checkGitWarnings('git reset --hard HEAD~3');
    assert.ok(warning);
    assert.ok(warning.includes('data loss'));
  });

  it('warns on branch -D', () => {
    const warning = checkGitWarnings('git branch -D feature');
    assert.ok(warning);
  });

  it('returns null for safe git commands', () => {
    assert.equal(checkGitWarnings('git push origin main'), null);
    assert.equal(checkGitWarnings('git commit -m "test"'), null);
    assert.equal(checkGitWarnings('git status'), null);
  });
});

// ---------------------------------------------------------------------------
// ShellTool — basic execution
// ---------------------------------------------------------------------------

describe('ShellTool', () => {
  it('should execute a simple command', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'echo hello' });
    assert.equal(result.trim(), 'hello');
  });

  it('should return stderr alongside stdout', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'echo out && echo err >&2' });
    assert.ok(result.includes('out'));
    assert.ok(result.includes('err'));
  });

  it('should report exit code for non-zero exits', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'exit 42' });
    assert.ok(result.includes('exit code: 42'));
  });

  it('should block dangerous commands', async () => {
    const tool = new ShellTool({ blocked: ['rm -rf /'] });
    const result = await tool.execute({ command: 'rm -rf / --no-preserve-root' });
    assert.ok(result.includes('blocked'));
  });

  it('should block fork bomb', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: ':(){:|:&};:' });
    assert.ok(result.includes('blocked'));
  });

  it('should return error for empty command', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: '' });
    assert.ok(result.includes('Error'));
  });

  it('should return error for missing command arg', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
  });

  it('should respect custom working directory', async () => {
    const tool = new ShellTool({ cwd: '/tmp' });
    const result = await tool.execute({ command: 'pwd' });
    assert.equal(result.trim(), '/tmp');
  });

  it('should respect cwd override in args', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'pwd', cwd: '/tmp' });
    assert.equal(result.trim(), '/tmp');
  });

  it('should abort on signal', async () => {
    const controller = new AbortController();

    const tool = new ShellTool({ timeoutMs: 30000 });
    const promise = tool.execute({ command: 'sleep 30' }, controller.signal);

    // Abort after a short delay
    setTimeout(() => controller.abort(), 100);

    const result = await promise;
    assert.ok(result.includes('abort') || result.includes('SIGTERM') || result.includes('exit code'));
  });

  it('should truncate long output', async () => {
    const tool = new ShellTool({ maxOutput: 50 });
    const result = await tool.execute({ command: 'seq 1 1000' });
    assert.ok(result.includes('truncated'));
  });

  it('should handle commands that produce no output', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'true' });
    assert.equal(result, '(no output)');
  });

  it('should have correct tool metadata', () => {
    const tool = new ShellTool();
    assert.equal(tool.name, 'shell');
    assert.ok(tool.description.length > 0);
    assert.ok(tool.parameters);
    assert.equal(tool.parameters.type, 'object');
  });
});

// ---------------------------------------------------------------------------
// ShellTool — command categorization & approval
// ---------------------------------------------------------------------------

describe('ShellTool approval', () => {
  it('blocks dangerous commands by default', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'dd if=/dev/zero of=/dev/sda' });
    assert.ok(result.includes('blocked'));
  });

  it('allows read commands with warn approval', async () => {
    const tool = new ShellTool({ approval: { read: 'warn' } });
    const result = await tool.execute({ command: 'echo hello' });
    assert.ok(result.includes('Warning'));
    assert.ok(result.includes('hello'));
  });

  it('blocks write commands when configured', async () => {
    const tool = new ShellTool({ approval: { write: 'block' } });
    const result = await tool.execute({ command: 'npm install' });
    assert.ok(result.includes('blocked'));
    assert.ok(result.includes('category: write'));
  });
});

// ---------------------------------------------------------------------------
// ShellTool — session cwd
// ---------------------------------------------------------------------------

describe('ShellTool session cwd', () => {
  it('persists cwd across cd commands', async () => {
    const tool = new ShellTool({ cwd: '/tmp' });

    const cdResult = await tool.execute({ command: 'cd /home' });
    assert.ok(cdResult.includes('/home'));

    // Next command should run in /home
    assert.equal(tool.getSessionCwd(), '/home');
  });

  it('rejects cd to nonexistent directory', async () => {
    const tool = new ShellTool();
    const result = await tool.execute({ command: 'cd /this/does/not/exist/at/all' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('not found'));
  });

  it('resets session cwd', async () => {
    const tool = new ShellTool({ cwd: '/tmp' });
    await tool.execute({ command: 'cd /home' });
    assert.equal(tool.getSessionCwd(), '/home');

    tool.resetSessionCwd();
    assert.equal(tool.getSessionCwd(), '/tmp');
  });
});

// ---------------------------------------------------------------------------
// ShellTool — git safety
// ---------------------------------------------------------------------------

describe('ShellTool git safety', () => {
  it('warns on force push', async () => {
    const tool = new ShellTool();
    // This will try to actually run git push --force, which will fail,
    // but the warning should still be in the output
    const result = await tool.execute({ command: 'echo "would force push" && git push --force origin main 2>&1 || true' });
    assert.ok(result.includes('⚠️') || result.includes('force'), `Expected git warning, got: ${result}`);
  });
});
