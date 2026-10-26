import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import axios from 'axios'
import http, { isIpcTransport } from '../http.js'

vi.mock('axios')

function mockBridge(overrides = {}) {
  const bridge = {
    request: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      contentType: 'application/json',
      text: '{"ok":true}',
    }),
    abortRequest: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  }
  window.electronAPI = bridge
  return bridge
}

describe('http transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete window.electronAPI
  })

  it('should fall back to axios without the electron bridge', async () => {
    axios.post.mockResolvedValueOnce({ data: { ok: 1 } })
    expect(isIpcTransport()).toBe(false)

    const res = await http.post('https://api.test.com/v1/chat', { a: 1 }, { timeout: 1000 })

    expect(res.data).toEqual({ ok: 1 })
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.test.com/v1/chat',
      { a: 1 },
      { timeout: 1000 },
    )
  })

  it('should route through IPC and parse JSON when the bridge exists', async () => {
    const bridge = mockBridge()
    expect(isIpcTransport()).toBe(true)

    const res = await http.post(
      'https://api.test.com/v1/chat',
      { model: 'm' },
      { headers: { Authorization: 'Bearer k' }, timeout: 5000 },
    )

    expect(res.data).toEqual({ ok: true })
    expect(res.status).toBe(200)
    expect(axios.post).not.toHaveBeenCalled()

    const payload = bridge.request.mock.calls[0][0]
    expect(payload).toMatchObject({
      url: 'https://api.test.com/v1/chat',
      method: 'POST',
      body: { model: 'm' },
      timeout: 5000,
    })
    expect(payload.headers.Authorization).toBe('Bearer k')
    expect(payload.requestId).toBeTruthy()
  })

  it('should throw an axios-shaped error for non-2xx responses', async () => {
    mockBridge({
      request: vi.fn().mockResolvedValue({
        ok: true,
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        contentType: 'application/json',
        text: '{"error":{"message":"bad key"}}',
      }),
    })

    await expect(http.get('https://api.test.com/v1/models')).rejects.toMatchObject({
      status: 401,
      response: { status: 401, data: { error: { message: 'bad key' } } },
    })
  })

  it('should expose network error codes so existing messages still work', async () => {
    mockBridge({
      request: vi
        .fn()
        .mockResolvedValue({ ok: false, code: 'ENOTFOUND', message: 'net::ERR_NAME_NOT_RESOLVED' }),
    })

    await expect(http.get('https://bad.host/v1/models')).rejects.toMatchObject({
      code: 'ENOTFOUND',
      isNetworkError: true,
    })
  })

  it('should map cancelled requests to CanceledError', async () => {
    mockBridge({
      request: vi.fn().mockResolvedValue({ ok: false, cancelled: true, code: 'ERR_CANCELED' }),
    })

    await expect(http.get('https://api.test.com/v1/models')).rejects.toMatchObject({
      name: 'CanceledError',
    })
  })

  it('should decode arraybuffer responses into ArrayBuffer', async () => {
    mockBridge({
      request: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {},
        contentType: 'audio/mpeg',
        base64: btoa('hi'),
      }),
    })

    const res = await http.post(
      'https://api.test.com/v1/audio/speech',
      {},
      { responseType: 'arraybuffer' },
    )

    expect(res.data instanceof ArrayBuffer).toBe(true)
    expect(new Uint8Array(res.data).length).toBe(2)
  })

  it('should serialize FormData into transportable parts', async () => {
    const bridge = mockBridge()
    const form = new FormData()
    form.append('model', 'whisper-1')
    form.append('file', new File(['wav'], 'test.wav', { type: 'audio/wav' }))

    await http.post('https://api.test.com/v1/audio/transcriptions', form, {
      headers: { Authorization: 'Bearer k' },
    })

    const body = bridge.request.mock.calls[0][0].body
    expect(body.__formData).toBe(true)
    expect(body.parts[0]).toEqual({ name: 'model', value: 'whisper-1' })
    expect(body.parts[1].filename).toBe('test.wav')
    expect(body.parts[1].base64).toBeTruthy()
  })

  it('should abort the main-process request when the signal fires', async () => {
    const bridge = mockBridge({
      request: vi.fn().mockResolvedValue({ ok: false, cancelled: true }),
    })
    const controller = new AbortController()
    const pending = http.get('https://api.test.com/v1/models', { signal: controller.signal })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'CanceledError' })
    expect(bridge.abortRequest).toHaveBeenCalled()
  })
})

describe('http stream', () => {
  afterEach(() => {
    delete window.electronAPI
  })

  it('should deliver chunks in order and resolve with the status', async () => {
    window.electronAPI = {
      stream: vi.fn(async (payload, onEvent) => {
        onEvent({ requestId: payload.requestId, type: 'chunk', text: '你' })
        onEvent({ requestId: payload.requestId, type: 'chunk', text: '好' })
        onEvent({ requestId: payload.requestId, type: 'done' })
        return { ok: true, status: 200, statusText: 'OK', headers: {} }
      }),
    }

    const chunks = []
    const result = await http.stream('https://api.test.com/v1/chat', { a: 1 }, {}, (c) =>
      chunks.push(c),
    )

    expect(chunks).toEqual(['你', '好'])
    expect(result.status).toBe(200)
    expect(window.electronAPI.stream.mock.calls[0][0].body).toEqual({ a: 1 })
  })

  it('should throw an axios-shaped error for non-2xx responses', async () => {
    window.electronAPI = {
      stream: vi.fn(async () => ({
        ok: true,
        status: 429,
        statusText: 'Too Many Requests',
        headers: {},
        text: '{"error":{"message":"slow down"}}',
      })),
    }

    await expect(http.stream('https://api.test.com/v1/chat', {}, {})).rejects.toMatchObject({
      status: 429,
      response: { status: 429, data: { error: { message: 'slow down' } } },
    })
  })

  it('should resolve cancelled streams so partial output is kept', async () => {
    window.electronAPI = {
      stream: vi.fn(async () => ({ ok: true, cancelled: true, status: 200 })),
    }

    const result = await http.stream('https://api.test.com/v1/chat', {}, {})
    expect(result.cancelled).toBe(true)
  })

  it('should surface network errors with a code', async () => {
    window.electronAPI = {
      stream: vi.fn(async () => ({ ok: false, code: 'ECONNREFUSED', message: 'refused' })),
    }

    await expect(http.stream('https://api.test.com/v1/chat', {}, {})).rejects.toMatchObject({
      code: 'ECONNREFUSED',
      isNetworkError: true,
    })
  })
})
