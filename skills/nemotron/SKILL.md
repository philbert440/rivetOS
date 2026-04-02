# Nemotron Companion Tools

Local NVIDIA AI models running on GERTY (pve3, 10.4.20.12:9400). Zero API cost, zero latency to cloud.

## Available Tools

### Transcribe Audio (ASR)
Speech-to-text using Nemotron ASR Streaming 0.6B. 12x realtime speed on V100.

```bash
curl -s -F "file=@/path/to/audio.ogg" http://10.4.20.12:9400/transcribe
```

Response: `{"text": "transcribed text", "duration_seconds": 0.98, "audio_file": "voice.ogg"}`

Accepts: wav, ogg, opus, mp3, m4a, flac. Auto-converts to 16kHz mono WAV.

### Rerank Documents
Score and rank documents by relevance to a query. Uses Llama-Nemotron-Rerank-1B-v2.

```bash
curl -s -X POST http://10.4.20.12:9400/rerank \
  -H "Content-Type: application/json" \
  -d '{"query": "search query", "documents": ["doc1", "doc2", "doc3"], "top_k": 5}'
```

Response: `{"results": [{"index": 0, "score": 2.93, "text": "doc1"}, ...], "duration_seconds": 0.05}`

### Health Check
```bash
curl -s http://10.4.20.12:9400/health
```

## When to Use

- **Transcribe**: When you receive audio messages, voice notes, or need to process audio files. Better than cloud transcription for Phil's voice — runs locally, zero cost.
- **Rerank**: When you have search results, RAG retrieval candidates, or need to sort documents by relevance to a query. Use after initial retrieval (e.g., vector search, web_search) to improve ranking.

## Notes
- Runs on GPU 1 of GERTY's V100s — GPU 0 reserved for Ollama/inference.
- Models are always loaded (systemd service auto-starts on boot).
- If health check fails, the service may need restart: `ssh pve3 'systemctl restart nemotron-service'`
