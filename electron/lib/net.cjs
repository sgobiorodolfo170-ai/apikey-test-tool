// CJS 网络细节助手，供 Electron 主进程使用。
// classifyListenError：端口监听错误分类，给出可操作提示（不建议提权）。
// listLanAddresses：枚举局域网 IPv4，过滤虚拟网卡，物理网卡优先。
// resolveProxyBypass：遵守 NO_PROXY / no_proxy，判断某目标是否应绕过代理。

const os = require('os')

// 常见虚拟 / 隧道 / 回环网卡名特征：这些地址不适合作为局域网访问入口
const VIRTUAL_NIC_PATTERN =
  /(vethernet|vmware|virtualbox|vbox|hyper[-_]?v|loopback|docker|virbr|vnet|tun|tap|utun|bridge|wsl|npcap|wan miniport|bluetooth|teredo|isatap|6to4|ppp)/i
// 物理网卡名特征：用于排序时优先展示
const PHYSICAL_NIC_PATTERN = /^(eth|en\d|ethernet|wi[-_]?fi|wlan|wl|以太网|无线网络|本地连接)/i

function classifyListenError(error, port) {
  const code = String(error?.code || '')
  const numericPort = Number(port) || 0
  if (code === 'EADDRINUSE') {
    const alternative = numericPort > 0 && numericPort < 65535 ? numericPort + 1 : 0
    return {
      code,
      reason: 'port_in_use',
      message: alternative
        ? `端口 ${numericPort} 已被占用，可改用 ${alternative}`
        : `端口 ${numericPort} 已被占用，请更换其它端口`,
      alternativePort: alternative,
    }
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      code,
      reason: 'permission_denied',
      message: `监听端口 ${numericPort} 权限不足（${code}）。请更换其它端口，或检查该端口是否被系统保留；不建议以管理员权限运行。`,
      alternativePort: 0,
    }
  }
  if (code === 'EADDRNOTAVAIL') {
    return {
      code,
      reason: 'address_unavailable',
      message: `监听地址不可用（${code}）：请确认所选网卡 / IP 仍然存在。`,
      alternativePort: 0,
    }
  }
  return {
    code,
    reason: 'unknown',
    message: `中转站启动失败：${error?.message || code || '未知错误'}`,
    alternativePort: 0,
  }
}

function familyOf(addr) {
  return typeof addr?.family === 'number' ? `IPv${addr.family}` : String(addr?.family || '')
}

// interfaces 可注入（默认取 os.networkInterfaces()），便于离线单测。
// 返回 [{ name, address, physical }]，物理网卡优先，其余按名称 / 地址稳定排序。
function listLanAddresses(interfaces) {
  const source = interfaces || os.networkInterfaces()
  const result = []
  for (const [name, addrs] of Object.entries(source || {})) {
    if (VIRTUAL_NIC_PATTERN.test(name)) continue
    for (const addr of addrs || []) {
      if (familyOf(addr) !== 'IPv4') continue
      if (addr.internal) continue
      const address = String(addr.address || '')
      // 回环与链路本地地址不是可用的局域网入口
      if (!address || address.startsWith('127.') || address.startsWith('169.254.')) continue
      result.push({ name, address, physical: PHYSICAL_NIC_PATTERN.test(name) })
    }
  }
  result.sort(
    (a, b) =>
      Number(b.physical) - Number(a.physical) ||
      a.name.localeCompare(b.name) ||
      a.address.localeCompare(b.address),
  )
  return result
}

function noProxyRules(env) {
  const raw = String(env?.NO_PROXY ?? env?.no_proxy ?? '')
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function hostOf(target) {
  let host
  try {
    host = new URL(String(target)).hostname
  } catch {
    host = String(target || '')
  }
  return host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
}

// 规则语义：'*' 绕过全部；其余按主机名精确或后缀匹配（'.example.com' 与 'example.com'
// 都匹配 example.com 及其子域）。仅处理主机名，不解析 CIDR。
function resolveProxyBypass(target, env = process.env) {
  const rules = noProxyRules(env)
  if (rules.length === 0) return false
  if (rules.includes('*')) return true
  const host = hostOf(target)
  if (!host) return false
  for (const rule of rules) {
    const bare = rule.replace(/^\./, '')
    if (!bare) continue
    if (host === bare || host.endsWith(`.${bare}`)) return true
  }
  return false
}

module.exports = { classifyListenError, listLanAddresses, resolveProxyBypass }
