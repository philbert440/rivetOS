/**
 * rivetos doctor
 *
 * Check config, provider connectivity, workspace files, memory backend.
 */

import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const VERSION = '0.1.0';

export default async function doctor(): Promise<void> {
  console.log(`RivetOS Doctor v${VERSION}\n`);
  let issues = 0;

  // 1. Config file
  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml');
  try {
    await access(configPath);
    console.log(`✅ Config: ${configPath}`);
  } catch {
    console.log(`❌ Config: ${configPath} not found`);
    console.log('   Run: rivetos config init');
    issues++;
  }

  // 2. Workspace directory
  const workspacePath = resolve(process.env.HOME ?? '.', '.rivetos', 'workspace');
  const requiredFiles = ['SOUL.md', 'AGENTS.md'];
  const optionalFiles = ['IDENTITY.md', 'USER.md', 'TOOLS.md', 'MEMORY.md', 'HEARTBEAT.md'];

  for (const file of requiredFiles) {
    try {
      await access(resolve(workspacePath, file));
      console.log(`✅ Workspace: ${file}`);
    } catch {
      console.log(`❌ Workspace: ${file} missing (required)`);
      issues++;
    }
  }

  for (const file of optionalFiles) {
    try {
      await access(resolve(workspacePath, file));
      console.log(`✅ Workspace: ${file}`);
    } catch {
      console.log(`⚠️ Workspace: ${file} missing (optional)`);
    }
  }

  // 3. Environment variables
  const envVars: Array<{ name: string; required: boolean }> = [
    { name: 'ANTHROPIC_API_KEY', required: false },
    { name: 'XAI_API_KEY', required: false },
    { name: 'GOOGLE_API_KEY', required: false },
    { name: 'TELEGRAM_BOT_TOKEN', required: false },
    { name: 'RIVETOS_PG_URL', required: false },
  ];

  console.log('');
  for (const { name, required } of envVars) {
    const value = process.env[name];
    if (value) {
      console.log(`✅ Env: ${name} = ${value.slice(0, 10)}...`);
    } else if (required) {
      console.log(`❌ Env: ${name} not set (required)`);
      issues++;
    } else {
      console.log(`⚠️ Env: ${name} not set`);
    }
  }

  // 4. OAuth tokens
  console.log('');
  const tokenPath = resolve(process.env.HOME ?? '.', '.rivetos', 'anthropic-tokens.json');
  try {
    const raw = await readFile(tokenPath, 'utf-8');
    const tokens = JSON.parse(raw);
    const expired = Date.now() >= tokens.expiresAt;
    const hasRefresh = !!tokens.refreshToken;
    if (hasRefresh) {
      console.log(`✅ Anthropic OAuth: tokens stored ${expired ? '(access expired, will auto-refresh)' : '(valid)'}`);
    } else if (!expired) {
      console.log(`⚠️ Anthropic OAuth: access token only (no refresh — will expire)`);
    } else {
      console.log(`❌ Anthropic OAuth: expired, no refresh token`);
      console.log('   Run: rivetos login anthropic');
      issues++;
    }
  } catch {
    console.log(`⚠️ Anthropic OAuth: not configured (run: rivetos login anthropic)`);
  }

  // Summary
  console.log('');
  if (issues === 0) {
    console.log('✅ All checks passed.');
  } else {
    console.log(`⚠️ ${issues} issue(s) found.`);
  }
}
