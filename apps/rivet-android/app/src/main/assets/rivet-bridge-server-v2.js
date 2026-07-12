#!/usr/bin/env node
/*
 * Rivet Bridge v2.6 — OpenAI-compatible localhost endpoint backed by the on-device
 * `claude` / `grok` CLIs, SESSION-AWARE. Runs INSIDE RivetHub's rootfs as the
 * non-root `rivet` user (launched via `proot -i 1000:1000`), so the spawned agents
 * inherit uid 1000 and accept their skip-permission flags.
 *
 * Each RivetHub conversation maps 1:1 to a CLI session, so GUI chat and an escalated
 * `claude --resume <id>` / `grok -r <id>` terminal session are the same session.
 *
 *  - SESSIONING IS GATED ON THE `x-rivet-conversation` HEADER. RivetHub sends it only
 *    on real chat turns; its internal title/translate calls don't — so those run as
 *    stateless one-shots and never pollute or spawn conversation sessions.
 *  - claude: conversationId IS the session id (`--session-id <conv>` / `--resume <conv>`).
 *  - grok (0.2.33 has no --session-id): create, capture grok's `sessionId` from JSON,
 *    map conversationId -> grokSessionId, resume with `-r <grokSessionId>`.
 *  - first turn sends the flattened history; later turns send only the latest user
 *    message (the CLI session already holds the context).
 *  - per-conversation lock serializes turns so concurrent requests can't corrupt a session.
 *
 * TOOL-ACTIVITY STREAMING (v2.3 claude via stream-json; v2.6 grok via ACP `grok agent stdio` —
 * live tool_call/tool_call_update + thought chunks + REAL token usage on the prompt
 * response; grok's plain streaming-json output has none of this) + reasoning deltas:
 *  - claude's stream-json emits `assistant` events with completed tool_use blocks and
 *    `user` events with the matching tool_result. We forward them on the SSE as a custom
 *    delta field `rivet_tools: [{id, name, arguments} | {id, output}]`. The app parses
 *    these into DISPLAY-ONLY executed tool parts (it must never see OpenAI `tool_calls`,
 *    which its generation loop would try to execute itself and then re-prompt with).
 *  - every started tool id is flushed with an output by stream close, so the app never
 *    ends a turn with a dangling unexecuted tool (which would also trigger its tool loop).
 *  - AskUserQuestion: headless claude fires the tool_use (with full question+options
 *    structured input) then INSTANTLY auto-cancels it (tool_result is_error "Answer
 *    questions?") — it never blocks. So the question/options reach the app as a normal
 *    tool part; the app turns the option labels into tappable suggestion chips and the
 *    tapped answer arrives as the next plain user turn. We just rewrite the noisy
 *    cancellation result into a friendly note.
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const PORT = parseInt(process.env.RIVET_BRIDGE_PORT || '8765', 10);
const HOST = '127.0.0.1';
const HOME = process.env.HOME || '/home/rivet';
const DIR = HOME + '/rivet-bridge';
const TMP = process.env.TMPDIR || (DIR + '/tmp');
const TOKEN_FILE = DIR + '/token';
const CLAUDE_SESSIONS = DIR + '/claude-sessions.json'; // Set of convIds we've created
const GROK_SESSIONS = DIR + '/grok-sessions.json';     // { convId: grokSessionId }
const LOG = (...a) => console.log(new Date().toISOString(), ...a);

for (const d of [DIR, TMP]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }

let TOKEN = '';
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}
if (!TOKEN) { TOKEN = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 24); try { fs.writeFileSync(TOKEN_FILE, TOKEN); } catch (e) {} }

let claudeKnown = new Set();
try { claudeKnown = new Set(JSON.parse(fs.readFileSync(CLAUDE_SESSIONS, 'utf8'))); } catch (e) {}
const saveClaude = () => { try { fs.writeFileSync(CLAUDE_SESSIONS, JSON.stringify([...claudeKnown])); } catch (e) {} };
let grokMap = {};
try { grokMap = JSON.parse(fs.readFileSync(GROK_SESSIONS, 'utf8')); } catch (e) {}
const saveGrok = () => { try { fs.writeFileSync(GROK_SESSIONS, JSON.stringify(grokMap)); } catch (e) {} };

const MODELS = {
  'rivet-claude': { cmd: 'claude', kind: 'claude' },
  'rivet-grok':   { cmd: 'grok',   kind: 'grok' },
};

// ---- per-conversation lock: serialize turns on the same session ----
const locks = new Map();
function withLock(key, fn) {
  if (!key) return fn(); // one-shot (no session) needs no lock
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => {}, () => {}));
  return run;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && (c.text || c.content)) || '').join('');
  return content == null ? '' : String(content);
}
function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) if (messages[i].role === 'user') return textOf(messages[i].content);
  return '';
}
// "rivet-claude" -> "Rivet-Claude" so a joining agent sees who said each prior turn.
function labelFor(name) {
  if (!name) return 'Assistant';
  return String(name).split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join('-');
}
// Flatten a transcript into one prompt for a session CREATE. Assistant turns are
// attributed by their author (OpenAI `name`), so when you switch models mid-chat the
// new agent reads earlier replies as the OTHER agent's, not its own (no impersonation).
// selfModel labels the trailing continuation cue so it answers in its own voice.
function flatten(messages, selfModel) {
  const sys = [], turns = [];
  for (const m of messages || []) {
    const c = textOf(m.content);
    if (m.role === 'system') sys.push(c);
    else if (m.role === 'assistant') turns.push(labelFor(m.name) + ': ' + c);
    else turns.push('User: ' + c);
  }
  let p = '';
  if (sys.length) p += sys.join('\n') + '\n\n';
  return p + turns.join('\n\n') + '\n\n' + labelFor(selfModel) + ':';
}
function uuidFromString(s) {
  const h = crypto.createHash('sha256').update(s || 'rivet').digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '4' + h.slice(13, 16), ((parseInt(h[16], 16) & 3) | 8).toString(16) + h.slice(17, 20), h.slice(20, 32)].join('-');
}
// conversationId: present ONLY when RivetHub sends the header (-> session). Absent -> null (one-shot).
function conversationId(req) {
  const hdr = (req.headers['x-rivet-conversation'] || '').trim();
  if (!hdr) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hdr) ? hdr.toLowerCase() : uuidFromString(hdr);
}

// Pull {text, sessionId} out of an agent's JSON stdout (claude: result/session_id, grok: text/sessionId).
function parseAgentJson(out, kind) {
  let obj = null;
  try { obj = JSON.parse(out.trim()); } catch (e) {
    const i = out.indexOf('{');
    if (i >= 0) { // brace-match the first complete object
      let depth = 0, end = -1, instr = false, esc = false;
      for (let k = i; k < out.length; k++) {
        const ch = out[k];
        if (instr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') instr = false; }
        else if (ch === '"') instr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
      }
      if (end > 0) { try { obj = JSON.parse(out.slice(i, end)); } catch (e2) {} }
    }
  }
  if (!obj) return { text: out.trim(), sessionId: null };
  if (kind === 'grok') return { text: obj.text != null ? String(obj.text) : '', sessionId: obj.sessionId || null };
  return { text: obj.result != null ? String(obj.result) : '', sessionId: obj.session_id || null };
}

function spawnAgent(cmd, args, prompt) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: HOME, env: Object.assign({}, process.env, { TMPDIR: TMP, HOME }) });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// Flatten a claude tool_result content (string or [{type:text,text}]) to a short string.
function toolResultText(block) {
  let t = '';
  if (typeof block.content === 'string') t = block.content;
  else if (Array.isArray(block.content)) t = block.content.map((c) => (c && c.type === 'text' && c.text) || '').join('\n');
  if (t.length > 4000) t = t.slice(0, 4000) + '\n…[truncated]';
  return (block.is_error ? '[error] ' : '') + t;
}

// The grok model only exists as prose in the session's system entry ("You are Grok 4.3 …").
const grokHist = (s) => HOME + '/.grok/sessions/' + encodeURIComponent(HOME) + '/' + s + '/chat_history.jsonl';
function grokModelFromSession(s) {
  try {
    const fd = fs.openSync(grokHist(s), 'r');
    const b = Buffer.alloc(4096);
    const n = fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd);
    const m2 = b.toString('utf8', 0, n).match(/You are (Grok ?[\d][\d.]*)/);
    return m2 ? m2[1].trim() : null;
  } catch (e) { return null; }
}

// Spawn claude with stream-json and call onDelta(text) as tokens arrive.
// onTool (optional) gets {id,name,arguments} on tool_use and {id,output} on tool_result;
// any tool left without a result by stream end is flushed with a placeholder output.
// onReasoning (optional) gets thinking deltas. Resolves { code, err, full, sid, emitted,
// usage, agentModel }. usage is the result event's token usage: { input_tokens,
// cache_read_input_tokens, cache_creation_input_tokens, output_tokens } —
// input+cache ≈ the session's current context size. (grok turns: see grokAcpTurn.)
function streamOnce(cmd, args, kind, onDelta, onTool, onReasoning, onStatus) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: HOME, env: Object.assign({}, process.env, { TMPDIR: TMP, HOME }) });
    let buf = '', err = '', full = '', sid = null, emitted = false, usage = null, agentModel = null, thinkTok = 0;
    const pendingTools = new Map(); // tool_use id -> name (started, no result yet)
    const flushTools = () => { if (onTool) for (const [id] of pendingTools) onTool({ id, output: '(no result)' }); pendingTools.clear(); };
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let d; try { d = JSON.parse(line); } catch (e) { continue; }
        if (kind === 'claude') {
          if (d.session_id) sid = d.session_id;
          // The backing model (e.g. "claude-fable-5") rides on assistant events.
          // Error/system turns report "<synthetic>" — never let that overwrite the real id.
          if (d.type === 'assistant' && d.message && d.message.model && d.message.model !== '<synthetic>') agentModel = String(d.message.model);
          if (d.type === 'stream_event' && d.event && d.event.type === 'content_block_delta' && d.event.delta && d.event.delta.type === 'text_delta') {
            const t = d.event.delta.text || '';
            if (t) {
              if (thinkTok && onStatus) { onStatus(''); thinkTok = 0; } // thinking done -> clear pulse
              full += t; emitted = true; onDelta(t);
            }
          } else if (d.type === 'stream_event' && onReasoning && d.event && d.event.type === 'content_block_delta' && d.event.delta && d.event.delta.type === 'thinking_delta') {
            const t = d.event.delta.thinking || '';
            if (t) onReasoning(t);
            // fable-class models: thinking text arrives EMPTY (encrypted provider-side),
            // only estimated_tokens — surface deliberation as a status pulse, like the TUI.
            else if (onStatus && d.event.delta.estimated_tokens) {
              thinkTok += d.event.delta.estimated_tokens;
              onStatus('thinking · ~' + (thinkTok >= 1000 ? (thinkTok / 1000).toFixed(1) + 'k' : thinkTok) + ' tok');
            }
          } else if (d.type === 'assistant' && onTool && d.message && Array.isArray(d.message.content)) {
            for (const b of d.message.content) {
              if (b.type === 'tool_use' && b.id && !pendingTools.has(b.id)) {
                pendingTools.set(b.id, b.name || '');
                onTool({ id: b.id, name: b.name || '', arguments: JSON.stringify(b.input || {}) });
              }
            }
          } else if (d.type === 'user' && onTool && d.message && Array.isArray(d.message.content)) {
            for (const b of d.message.content) {
              if (b.type === 'tool_result' && b.tool_use_id && pendingTools.has(b.tool_use_id)) {
                const name = pendingTools.get(b.tool_use_id);
                pendingTools.delete(b.tool_use_id);
                // headless claude auto-cancels AskUserQuestion; the real answer comes as the next user turn
                const out = name === 'AskUserQuestion' ? 'Question shown in chat — tap a chip or type a reply.' : toolResultText(b);
                onTool({ id: b.tool_use_id, output: out });
              }
            }
          } else if (d.type === 'result') {
            if (d.usage) usage = d.usage;
            if (d.result != null && !emitted) { // no deltas seen -> emit whole
              full = String(d.result); if (full) { emitted = true; onDelta(full); }
            }
          }
        }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { flushTools(); resolve({ code: -1, err: String(e), full, sid, emitted, usage, agentModel }); });
    child.on('close', (code) => { flushTools(); resolve({ code, err, full, sid, emitted, usage, agentModel }); });
  });
}

// Run one grok turn over the Agent Client Protocol (`grok agent stdio`). Unlike grok's
// headless streaming-json output (thought/text/end ONLY — verified 0.2.45), ACP streams
// live tool_call/tool_call_update events, thought chunks, and returns real token usage on
// the prompt response (xAI docs' headless page demonstrates the session/update shape).
// gsid != null -> session/load (resume); load failure resolves code 1 so the caller's
// recreate-with-full-history fallback runs. Result shape matches streamOnce.
function grokAcpTurn(promptText, gsid, onDelta, onTool, onReasoning) {
  return new Promise((resolve) => {
    const child = spawn('grok', ['agent', 'stdio'], { cwd: HOME, env: Object.assign({}, process.env, { TMPDIR: TMP, HOME }) });
    let buf = '', err = '', full = '', sid = gsid || null, emitted = false, usage = null;
    let live = false, finished = false; // live: session/load replay is over, updates are this turn's
    const pendingTools = new Map();
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (e) {} };
    const finish = (code, e) => {
      if (finished) return; finished = true;
      if (onTool) for (const [id] of pendingTools) onTool({ id, output: '(no result)' });
      pendingTools.clear();
      const agentModel = sid ? grokModelFromSession(sid) : null;
      try { child.kill(); } catch (e2) {}
      resolve({ code, err: e != null ? String(e) : err, full, sid, emitted, usage, agentModel });
    };
    const prompt = () => { live = true; send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: promptText }] } }); };
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.id === 0 && (m.result || m.error)) { // initialize
          if (m.error) return finish(1, 'ACP init: ' + JSON.stringify(m.error));
          if (sid) send({ jsonrpc: '2.0', id: 3, method: 'session/load', params: { sessionId: sid, cwd: HOME, mcpServers: [] } });
          else send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: HOME, mcpServers: [] } });
        } else if (m.id === 3 && (m.result || m.error)) { // session/load
          if (m.error) return finish(1, 'ACP session/load: ' + JSON.stringify(m.error));
          prompt();
        } else if (m.id === 1 && (m.result || m.error)) { // session/new
          if (m.error || !m.result.sessionId) return finish(1, 'ACP session/new: ' + JSON.stringify(m.error || m.result));
          sid = m.result.sessionId; prompt();
        } else if (m.id === 2 && (m.result || m.error)) { // prompt finished
          const meta = (m.result && m.result._meta) || {};
          if (meta.inputTokens != null) {
            usage = { // shaped like claude's so the SSE usage mapping is shared
              input_tokens: Math.max(0, (meta.inputTokens || 0) - (meta.cachedReadTokens || 0)),
              cache_read_input_tokens: meta.cachedReadTokens || 0,
              cache_creation_input_tokens: 0,
              output_tokens: meta.outputTokens || 0,
            };
          }
          if (m.error) return finish(1, 'ACP prompt: ' + JSON.stringify(m.error));
          return finish(0);
        } else if (m.method === 'session/update' && live) {
          const u = (m.params && m.params.update) || {};
          if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.text) {
            full += u.content.text; emitted = true; onDelta(u.content.text);
          } else if (u.sessionUpdate === 'agent_thought_chunk' && onReasoning && u.content && u.content.text) {
            onReasoning(u.content.text);
          } else if (u.sessionUpdate === 'tool_call' && u.toolCallId && onTool && !pendingTools.has(u.toolCallId)) {
            pendingTools.set(u.toolCallId, u.title || '');
            onTool({ id: u.toolCallId, name: u.title || '', arguments: JSON.stringify(u.rawInput || {}) });
          } else if (u.sessionUpdate === 'tool_call_update' && u.toolCallId && onTool && (u.status === 'completed' || u.status === 'failed') && pendingTools.has(u.toolCallId)) {
            pendingTools.delete(u.toolCallId);
            const out = (u.rawOutput && u.rawOutput.output_for_prompt)
              || (u.content || []).map((c) => (c && c.content && c.content.text) || '').join('')
              || '(done)';
            onTool({ id: u.toolCallId, output: toolResultText({ content: out, is_error: u.status === 'failed' }) });
          }
        } else if (m.method === 'session/request_permission' && m.id != null) {
          // bridge policy = always approve (replaces the old --always-approve flag)
          const opts = (m.params && m.params.options) || [];
          const allow = opts.find((o) => /allow/i.test(String((o && (o.kind || o.optionId || o.name)) || ''))) || opts[0];
          send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: allow && allow.optionId } } });
        }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(-1, String(e)));
    child.on('close', () => finish(1, err || 'ACP process exited before the turn completed'));
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } });
  });
}

const CLAUDE_STREAM = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--dangerously-skip-permissions'];

// Streaming counterpart of runAgent. Emits deltas via onDelta, tool activity via onTool,
// thinking via onReasoning (claude stream-json live; grok over ACP — see grokAcpTurn).
// Resolves the final result obj.
async function streamAgent(model, messages, conv, title, onDelta, onTool, onReasoning, onStatus) {
  const m = MODELS[model];
  if (!m) throw new Error('unknown model ' + model);
  const flat = flatten(messages, model), last = lastUserText(messages);

  if (!conv) { // one-shot
    if (m.kind === 'claude') return streamOnce('claude', [...CLAUDE_STREAM, flat], 'claude', onDelta, onTool, onReasoning, onStatus);
    return grokAcpTurn(flat, null, onDelta, onTool, onReasoning);
  }
  if (m.kind === 'claude') {
    const nameArgs = title ? ['-n', title] : [];
    if (claudeKnown.has(conv)) {
      const r = await streamOnce('claude', [...CLAUDE_STREAM, '--resume', conv, ...nameArgs, last], 'claude', onDelta, onTool, onReasoning, onStatus);
      if (!(r.code !== 0 && !r.emitted && /No conversation|not found|No session/i.test(r.err))) { if (r.code === 0) { claudeKnown.add(conv); saveClaude(); } return r; }
      // resume missed with nothing emitted -> recreate
    }
    const r = await streamOnce('claude', [...CLAUDE_STREAM, '--session-id', conv, ...nameArgs, flat], 'claude', onDelta, onTool, onReasoning, onStatus);
    if (r.code === 0) { claudeKnown.add(conv); saveClaude(); }
    return r;
  }
  // grok
  const gsid = grokMap[conv];
  if (gsid) {
    const r = await grokAcpTurn(last, gsid, onDelta, onTool, onReasoning);
    if (r.code === 0) { if (r.sid) { grokMap[conv] = r.sid; saveGrok(); } return r; }
    if (r.emitted) return r;
    delete grokMap[conv]; // recreate
  }
  const r = await grokAcpTurn(flat, null, onDelta, onTool, onReasoning);
  if (r.code === 0 && r.sid) { grokMap[conv] = r.sid; saveGrok(); }
  return r;
}

// Run one turn. conv==null -> stateless one-shot. Returns assistant text.
async function runAgent(model, messages, conv, title) {
  const m = MODELS[model];
  if (!m) throw new Error('unknown model ' + model);
  const flat = flatten(messages, model);
  const last = lastUserText(messages);

  // ---- one-shot (no session): title-gen, translate, anything without a conv header ----
  if (!conv) {
    if (m.kind === 'claude') {
      const r = await spawnAgent('claude', ['-p', '--output-format', 'json', '--dangerously-skip-permissions', flat], flat);
      if (r.code !== 0) throw new Error('claude ' + r.code + ': ' + r.err.slice(0, 400));
      return parseAgentJson(r.out, 'claude').text;
    }
    const r = await spawnAgent('grok', ['-p', flat, '--output-format', 'json', '--always-approve'], flat);
    if (r.code !== 0) throw new Error('grok ' + r.code + ': ' + r.err.slice(0, 400));
    return parseAgentJson(r.out, 'grok').text;
  }

  // ---- session-mapped ----
  if (m.kind === 'claude') {
    const nameArgs = title ? ['-n', title] : [];
    const create = async () => {
      const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--session-id', conv, ...nameArgs, flat];
      const r = await spawnAgent('claude', args);
      if (r.code !== 0 && /already (in use|exists)/i.test(r.err)) return resume(true);
      if (r.code !== 0) throw new Error('claude create ' + r.code + ': ' + r.err.slice(0, 400));
      claudeKnown.add(conv); saveClaude();
      return parseAgentJson(r.out, 'claude').text;
    };
    const resume = async (fromCreate) => {
      const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--resume', conv, ...nameArgs, last];
      const r = await spawnAgent('claude', args);
      if (r.code !== 0 && !fromCreate && /No conversation|not found|No session/i.test(r.err)) return create();
      if (r.code !== 0) throw new Error('claude resume ' + r.code + ': ' + r.err.slice(0, 400));
      claudeKnown.add(conv); saveClaude();
      return parseAgentJson(r.out, 'claude').text;
    };
    return claudeKnown.has(conv) ? resume(false) : create();
  }

  // grok: capture-and-map (0.2.33 has no --session-id)
  const gsid = grokMap[conv];
  if (gsid) {
    const r = await spawnAgent('grok', ['-p', last, '--output-format', 'json', '--always-approve', '--resume', gsid]);
    if (r.code === 0) { const p = parseAgentJson(r.out, 'grok'); if (p.sessionId) { grokMap[conv] = p.sessionId; saveGrok(); } return p.text; }
    if (!/No.*session|not found/i.test(r.err)) throw new Error('grok resume ' + r.code + ': ' + r.err.slice(0, 400));
    delete grokMap[conv]; // fall through to recreate
  }
  const r = await spawnAgent('grok', ['-p', flat, '--output-format', 'json', '--always-approve']);
  if (r.code !== 0) throw new Error('grok create ' + r.code + ': ' + r.err.slice(0, 400));
  const p = parseAgentJson(r.out, 'grok');
  if (p.sessionId) { grokMap[conv] = p.sessionId; saveGrok(); }
  return p.text;
}

function authed(req) {
  const h = req.headers['authorization'] || '';
  const t = (h.replace(/^Bearer\s+/i, '').trim()) || req.headers['x-rivet-token'] || '';
  return t === TOKEN;
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
  if (url === '/' || url === '/health') return json(res, 200, { ok: true, service: 'rivet-bridge', version: '2.6', models: Object.keys(MODELS) });
  if (url === '/v1/models') { if (!authed(req)) return json(res, 401, { error: { message: 'invalid token' } }); return json(res, 200, { object: 'list', data: Object.keys(MODELS).map((id) => ({ id, object: 'model', created: 0, owned_by: 'rivet' })) }); }

  // Resume info for the escalation button. Body: {model}. Header: x-rivet-conversation.
  if (url === '/v1/session') {
    if (!authed(req)) return json(res, 401, { error: { message: 'invalid token' } });
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let p = {}; try { p = JSON.parse(body || '{}'); } catch (e) {}
      const conv = conversationId(req);
      const kind = (MODELS[p.model] || {}).kind || 'claude';
      if (!conv) return json(res, 200, { conversation_id: null, known: false, resume_cmd: null });
      if (kind === 'grok') { const g = grokMap[conv]; return json(res, 200, { conversation_id: conv, known: !!g, grok_session_id: g || null, resume_cmd: g ? ('grok -r ' + g) : null }); }
      return json(res, 200, { conversation_id: conv, known: claudeKnown.has(conv), resume_cmd: 'claude --resume ' + conv });
    });
    return;
  }

  if (url === '/v1/chat/completions' && req.method === 'POST') {
    if (!authed(req)) return json(res, 401, { error: { message: 'invalid token' } });
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch (e) { return json(res, 400, { error: { message: 'bad json' } }); }
      const model = (payload.model && MODELS[payload.model]) ? payload.model : 'rivet-claude';
      const conv = conversationId(req);
      const title = (req.headers['x-rivet-title'] || '').trim() || null;
      const stream = !!payload.stream;
      const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
      const created = Math.floor(Date.now() / 1000);
      try {
        if (!stream) {
          const text = await withLock(conv, () => runAgent(model, payload.messages, conv, title));
          return json(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, rivet_conversation: conv });
        }
        // ---- real streaming: pipe CLI token deltas straight to OpenAI SSE chunks ----
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        const chunk = (delta, finish, extra) => res.write('data: ' + JSON.stringify(Object.assign({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish || null }], rivet_conversation: conv }, extra)) + '\n\n');
        chunk({ role: 'assistant', content: '' }, null); // opening role delta
        const r = await withLock(conv, () => streamAgent(model, payload.messages, conv, title,
          (t) => chunk({ content: t }, null),
          (ev) => chunk({ rivet_tools: [ev] }, null), // display-only tool activity (see header)
          (t) => chunk({ reasoning_content: t }, null), // thinking/thought deltas
          (s) => chunk({}, null, { rivet_status: s }))); // deliberation pulse (encrypted-thinking models)
        if (r && r.code !== 0 && !r.emitted) chunk({ content: '[agent error: ' + String(r.err || '').slice(0, 200) + ']' }, null);
        // OpenAI-shaped usage on the final chunk; prompt_tokens folds in the cache reads so it
        // reflects the session's full context size (what the app's context meter wants).
        const u = r && r.usage ? (() => {
          const inp = (r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0);
          const out = r.usage.output_tokens || 0;
          return { prompt_tokens: inp, completion_tokens: out, total_tokens: inp + out,
            prompt_tokens_details: { cached_tokens: r.usage.cache_read_input_tokens || 0 } };
        })() : null;
        const extra = Object.assign({}, u ? { usage: u } : null, r && r.agentModel ? { rivet_model: r.agentModel } : null);
        chunk({}, 'stop', extra); res.write('data: [DONE]\n\n'); res.end();
      } catch (e) {
        LOG('ERROR', String((e && e.message) || e));
        if (!res.headersSent) return json(res, 500, { error: { message: String((e && e.message) || e) } });
        res.end();
      }
    });
    return;
  }
  json(res, 404, { error: { message: 'not found: ' + url } });
});

server.listen(PORT, HOST, () => {
  LOG('rivet-bridge v2.6 on http://' + HOST + ':' + PORT, 'models=' + Object.keys(MODELS).join(','), 'claude-sessions=' + claudeKnown.size, 'grok-sessions=' + Object.keys(grokMap).length);
  LOG('token:', TOKEN);
});
