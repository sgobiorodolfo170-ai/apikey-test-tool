import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  classifyListenError,
  listLanAddresses,
  resolveProxyBypass,
} = require('../../electron/lib/net.cjs')

describe('classifyListenError', () => {
  it('EADDRINUSE 给出 port+1 替代端口与可操作提示', () => {
    const result = classifyListenError({ code: 'EADDRINUSE' }, 8787)
    expect(result.reason).toBe('port_in_use')
    expect(result.alternativePort).toBe(8788)
    expect(result.message).toContain('8787')
    expect(result.message).toContain('8788')
  })

  it('EADDRINUSE 在 65535 时不再给出越界替代端口', () => {
    const result = classifyListenError({ code: 'EADDRINUSE' }, 65535)
    expect(result.alternativePort).toBe(0)
    expect(result.message).toContain('65535')
  })

  it('EACCES 提示权限不足且不建议管理员权限', () => {
    const result = classifyListenError({ code: 'EACCES' }, 80)
    expect(result.reason).toBe('permission_denied')
    expect(result.message).toContain('权限不足')
    expect(result.message).toContain('不建议以管理员权限运行')
    expect(result.alternativePort).toBe(0)
  })

  it('EADDRNOTAVAIL 与未知错误各有兜底文案', () => {
    expect(classifyListenError({ code: 'EADDRNOTAVAIL' }, 8787).reason).toBe('address_unavailable')
    const unknown = classifyListenError({ code: 'EFOO', message: 'boom' }, 8787)
    expect(unknown.reason).toBe('unknown')
    expect(unknown.message).toContain('boom')
  })
})

describe('listLanAddresses', () => {
  const fixture = {
    'vEthernet (WSL)': [{ address: '172.20.10.2', family: 'IPv4', internal: false }],
    'VMware Network Adapter VMnet1': [{ address: '192.168.88.1', family: 'IPv4', internal: false }],
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'Wi-Fi': [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    Ethernet: [
      { address: '10.0.0.5', family: 'IPv4', internal: false },
      { address: '169.254.1.1', family: 'IPv4', internal: false },
    ],
  }

  it('过滤虚拟网卡、internal、IPv6 与链路本地地址', () => {
    const addresses = listLanAddresses(fixture).map((item) => item.address)
    expect(addresses).toContain('192.168.1.20')
    expect(addresses).toContain('10.0.0.5')
    expect(addresses).not.toContain('172.20.10.2')
    expect(addresses).not.toContain('192.168.88.1')
    expect(addresses).not.toContain('127.0.0.1')
    expect(addresses).not.toContain('169.254.1.1')
    expect(addresses).not.toContain('fe80::1')
  })

  it('物理网卡优先排序', () => {
    const list = listLanAddresses({
      'zzz-physical': [{ address: '10.1.1.1', family: 'IPv4', internal: false }],
      Ethernet: [{ address: '10.2.2.2', family: 'IPv4', internal: false }],
    })
    expect(list[0].name).toBe('Ethernet')
    expect(list[0].physical).toBe(true)
    expect(list[1].physical).toBe(false)
  })

  it('兼容 family 为数字 4 的写法', () => {
    const list = listLanAddresses({ eth0: [{ address: '10.3.3.3', family: 4, internal: false }] })
    expect(list).toHaveLength(1)
    expect(list[0].address).toBe('10.3.3.3')
  })

  it('空输入返回空数组', () => {
    expect(listLanAddresses({})).toEqual([])
  })
})

describe('resolveProxyBypass', () => {
  it('无 NO_PROXY 时不绕过', () => {
    expect(resolveProxyBypass('https://api.openai.com/v1', {})).toBe(false)
  })

  it('* 绕过全部', () => {
    expect(resolveProxyBypass('https://api.openai.com/v1', { NO_PROXY: '*' })).toBe(true)
  })

  it('精确主机名匹配（忽略大小写与端口）', () => {
    const env = { NO_PROXY: 'api.openai.com' }
    expect(resolveProxyBypass('https://API.OpenAI.com:443/v1', env)).toBe(true)
    expect(resolveProxyBypass('https://other.com/v1', env)).toBe(false)
  })

  it('后缀匹配子域，前导点可选', () => {
    expect(resolveProxyBypass('https://api.openai.com', { NO_PROXY: '.openai.com' })).toBe(true)
    expect(resolveProxyBypass('https://openai.com', { NO_PROXY: 'openai.com' })).toBe(true)
    expect(resolveProxyBypass('https://notopenai.com', { NO_PROXY: 'openai.com' })).toBe(false)
  })

  it('读取小写 no_proxy，逗号分隔多规则', () => {
    const env = { no_proxy: 'localhost, 127.0.0.1, .internal' }
    expect(resolveProxyBypass('http://localhost:8787', env)).toBe(true)
    expect(resolveProxyBypass('http://127.0.0.1:8787', env)).toBe(true)
    expect(resolveProxyBypass('http://svc.internal', env)).toBe(true)
    expect(resolveProxyBypass('http://example.com', env)).toBe(false)
  })

  it('接受裸主机名（无 scheme）', () => {
    expect(resolveProxyBypass('api.openai.com', { NO_PROXY: 'openai.com' })).toBe(true)
  })
})
