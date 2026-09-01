# realtime-tts-mcp

An MCP server wrapping a real-time, streaming text-to-speech gateway (Kokoro-82M, GPU-capable) as a single `synthesize_speech` tool. Returns a playable WAV file.

## Tool

- **`synthesize_speech(text, voice?, speed?)`** — converts text to spoken audio. `voice` defaults to `af_heart` (a Kokoro voice id); `speed` defaults to `1.0`.

## Install

```bash
git clone https://github.com/tsushanth/realtime-tts-mcp.git
cd realtime-tts-mcp
npm install
npm run build
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "realtime-tts": {
      "command": "node",
      "args": ["/absolute/path/to/realtime-tts-mcp/dist/index.js"],
      "env": {
        "REALTIME_TTS_API_KEY": "rtts_your_key_here"
      }
    }
  }
}
```

## Getting an API key

Key issuance is manual right now — there's no self-serve signup yet. Reach out and one will be issued. Without a key, calls will fail with `invalid or missing API key`.

## What actually happens on a call

The gateway auto-provisions a GPU worker on your first request if none is warm, which can take up to a few minutes — the default 60s timeout (`REALTIME_TTS_TIMEOUT_MS` env var) may need to be raised for a genuinely cold start. The worker tears itself down after 15 minutes of inactivity, so infrequent use means occasional slow first-calls rather than a constantly-billed idle server.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REALTIME_TTS_ENDPOINT` | `wss://realtime-tts-gateway.fly.dev/tts` | Gateway WebSocket URL |
| `REALTIME_TTS_API_KEY` | *(none)* | Required for gated access |
| `REALTIME_TTS_TIMEOUT_MS` | `60000` | Per-synthesis timeout, raise for cold starts |

## License

MIT
