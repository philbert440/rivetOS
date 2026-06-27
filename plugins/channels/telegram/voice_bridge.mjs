// voice_bridge.mjs — async voice I/O for talking to Rivet Local over Telegram voice notes.
// Reference module for the CT114 instance to import/port into the telegram channel.
// Node 18+ (global fetch). Needs `ffmpeg` on PATH. No cloud — hits the Gerty stack only.
//
//   transcribe(oggOrWavPath) -> string          (Qwen3-ASR on :9000, /v1/chat/completions)
//   synthesize(text, {speaker,lang}) -> Buffer   (Qwen3-TTS on :9001, /v1/audio/speech) => OGG/Opus
//
// CLI:  node voice_bridge.mjs selftest          (TTS->STT roundtrip, proves the loop)
//       node voice_bridge.mjs transcribe a.ogg
//       node voice_bridge.mjs synthesize "ni hao" out.ogg
import { execFile } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);

const GERTY    = process.env.GERTY_HOST   || 'localhost';
const STT_URL  = process.env.STT_URL      || `http://${GERTY}:9000/v1/chat/completions`;
const TTS_URL  = process.env.TTS_URL      || `http://${GERTY}:9001/v1/audio/speech`;
const LANG     = process.env.TTS_LANG     || 'English';
// Rivet Local's chosen voice (it self-described; Phil confirmed "canonical" by ear 2026-06-23).
// voicedesign mode → pass `instruct`. Override per-call (e.g. female-Sichuan) via opts/env.
const INSTRUCT = process.env.TTS_INSTRUCT ||
  "A warm, natural male voice. Conversational — not overly formal, but not too casual either. " +
  "A bit of gravitas without being dramatic or announcer-y. Steady and calm, genuinely easy to " +
  "listen to — never sounds like he's performing. A bit of texture to it, not too smooth or " +
  "polished; the kind of voice you'd want to have a long conversation with.";
const tmp = (ext) => join(tmpdir(), `vb-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`);

// ---- STT: any audio file -> text. llama.cpp's miniaudio doesn't do opus, so transcode to wav first.
export async function transcribe(audioPath) {
  const wav = tmp('wav');
  try {
    await exec('ffmpeg', ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wav]);
    const b64 = (await readFile(wav)).toString('base64');
    const body = { model: 'qwen3-asr', temperature: 0, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Transcribe this audio verbatim. Output only the transcript.' },
      { type: 'input_audio', input_audio: { data: b64, format: 'wav' } } ] }] };
    const r = await fetch(STT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`STT ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || '').trim();
  } finally { await rm(wav, { force: true }); }
}

// ---- TTS: text -> OGG/Opus Buffer (Telegram voice-note format).
// Default = Rivet's canonical voice (voicedesign instruct). Pass {speaker} to use a customvoice
// preset instead (e.g. {speaker:'serena', lang:'sichuan_dialect'} for the female-Sichuan voice).
export async function synthesize(text, { instruct = INSTRUCT, speaker, lang = LANG } = {}) {
  // Native tts-server (qwentts.cpp /v1/audio/speech) — basic mode needs only `input` + `response_format`.
  // The `instructions`/voicedesign fields break on models without custom voice speakers configured.
  // Send speaker+voice when a custom speaker is requested; otherwise use bare input.
  const payload = speaker
    ? { input: text, voice: speaker, speaker, lang, response_format: 'wav' }
    : { input: text, response_format: 'wav' };
  const r = await fetch(TTS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const wav = tmp('wav'), ogg = tmp('ogg');
  try {
    await writeFile(wav, Buffer.from(await r.arrayBuffer()));
    await exec('ffmpeg', ['-y', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', ogg]);  // Telegram sendVoice wants OGG/Opus
    return await readFile(ogg);
  } finally { await rm(wav, { force: true }); await rm(ogg, { force: true }); }
}

// ---- self-test: synth a phrase, transcribe it back, compare. Run on CT114 once the stack is up.
async function selftest() {
  const phrase = 'the quick brown fox jumps over the lazy dog';
  const ogg = await synthesize(phrase, { lang: 'English' });
  const p = tmp('ogg'); await writeFile(p, ogg);
  try {
    const got = await transcribe(p);
    console.log('TTS bytes:', ogg.length, '| transcript:', JSON.stringify(got));
    console.log(/fox/i.test(got) ? 'ROUNDTRIP OK ✓' : 'ROUNDTRIP MISMATCH ✗');
  } finally { await rm(p, { force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'selftest') await selftest();
  else if (cmd === 'transcribe') console.log(await transcribe(a));
  else if (cmd === 'synthesize') { await writeFile(b || 'out.ogg', await synthesize(a)); console.log('wrote', b || 'out.ogg'); }
  else console.error('usage: selftest | transcribe <file> | synthesize <text> [out.ogg]');
}
