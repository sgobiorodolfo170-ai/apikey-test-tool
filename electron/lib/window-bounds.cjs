// 恢复窗口位置前先确认它仍落在某个显示器的工作区内。
// 外接屏拔掉/分辨率变化后，旧的 x/y 可能把窗口放到屏幕外，表现为“应用打开了但看不见”。
const DEFAULT_SIZE = { width: 1200, height: 800 }

function normalizeWindowBounds(state, displays = []) {
  const width = Number(state?.width) > 0 ? Math.round(Number(state.width)) : DEFAULT_SIZE.width
  const height = Number(state?.height) > 0 ? Math.round(Number(state.height)) : DEFAULT_SIZE.height
  const x = Number(state?.x)
  const y = Number(state?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height }

  const visible = displays.some((display) => {
    const area = display?.workArea || display?.bounds
    if (!area) return false
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x)
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y)
    // 至少露出一角，避免只剩 1px 在屏幕边缘
    return overlapX >= 80 && overlapY >= 80
  })

  return visible ? { x, y, width, height } : { width, height }
}

module.exports = { normalizeWindowBounds, DEFAULT_SIZE }
