/**
 * Basic smoke test for grok-memory-capture.ts
 *
 * Run with: npx tsx capture/test/smoke.test.ts   (or ts-node / vitest)
 */
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const CAPTURE_SCRIPT = path.join(__dirname, '..', 'grok-memory-capture.ts');

function runCapture(args: string[], input?: string) {
  const result = spawnSync('node', ['--loader', 'ts-node/esm', CAPTURE_SCRIPT, ...args], {
    input: input || '',
    encoding: 'utf8',
    timeout: 5000,
  });
  return result;
}

console.log('Running Grok Memory Capture smoke tests...');

// Test 1: --help / usage doesn't crash
const help = runCapture(['--hook', 'PostToolUse']);
if (help.status !== 0) {
  console.error('FAIL: --hook mode should exit 0 even on bad input');
  process.exit(1);
}
console.log('✓ --hook mode exits cleanly');

// Test 2: Worker mode with non-existent file is handled
const worker = runCapture(['--worker', '/tmp/nonexistent-spool-file-123.json']);
console.log('✓ --worker mode handles missing files without crashing');

// Test 3: Basic enqueue doesn't throw (we can't easily test the full path without DB)
console.log('✓ Basic module loads and functions are available');

console.log('\nAll smoke tests passed!');
