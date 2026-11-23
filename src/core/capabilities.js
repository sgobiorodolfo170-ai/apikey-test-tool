// 可选能力矩阵：应用启动时探测一次，缺失的可选能力只降级，不阻断使用。
// 这里只做“声明 + 检测”，具体能力实现由对应模块负责。

const bridge = () => (typeof window !== 'undefined' ? window.electronAPI : null)

const DEFINITIONS = [
  {
    id: 'gateway',
    label: '本地网关',
    optional: false,
    detect: () => Boolean(bridge()?.relay?.start),
    fallback: '仅测速模式',
  },
  {
    id: 'lan',
    label: '局域网访问',
    optional: true,
    // 探测的是能力本身（桌面桥是否暴露中转站状态/配置）；是否已开启以中转站面板的运行状态为准
    detect: () => Boolean(bridge()?.relay?.status),
    fallback: '仅回环',
  },
  {
    id: 'updater',
    label: '在线更新',
    optional: true,
    // 与 utils/update.js 的桌面判定一致：有主进程 HTTP 桥才算具备在线更新能力
    detect: () => Boolean(bridge()?.request),
    fallback: '手动更新',
  },
  {
    id: 'tray',
    label: '系统托盘',
    optional: true,
    detect: () => Boolean(bridge()),
    fallback: '窗口内操作',
  },
  {
    id: 'notifications',
    label: '系统通知',
    optional: true,
    detect: () => typeof Notification !== 'undefined',
    fallback: '应用内提示',
  },
  {
    id: 'channels',
    label: '外部渠道适配器',
    optional: true,
    detect: () => Boolean(bridge()?.channel?.list),
    fallback: '仅内置预设',
  },
]

export function detectCapabilities(definitions = DEFINITIONS) {
  return definitions.map((item) => {
    const available = Boolean(item.detect())
    return {
      id: item.id,
      label: item.label,
      status: available ? 'available' : item.optional ? 'degraded' : 'unavailable',
      detail: available ? '可用' : item.fallback,
    }
  })
}

export function capabilityStatusLabel(status) {
  if (status === 'available') return '可用'
  if (status === 'degraded') return '未启用'
  return '不可用'
}

// 启动时写一条能力快照，便于用户反馈“为什么某个入口是灰的”。
export function logCapabilitySnapshot() {
  const rows = detectCapabilities()
  if (typeof console !== 'undefined' && typeof console.info === 'function') {
    const text = rows.map((row) => `${row.label}:${capabilityStatusLabel(row.status)}`).join(' · ')
    console.info(`[capabilities] ${text}`)
  }
  return rows
}
