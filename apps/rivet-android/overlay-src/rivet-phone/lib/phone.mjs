#!/usr/bin/env node
/**
 * phone — RivetHub device-control CLI (Fidelity + PR6b surface).
 *
 * Reads ~/.rivet/control.json (or RIVET_CONTROL_JSON path override), talks HTTP
 * to 127.0.0.1:<port> with X-Rivet-Token, pretty-prints JSON responses.
 *
 * Exit codes:
 *   0 — ok:true / 2xx success
 *   1 — ok:false, HTTP error (401/403/stale_node/…), connection refused
 *   2 — usage error or unknown subcommand
 *   3 — error:"busy" (gesture queue full)
 *
 * Output: pretty JSON on stdout by default. Pass --quiet to suppress body on
 * success (one-line summary still goes to stderr when helpful). --json is
 * accepted as an alias for default pretty-JSON (documented for agents).
 *
 * Node ≥18, zero npm deps. ESM.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const EXIT_OK = 0;
const EXIT_ERR = 1;
const EXIT_USAGE = 2;
const EXIT_BUSY = 3;

const DEFAULT_TIMEOUT_MS = 15_000;
const HOST = "127.0.0.1";

/** Subcommands that are intentionally not shipped yet (exit 2). */
const DEFERRED = new Set([
  // PR6b shipped wait/clipboard/long-press/double-tap/drag/scroll/rich node.
  // Keep the set for future deferred surface.
]);

const GLOBAL_ACTIONS = new Set([
  "BACK",
  "HOME",
  "RECENTS",
  "NOTIFICATIONS",
  "QUICK_SETTINGS",
  "POWER_DIALOG",
  "LOCK_SCREEN",
  "TAKE_SCREENSHOT",
  "DISMISS_NOTIFICATION_SHADE",
]);

const NODE_ACTIONS = new Set([
  "click",
  "long_click",
  "focus",
  "set_text",
  "scroll_forward",
  "scroll_backward",
  "select",
]);

const SCROLL_DIRS = new Set(["up", "down", "left", "right"]);

// ─── helpers ────────────────────────────────────────────────────────────────

function die(msg, code = EXIT_USAGE) {
  process.stderr.write(`phone: ${msg}\n`);
  process.exit(code);
}

function usage(exit = EXIT_USAGE) {
  process.stdout.write(`phone — RivetHub device-control CLI

Usage:
  phone status
  phone mode <full|eyes|parked>
  phone ui [--format flat|tree|compact] [--clickable] [--editable]
           [--text S] [--package P] [--limit N] [--max-depth N] …
  phone shot [-o path] [--scale 0.4] [--quality 70] [--dest file|json]
  phone tap X Y
  phone swipe X1 Y1 X2 Y2 [--duration 280]
  phone text 'hello'                 # replace (mode=replace)
  phone text --append 'more'         # append into focused field
  phone global BACK|HOME|RECENTS|NOTIFICATIONS|QUICK_SETTINGS
                     |POWER_DIALOG|LOCK_SCREEN|TAKE_SCREENSHOT|DISMISS_NOTIFICATION_SHADE
  phone click-text 'Settings' [--package P]
  phone node NODE_ID [--action click|long_click|focus|set_text|
                       scroll_forward|scroll_backward|select] [--text S]
  phone long-press X Y [--duration 600]
  phone long-press --node NODE_ID
  phone double-tap X Y
  phone drag X1 Y1 X2 Y2 [--duration 300]
  phone scroll <up|down|left|right> [--node NODE_ID]
  phone wait [--text S] [--package P] [--gone S] [--timeout MS] [--interval MS]
  phone clipboard get
  phone clipboard set 'text'
  phone launch PACKAGE
  phone intent --action VIEW --data URL [--package P] [--confirm]
  phone notify --title T [--body B] [--url U]
  phone help

Global flags:
  --timeout MS   HTTP timeout (default ${DEFAULT_TIMEOUT_MS}); also wait timeoutMs
  --json         pretty-print JSON (default)
  --quiet        suppress JSON body; keep one-line summary on stderr

Config: ~/.rivet/control.json  ({"port":9876,"token":"…"})
        override path with RIVET_CONTROL_JSON
Base URL: http://${HOST}:<port>  (loopback only)

Full reference: ~/.rivet/device-control.md
`);
  process.exit(exit);
}

function loadControl() {
  const cfgPath =
    process.env.RIVET_CONTROL_JSON ||
    path.join(os.homedir(), ".rivet", "control.json");
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, "utf8");
  } catch (e) {
    die(
      `cannot read control config at ${cfgPath}: ${e.message}\n` +
        `  Is RivetHub running? control.json is written on each agent launch.`,
      EXIT_ERR,
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    die(`invalid JSON in ${cfgPath}`, EXIT_ERR);
  }
  const port = Number(cfg.port);
  const token = cfg.token;
  if (!Number.isFinite(port) || port <= 0) {
    die(`control.json missing valid "port" (${cfgPath})`, EXIT_ERR);
  }
  if (typeof token !== "string" || !token) {
    die(`control.json missing "token" (${cfgPath})`, EXIT_ERR);
  }
  return { port, token, cfgPath };
}

/**
 * Minimal argv parser: global flags anywhere; returns { flags, positionals }.
 * Boolean flags: --clickable, --editable, --json, --quiet, --help, -h, --append
 * Value flags: --timeout, --format, --scale, --quality, --dest, -o/--output,
 *              --package, --text, --limit, --max-depth, --duration,
 *              --action, --data, --title, --body, --url, --class, --view-id,
 *              --fields, --visible, --text-exact, --text-regex, --gone,
 *              --interval, --node
 */
function parseArgs(argv) {
  const flags = {
    timeout: DEFAULT_TIMEOUT_MS,
    json: true,
    quiet: false,
  };
  const positionals = [];
  const boolFlags = new Set([
    "clickable",
    "editable",
    "json",
    "quiet",
    "help",
    "append",
    "confirm",
  ]);
  const valueFlags = new Map([
    ["timeout", "timeout"],
    ["format", "format"],
    ["scale", "scale"],
    ["quality", "quality"],
    ["dest", "dest"],
    ["o", "output"],
    ["output", "output"],
    ["package", "package"],
    ["text", "textFilter"],
    ["limit", "limit"],
    ["max-depth", "maxDepth"],
    ["maxDepth", "maxDepth"],
    ["duration", "duration"],
    ["action", "action"],
    ["data", "data"],
    ["title", "title"],
    ["body", "body"],
    ["url", "url"],
    ["class", "class"],
    ["view-id", "viewId"],
    ["viewId", "viewId"],
    ["fields", "fields"],
    ["visible", "visible"],
    ["text-exact", "textExact"],
    ["textExact", "textExact"],
    ["text-regex", "textRegex"],
    ["textRegex", "textRegex"],
    ["gone", "gone"],
    ["interval", "interval"],
    ["node", "node"],
  ]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      flags.help = true;
      continue;
    }
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2 && a !== "--")) {
      const raw = a.startsWith("--") ? a.slice(2) : a.slice(1);
      // --flag=value
      let key = raw;
      let inline;
      const eq = raw.indexOf("=");
      if (eq >= 0) {
        key = raw.slice(0, eq);
        inline = raw.slice(eq + 1);
      }
      if (boolFlags.has(key)) {
        flags[key] = inline === undefined ? true : inline !== "0" && inline !== "false";
        continue;
      }
      if (valueFlags.has(key)) {
        const dest = valueFlags.get(key);
        const val = inline !== undefined ? inline : argv[++i];
        if (val === undefined) die(`missing value for --${key}`);
        if (
          dest === "timeout" ||
          dest === "limit" ||
          dest === "maxDepth" ||
          dest === "duration" ||
          dest === "quality" ||
          dest === "interval"
        ) {
          const n = Number(val);
          if (!Number.isFinite(n)) die(`--${key} expects a number`);
          flags[dest] = n;
          if (dest === "timeout") flags._timeoutExplicit = true;
          if (dest === "interval") flags._intervalExplicit = true;
        } else if (dest === "scale") {
          const n = Number(val);
          if (!Number.isFinite(n)) die(`--scale expects a number`);
          flags.scale = n;
        } else if (dest === "clickable" || dest === "editable") {
          flags[dest] = val !== "0" && val !== "false";
        } else {
          flags[dest] = val;
        }
        continue;
      }
      // unknown flag — keep as positional only if it doesn't look like a flag mistake
      die(`unknown flag: ${a}`);
    }
    positionals.push(a);
  }
  return { flags, positionals };
}

function request(port, token, method, urlPath, { body, timeoutMs, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: "application/json",
      Connection: "close",
    };
    if (auth) headers["X-Rivet-Token"] = token;
    let payload;
    if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        host: HOST,
        port,
        path: urlPath,
        method,
        headers,
        timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            // non-JSON body
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`HTTP timeout after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    });
    req.on("error", (err) => reject(err));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function isConnectionRefused(err) {
  return (
    err &&
    (err.code === "ECONNREFUSED" ||
      err.code === "ECONNRESET" ||
      /ECONNREFUSED|connect ECONNREFUSED/i.test(String(err.message || err)))
  );
}

function printResult(res, flags, { summary } = {}) {
  if (summary) process.stderr.write(`${summary}\n`);
  if (flags.quiet) return;
  if (res.json !== null && res.json !== undefined) {
    process.stdout.write(JSON.stringify(res.json, null, 2) + "\n");
  } else if (res.text) {
    process.stdout.write(res.text.endsWith("\n") ? res.text : res.text + "\n");
  }
}

function exitFromResponse(res) {
  const j = res.json;
  if (j && j.error === "busy") return EXIT_BUSY;
  if (res.status >= 200 && res.status < 300) {
    if (j && j.ok === false) return EXIT_ERR;
    return EXIT_OK;
  }
  // HTTP error
  if (j && j.error === "busy") return EXIT_BUSY;
  return EXIT_ERR;
}

async function call(port, token, method, urlPath, opts, flags, summaryFn) {
  let res;
  try {
    res = await request(port, token, method, urlPath, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? flags.timeout,
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      die(
        `connection refused on ${HOST}:${port} — is the Rivet accessibility service on?\n` +
          `  Enable RivetHub Accessibility in Android Settings, then retry.`,
        EXIT_ERR,
      );
    }
    die(`request failed: ${err.message}`, EXIT_ERR);
  }
  const summary = typeof summaryFn === "function" ? summaryFn(res) : undefined;
  printResult(res, flags, { summary });
  process.exit(exitFromResponse(res));
}

function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false) continue;
    if (v === true) {
      parts.push(`${encodeURIComponent(k)}=1`);
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function expandIntentAction(action) {
  if (!action) return action;
  if (action.includes(".")) return action;
  // short form VIEW → android.intent.action.VIEW
  return `android.intent.action.${action}`;
}

function deferredMessage(cmd) {
  return (
    `'${cmd}' is not in the phone CLI surface yet — see ~/.rivet/device-control.md and phone help.`
  );
}

/**
 * Lenient capability check.
 * - If /status has no capabilities object → allow (older builds).
 * - If capabilities is present and the named field is explicitly false → block.
 * - If capabilities has other known keys but this key is absent → block.
 * - Otherwise allow.
 */
function requireCapability(caps, key, label) {
  if (!caps || typeof caps !== "object") return;
  const known = [
    "wait",
    "clipboard",
    "node_actions",
    "modes",
    "gesture_wait",
    "screenshot",
    "ui",
    "notifications_read",
    "exec",
  ];
  const hasAnyKnown = known.some((k) => Object.prototype.hasOwnProperty.call(caps, k));
  if (!hasAnyKnown) return;
  const present = Object.prototype.hasOwnProperty.call(caps, key);
  if (caps[key] === false || (!present && hasAnyKnown)) {
    die(
      `${label} needs a newer RivetHub build (capabilities.${key} not available)`,
      EXIT_ERR,
    );
  }
}

// ─── status cache for feature-detect ────────────────────────────────────────

async function fetchStatus(port, token, timeoutMs) {
  try {
    return await request(port, token, "GET", "/status", {
      auth: false,
      timeoutMs,
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      die(
        `connection refused on ${HOST}:${port} — is the Rivet accessibility service on?\n` +
          `  Enable RivetHub Accessibility in Android Settings, then retry.`,
        EXIT_ERR,
      );
    }
    die(`request failed: ${err.message}`, EXIT_ERR);
  }
}

// ─── commands ───────────────────────────────────────────────────────────────

async function cmdStatus(port, token, flags) {
  await call(port, token, "GET", "/status", { auth: false }, flags, (res) => {
    if (!res.json) return undefined;
    const m = res.json.mode ?? "?";
    const a11y = res.json.accessibility_connected;
    const pkg = res.json.current_package ?? "";
    return `status mode=${m} a11y=${a11y} package=${pkg}`;
  });
}

async function cmdMode(port, token, flags, positionals) {
  const mode = positionals[0];
  if (!mode || !["full", "eyes", "parked"].includes(mode)) {
    die("usage: phone mode <full|eyes|parked>");
  }
  // Feature-detect: modes require capabilities.modes (non-empty array).
  const st = await fetchStatus(port, token, flags.timeout);
  const caps = st.json?.capabilities;
  if (!caps || caps.modes === false || caps.modes === undefined) {
    die(
      "server does not support control modes (capabilities.modes missing) — needs Fidelity PR1b+",
      EXIT_ERR,
    );
  }
  if (Array.isArray(caps.modes) && caps.modes.length === 0) {
    die("server does not support control modes (capabilities.modes empty)", EXIT_ERR);
  }
  if (!Array.isArray(caps.modes)) {
    die("server does not support control modes (capabilities.modes invalid)", EXIT_ERR);
  }
  await call(
    port,
    token,
    "POST",
    "/mode",
    { body: { mode } },
    flags,
    (res) => (res.json?.ok ? `mode → ${mode}` : undefined),
  );
}

async function cmdUi(port, token, flags) {
  const params = {
    format: flags.format || "flat",
  };
  if (flags.clickable) params.clickable = 1;
  if (flags.editable) params.editable = 1;
  if (flags.textFilter) params.text = flags.textFilter;
  if (flags.package) params.package = flags.package;
  if (flags.limit !== undefined) params.limit = flags.limit;
  if (flags.maxDepth !== undefined) params.maxDepth = flags.maxDepth;
  if (flags.class) params.class = flags.class;
  if (flags.viewId) params.viewId = flags.viewId;
  if (flags.fields) params.fields = flags.fields;
  if (flags.visible !== undefined) params.visible = flags.visible;
  if (flags.textExact) params.textExact = flags.textExact;
  if (flags.textRegex) params.textRegex = flags.textRegex;

  await call(port, token, "GET", `/ui${qs(params)}`, {}, flags, (res) => {
    const n = res.json?.nodes?.length ?? res.json?.count;
    if (n !== undefined) return `ui format=${params.format} nodes=${n}`;
    return undefined;
  });
}

async function cmdShot(port, token, flags) {
  // Feature-detect screenshot support when capabilities present.
  const st = await fetchStatus(port, token, flags.timeout);
  const shot = st.json?.capabilities?.screenshot;
  if (shot && shot.supported === false) {
    die(
      "screenshots not supported on this device (capabilities.screenshot.supported=false; needs API 30+)",
      EXIT_ERR,
    );
  }

  const dest = flags.dest || "file";
  if (!["file", "json", "raw"].includes(dest)) {
    die("usage: phone shot [--dest file|json] [-o path] [--scale 0.4] [--quality 70]");
  }
  const params = {
    dest,
    scale: flags.scale !== undefined ? flags.scale : 0.4,
    quality: flags.quality !== undefined ? flags.quality : 70,
    format: "jpeg",
  };

  let res;
  try {
    res = await request(port, token, "GET", `/screenshot${qs(params)}`, {
      timeoutMs: flags.timeout,
    });
  } catch (err) {
    if (isConnectionRefused(err)) {
      die(
        `connection refused on ${HOST}:${port} — is the Rivet accessibility service on?\n` +
          `  Enable RivetHub Accessibility in Android Settings, then retry.`,
        EXIT_ERR,
      );
    }
    die(`request failed: ${err.message}`, EXIT_ERR);
  }

  // -o copy after dest=file success
  if (flags.output && res.json?.ok && dest === "file" && res.json.path) {
    try {
      const src = res.json.path;
      const dst = path.resolve(flags.output);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      res.json.copied_to = dst;
      process.stderr.write(`shot copied ${src} → ${dst}\n`);
    } catch (e) {
      process.stderr.write(`phone: warning: -o copy failed: ${e.message}\n`);
      // still report the server response; exit based on server ok
    }
  } else if (flags.output && dest !== "file") {
    process.stderr.write(`phone: warning: -o only applies with --dest file (got ${dest})\n`);
  }

  printResult(res, flags, {
    summary:
      res.json?.ok && res.json.path
        ? `shot ${res.json.width}x${res.json.height} → ${res.json.path}`
        : res.json?.ok
          ? `shot ok dest=${dest}`
          : undefined,
  });
  process.exit(exitFromResponse(res));
}

async function cmdTap(port, token, flags, positionals) {
  if (positionals.length < 2) die("usage: phone tap X Y");
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) die("tap: X Y must be numbers");
  await call(
    port,
    token,
    "POST",
    "/action",
    { body: { type: "click", x, y } },
    flags,
    (res) => (res.json?.ok ? `tap ${x},${y} completed=${res.json.completed}` : undefined),
  );
}

async function cmdSwipe(port, token, flags, positionals) {
  if (positionals.length < 4) die("usage: phone swipe X1 Y1 X2 Y2 [--duration 280]");
  const x1 = Number(positionals[0]);
  const y1 = Number(positionals[1]);
  const x2 = Number(positionals[2]);
  const y2 = Number(positionals[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) die("swipe: coordinates must be numbers");
  const duration = flags.duration !== undefined ? flags.duration : 280;
  await call(
    port,
    token,
    "POST",
    "/action",
    { body: { type: "swipe", x1, y1, x2, y2, duration } },
    flags,
    (res) =>
      res.json?.ok
        ? `swipe ${x1},${y1}→${x2},${y2} completed=${res.json.completed}`
        : undefined,
  );
}

async function cmdText(port, token, flags, positionals) {
  if (flags.append) {
    // phone text --append 'more'  → text is first positional
    const text = positionals[0];
    if (text === undefined) die("usage: phone text --append 'more'");
    await call(
      port,
      token,
      "POST",
      "/action",
      { body: { type: "text", mode: "append", text } },
      flags,
      (res) => (res.json?.ok ? `text append (${text.length} chars)` : undefined),
    );
    return;
  }
  const text = positionals[0];
  if (text === undefined) die("usage: phone text 'hello'  |  phone text --append 'more'");
  // replace: include mode:replace for explicitness (server accepts omit as replace)
  await call(
    port,
    token,
    "POST",
    "/action",
    { body: { type: "text", mode: "replace", text } },
    flags,
    (res) => (res.json?.ok ? `text ok (${text.length} chars)` : undefined),
  );
}

async function cmdGlobal(port, token, flags, positionals) {
  const action = (positionals[0] || "").toUpperCase();
  if (!GLOBAL_ACTIONS.has(action)) {
    die(
      `usage: phone global BACK|HOME|RECENTS|NOTIFICATIONS|QUICK_SETTINGS|POWER_DIALOG|LOCK_SCREEN|TAKE_SCREENSHOT|DISMISS_NOTIFICATION_SHADE (got '${positionals[0] || ""}')`,
    );
  }
  await call(
    port,
    token,
    "POST",
    "/action",
    { body: { type: "global", action } },
    flags,
    (res) => (res.json?.ok ? `global ${action}` : undefined),
  );
}

async function cmdClickText(port, token, flags, positionals) {
  const text = positionals[0];
  if (!text) die("usage: phone click-text 'Settings' [--package P]");
  const body = { type: "node_click", text };
  if (flags.package) body.package = flags.package;
  await call(
    port,
    token,
    "POST",
    "/action",
    { body },
    flags,
    (res) => (res.json?.ok ? `click-text '${text}'` : undefined),
  );
}

async function cmdNode(port, token, flags, positionals) {
  const nodeId = positionals[0];
  if (!nodeId) {
    die(
      "usage: phone node NODE_ID [--action click|long_click|focus|set_text|scroll_forward|scroll_backward|select] [--text S]",
    );
  }
  const action = flags.action || "click";
  if (!NODE_ACTIONS.has(action)) {
    die(
      `usage: phone node NODE_ID --action <click|long_click|focus|set_text|scroll_forward|scroll_backward|select> (got '${action}')`,
    );
  }
  if (action === "set_text" && flags.textFilter === undefined) {
    die("usage: phone node NODE_ID --action set_text --text S");
  }

  // Feature-detect rich node actions when action is not plain click.
  if (action !== "click") {
    const st = await fetchStatus(port, token, flags.timeout);
    requireCapability(st.json?.capabilities, "node_actions", "rich node actions");
  }

  const body = { type: "node_action", nodeId, action };
  if (flags.textFilter !== undefined) body.text = flags.textFilter;

  await call(
    port,
    token,
    "POST",
    "/action",
    { body },
    flags,
    (res) => (res.json?.ok ? `node ${nodeId} ${action}` : undefined),
  );
}

async function cmdLongPress(port, token, flags, positionals) {
  // phone long-press --node NX  → node_action long_click
  if (flags.node) {
    const st = await fetchStatus(port, token, flags.timeout);
    requireCapability(st.json?.capabilities, "node_actions", "rich node actions");
    await call(
      port,
      token,
      "POST",
      "/action",
      { body: { type: "node_action", nodeId: flags.node, action: "long_click" } },
      flags,
      (res) => (res.json?.ok ? `long-press node ${flags.node}` : undefined),
    );
    return;
  }
  if (positionals.length < 2) die("usage: phone long-press X Y [--duration 600]  |  phone long-press --node NODE_ID");
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) die("long-press: X Y must be numbers");
  const durationMs = flags.duration !== undefined ? flags.duration : 600;
  await call(
    port,
    token,
    "POST",
    "/action",
    { body: { type: "long_press", x, y, durationMs } },
    flags,
    (res) =>
      res.json?.ok ? `long-press ${x},${y} completed=${res.json.completed}` : undefined,
  );
}

async function cmdDoubleTap(port, token, flags, positionals) {
  if (positionals.length < 2) die("usage: phone double-tap X Y");
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) die("double-tap: X Y must be numbers");
  await call(
    port,
    token,
    "POST",
    "/action",
    { body: { type: "double_tap", x, y } },
    flags,
    (res) =>
      res.json?.ok ? `double-tap ${x},${y} completed=${res.json.completed}` : undefined,
  );
}

async function cmdDrag(port, token, flags, positionals) {
  if (positionals.length < 4) die("usage: phone drag X1 Y1 X2 Y2 [--duration 300]");
  const x1 = Number(positionals[0]);
  const y1 = Number(positionals[1]);
  const x2 = Number(positionals[2]);
  const y2 = Number(positionals[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) die("drag: coordinates must be numbers");
  const durationMs = flags.duration !== undefined ? flags.duration : 300;
  await call(
    port,
    token,
    "POST",
    "/action",
    { body: { type: "drag", x1, y1, x2, y2, durationMs } },
    flags,
    (res) =>
      res.json?.ok
        ? `drag ${x1},${y1}→${x2},${y2} completed=${res.json.completed}`
        : undefined,
  );
}

async function cmdScroll(port, token, flags, positionals) {
  const direction = (positionals[0] || "").toLowerCase();
  if (!SCROLL_DIRS.has(direction)) {
    die("usage: phone scroll <up|down|left|right> [--node NODE_ID]");
  }
  const body = { type: "scroll", direction };
  if (flags.node) body.nodeId = flags.node;
  await call(
    port,
    token,
    "POST",
    "/action",
    { body },
    flags,
    (res) =>
      res.json?.ok
        ? `scroll ${direction}${flags.node ? ` node=${flags.node}` : ""} completed=${res.json.completed}`
        : undefined,
  );
}

async function cmdWait(port, token, flags) {
  const st = await fetchStatus(port, token, flags.timeout);
  requireCapability(st.json?.capabilities, "wait", "phone wait");

  const body = {};
  if (flags.textFilter !== undefined) body.text = flags.textFilter;
  if (flags.package !== undefined) body.package = flags.package;
  if (flags.gone !== undefined) body.gone = flags.gone;
  if (flags._timeoutExplicit) body.timeoutMs = flags.timeout;
  if (flags._intervalExplicit) body.intervalMs = flags.interval;

  if (!body.text && !body.package && !body.gone) {
    die("usage: phone wait [--text S] [--package P] [--gone S] [--timeout MS] [--interval MS]\n  at least one of --text / --package / --gone is required");
  }

  // HTTP timeout must cover wait timeoutMs (default server wait can be long).
  const httpTimeout = body.timeoutMs
    ? Math.max(flags.timeout, body.timeoutMs + 2000)
    : flags.timeout;

  await call(
    port,
    token,
    "POST",
    "/wait",
    { body, timeoutMs: httpTimeout },
    flags,
    (res) => {
      if (res.json?.ok) {
        return `wait matched=${res.json.matched} waitedMs=${res.json.waitedMs}`;
      }
      if (res.json?.error === "timed_out") return `wait timed_out`;
      return undefined;
    },
  );
}

async function cmdClipboard(port, token, flags, positionals) {
  const st = await fetchStatus(port, token, flags.timeout);
  requireCapability(st.json?.capabilities, "clipboard", "phone clipboard");

  const op = (positionals[0] || "").toLowerCase();
  if (op !== "get" && op !== "set") {
    die("usage: phone clipboard get  |  phone clipboard set 'text'");
  }
  if (op === "get") {
    await call(
      port,
      token,
      "POST",
      "/action",
      { body: { type: "clipboard", op: "get" } },
      flags,
      (res) => {
        // Prefer surfacing .text for agents (also in JSON body).
        if (res.json?.ok && res.json.text !== undefined) {
          return `clipboard get text=${JSON.stringify(res.json.text)}`;
        }
        return res.json?.ok ? "clipboard get" : undefined;
      },
    );
    return;
  }
  // set
  const text = positionals[1];
  if (text === undefined) die("usage: phone clipboard set 'text'");
  await call(
    port,
    token,
    "POST",
    "/action",
    { body: { type: "clipboard", op: "set", text } },
    flags,
    (res) => (res.json?.ok ? `clipboard set (${text.length} chars)` : undefined),
  );
}

async function cmdLaunch(port, token, flags, positionals) {
  const pkg = positionals[0];
  if (!pkg) die("usage: phone launch PACKAGE");
  await call(
    port,
    token,
    "POST",
    "/action",
    { body: { type: "launch", package: pkg } },
    flags,
    (res) => (res.json?.ok ? `launch ${pkg}` : undefined),
  );
}

async function cmdIntent(port, token, flags) {
  if (!flags.action || !flags.data) {
    die("usage: phone intent --action VIEW --data URL [--package P]");
  }
  const body = {
    type: "intent",
    action: expandIntentAction(flags.action),
    data: flags.data,
  };
  if (flags.package) body.package = flags.package;
  // SafetyPolicy gates SMS/share/pay/install intents behind confirm:true; without --confirm
  // the server replies needs_confirm and the CLI surfaces that message.
  if (flags.confirm) body.confirm = true;
  await call(
    port,
    token,
    "POST",
    "/action",
    { body },
    flags,
    (res) => (res.json?.ok ? `intent ${body.action}` : undefined),
  );
}

async function cmdNotify(port, token, flags) {
  if (!flags.title) die("usage: phone notify --title T [--body B] [--url U]");
  const body = { title: flags.title };
  if (flags.body !== undefined) body.body = flags.body;
  if (flags.url !== undefined) body.url = flags.url;
  await call(
    port,
    token,
    "POST",
    "/notify",
    { body },
    flags,
    (res) => (res.json?.ok ? `notify '${flags.title}'` : undefined),
  );
}

function cmdHelp() {
  usage(EXIT_OK);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  if (flags.help || positionals[0] === "help") {
    cmdHelp();
    return;
  }

  const cmd = positionals[0];
  if (!cmd) usage();

  if (DEFERRED.has(cmd)) {
    die(deferredMessage(cmd), EXIT_USAGE);
  }

  const rest = positionals.slice(1);
  const { port, token } = loadControl();

  switch (cmd) {
    case "status":
      return cmdStatus(port, token, flags);
    case "mode":
      return cmdMode(port, token, flags, rest);
    case "ui":
      return cmdUi(port, token, flags);
    case "shot":
    case "screenshot":
      return cmdShot(port, token, flags);
    case "tap":
    case "click":
      return cmdTap(port, token, flags, rest);
    case "swipe":
      return cmdSwipe(port, token, flags, rest);
    case "text":
      return cmdText(port, token, flags, rest);
    case "global":
      return cmdGlobal(port, token, flags, rest);
    case "click-text":
    case "click_text":
      return cmdClickText(port, token, flags, rest);
    case "node":
      return cmdNode(port, token, flags, rest);
    case "long-press":
    case "long_press":
      return cmdLongPress(port, token, flags, rest);
    case "double-tap":
    case "double_tap":
      return cmdDoubleTap(port, token, flags, rest);
    case "drag":
      return cmdDrag(port, token, flags, rest);
    case "scroll":
      return cmdScroll(port, token, flags, rest);
    case "wait":
      return cmdWait(port, token, flags);
    case "clipboard":
      return cmdClipboard(port, token, flags, rest);
    case "launch":
      return cmdLaunch(port, token, flags, rest);
    case "intent":
      return cmdIntent(port, token, flags);
    case "notify":
      return cmdNotify(port, token, flags);
    case "help":
      return cmdHelp();
    default:
      die(
        `unknown subcommand '${cmd}'. Run 'phone help' for the supported surface.`,
        EXIT_USAGE,
      );
  }
}

main().catch((err) => {
  process.stderr.write(`phone: fatal: ${err?.stack || err}\n`);
  process.exit(EXIT_ERR);
});
