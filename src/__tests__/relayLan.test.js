import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const relay = require('../../electron/relay.cjs')

const mockReq = (remoteAddress, authorization = '') => ({
  headers: authorization ? { authorization } : {},
  socket: { remoteAddress },
})

afterEach(async () => {
  await relay.stop()
})

describe('isLoopbackRequest', () => {
  it('识别回环地址（IPv4 / IPv6 / 映射）', () => {
    expect(relay.isLoopbackRequest(mockReq('127.0.0.1'))).toBe(true)
    expect(relay.isLoopbackRequest(mockReq('::1'))).toBe(true)
    expect(relay.isLoopbackRequest(mockReq('::ffff:127.0.0.1'))).toBe(true)
  })

  it('非回环与空地址判为非本机（fail closed）', () => {
    expect(relay.isLoopbackRequest(mockReq('192.168.1.5'))).toBe(false)
    expect(relay.isLoopbackRequest(mockReq(''))).toBe(false)
  })
})

describe('局域网鉴权守卫', () => {
  it('未设 Key：本机放行，非回环拒绝', async () => {
    await relay.start({ port: 0, providers: [] })
    expect(relay.identifyClient(mockReq('127.0.0.1')).ok).toBe(true)
    expect(relay.identifyClient(mockReq('192.168.1.5')).ok).toBe(false)
  })

  it('设了 Key：非回环带正确 Key 放行，无 Key 拒绝', async () => {
    await relay.start({ port: 0, providers: [], apiKey: 'sk-access' })
    expect(relay.identifyClient(mockReq('192.168.1.5', 'Bearer sk-access')).ok).toBe(true)
    expect(relay.identifyClient(mockReq('192.168.1.5')).ok).toBe(false)
    expect(relay.identifyClient(mockReq('127.0.0.1')).ok).toBe(false)
  })

  it('接受 Anthropic 客户端的 x-api-key 头', async () => {
    await relay.start({ port: 0, providers: [], apiKey: 'sk-access' })
    const req = {
      headers: { 'x-api-key': 'sk-access' },
      socket: { remoteAddress: '192.168.1.5' },
    }
    expect(relay.identifyClient(req)).toMatchObject({ ok: true, label: '默认' })
  })
})

describe('LAN 开关与监听地址', () => {
  it('默认关闭，监听回环', async () => {
    await relay.start({ port: 0, providers: [] })
    const status = relay.getStatus()
    expect(status.lan.enabled).toBe(false)
    expect(status.lan.active).toBe(false)
    expect(status.listenHost).toBe('127.0.0.1')
  })

  it('开启 LAN 但无 Key → 拒绝启动 LAN_KEY_REQUIRED', async () => {
    let err
    try {
      await relay.start({ port: 0, providers: [], lan: { enabled: true } })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('LAN_KEY_REQUIRED')
    expect(relay.getStatus().running).toBe(false)
  })

  it('开启 LAN 且有 Key → 监听 0.0.0.0，本机 baseUrl 不变', async () => {
    const info = await relay.start({
      port: 0,
      providers: [],
      apiKey: 'sk-access',
      lan: { enabled: true },
    })
    const status = relay.getStatus()
    expect(status.listenHost).toBe('0.0.0.0')
    expect(status.lan.enabled).toBe(true)
    expect(status.lan.active).toBe(true)
    expect(Array.isArray(status.lan.addresses)).toBe(true)
    expect(info.baseUrl).toContain('127.0.0.1')
  })
})

describe('监听错误分类', () => {
  it('EADDRINUSE → port_in_use 且给出替代端口', async () => {
    const blocker = http.createServer(() => {})
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const port = blocker.address().port
    let err
    try {
      await relay.start({ port, providers: [] })
    } catch (e) {
      err = e
    } finally {
      blocker.close()
    }
    expect(err?.listenError?.reason).toBe('port_in_use')
    expect(err?.listenError?.alternativePort).toBe(port + 1)
  })
})
