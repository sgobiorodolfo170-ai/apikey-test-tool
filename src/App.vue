<template>
  <!-- vue-grid-layout 卡片四周各有 margin(5px) 的内缩，因此左右/上 padding = 目标间距(20px) - margin；
       右侧目标 30px → pr 25px；底部 30px 由 rowHeight 反推公式直接控制（见 applyScale） -->
  <div
    class="h-screen bg-canvas flex flex-col overflow-hidden pt-[15px] pl-[15px] pr-[25px] pb-[30px]"
  >
    <div ref="containerRef" class="flex-1 min-h-0 w-full relative">
      <div :style="gridWidthStyle">
        <grid-layout
          :layout="gridLayout"
          :col-num="12"
          :row-height="rowHeight"
          :is-draggable="true"
          :is-resizable="true"
          :vertical-compact="true"
          :margin="GRID_MARGIN"
          @layout-updated="onLayoutUpdated"
        >
          <grid-item
            v-for="item in gridLayout"
            :key="item.i"
            :x="item.x"
            :y="item.y"
            :w="item.w"
            :h="item.h"
            :i="item.i"
            :min-w="item.minW"
            :min-h="item.minH"
            :is-draggable="false"
            :drag-ignore-from="dragIgnoreFrom"
          >
            <div class="relative h-full w-full" :data-panel="item.i">
              <!-- 单张卡片：左区历史、右区聊天/测评，中间用可拖动分割线区分 -->
              <!-- 该节点位于 v-for 内：模板 ref 会被收集成数组，这里用函数式 ref 直接取元素 -->
              <div :ref="setWorkspaceEl" class="card h-full w-full flex overflow-hidden">
                <div
                  :ref="setLeftPaneEl"
                  class="h-full min-w-0 flex flex-col"
                  :style="leftPaneStyle"
                >
                  <HistoryPanel>
                    <template #actions>
                      <button
                        type="button"
                        class="w-8 h-8 flex items-center justify-center rounded-full text-text-secondary hover:bg-surface-hover hover:text-accent transition-colors flex-shrink-0"
                        :title="chatCollapsed ? '展开聊天测试区' : '折叠聊天测试区'"
                        :aria-label="chatCollapsed ? '展开聊天测试区' : '折叠聊天测试区'"
                        @click.stop="toggleChatCollapsed"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          class="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path v-if="chatCollapsed" d="M18 17l-5-5 5-5" />
                          <path v-if="chatCollapsed" d="M11 17l-5-5 5-5" />
                          <path v-if="!chatCollapsed" d="M6 17l5-5-5-5" />
                          <path v-if="!chatCollapsed" d="M13 17l5-5-5-5" />
                        </svg>
                      </button>
                    </template>
                  </HistoryPanel>
                </div>
                <div
                  v-if="!chatCollapsed"
                  class="pane-divider flex-shrink-0"
                  title="拖动调节左右区域宽度"
                  @mousedown.prevent.stop="startPaneResize"
                ></div>
                <div v-if="!chatCollapsed" class="h-full min-w-0 flex-1 flex flex-col">
                  <ChatEvalPanel />
                </div>
              </div>
              <!-- 自定义边把手：覆盖整条右/下边缘，悬停显示调整大小光标 -->
              <div class="vue-resizable-handle edge-handle edge-right"></div>
              <div class="vue-resizable-handle edge-handle edge-bottom"></div>
            </div>
          </grid-item>
        </grid-layout>
      </div>
    </div>
    <ToastContainer />
  </div>
</template>

<script>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import HistoryPanel from './components/HistoryPanel.vue'
import ChatEvalPanel from './components/ChatEvalPanel.vue'
import ToastContainer from './components/Toast.vue'
import { useHistoryStore } from './stores/historyStore.js'
import { useUpdateStore } from './stores/updateStore.js'
import { cancelAllRequests as cancelOpenAIRequests } from './api/openai.js'
import { cancelAllRequests as cancelAnthropicRequests } from './api/anthropic.js'
import { initStorage } from './utils/storage.js'

const LAYOUT_KEY = 'dashboard-layout'
const COLLAPSE_KEY = 'dashboard-chat-collapsed'
const COLLAPSE_WIDTH_KEY = 'dashboard-chat-collapsed-width'
const PANE_RATIO_KEY = 'dashboard-pane-ratio'

const WORKSPACE_ID = 'workspace'

// 单张卡片：左区历史、右区聊天/测评，中间用分割线区分；折叠时只保留左区
const defaultLayout = [{ i: WORKSPACE_ID, x: 0, y: 0, w: 12, h: 10, minW: 6, minH: 4 }]

// 折叠后窗口收窄时，左区最小可用宽度
const COLLAPSED_PANE_MIN = 360

// 卡片间距；vue-grid-layout 的卡片定位含 margin 内缩：
// top = y*rowHeight + (y+1)*margin, left = x*colWidth + (x+1)*margin
const GRID_MARGIN = [5, 5]

// 单卡高度上限（行）：异常布局值会把行高自适应压到几像素，导致高度无法微调
const MAX_LAYOUT_ROWS = 24

// 拖拽忽略：在卡片内的交互/内容组件上按下时不要拖动卡片，仅空白区域可拖拽
const DRAG_IGNORE_FROM =
  'a, button, input, select, textarea, label, [contenteditable], .vue-resizable-handle, [class*="btn"]'

function loadLayout() {
  let layout = defaultLayout
  try {
    const saved = localStorage.getItem(LAYOUT_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      const valid =
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(
          (item) =>
            item &&
            typeof item.i === 'string' &&
            Number.isFinite(item.x) &&
            Number.isFinite(item.y) &&
            Number.isFinite(item.w) &&
            Number.isFinite(item.h),
        )
      if (valid) layout = parsed
    }
  } catch (e) {
    console.error('加载布局失败:', e)
  }

  // 旧版两张卡片（history / chateval）合并为单张卡片，高度取较大值
  const maxH = layout.reduce((max, item) => Math.max(max, item.h), defaultLayout[0].h)
  const workspace = layout.find((item) => item.i === WORKSPACE_ID)
  // 行数限制在合理区间：旧布局或异常写入可能留下极大的 h，
  // 会让行高自适应后每行只剩几像素，导致卡片高度几乎无法微调
  const rawH = Math.round(workspace ? workspace.h : maxH)
  const h = Number.isFinite(rawH)
    ? Math.min(MAX_LAYOUT_ROWS, Math.max(defaultLayout[0].minH, rawH))
    : defaultLayout[0].h
  // 单卡片始终占满 12 列，只保留可调整的高度
  return [{ ...defaultLayout[0], h }]
}

function loadPaneRatio() {
  try {
    const ratio = Number(localStorage.getItem(PANE_RATIO_KEY))
    return Number.isFinite(ratio) && ratio >= 0.2 && ratio <= 0.8 ? ratio : 0.5
  } catch (e) {
    console.error('加载左右比例失败:', e)
  }
  return 0.5
}

function loadChatCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch (e) {
    console.error('加载折叠状态失败:', e)
  }
  return false
}

function loadCollapsedWidth() {
  try {
    const width = Number(localStorage.getItem(COLLAPSE_WIDTH_KEY))
    return Number.isFinite(width) && width > 0 ? Math.round(width) : 0
  } catch (e) {
    console.error('加载折叠窗口宽度失败:', e)
  }
  return 0
}

function stripLayoutItem(item) {
  const base = defaultLayout.find((d) => d.i === item.i)
  return {
    i: item.i,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    minW: item.minW ?? base?.minW ?? 2,
    minH: item.minH ?? base?.minH ?? 3,
  }
}

async function logErrorToFile(errorType, errorMessage, stackTrace) {
  try {
    if (window.electronAPI && window.electronAPI.logError) {
      await window.electronAPI.logError(errorType, errorMessage, stackTrace)
    }
  } catch (e) {
    console.error('记录错误失败:', e)
  }
}

export default {
  name: 'App',
  components: {
    HistoryPanel,
    ChatEvalPanel,
    ToastContainer,
  },
  setup() {
    const historyStore = useHistoryStore()
    const updateStore = useUpdateStore()
    const savedLayout = ref(loadLayout())
    const chatCollapsed = ref(loadChatCollapsed())
    const collapsedWindowWidth = ref(loadCollapsedWidth())
    const leftRatio = ref(loadPaneRatio())
    const containerRef = ref(null)
    // 单卡工作区元素；模板 ref 位于 v-for 内，Vue 会收集成数组，
    // 因此改用函数式 ref 直接持有元素引用
    const workspaceEl = ref(null)
    const leftPaneEl = ref(null)
    const setWorkspaceEl = (el) => {
      workspaceEl.value = el
    }
    const setLeftPaneEl = (el) => {
      leftPaneEl.value = el
    }
    const rowHeight = ref(60)

    // 卡片尺寸变化后让窗口跟随：调整期间暂停 rowHeight 自适应，避免两边互相抵消
    let lastFittedCols = null
    const windowFit = { active: false, suspended: false, timer: null, target: null, seq: 0 }

    // 单张卡片：左右区由内部布局控制，折叠只影响右区显示
    const gridLayout = computed(() => savedLayout.value.map((item) => ({ ...item })))

    // 左区按比例占卡片宽度；折叠后铺满整张卡片
    const leftPaneStyle = computed(() =>
      chatCollapsed.value
        ? { flex: '1 1 100%' }
        : { flex: `0 0 ${(leftRatio.value * 100).toFixed(2)}%` },
    )

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))

    // 折叠后把主窗口收窄到刚好容纳左区：先按折叠前左区宽度估算，
    // 等窗口重排后按实际渲染宽度补偿一次，保证左区宽度不变。
    async function fitWindowToLeftPane(paneWidth) {
      const api = window.electronAPI
      if (!api?.setWindowCollapsed) return
      const frameW = Math.max(0, (window.outerWidth || 0) - window.innerWidth)
      const target = Math.round(Math.max(COLLAPSED_PANE_MIN, paneWidth || 0) + 40 + frameW)
      const result = await api.setWindowCollapsed({ collapsed: true, width: target })
      if (!result?.ok) return

      await nextFrame()
      await new Promise((resolve) => setTimeout(resolve, 120))
      const after = leftPaneEl.value?.getBoundingClientRect().width || 0
      if (paneWidth && Math.abs(after - paneWidth) > 2) {
        // setBounds 使用窗口外框宽度，校正时同样按 outerWidth 计算
        await api.setWindowCollapsed({
          collapsed: true,
          width: Math.round((window.outerWidth || window.innerWidth) + (paneWidth - after)),
        })
      }
      // 记住折叠时的窗口宽度（外框）：刷新或重启后按它恢复折叠窗口
      collapsedWindowWidth.value = Math.round(window.outerWidth || window.innerWidth)
      localStorage.setItem(COLLAPSE_WIDTH_KEY, String(collapsedWindowWidth.value))
    }

    const toggleChatCollapsed = async () => {
      const api = window.electronAPI
      const willCollapse = !chatCollapsed.value
      const paneWidth = leftPaneEl.value?.getBoundingClientRect().width || 0

      windowFit.suspended = true
      chatCollapsed.value = willCollapse
      localStorage.setItem(COLLAPSE_KEY, willCollapse ? '1' : '0')
      await nextTick()
      applyScale()

      try {
        if (!api?.setWindowCollapsed) return
        if (willCollapse) {
          await fitWindowToLeftPane(paneWidth)
        } else {
          await api.setWindowCollapsed({ collapsed: false })
          collapsedWindowWidth.value = 0
          localStorage.removeItem(COLLAPSE_WIDTH_KEY)
        }
      } finally {
        windowFit.suspended = false
        lastFittedCols = gridCols.value
      }
    }

    // 拖动卡片内的左右分割线：按比例重新分配左右区域宽度
    function startPaneResize(event) {
      if (chatCollapsed.value) return
      const container = workspaceEl.value
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (!rect.width) return

      const startX = event.clientX
      const startRatio = leftRatio.value
      const minRatio = Math.min(0.45, 300 / rect.width)

      const onMove = (moveEvent) => {
        const next = startRatio + (moveEvent.clientX - startX) / rect.width
        leftRatio.value = Math.min(1 - minRatio, Math.max(minRatio, next))
      }
      const stop = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', stop)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        localStorage.setItem(PANE_RATIO_KEY, String(leftRatio.value))
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', stop)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }

    // 布局实际使用的最大列数（最右卡片的结束列）
    const gridCols = computed(() => {
      let k = 0
      for (const item of gridLayout.value) {
        k = Math.max(k, item.x + item.w)
      }
      return Math.min(12, Math.max(1, k))
    })

    // 网格宽度按使用列数等比拉伸铺满容器，使最右卡片的右边缘始终锁定在
    // 距窗口右边线 30px 处（pr 25px + 库的 margin 内缩 5px）。
    // 由 右边缘 = k*(G - margin)/12 = 容器宽 - margin 反解得 G，
    // k=12 时即为 100%
    const gridWidthStyle = computed(() => {
      const k = gridCols.value
      if (k === 12) return { width: '100%' }
      return {
        width: `calc(${(1200 / k).toFixed(4)}% - ${((12 / k - 1) * GRID_MARGIN[0]).toFixed(4)}px)`,
      }
    })

    // 卡片尺寸改变后让窗口跟随：高度按行数、宽度按使用列数等比调整，
    // 保持窗口边界与卡片间距不变（顶部 15 / 底部 30，左侧 15 / 右侧 25）
    function scheduleWindowFit(layout) {
      const api = window.electronAPI
      if (!api?.setWindowSize || windowFit.suspended) return

      const rows = Math.max(...layout.map((item) => item.y + item.h))
      const k = Math.max(...layout.map((item) => item.x + item.w))
      if (!rows || !k) return

      const frameW = Math.max(0, (window.outerWidth || 0) - window.innerWidth)
      const frameH = Math.max(0, (window.outerHeight || 0) - window.innerHeight)
      const rowUnit = rowHeight.value + GRID_MARGIN[1]
      const height = Math.round(45 + rows * rowUnit + frameH)

      let width = null
      if (lastFittedCols && k !== lastFittedCols) {
        width = Math.round((window.innerWidth * k) / lastFittedCols + frameW)
      }
      lastFittedCols = k

      if (width === null && Math.abs(height - window.outerHeight) <= 2) return

      windowFit.target = { width, height }
      windowFit.active = true
      const seq = ++windowFit.seq
      if (windowFit.timer) clearTimeout(windowFit.timer)
      windowFit.timer = setTimeout(async () => {
        const target = windowFit.target || {}
        try {
          await api.setWindowSize({
            width: target.width ?? window.outerWidth,
            height: target.height,
          })
        } finally {
          setTimeout(() => {
            if (windowFit.seq !== seq) return
            windowFit.active = false
            windowFit.target = null
            applyScale()
          }, 160)
        }
      }, 80)
    }

    function onLayoutUpdated(newLayout) {
      // 折叠时卡片始终保留，窗口收窄过程中库可能重复 emit，忽略即可
      if (chatCollapsed.value) return

      const raw = newLayout.map(stripLayoutItem)
      const next = JSON.stringify(raw)
      // vue-grid-layout 在 layout prop 变化后会再次 emit layout-updated，
      // 内容未变化时必须忽略，否则与 :layout 绑定形成无限重排循环
      if (next === JSON.stringify(savedLayout.value)) return

      // 用调整前的 rowHeight 计算窗口目标，避免与 applyScale 的自动缩放互相抵消
      scheduleWindowFit(raw)
      savedLayout.value = raw
      localStorage.setItem(LAYOUT_KEY, next)
    }

    let resizeObserver = null
    let lastSize = { width: 0, height: 0 }

    // 卡片底边（库的几何公式）= (y+h) * (rowHeight + margin)，同一底行的卡片严格对齐。
    // 令其等于容器高度，则最底部卡片的下边缘恰好贴合容器底部（距窗口下边界 30px）
    const applyScale = () => {
      // 卡片尺寸调整 / 折叠窗口期间，rowHeight 先保持不变，由窗口跟随逻辑接管
      if (windowFit.active || windowFit.suspended) return
      const { width, height } = lastSize
      if (width <= 0 || height <= 0 || gridLayout.value.length === 0) return
      let rows = 0
      for (const item of gridLayout.value) {
        rows = Math.max(rows, item.y + item.h)
      }
      if (rows <= 0) return
      const next = height / rows - GRID_MARGIN[1]
      if (Number.isFinite(next) && next > 0 && Math.abs(next - rowHeight.value) > 0.01) {
        rowHeight.value = next
      }
    }

    watch(gridLayout, applyScale)

    const errorHandler = (event) => {
      // 浏览器良性警告：ResizeObserver 回调中触发布局变化时的标准提示，无需记录
      if (event.message && event.message.includes('ResizeObserver loop')) return
      logErrorToFile('JavaScript Error', event.message, event.error?.stack)
    }
    const rejectionHandler = (event) => {
      const errorMessage =
        event.reason instanceof Error ? event.reason.message : String(event.reason)
      const stackTrace = event.reason instanceof Error ? event.reason.stack : null
      logErrorToFile('Unhandled Promise Rejection', errorMessage, stackTrace)
    }

    onMounted(async () => {
      await initStorage()
      window.addEventListener('error', errorHandler)
      window.addEventListener('unhandledrejection', rejectionHandler)

      // 版本号与「更新」按钮显示在卡片头部，启动时统一检查一次更新
      updateStore.check()

      if (!historyStore.initialized && !historyStore.loading) {
        historyStore.loadHistory()
      }

      if (containerRef.value && typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            lastSize.width = entry.contentRect.width
            lastSize.height = entry.contentRect.height
          }
          applyScale()
        })
        resizeObserver.observe(containerRef.value)
      }

      if (window.electronAPI && window.electronAPI.on) {
        window.electronAPI.on('app-cleanup', () => {
          cancelOpenAIRequests()
          cancelAnthropicRequests()
        })
      }

      await nextTick()
      lastFittedCols = gridCols.value

      // 折叠状态是持久化的：页面刷新或应用重启后，把窗口收窄到上次折叠时的宽度
      if (chatCollapsed.value && collapsedWindowWidth.value) {
        await window.electronAPI?.setWindowCollapsed?.({
          collapsed: true,
          width: collapsedWindowWidth.value,
        })
      }
    })

    onUnmounted(() => {
      window.removeEventListener('error', errorHandler)
      window.removeEventListener('unhandledrejection', rejectionHandler)
      resizeObserver?.disconnect()
      cancelOpenAIRequests()
      cancelAnthropicRequests()

      if (window.electronAPI && window.electronAPI.removeAllListeners) {
        window.electronAPI.removeAllListeners('app-cleanup')
      }
    })

    return {
      gridLayout,
      onLayoutUpdated,
      chatCollapsed,
      toggleChatCollapsed,
      containerRef,
      setWorkspaceEl,
      setLeftPaneEl,
      leftPaneStyle,
      startPaneResize,
      rowHeight,
      GRID_MARGIN,
      dragIgnoreFrom: DRAG_IGNORE_FROM,
      gridWidthStyle,
    }
  },
}
</script>

<style>
/* 卡片内的左右分割线：拖动调整左右区宽度 */
.pane-divider {
  width: 12px;
  cursor: col-resize;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pane-divider::before {
  content: '';
  width: 1px;
  height: 100%;
  background: #b6bac2;
  transition:
    background 0.15s,
    width 0.15s;
}
.pane-divider:hover::before {
  width: 2px;
  background: rgba(59, 130, 246, 0.5);
}

/* 卡片边缘缩放把手：覆盖整条右/下边缘，悬停显示对应调整光标 */
.vue-grid-item .edge-handle {
  position: absolute;
  z-index: 1;
  pointer-events: auto;
}
.vue-grid-item .edge-handle.edge-right {
  top: 0;
  right: 0;
  width: 8px;
  height: 100%;
  cursor: e-resize;
}
.vue-grid-item .edge-handle.edge-bottom {
  left: 0;
  bottom: 0;
  width: 100%;
  height: 8px;
  cursor: s-resize;
}
/* 右下角区域交给库自带的 se-resize 把手 */
.vue-grid-item > .vue-resizable-handle {
  z-index: 2;
}
</style>
