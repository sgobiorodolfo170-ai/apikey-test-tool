import http from './http.js'
import {
  buildUrl,
  getErrorMessage,
  extractProviderError,
  createController,
  releaseController,
  runConcurrentBatch,
} from './utils.js'
import { listOpenAIModels } from './openai.js'

const TEST_PROMPT = '这是大模型连通性测试'
const TIMEOUT = 30000
const PROBE_TIMEOUT = 20000

export { cancelAllRequests } from './utils.js'

// 图片/语音模式尽量兼容市面上通用的调用方式，而非仅限 OpenAI：
// 图片：OpenAI /images/generations、Stable Diffusion WebUI、Google Imagen
// 语音：OpenAI /audio/speech、Azure TTS、ElevenLabs、OpenAI /audio/transcriptions(whisper)

const VISION_MODELS = new Set(['gpt-4o', 'gpt-4o-mini'])
const OPENAI_TTS = new Set(['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'])

// 1x1 透明 PNG，用于视觉连通性测试
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

function resolveModelId(model) {
  return (typeof model === 'string' ? model : model.id || model.name || '').trim()
}

function isAbort(error) {
  return error?.name === 'CanceledError' || error?.name === 'AbortError'
}

function describeError(error, baseUrl) {
  return extractProviderError(error) || getErrorMessage(error, baseUrl)
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return TEST_PROMPT
  const last = [...messages].reverse().find((m) => m.role === 'user')
  return last?.content || TEST_PROMPT
}

function visionMessages(text) {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
      ],
    },
  ]
}

// 若 baseUrl 已含 /v1 版本段则直接用，否则同时尝试 {base}{path} 与 {base}/v1{path}
function candidateUrls(baseUrl, path) {
  const base = (baseUrl || '').replace(/\/+$/, '')
  if (/\/v\d+$/i.test(base)) return [base + path]
  return [base + path, base + '/v1' + path]
}

function makeSilentWav(durationMs = 500, sampleRate = 8000) {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000)
  const dataSize = numSamples
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  return new Uint8Array(buffer)
}

// ---------- 各协议调用形状（失败即 throw） ----------

async function openaiShape(config, signal, path, body, responseType, timeout = PROBE_TIMEOUT) {
  const { apiKey, baseUrl } = config
  const urls = candidateUrls(baseUrl, path)
  let lastError
  for (const url of urls) {
    try {
      return await http.post(url, body, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout,
        signal,
        responseType,
      })
    } catch (error) {
      if (isAbort(error)) throw error
      lastError = error
    }
  }
  throw lastError || new Error('请求失败')
}

async function sdWebuiShape(config, signal, prompt, timeout = PROBE_TIMEOUT) {
  const { apiKey, baseUrl } = config
  const url = buildUrl(baseUrl, '/sdapi/v1/txt2img')
  const headers =
    apiKey && apiKey.trim()
      ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' }
  return http.post(
    url,
    { prompt, steps: 20, width: 512, height: 512, cfg_scale: 7 },
    { headers, timeout, signal },
  )
}

async function imagenShape(config, signal, model, prompt, timeout = PROBE_TIMEOUT) {
  const { apiKey, baseUrl } = config
  const modelId = (model || 'imagen-3.0-generate-001').replace(/^models\//, '')
  const url = `${buildUrl(baseUrl, '/v1beta/models')}/${modelId}:predict`
  return http.post(
    url,
    { instances: [{ prompt }], parameters: { sampleCount: 1 } },
    {
      headers: { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json' },
      timeout,
      signal,
    },
  )
}

async function azureTtsShape(config, signal, text, voice, timeout = PROBE_TIMEOUT) {
  const { apiKey, baseUrl } = config
  const voiceName = voice || 'zh-CN-XiaoxiaoNeural'
  const ssml = `<speak version='1.0' xml:lang='zh-CN'><voice xml:lang='zh-CN' xml:gender='Female' name='${voiceName}'>${text}</voice></speak>`
  return http.post(buildUrl(baseUrl, '/cognitiveservices/v1'), ssml, {
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
    },
    timeout,
    signal,
    responseType: 'arraybuffer',
  })
}

async function elevenLabsShape(config, signal, text, timeout = PROBE_TIMEOUT) {
  const { apiKey, baseUrl } = config
  return http.post(
    buildUrl(baseUrl, '/v1/text-to-speech/alloy'),
    {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.5 },
    },
    {
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      timeout,
      signal,
      responseType: 'arraybuffer',
    },
  )
}

async function openaiTranscribeShape(config, signal, timeout = PROBE_TIMEOUT) {
  const { apiKey, baseUrl } = config
  const urls = candidateUrls(baseUrl, '/audio/transcriptions')
  const form = new FormData()
  form.append('model', 'whisper-1')
  form.append('file', new Blob([makeSilentWav()], { type: 'audio/wav' }), 'connectivity-test.wav')
  let lastError
  for (const url of urls) {
    try {
      return await http.post(url, form, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout,
        signal,
      })
    } catch (error) {
      if (isAbort(error)) throw error
      lastError = error
    }
  }
  throw lastError || new Error('请求失败')
}

// 依次调用 steps，返回第一个成功的结果
async function probeShape(config, steps, timeout = PROBE_TIMEOUT) {
  const startTime = Date.now()
  const controller = createController()
  let firstError = null
  try {
    for (const step of steps) {
      try {
        const response = await step(config, controller, timeout)
        return { ok: true, latency: Date.now() - startTime, response }
      } catch (error) {
        if (isAbort(error)) {
          return { ok: false, cancelled: true, error }
        }
        if (!firstError) firstError = error
      }
    }
    return {
      ok: false,
      error: firstError,
      status: firstError?.response?.status,
    }
  } finally {
    releaseController(controller)
  }
}

// ---------- 图片模型 ----------

// 以提供商 URL+Key 实际检测（/models）返回的模型为基准，不做硬编码添加
export function listImageModels(config) {
  return listOpenAIModels(config)
}

const IMAGE_PROBE_STEPS = [
  (c, s, t) =>
    openaiShape(
      c,
      s,
      '/images/generations',
      {
        model: 'gpt-image-1',
        prompt: TEST_PROMPT,
        size: '1024x1024',
      },
      undefined,
      t,
    ),
  (c, s, t) => sdWebuiShape(c, s, TEST_PROMPT, t),
  (c, s, t) => imagenShape(c, s, 'imagen-3.0-generate-001', TEST_PROMPT, t),
  (c, s, t) =>
    openaiShape(
      c,
      s,
      '/chat/completions',
      { model: 'gpt-4o-mini', messages: visionMessages(TEST_PROMPT), max_tokens: 8 },
      undefined,
      t,
    ),
]

export async function testImageConnection(config) {
  const { baseUrl } = config
  const result = await probeShape(config, IMAGE_PROBE_STEPS)

  if (result.ok) {
    return {
      connected: true,
      connectTime: result.latency,
      usedEndpoint: result.response?.config?.url || '',
    }
  }
  if (result.cancelled) {
    return { connected: false, error: '请求已取消' }
  }
  if (result.status === 401) {
    return { connected: false, connectTime: 0, error: 'API Key无效或已过期', status: 401 }
  }
  if (result.status === 429) {
    return { connected: false, connectTime: 0, error: '请求过多，请稍后再试 (429)', status: 429 }
  }
  return {
    connected: false,
    connectTime: 0,
    error: describeError(result.error, baseUrl),
    status: result.status,
  }
}

export async function testImageModelLatency(config, model) {
  const modelId = resolveModelId(model)
  const startTime = Date.now()

  if (VISION_MODELS.has(modelId)) {
    const controller = createController()
    try {
      await openaiShape(
        config,
        controller,
        '/chat/completions',
        { model: modelId, messages: visionMessages(TEST_PROMPT), max_tokens: 8 },
        undefined,
        TIMEOUT,
      )
      return { model: modelId, latency: Date.now() - startTime, status: 'success' }
    } catch (error) {
      if (isAbort(error)) {
        return { model: modelId, latency: -1, status: 'cancelled', error: '请求已取消' }
      }
      if (error.response?.status === 401) {
        return { model: modelId, latency: -1, status: 'failed', error: 'API Key无效' }
      }
      return {
        model: modelId,
        latency: -1,
        status: 'failed',
        error: describeError(error, config.baseUrl),
      }
    } finally {
      releaseController(controller)
    }
  }

  const isSD = /^stable-diffusion/i.test(modelId)
  const isImagen = /^imagen-/i.test(modelId)
  const steps = isSD
    ? [(c, s, t) => sdWebuiShape(c, s, TEST_PROMPT, t)]
    : isImagen
      ? [(c, s, t) => imagenShape(c, s, modelId, TEST_PROMPT, t)]
      : [
          (c, s, t) =>
            openaiShape(
              c,
              s,
              '/images/generations',
              { model: modelId, prompt: TEST_PROMPT, size: '1024x1024' },
              undefined,
              t,
            ),
          (c, s, t) => sdWebuiShape(c, s, TEST_PROMPT, t),
          (c, s, t) => imagenShape(c, s, modelId, TEST_PROMPT, t),
        ]

  const result = await probeShape(config, steps, TIMEOUT)
  if (result.ok) {
    return { model: modelId, latency: result.latency, status: 'success' }
  }
  if (result.cancelled) {
    return { model: modelId, latency: -1, status: 'cancelled', error: '请求已取消' }
  }
  if (result.status === 401) {
    return { model: modelId, latency: -1, status: 'failed', error: 'API Key无效' }
  }
  return {
    model: modelId,
    latency: -1,
    status: 'failed',
    error: describeError(result.error, config.baseUrl),
  }
}

export function testImageModels(config, models, concurrency = 2) {
  return runConcurrentBatch(models, (m) => testImageModelLatency(config, m), concurrency)
}

function imageResultText(data) {
  const item = data?.data?.[0]
  if (item?.url) return `图片已生成：${item.url}`
  if (item?.b64_json) return `图片已生成（base64，约 ${Math.round(item.b64_json.length / 1024)}KB）`
  const sdImage = data?.images?.[0]
  if (sdImage) return `图片已生成（base64，约 ${Math.round(sdImage.length / 1024)}KB）`
  const imagenB64 = data?.predictions?.[0]?.bytesBase64Encoded
  if (imagenB64) return `图片已生成（base64，约 ${Math.round(imagenB64.length / 1024)}KB）`
  return '图片已生成，但响应中未包含图片数据'
}

// 聊天调用：视觉模型走 chat/completions，生图模型按协议生成图片
export async function sendImageChat(config, { model, messages, maxTokens = 500, timeout = 60000 }) {
  const modelId = resolveModelId(model) || 'gpt-image-1'
  const prompt = lastUserMessage(messages)

  if (VISION_MODELS.has(modelId)) {
    const controller = createController()
    try {
      const response = await openaiShape(
        config,
        controller,
        '/chat/completions',
        {
          model: modelId,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: maxTokens,
        },
        undefined,
        timeout,
      )
      return response.data?.choices?.[0]?.message?.content || '无响应'
    } finally {
      releaseController(controller)
    }
  }

  const isSD = /^stable-diffusion/i.test(modelId)
  const isImagen = /^imagen-/i.test(modelId)
  const steps = isSD
    ? [(c, s, t) => sdWebuiShape(c, s, prompt, t)]
    : isImagen
      ? [(c, s, t) => imagenShape(c, s, modelId, prompt, t)]
      : [
          (c, s, t) =>
            openaiShape(
              c,
              s,
              '/images/generations',
              { model: modelId, prompt, size: '1024x1024' },
              undefined,
              t,
            ),
          (c, s, t) => sdWebuiShape(c, s, prompt, t),
          (c, s, t) => imagenShape(c, s, modelId, prompt, t),
        ]

  const result = await probeShape(config, steps, timeout)
  if (!result.ok) {
    throw result.error || new Error('图片生成失败')
  }
  return `图片已生成（${modelId}）：${imageResultText(result.response?.data)}`
}

// ---------- 语音模型 ----------

// 以提供商 URL+Key 实际检测（/models）返回的模型为基准，不做硬编码添加
export function listSpeechModels(config) {
  return listOpenAIModels(config)
}

const SPEECH_PROBE_STEPS = [
  (c, s, t) =>
    openaiShape(
      c,
      s,
      '/audio/speech',
      { model: 'tts-1', input: TEST_PROMPT, voice: 'alloy' },
      'arraybuffer',
      t,
    ),
  (c, s, t) => azureTtsShape(c, s, TEST_PROMPT, undefined, t),
  (c, s, t) => elevenLabsShape(c, s, TEST_PROMPT, t),
  (c, s, t) => openaiTranscribeShape(c, s, t),
]

export async function testSpeechConnection(config) {
  const { baseUrl } = config
  const result = await probeShape(config, SPEECH_PROBE_STEPS)

  if (result.ok) {
    return {
      connected: true,
      connectTime: result.latency,
      usedEndpoint: result.response?.config?.url || '',
    }
  }
  if (result.cancelled) {
    return { connected: false, error: '请求已取消' }
  }
  if (result.status === 401) {
    return { connected: false, connectTime: 0, error: 'API Key无效或已过期', status: 401 }
  }
  if (result.status === 429) {
    return { connected: false, connectTime: 0, error: '请求过多，请稍后再试 (429)', status: 429 }
  }
  return {
    connected: false,
    connectTime: 0,
    error: describeError(result.error, baseUrl),
    status: result.status,
  }
}

export async function testSpeechModelLatency(config, model) {
  const modelId = resolveModelId(model)
  const startTime = Date.now()
  const controller = createController()

  try {
    if (OPENAI_TTS.has(modelId)) {
      await openaiShape(
        config,
        controller,
        '/audio/speech',
        { model: modelId, input: TEST_PROMPT, voice: 'alloy' },
        'arraybuffer',
        TIMEOUT,
      )
    } else if (modelId === 'whisper-1') {
      await openaiTranscribeShape(config, controller, TIMEOUT)
    } else if (/^eleven/i.test(modelId)) {
      await elevenLabsShape(config, controller, TEST_PROMPT, TIMEOUT)
    } else if (/^azure/i.test(modelId)) {
      await azureTtsShape(config, controller, TEST_PROMPT, modelId.replace(/^azure-/, ''), TIMEOUT)
    } else {
      const result = await probeShape(
        config,
        [
          (c, s, t) =>
            openaiShape(
              c,
              s,
              '/audio/speech',
              { model: modelId, input: TEST_PROMPT, voice: 'alloy' },
              'arraybuffer',
              t,
            ),
          (c, s, t) => azureTtsShape(c, s, TEST_PROMPT, undefined, t),
          (c, s, t) => elevenLabsShape(c, s, TEST_PROMPT, t),
          (c, s, t) => openaiTranscribeShape(c, s, t),
        ],
        TIMEOUT,
      )
      if (result.ok) {
        return { model: modelId, latency: result.latency, status: 'success' }
      }
      if (result.cancelled) {
        return { model: modelId, latency: -1, status: 'cancelled', error: '请求已取消' }
      }
      return {
        model: modelId,
        latency: -1,
        status: 'failed',
        error: describeError(result.error, config.baseUrl),
      }
    }

    return { model: modelId, latency: Date.now() - startTime, status: 'success' }
  } catch (error) {
    if (isAbort(error)) {
      return { model: modelId, latency: -1, status: 'cancelled', error: '请求已取消' }
    }
    if (error.response?.status === 401) {
      return { model: modelId, latency: -1, status: 'failed', error: 'API Key无效' }
    }
    return {
      model: modelId,
      latency: -1,
      status: 'failed',
      error: describeError(error, config.baseUrl),
    }
  } finally {
    releaseController(controller)
  }
}

export function testSpeechModels(config, models, concurrency = 2) {
  return runConcurrentBatch(models, (m) => testSpeechModelLatency(config, m), concurrency)
}

// 聊天调用：TTS 合成最后一条用户消息，Whisper 识别静音样本
export async function sendSpeechChat(config, { model, messages, timeout = 60000 }) {
  const modelId = resolveModelId(model) || 'tts-1'
  const input = lastUserMessage(messages)
  const controller = createController()

  try {
    let response
    if (OPENAI_TTS.has(modelId)) {
      response = await openaiShape(
        config,
        controller,
        '/audio/speech',
        { model: modelId, input, voice: 'alloy' },
        'arraybuffer',
        timeout,
      )
      return `语音合成成功（${Math.round((response.data?.byteLength || 0) / 1024)}KB，模型 ${modelId}）`
    }
    if (modelId === 'whisper-1') {
      response = await openaiTranscribeShape(config, controller, timeout)
      return `语音识别结果：${response.data?.text || '（无文本）'}（模型 whisper-1）`
    }
    if (/^eleven/i.test(modelId)) {
      response = await elevenLabsShape(config, controller, input, timeout)
      return `语音合成成功（ElevenLabs，${Math.round((response.data?.byteLength || 0) / 1024)}KB）`
    }
    if (/^azure/i.test(modelId)) {
      response = await azureTtsShape(
        config,
        controller,
        input,
        modelId.replace(/^azure-/, ''),
        timeout,
      )
      return `语音合成成功（Azure TTS，${Math.round((response.data?.byteLength || 0) / 1024)}KB）`
    }

    const result = await probeShape(
      config,
      [
        (c, s, t) =>
          openaiShape(
            c,
            s,
            '/audio/speech',
            { model: modelId, input, voice: 'alloy' },
            'arraybuffer',
            t,
          ),
        (c, s, t) => azureTtsShape(c, s, input, undefined, t),
        (c, s, t) => elevenLabsShape(c, s, input, t),
        (c, s, t) => openaiTranscribeShape(c, s, t),
      ],
      timeout,
    )
    if (!result.ok) {
      throw result.error || new Error('语音调用失败')
    }
    return `语音调用成功（${Math.round(
      (result.response?.data?.byteLength || 0) / 1024,
    )}KB，模型 ${modelId}）`
  } finally {
    releaseController(controller)
  }
}
