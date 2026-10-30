<template>
  <!-- vue-grid-layout 卡片四周各有 margin(5px) 的内缩，因此左右/上 padding = 目标间距(20px) - margin；
       右侧目标 30px → pr 25px；底部 30px 由 rowHeight 反推公式直接控制（见 applyScale） -->
  <div
    class="h-screen bg-canvas flex flex-col overflow-hidden pt-[15px] pl-[15px] pr-[25px] pb-[30px]"
  >
    <div ref="containerRef" class="flex-1 min-h-0 w-full">
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
            :static="item.static"
            :drag-ignore-from="dragIgnoreFrom"
          >
            <div class="relative h-full w-full">
              <button
                class="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center rounded-full text-sm transition-all"
                :class="
                  isPinned(item.i)
                    ? 'bg-accent text-white shadow-elevated'
                    : 'bg-surface-hover text-text-secondary opacity-50 hover:opacity-100'
                "
                :title="
                  isPinned(item.i) ? '取消固定（恢复拖拽/调整大小）' : '固定卡片（锁定位置和尺寸）'
                "
                @mousedown.stop
                @click.stop="togglePin(item.i)"
              >
                📌
              </button>
              <HistoryPanel v-if="item.i === 'history'" />
              <ConfigPanel v-if="item.i === 'config'" />
              <ChatEvalPanel v-if="item.i === 'chateval'" />
              <ResultPanel v-if="item.i === 'result'" />
              <RelayPanel v-if="item.i === 'relay'" />
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import ConfigPanel from './components/ConfigPanel.vue'
import ResultPanel from './components/ResultPanel.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import ChatEvalPanel from './components/ChatEvalPanel.vue'
import RelayPanel from './components/RelayPanel.vue'
import ToastContainer from './components/Toast.vue'
import { useHistoryStore } from './stores/historyStore.js'
import { cancelAllRequests as cancelOpenAIRequests } from './api/openai.js'
import { cancelAllRequests as cancelAnthropicRequests } from './api/anthropic.js'
import { initStorage } from './utils/storage.js'

const LAYOUT_KEY = 'dashboard-layout'
const PINS_KEY = 'dashboard-pins'

const defaultLayout = [
  { i: 'history', x: 0, y: 0, w: 2, h: 10, minW: 2, minH: 4 },
  { i: 'config', x: 2, y: 0, w: 4, h: 10, minW: 3, minH: 4 },
  { i: 'chateval', x: 6, y: 0, w: 6, h: 6, minW: 3, minH: 4 },
  { i: 'relay', x: 6, y: 6, w: 6, h: 4, minW: 3, minH: 3 },
]

// 卡片间距；vue-grid-layout 的卡片定位含 margin 内缩：
// top = y*rowHeight + (y+1)*margin, left = x*colWidth + (x+1)*margin
const GRID_MARGIN = [5, 5]

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
  // 新面板（如 eval）未随旧布局保存时，追加默认位置
  const ids = new Set(layout.map((item) => item.i))
  for (const base of defaultLayout) {
    if (!ids.has(base.i)) {
      layout = [...layout, { ...base }]
    }
  }
  return layout
}

function loadPins() {
  try {
    const saved = localStorage.getItem(PINS_KEY)
    if (saved) {
      const arr = JSON.parse(saved)
      if (Array.isArray(arr)) return arr
    }
  } catch (e) {
    console.error('加载固定状态失败:', e)
  }
  return []
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
    ConfigPanel,
    ResultPanel,
    HistoryPanel,
    ChatEvalPanel,
    RelayPanel,
    ToastContainer,
  },
  setup() {
    const historyStore = useHistoryStore()
    const savedLayout = ref(loadLayout())
    const pinnedIds = ref(loadPins())
    const containerRef = ref(null)
    const rowHeight = ref(60)

    const gridLayout = computed(() =>
      savedLayout.value.map((item) => ({
        ...item,
        static: pinnedIds.value.includes(item.i),
      })),
    )

    const isPinned = (id) => pinnedIds.value.includes(id)

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

    const togglePin = (id) => {
      if (isPinned(id)) {
        pinnedIds.value = pinnedIds.value.filter((p) => p !== id)
      } else {
        pinnedIds.value = [...pinnedIds.value, id]
      }
      localStorage.setItem(PINS_KEY, JSON.stringify(pinnedIds.value))
    }

    function onLayoutUpdated(newLayout) {
      const raw = newLayout.map(stripLayoutItem)
      const next = JSON.stringify(raw)
      // vue-grid-layout 在 layout prop 变化后会再次 emit layout-updated，
      // 内容未变化时必须忽略，否则与 :layout 绑定形成无限重排循环
      if (next === JSON.stringify(savedLayout.value)) return
      savedLayout.value = raw
      localStorage.setItem(LAYOUT_KEY, next)
    }

    let resizeObserver = null
    let lastSize = { width: 0, height: 0 }

    // 卡片底边（库的几何公式）= (y+h) * (rowHeight + margin)，同一底行的卡片严格对齐。
    // 令其等于容器高度，则最底部卡片的下边缘恰好贴合容器底部（距窗口下边界 30px）
    const applyScale = () => {
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
      pinnedIds,
      containerRef,
      rowHeight,
      GRID_MARGIN,
      dragIgnoreFrom: DRAG_IGNORE_FROM,
      gridWidthStyle,
      isPinned,
      togglePin,
    }
  },
}
</script>

<style>
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
