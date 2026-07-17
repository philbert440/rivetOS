#!/usr/bin/env node
/**
 * Pure-Node loopback mock of the Fidelity ControlServer API for phone CLI tests.
 *
 * Env:
 *   MOCK_PORT          listen port (default 0 = ephemeral; writes port to MOCK_PORT_FILE)
 *   MOCK_PORT_FILE     path to write the bound port (default cwd .mock-port)
 *   MOCK_TOKEN         expected X-Rivet-Token (default "test-token")
 *   MOCK_SCREENSHOT_DIR dir for dest=file last.jpg (default os.tmpdir()/rivet-mock-screenshots)
 *   MOCK_FORCE_ERROR   force error on next matching request: unauthorized|forbidden_mode|
 *                      not_found|rate_limited|busy|stale_node|none
 *   MOCK_MODE          initial mode: full|eyes|parked (default full)
 *   MOCK_SCREENSHOT_SUPPORTED  "true"|"false" (default true)
 *   MOCK_MODES_ENABLED "true"|"false" — if false, omit modes from capabilities (default true)
 *
 * Query override: ?force_error=busy etc. on any path.
 *
 * Writes PID to MOCK_PID_FILE if set. SIGTERM/SIGINT clean exit.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TOKEN = process.env.MOCK_TOKEN || "test-token";
const PORT = Number(process.env.MOCK_PORT || 0);
const PORT_FILE = process.env.MOCK_PORT_FILE || path.join(process.cwd(), ".mock-port");
const PID_FILE = process.env.MOCK_PID_FILE || "";
const SHOT_DIR =
  process.env.MOCK_SCREENSHOT_DIR ||
  path.join(os.tmpdir(), "rivet-mock-screenshots");
const SHOT_SUPPORTED = process.env.MOCK_SCREENSHOT_SUPPORTED !== "false";
const MODES_ENABLED = process.env.MOCK_MODES_ENABLED !== "false";

let mode = process.env.MOCK_MODE || "full";
let forceError = process.env.MOCK_FORCE_ERROR || "";

// Minimal valid-ish JPEG (1x1 pixel) — enough for copyFile tests
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy" +
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA" +
    "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEB" +
    "AQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//E" +
    "ABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAI" +
    "AQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAA" +
    "AAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64",
);

function json(code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj, null, 2);
  return {
    code,
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(body, "utf8"),
    headers: extraHeaders,
  };
}

function err(code, error, message, extra = {}) {
  return json(code, { ok: false, error, message, code, ...extra });
}

function parseUrl(url) {
  const q = url.indexOf("?");
  if (q < 0) return { path: url, query: {} };
  const pathPart = url.slice(0, q);
  const query = {};
  for (const part of url.slice(q + 1).split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const v = decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1));
    query[k] = v;
  }
  return { path: pathPart, query };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function checkAuth(req) {
  const t = req.headers["x-rivet-token"];
  return t === TOKEN;
}

function actionEnvelope(type, overrides = {}) {
  return {
    ok: true,
    accepted: true,
    completed: true,
    cancelled: false,
    timedOut: false,
    type,
    durationMs: 12,
    executed_at: Date.now(),
    ...overrides,
  };
}

function modeBlocks(pathName, method) {
  if (pathName === "/status" || pathName === "/notify" || pathName === "/mode") return false;
  if (mode === "parked") {
    if (pathName === "/ui" || pathName === "/screenshot" || pathName === "/action") return true;
  }
  if (mode === "eyes") {
    if (pathName === "/action") return true;
  }
  return false;
}

const FLAT_NODES = [
  {
    id: "n0",
    depth: 0,
    class: "android.widget.FrameLayout",
    text: "",
    contentDescription: "",
    package: "com.android.settings",
    clickable: false,
    bounds: { l: 0, t: 0, r: 1080, b: 2400 },
    path: "0",
  },
  {
    id: "n1",
    depth: 1,
    class: "android.widget.TextView",
    text: "Settings",
    contentDescription: "Settings",
    package: "com.android.settings",
    clickable: true,
    bounds: { l: 40, t: 200, r: 1040, b: 320 },
    path: "0/0",
  },
  {
    id: "n2",
    depth: 1,
    class: "android.widget.EditText",
    text: "",
    contentDescription: "Search",
    package: "com.android.settings",
    clickable: true,
    editable: true,
    bounds: { l: 40, t: 400, r: 1040, b: 500 },
    path: "0/1",
  },
];

function compactNodes() {
  return FLAT_NODES.filter((n) => n.clickable || n.editable || (n.text && n.text.length > 0));
}

async function handle(req, res) {
  const { path: urlPath, query } = parseUrl(req.url || "/");
  const method = (req.method || "GET").toUpperCase();

  // Global force-error via env or query
  const forced = query.force_error || forceError;
  if (forced && forced !== "none") {
    // allow one-shot via query without clearing env
  }

  try {
    // Test admin (always available when token matches; not subject to force_error)
    if (method === "POST" && urlPath === "/_mock/force") {
      if (!checkAuth(req)) {
        return write(res, err(401, "unauthorized", "missing or invalid X-Rivet-Token"));
      }
      const body = await readBody(req);
      const next = body.error || "";
      forceError = next === "none" ? "" : next;
      return write(res, json(200, { ok: true, forceError: forceError || "none" }));
    }

    // Auth: /status is open
    if (urlPath !== "/status") {
      if (!checkAuth(req) || forced === "unauthorized") {
        const r = err(401, "unauthorized", "missing or invalid X-Rivet-Token");
        return write(res, r);
      }
    }

    if (forced === "not_found") {
      return write(res, err(404, "not_found", "unknown path"));
    }
    if (forced === "rate_limited") {
      return write(
        res,
        err(429, "rate_limited", "screenshot rate limit exceeded", { retry_after_ms: 500 }),
      );
    }
    if (forced === "busy") {
      return write(res, err(429, "busy", "gesture_busy"));
    }
    if (forced === "stale_node") {
      return write(res, err(400, "stale_node", "nodeId expired or failed re-resolve"));
    }
    if (forced === "forbidden_mode" || modeBlocks(urlPath, method)) {
      return write(
        res,
        err(403, "forbidden_mode", `mode=${mode} blocks ${method} ${urlPath}`),
      );
    }

    if (method === "GET" && urlPath === "/status") {
      const caps = {
        schema: 1,
        screenshot: {
          supported: SHOT_SUPPORTED,
          minApi: 30,
          dest: ["file", "json", "raw"],
        },
        gesture_wait: true,
        ui: { formats: ["flat", "tree", "compact"], node_id: true, filters: true },
        wait: false,
        clipboard: false,
        notifications_read: false,
        exec: false,
      };
      if (MODES_ENABLED) caps.modes = ["full", "eyes", "parked"];
      return write(
        res,
        json(200, {
          ok: true,
          package: "dev.rivet.app.debug",
          accessibility_connected: true,
          current_package: "com.android.settings",
          port: Number(process.env.MOCK_BOUND_PORT || 0) || undefined,
          version: "0.2.0",
          mode,
          capabilities: caps,
          display: { width: 1080, height: 2400, densityDpi: 420 },
          timestamp: Date.now(),
        }),
      );
    }

    if (method === "POST" && urlPath === "/mode") {
      const body = await readBody(req);
      const m = body.mode;
      if (!["full", "eyes", "parked"].includes(m)) {
        return write(res, err(400, "bad_request", "mode must be full|eyes|parked"));
      }
      mode = m;
      return write(res, json(200, { ok: true, mode }));
    }

    if (method === "GET" && urlPath === "/ui") {
      const format = query.format || "flat";
      let nodes = format === "compact" ? compactNodes() : FLAT_NODES.slice();
      if (query.clickable === "1") nodes = nodes.filter((n) => n.clickable);
      if (query.editable === "1") nodes = nodes.filter((n) => n.editable);
      if (query.text) {
        const t = query.text.toLowerCase();
        nodes = nodes.filter(
          (n) =>
            (n.text || "").toLowerCase().includes(t) ||
            (n.contentDescription || "").toLowerCase().includes(t),
        );
      }
      if (query.package) nodes = nodes.filter((n) => n.package === query.package);
      if (query.limit) nodes = nodes.slice(0, Number(query.limit) || 0);
      return write(
        res,
        json(200, {
          ok: true,
          format,
          count: nodes.length,
          nodes,
        }),
      );
    }

    if (method === "GET" && urlPath === "/screenshot") {
      if (!SHOT_SUPPORTED) {
        return write(res, err(501, "unsupported", "screenshot requires API 30+"));
      }
      const dest = query.dest || "file";
      const scale = Number(query.scale || 0.4);
      const quality = Number(query.quality || 70);
      const width = Math.round(1080 * scale);
      const height = Math.round(2400 * scale);
      if (dest === "file") {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        const guestPath = path.join(SHOT_DIR, "last.jpg");
        fs.writeFileSync(guestPath, TINY_JPEG);
        return write(
          res,
          json(200, {
            ok: true,
            width,
            height,
            scale,
            format: "jpeg",
            bytes: TINY_JPEG.length,
            sha256: "mock",
            path: guestPath,
            captured_at: Date.now(),
            display_id: 0,
          }),
        );
      }
      if (dest === "json") {
        return write(
          res,
          json(200, {
            ok: true,
            width,
            height,
            scale,
            format: "jpeg",
            bytes: TINY_JPEG.length,
            base64: TINY_JPEG.toString("base64"),
            captured_at: Date.now(),
            display_id: 0,
          }),
        );
      }
      return write(res, err(400, "bad_request", `dest=${dest} not supported in mock`));
    }

    if (method === "POST" && urlPath === "/action") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return write(res, err(400, "bad_request", "invalid JSON body"));
      }
      const type = body.type;
      switch (type) {
        case "click":
          if (body.x === undefined || body.y === undefined) {
            return write(res, err(400, "bad_request", "click requires x,y"));
          }
          return write(res, json(200, actionEnvelope("click", { x: body.x, y: body.y })));
        case "swipe":
          return write(
            res,
            json(
              200,
              actionEnvelope("swipe", {
                x1: body.x1,
                y1: body.y1,
                x2: body.x2,
                y2: body.y2,
                duration: body.duration ?? 280,
              }),
            ),
          );
        case "text":
          return write(res, json(200, actionEnvelope("text", { text: body.text })));
        case "global":
          return write(res, json(200, actionEnvelope("global", { action: body.action })));
        case "node_click":
          return write(res, json(200, actionEnvelope("node_click", { text: body.text })));
        case "node_action":
          if (body.action && body.action !== "click") {
            return write(
              res,
              err(400, "bad_request", `node_action action=${body.action} not in MVP mock`),
            );
          }
          if (!body.nodeId) {
            return write(res, err(400, "bad_request", "node_action requires nodeId"));
          }
          // Simulate stale for nodeId "n_stale"
          if (body.nodeId === "n_stale") {
            return write(res, err(400, "stale_node", "nodeId expired or failed re-resolve"));
          }
          return write(
            res,
            json(
              200,
              actionEnvelope("node_action", {
                nodeId: body.nodeId,
                action: "click",
              }),
            ),
          );
        case "launch":
          return write(res, json(200, actionEnvelope("launch", { package: body.package })));
        case "intent":
          return write(
            res,
            json(
              200,
              actionEnvelope("intent", {
                action: body.action,
                data: body.data,
                package: body.package,
              }),
            ),
          );
        default:
          return write(res, err(400, "bad_request", `unknown action type: ${type}`));
      }
    }

    if (method === "POST" && urlPath === "/notify") {
      const body = await readBody(req);
      if (!body.title) {
        return write(res, err(400, "bad_request", "title required"));
      }
      return write(res, json(200, { ok: true, notified: true, title: body.title }));
    }

    return write(res, err(404, "not_found", `unknown path ${urlPath}`));
  } catch (e) {
    return write(res, err(500, "internal_error", String(e.message || e)));
  }
}

function write(res, r) {
  res.writeHead(r.code, {
    "Content-Type": r.contentType,
    "Content-Length": r.body.length,
    ...r.headers,
  });
  res.end(r.body);
}

const server = http.createServer((req, res) => {
  handle(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : PORT;
  process.env.MOCK_BOUND_PORT = String(bound);
  fs.writeFileSync(PORT_FILE, String(bound));
  if (PID_FILE) fs.writeFileSync(PID_FILE, String(process.pid));
  process.stderr.write(`mock-server listening 127.0.0.1:${bound} token=${TOKEN}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
