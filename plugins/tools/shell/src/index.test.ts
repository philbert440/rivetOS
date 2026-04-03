/**
 * ShellTool tests — command execution, blocked commands, timeout, abort.
 */

import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { ShellTool } from './index.js';

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
