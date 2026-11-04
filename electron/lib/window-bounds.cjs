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

// 取用于持久化的窗口状态。最大化/最小化时 getBounds() 可能是当前状态的边界
// （最大化即屏幕大小），直接保存会让下次「取消最大化」恢复成屏幕尺寸；
// normalBounds 始终是用户调整后的正常尺寸，两种状态统一用它。
function snapshotWindowState(win) {
  if (!win || win.isDestroyed?.() === true) return null
  const readBounds = typeof win.getNormalBounds === 'function' ? win.getNormalBounds : win.getBounds
  if (typeof readBounds !== 'function') return null
  const bounds = readBounds.call(win)
  if (!bounds || typeof bounds !== 'object') return null

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized?.() === true,
  }
}

module.exports = { normalizeWindowBounds, snapshotWindowState, DEFAULT_SIZE }
