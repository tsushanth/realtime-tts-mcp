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

// --- Orpheus streaming voice cloning: simple REST calls through the public
// gateway (api.readaloudai.org/v1/orpheus-voices, /v1/orpheus-tts), unlike
// synthesize_speech's persistent-WebSocket fast path above -- no perf case
// for bypassing the gateway here, these are one-shot request/response calls.
function apiKeyOrThrow(): string {
  if (!API_KEY) {
    throw new Error(
      'REALTIME_TTS_API_KEY is not set. Get a free API key at https://readaloudai.org/developers'
    )
  }
  return API_KEY
}

async function orpheusFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKeyOrThrow()}`, ...(init.headers ?? {}) },
  })
  return res
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
  {
    name: 'create_cloned_voice',
    description:
      'Start creating a low-latency streaming cloned voice (Orpheus). Records your consent to clone the named speaker\'s voice, and returns a voice id -- upload a dataset with upload_voice_dataset next. Requires a billing-enabled API key.',
    inputSchema: {
      type: 'object',
      properties: {
        speaker_name: { type: 'string', description: 'Name of the person whose voice is being cloned' },
        attested_by: { type: 'string', description: 'Name of the person giving consent (often the same as speaker_name)' },
        consent_statement: { type: 'string', description: 'A statement attesting you are authorized to clone this voice and use it to synthesize new speech' },
      },
      required: ['speaker_name', 'attested_by', 'consent_statement'],
    },
  },
  {
    name: 'upload_voice_dataset',
    description:
      'Upload recordings (8-20 minutes recommended, single speaker, WAV/FLAC/MP3 zipped together) for a voice created with create_cloned_voice.',
    inputSchema: {
      type: 'object',
      properties: {
        voice_id: { type: 'string', description: 'Voice id returned by create_cloned_voice' },
        dataset_zip_base64: { type: 'string', description: 'Base64-encoded zip file of the recordings' },
      },
      required: ['voice_id', 'dataset_zip_base64'],
    },
  },
  {
    name: 'commit_voice_training',
    description:
      'Start training a voice after its dataset has been uploaded. Training takes roughly 10-90 minutes; poll get_voice_status for progress.',
    inputSchema: {
      type: 'object',
      properties: {
        voice_id: { type: 'string', description: 'Voice id to start training' },
      },
      required: ['voice_id'],
    },
  },
  {
    name: 'get_voice_status',
    description:
      'Check a cloned voice\'s status: awaiting_dataset, training, warming (checkpoint ready, warming up before serving), ready, or failed.',
    inputSchema: {
      type: 'object',
      properties: {
        voice_id: { type: 'string', description: 'Voice id to check' },
      },
      required: ['voice_id'],
    },
  },
  {
    name: 'synthesize_cloned_voice',
    description:
      'Synthesize speech in a cloned voice once its status is "ready". Returns a playable WAV file. This is a newer, lower-latency streaming model than the standard voice-cloning path, still being tuned -- see https://readaloudai.org/developers for current measured numbers and known limitations.',
    inputSchema: {
      type: 'object',
      properties: {
        voice_id: { type: 'string', description: 'A "ready" voice id from get_voice_status' },
        text: { type: 'string', description: 'Text to synthesize in the cloned voice' },
      },
      required: ['voice_id', 'text'],
    },
  },
  {
    name: 'delete_cloned_voice',
    description: 'Permanently delete a cloned voice and its consent record.',
    inputSchema: {
      type: 'object',
      properties: {
        voice_id: { type: 'string', description: 'Voice id to delete' },
      },
      required: ['voice_id'],
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  const a = args as any

  try {
    switch (name) {
      case 'synthesize_speech': {
        const text = String(a.text ?? '')
        if (!text.trim()) return { content: [{ type: 'text', text: 'Error: text is required' }], isError: true }
        const voice = a.voice ?? 'af_heart'
        const speed = Number.isFinite(a.speed) ? a.speed : 1.0
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
      }

      case 'create_cloned_voice': {
        const speaker_name = String(a.speaker_name ?? '')
        const attested_by = String(a.attested_by ?? '')
        const consent_statement = String(a.consent_statement ?? '')
        if (!speaker_name || !attested_by || !consent_statement) {
          return { content: [{ type: 'text', text: 'Error: speaker_name, attested_by, and consent_statement are all required' }], isError: true }
        }
        const res = await orpheusFetch('/v1/orpheus-voices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            speaker_name,
            attested_by,
            consent: true,
            consent_text_version: '2026-09-v1',
            consent_statement,
          }),
        })
        const body: any = await res.json().catch(() => ({}))
        if (!res.ok) return { content: [{ type: 'text', text: `Error (${res.status}): ${JSON.stringify(body)}` }], isError: true }
        return { content: [{ type: 'text', text: `Created voice ${body.id} (status: ${body.status}). Upload a dataset next with upload_voice_dataset.` }] }
      }

      case 'upload_voice_dataset': {
        const voiceId = String(a.voice_id ?? '')
        const zipBase64 = String(a.dataset_zip_base64 ?? '')
        if (!voiceId || !zipBase64) {
          return { content: [{ type: 'text', text: 'Error: voice_id and dataset_zip_base64 are required' }], isError: true }
        }
        const zipBuf = Buffer.from(zipBase64, 'base64')
        const res = await orpheusFetch(`/v1/orpheus-voices/${encodeURIComponent(voiceId)}/dataset`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/zip' },
          body: zipBuf,
        })
        const body: any = await res.json().catch(() => ({}))
        if (!res.ok) return { content: [{ type: 'text', text: `Error (${res.status}): ${JSON.stringify(body)}` }], isError: true }
        return { content: [{ type: 'text', text: `Uploaded ${body.uploaded_bytes ?? zipBuf.length} bytes for voice ${voiceId}. Call commit_voice_training next.` }] }
      }

      case 'commit_voice_training': {
        const voiceId = String(a.voice_id ?? '')
        if (!voiceId) return { content: [{ type: 'text', text: 'Error: voice_id is required' }], isError: true }
        const res = await orpheusFetch(`/v1/orpheus-voices/${encodeURIComponent(voiceId)}/dataset/commit`, { method: 'POST' })
        const body: any = await res.json().catch(() => ({}))
        if (!res.ok) return { content: [{ type: 'text', text: `Error (${res.status}): ${JSON.stringify(body)}` }], isError: true }
        return { content: [{ type: 'text', text: `Training started for voice ${voiceId} (status: ${body.status}). This takes roughly 10-90 minutes; poll get_voice_status for progress.` }] }
      }

      case 'get_voice_status': {
        const voiceId = String(a.voice_id ?? '')
        if (!voiceId) return { content: [{ type: 'text', text: 'Error: voice_id is required' }], isError: true }
        const res = await orpheusFetch(`/v1/orpheus-voices/${encodeURIComponent(voiceId)}`)
        const body: any = await res.json().catch(() => ({}))
        if (!res.ok) return { content: [{ type: 'text', text: `Error (${res.status}): ${JSON.stringify(body)}` }], isError: true }
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] }
      }

      case 'synthesize_cloned_voice': {
        const voiceId = String(a.voice_id ?? '')
        const text = String(a.text ?? '')
        if (!voiceId || !text.trim()) {
          return { content: [{ type: 'text', text: 'Error: voice_id and text are required' }], isError: true }
        }
        const res = await orpheusFetch('/v1/orpheus-tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice: `custom-fast:${voiceId}`, text }),
        })
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}))
          return { content: [{ type: 'text', text: `Error (${res.status}): ${JSON.stringify(errBody)}` }], isError: true }
        }
        const pcm = Buffer.from(await res.arrayBuffer())
        const wav = Buffer.concat([buildWavHeader(pcm.length), pcm])
        return { content: [{ type: 'audio', data: wav.toString('base64'), mimeType: 'audio/wav' }] }
      }

      case 'delete_cloned_voice': {
        const voiceId = String(a.voice_id ?? '')
        if (!voiceId) return { content: [{ type: 'text', text: 'Error: voice_id is required' }], isError: true }
        const res = await orpheusFetch(`/v1/orpheus-voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' })
        const body: any = await res.json().catch(() => ({}))
        if (!res.ok) return { content: [{ type: 'text', text: `Error (${res.status}): ${JSON.stringify(body)}` }], isError: true }
        return { content: [{ type: 'text', text: `Deleted voice ${voiceId}.` }] }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err.message ?? String(err)}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('realtime-tts-mcp running on stdio')
