#!/usr/bin/env node
/**
 * Merge or unmerge rivet-memory capture hooks into Codex ~/.codex/hooks.json.
 *
 *   node merge-hooks-json.cjs apply  DEST FRAGMENT PLUGIN_PATH
 *   node merge-hooks-json.cjs remove DEST PLUGIN_PATH
 *   node merge-hooks-json.cjs sync   DEST FRAGMENT PLUGIN_PATH managed|user
 *
 * Never rewrites DEST on parse/shape errors. Command strings are built with
 * bash single-quote quoting (never raw <PLUGIN_PATH> substitution).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MARKER_SCRIPT = 'codex-memory-capture.sh';
const MARKER_FLAG = '--hook';

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, `'\\''`) + "'";
}

function hookCommand(pluginPath) {
  const script = path.join(pluginPath, 'bin', MARKER_SCRIPT);
  return `bash ${shellQuote(script)} ${MARKER_FLAG}`;
}

function commandIsOurs(command) {
  const text = typeof command === 'string' ? command : '';
  return text.includes(MARKER_SCRIPT) && text.includes(MARKER_FLAG);
}

function die(message, dest) {
  const extra = dest ? ` Leaving ${dest} untouched.` : '';
  process.stderr.write(message.replace(/\n?$/, extra + '\n'));
  process.exit(1);
}

function loadJsonFile(file, missingOk) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (missingOk && err && err.code === 'ENOENT') return null;
    die(`error: cannot read ${file}: ${err.message}`, file);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    die(
      `error: ${file} is not valid JSON (${err.message}). Repair the file and re-run.`,
      file,
    );
  }
}

function requireHooksObject(destObj, dest) {
  if (!destObj || typeof destObj !== 'object' || Array.isArray(destObj)) {
    die(`error: ${dest} is not a JSON object. Repair the file and re-run.`, dest);
  }
  if (destObj.hooks == null) destObj.hooks = {};
  if (typeof destObj.hooks !== 'object' || Array.isArray(destObj.hooks)) {
    die(
      `error: ${dest} has a hooks value that is not an object. Repair the file and re-run.`,
      dest,
    );
  }
  return destObj;
}

function innerHasMarker(group) {
  const inner = group && Array.isArray(group.hooks) ? group.hooks : [];
  return inner.some((h) => h && commandIsOurs(h.command));
}

function eventHasMarker(groups) {
  return Array.isArray(groups) && groups.some(innerHasMarker);
}

function ourGroupFromTemplate(template, command) {
  const innerSrc =
    template && Array.isArray(template.hooks) && template.hooks.length
      ? template.hooks
      : [{ type: 'command', timeout: 20 }];
  const inner = innerSrc.map((item) => {
    const base = item && typeof item === 'object' && !Array.isArray(item) ? { ...item } : {};
    base.type = base.type || 'command';
    base.command = command;
    if (base.timeout == null) base.timeout = 20;
    return base;
  });
  return { hooks: inner };
}

function applyMerge(dest, fragmentPath, pluginPath) {
  const command = hookCommand(pluginPath);
  const fragment = loadJsonFile(fragmentPath, false);
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
    die(`error: ${fragmentPath} is not a JSON object.`);
  }
  let destObj = loadJsonFile(dest, true);
  if (destObj == null) destObj = { hooks: {} };
  else destObj = requireHooksObject(destObj, dest);
  const hooks = destObj.hooks;
  let added = 0;
  for (const [event, groups] of Object.entries(fragment.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    if (hooks[event] != null && !Array.isArray(hooks[event])) {
      die(
        `error: ${dest} hooks.${event} is not an array. Repair the file and re-run.`,
        dest,
      );
    }
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (eventHasMarker(existing)) continue;
    const built = groups.map((g) => ourGroupFromTemplate(g, command));
    hooks[event] = existing.concat(built);
    added += built.length;
  }
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(destObj, null, 2) + '\n');
  process.stdout.write(
    (added > 0 ? `merged ${added} hook group(s) into ` : `hooks already present in `) +
      dest +
      '\n',
  );
}

function stripGroup(group) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return group;
  const inner = Array.isArray(group.hooks) ? group.hooks : null;
  if (!inner) return group;
  const kept = inner.filter((h) => !(h && commandIsOurs(h.command)));
  if (kept.length === inner.length) return group;
  if (kept.length === 0) return null;
  return { ...group, hooks: kept };
}

function syncUserHooks(dest, fragmentPath, pluginPath, managedOk) {
  if (managedOk) {
    if (fs.existsSync(dest)) removeMerge(dest);
    else process.stdout.write(`no ${dest}\n`);
    return 'managed';
  }
  applyMerge(dest, fragmentPath, pluginPath);
  return 'user';
}

function removeMerge(dest) {
  const destObjRaw = loadJsonFile(dest, true);
  if (destObjRaw == null) {
    process.stdout.write(`no ${dest}\n`);
    return;
  }
  const destObj = requireHooksObject(destObjRaw, dest);
  const hooks = destObj.hooks;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const existing = hooks[event];
    if (!Array.isArray(existing)) continue;
    const kept = [];
    for (const group of existing) {
      const before =
        group && typeof group === 'object' && Array.isArray(group.hooks) ? group.hooks.length : 0;
      const stripped = stripGroup(group);
      if (stripped == null) {
        const inner =
          group && typeof group === 'object' && Array.isArray(group.hooks) ? group.hooks : [];
        removed += inner.filter((h) => h && commandIsOurs(h.command)).length;
        continue;
      }
      const after =
        stripped && typeof stripped === 'object' && Array.isArray(stripped.hooks)
          ? stripped.hooks.length
          : 0;
      if (after < before) removed += before - after;
      kept.push(stripped);
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  fs.writeFileSync(dest, JSON.stringify(destObj, null, 2) + '\n');
  process.stdout.write(`removed ${removed} hook command(s) from ${dest}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const action = args[0];
  if (action === 'apply') {
    if (args.length !== 4) die('usage: merge-hooks-json.cjs apply DEST FRAGMENT PLUGIN_PATH');
    applyMerge(args[1], args[2], args[3]);
    return;
  }
  if (action === 'remove') {
    if (args.length !== 3) die('usage: merge-hooks-json.cjs remove DEST PLUGIN_PATH');
    removeMerge(args[1]);
    return;
  }
  if (action === 'sync') {
    if (args.length !== 5 || (args[4] !== 'managed' && args[4] !== 'user')) {
      die('usage: merge-hooks-json.cjs sync DEST FRAGMENT PLUGIN_PATH managed|user');
    }
    const mode = syncUserHooks(args[1], args[2], args[3], args[4] === 'managed');
    process.stdout.write(`registration: ${mode}\n`);
    return;
  }
  process.stderr.write(
    'usage: merge-hooks-json.cjs apply DEST FRAGMENT PLUGIN_PATH\n' +
      '       merge-hooks-json.cjs remove DEST PLUGIN_PATH\n' +
      '       merge-hooks-json.cjs sync DEST FRAGMENT PLUGIN_PATH managed|user\n',
  );
  process.exit(1);
}

main();
