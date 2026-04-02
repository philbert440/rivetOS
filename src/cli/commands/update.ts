/**
 * rivetos update
 *
 * Update RivetOS to latest:
 * 1. Git pull
 * 2. npm install
 * 3. Re-symlink binary
 * 4. Show what changed
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { unlinkSync, symlinkSync, readlinkSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');

function exec(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 120000 }).trim();
}

function execQuiet(cmd: string): string | null {
  try {
    return exec(cmd);
  } catch {
    return null;
  }
}

export default async function update(): Promise<void> {
  const binSource = resolve(ROOT, 'bin', 'rivetos');
  const binTarget = '/usr/local/bin/rivetos';

  // Check if git repo
  if (!execQuiet('git rev-parse --git-dir')) {
    console.error(`Not a git repository: ${ROOT}`);
    process.exit(1);
  }

  // Current state
  const oldPkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf-8'));
  const oldCommit = execQuiet('git rev-parse --short HEAD') ?? 'unknown';
  console.log(`Current: v${oldPkg.version} (${oldCommit})\n`);

  // Git pull
  console.log('Pulling latest...');
  try {
    const pullOutput = exec('git pull --ff-only');
    console.log(`  ${pullOutput}\n`);
  } catch (err: any) {
    console.error('  ❌ Git pull failed. Resolve manually:');
    console.error(`     cd ${ROOT} && git status`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  // npm install
  console.log('Installing dependencies...');
  try {
    exec('npm install --no-audit --no-fund');
    console.log('  ✅ Dependencies installed\n');
  } catch (err: any) {
    console.error(`  ❌ npm install failed: ${err.message}`);
    process.exit(1);
  }

  // Re-symlink
  try {
    try {
      const current = readlinkSync(binTarget);
      if (current !== binSource) {
        unlinkSync(binTarget);
        symlinkSync(binSource, binTarget);
        console.log(`  ✅ Symlink updated: ${binTarget} → ${binSource}`);
      } else {
        console.log(`  ⏭️  Symlink unchanged`);
      }
    } catch {
      // Doesn't exist yet
      symlinkSync(binSource, binTarget);
      console.log(`  ✅ Symlink created: ${binTarget} → ${binSource}`);
    }
  } catch (err: any) {
    if (err.code === 'EACCES') {
      console.log(`  ⚠️  Permission denied updating symlink. Try: sudo rivetos update`);
    } else {
      console.log(`  ⚠️  Symlink error: ${err.message}`);
    }
  }

  // New state
  const newPkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf-8'));
  const newCommit = execQuiet('git rev-parse --short HEAD') ?? 'unknown';

  console.log('');
  if (oldPkg.version !== newPkg.version) {
    console.log(`  v${oldPkg.version} → v${newPkg.version}`);
  }
  if (oldCommit !== newCommit) {
    console.log('Recent commits:');
    const log = execQuiet('git log --oneline -5');
    if (log) {
      for (const line of log.split('\n')) {
        console.log(`    ${line}`);
      }
    }
  } else {
    console.log('Already up to date.');
  }

  console.log(`\n✅ RivetOS v${newPkg.version} (${newCommit})`);
}
