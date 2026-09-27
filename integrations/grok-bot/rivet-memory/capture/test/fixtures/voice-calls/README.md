# Voice-call fixture (real shape, synthetic content)

`call-redacted.json` matches the real Grok Bot voice-call JSON: top-level
`callId` and `startedAtMs` (int); each turn has `speaker` and `atMs` (int).
`toolCalls` is a call-level list; each item has `argumentsJson` (string)
and `result: { atMs, json }`. Nudges are dropped. Text is synthetic.
Positions are turn indices, ingested as `-v3-voice-<stem>`.
