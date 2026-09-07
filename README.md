# realtime-tts-mcp

An MCP server wrapping [ReadAloud](https://readaloudai.org)'s realtime streaming text-to-speech API (Kokoro-82M) as a single `synthesize_speech` tool. Returns a playable WAV file. Typical warm latency is well under a second.

## Tool

- **`synthesize_speech(text, voice?, speed?)`** — converts text to spoken audio. `voice` defaults to `af_heart` (a Kokoro voice id); `speed` defaults to `1.0`.

## Install

```bash
npx realtime-tts-mcp
```

Or from source:

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
      "command": "npx",
      "args": ["-y", "realtime-tts-mcp"],
      "env": {
        "REALTIME_TTS_API_KEY": "rtts_your_key_here"
      }
    }
  }
}
```

## Getting an API key

Self-serve signup at **https://readaloudai.org/developers** — sign in with email, generate a key. **10,000 characters free, no card required.** Beyond that, pay-as-you-go at $0.01 per 1,000 characters (no plan to manage). Without a key, calls fail with a clear error pointing you to the signup page.

## How it works

Each call does two steps: authorize (a fast key + free-tier/billing check against the ReadAloud API) then connects directly to the synthesis worker with a short-lived token — no relay hop in between, which is what keeps warm-call latency well under a second. A cold worker (idle for a couple minutes) can take several seconds longer on the first call after a gap.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REALTIME_TTS_API_KEY` | *(none, required)* | Get one free at https://readaloudai.org/developers |
| `REALTIME_TTS_API_BASE` | `https://api.readaloudai.org` | API base URL |
| `REALTIME_TTS_TIMEOUT_MS` | `30000` | Per-synthesis timeout |

## License

MIT
