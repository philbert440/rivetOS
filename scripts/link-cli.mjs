#!/usr/bin/env node

/**
 * link-cli.mjs — Creates the `rivetos` binary symlink in node_modules/.bin/
 *
 * npm workspaces don't reliably create .bin symlinks for workspace packages
 * when the root package is private. This script ensures `npx rivetos` works
 * after install + build.
 *
 * Cross-platform: works on Linux, macOS, and Windows (creates .cmd shim).
 */

import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from 'fs';
import { join, resolve } from 'path';

const root = resolve(import.meta.dirname, '..');
const binDir = join(root, 'node_modules', '.bin');
const target = join(root, 'packages', 'cli', 'dist', 'index.js');

if (!existsSync(target)) {
  console.warn('⚠ CLI not built yet — skipping link. Run `npm run build` first.');
  // Still try to clean up any stale/wrong symlinks
  const linkPath = join(binDir, 'rivetos');
  try { unlinkSync(linkPath); } catch { /* noop */ }
  process.exit(0);
}

// Ensure .bin directory exists
if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
}

const isWindows = process.platform === 'win32';

if (isWindows) {
  // Windows: create .cmd shim
  const cmdPath = join(binDir, 'rivetos.cmd');
  const ps1Path = join(binDir, 'rivetos.ps1');
  const shPath = join(binDir, 'rivetos');

  // .cmd for Command Prompt
  const cmdContent = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "${target}" %*\r\n`;
  writeFileSync(cmdPath, cmdContent);

  // PowerShell shim
  const ps1Content = `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n  $exe=".exe"\n}\n$ret=0\nif (Test-Path "$basedir/node$exe") {\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "$basedir/node$exe" "${target}" $args\n  } else {\n    & "$basedir/node$exe" "${target}" $args\n  }\n  $ret=$LASTEXITCODE\n} else {\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "node$exe" "${target}" $args\n  } else {\n    & "node$exe" "${target}" $args\n  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n`;
  writeFileSync(ps1Path, ps1Content);

  // Also create a shell script for WSL/Git Bash
  const shContent = `#!/bin/sh\nexec node "${target}" "$@"\n`;
  writeFileSync(shPath, shContent);

  console.log('✓ Linked rivetos CLI (Windows .cmd + .ps1 + sh shims)');
} else {
  // Unix: create symlink
  const linkPath = join(binDir, 'rivetos');

  try { unlinkSync(linkPath); } catch { /* doesn't exist yet */ }

  symlinkSync(target, linkPath);
  chmodSync(linkPath, 0o755);

  console.log(`✓ Linked rivetos CLI → packages/cli/dist/index.js`);
}
