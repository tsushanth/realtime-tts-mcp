#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import WebSocket from 'ws'

// Two-step fast path: POST /tts/authorize (key + free-tier/billing check) gets
// a short-lived signed token, then connect DIRECTLY to the returned worker
// URL with it — no gateway relay hop for the actual audio. See
// tsushanth/realtime-tts's DECISIONS.md: the old relay-everything-through-the-
// gateway path measured ~350-400ms of pure added handshake overhead per
// session versus connecting directly.
const API_BASE = process.env.REALTIME_TTS_API_BASE ?? 'https://api.readaloudai.org'
const API_KEY = process.env.REALTIME_TTS_API_KEY
const SYNTHESIS_TIMEOUT_MS = Number(process.env.REALTIME_TTS_TIMEOUT_MS) || 30_000
const SAMPLE_RATE = 24000
const BITS_PER_SAMPLE = 16
const CHANNELS = 1

function buildWavHeader(dataLength: number): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLength, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataLength, 40)

  return header
}

interface SynthesisResult {
  wav: Buffer
  genMs: number | null
  audioS: number | null
}

async function authorize(): Promise<{ token: string; url: string }> {
  const res = await fetch(`${API_BASE}/tts/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: API_KEY }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Authorization failed (${res.status}): ${body || res.statusText}`)
  }
  return res.json() as Promise<{ token: string; url: string }>
}

function synthesizeOverWs(wsUrl: string, text: string, voice: string, speed: number): Promise<SynthesisResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pcmChunks: Buffer[] = []
    let genMs: number | null = null
    let audioS: number | null = null
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      ws.terminate()
      reject(new Error(`Synthesis timed out after ${SYNTHESIS_TIMEOUT_MS}ms`))
    }, SYNTHESIS_TIMEOUT_MS)

    function finish(err: Error | null) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      if (err) return reject(err)
      const data = Buffer.concat(pcmChunks)
      resolve({ wav: Buffer.concat([buildWavHeader(data.length), data]), genMs, audioS })
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'synthesize', text, voice, speed }))
    })

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        pcmChunks.push(raw as Buffer)
        return
      }
      let msg: any
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      switch (msg.type) {
        case 'chunk_meta':
          genMs = (genMs ?? 0) + (msg.gen_ms ?? 0)
          audioS = (audioS ?? 0) + (msg.audio_s ?? 0)
          break
        case 'done':
          finish(null)
          break
        case 'cancelled':
          finish(new Error('Synthesis was cancelled by the server'))
          break
        case 'error':
          finish(new Error(msg.message ?? 'Unknown synthesis error'))
          break
      }
    })

    ws.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
    ws.on('close', (code) => {
      if (!settled) finish(new Error(`Connection closed unexpectedly (code ${code}) before synthesis completed`))
    })
  })
}

async function synthesize(text: string, voice: string, speed: number): Promise<SynthesisResult> {
  if (!API_KEY) {
    throw new Error(
      'REALTIME_TTS_API_KEY is not set. Get a free API key (10,000 free characters, no card required) at https://readaloudai.org/developers'
    )
  }
  const { token, url } = await authorize()
  return synthesizeOverWs(`${url}?token=${encodeURIComponent(token)}`, text, voice, speed)
}

const server = new Server(
  { name: 'realtime-tts-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } }
)

const TOOLS = [
  {
    name: 'synthesize_speech',
    description:
      'Convert text to spoken audio using ReadAloud\'s realtime streaming TTS API (Kokoro-82M). Returns a playable WAV file. Requires a free API key (10,000 free characters included, no card required — sign up at https://readaloudai.org/developers) set as REALTIME_TTS_API_KEY. Typical warm latency is well under a second.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to synthesize' },
        voice: { type: 'string', description: 'Kokoro voice id (default "af_heart")' },
        speed: { type: 'number', description: 'Playback speed multiplier (default 1.0)' },
      },
      required: ['text'],
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  if (name !== 'synthesize_speech') {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
  const text = String((args as any).text ?? '')
  if (!text.trim()) {
    return { content: [{ type: 'text', text: 'Error: text is required' }], isError: true }
  }
  const voice = (args as any).voice ?? 'af_heart'
  const speed = Number.isFinite((args as any).speed) ? (args as any).speed : 1.0

  try {
    const result = await synthesize(text, voice, speed)
    const content: any[] = [
      { type: 'audio', data: result.wav.toString('base64'), mimeType: 'audio/wav' },
    ]
    if (result.genMs != null && result.audioS != null) {
      content.push({
        type: 'text',
        text: `Generated ${result.audioS.toFixed(1)}s of audio in ${result.genMs.toFixed(0)}ms.`,
      })
    }
    return { content }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err.message ?? String(err)}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('realtime-tts-mcp running on stdio')
