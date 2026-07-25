<template>
  <div class="h-screen bg-canvas p-6 flex flex-col">
    <div class="max-w-[100rem] mx-auto flex-1 min-h-0 w-full">
      <grid-layout
        :layout="layout"
        :col-num="12"
        :row-height="60"
        :is-draggable="true"
        :is-resizable="true"
        :vertical-compact="true"
        :margin="[5, 5]"
        @layout-updated="onLayoutUpdated"
      >
        <grid-item
          v-for="item in layout"
          :key="item.i"
          :x="item.x"
          :y="item.y"
          :w="item.w"
          :h="item.h"
          :i="item.i"
          :min-w="3"
          :min-h="3"
        >
          <HistoryPanel v-if="item.i === 'history'" />
          <ConfigPanel v-if="item.i === 'config'" />
          <ResultPanel v-if="item.i === 'result'" />
          <ChatPanel v-if="item.i === 'chat'" />
        </grid-item>
      </grid-layout>
    </div>
    <ToastContainer />
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted } from 'vue'
import ConfigPanel from './components/ConfigPanel.vue'
import ResultPanel from './components/ResultPanel.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import ChatPanel from './components/ChatPanel.vue'
import ToastContainer from './components/Toast.vue'
import { useHistoryStore } from './stores/historyStore.js'
import { cancelAllRequests as cancelOpenAIRequests } from './api/openai.js'
import { cancelAllRequests as cancelAnthropicRequests } from './api/anthropic.js'
import { initStorage } from './utils/storage.js'

const LAYOUT_KEY = 'dashboard-layout'

const defaultLayout = [
  { i: 'history', x: 0, y: 0, w: 3, h: 10, minW: 2, minH: 4 },
  { i: 'config', x: 3, y: 0, w: 3, h: 10, minW: 2, minH: 4 },
  { i: 'result', x: 6, y: 0, w: 6, h: 6, minW: 3, minH: 3 },
  { i: 'chat', x: 6, y: 6, w: 6, h: 4, minW: 3, minH: 3 },
]

function loadLayout() {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY)
    if (saved) return JSON.parse(saved)
  } catch (_) {}
  return defaultLayout
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
    ChatPanel,
    ToastContainer,
  },
  setup() {
    const historyStore = useHistoryStore()
    const layout = ref(loadLayout())

    function onLayoutUpdated(newLayout) {
      layout.value = newLayout
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(newLayout))
    }

    const errorHandler = (event) => {
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

      if (!historyStore.initialized) {
        historyStore.loadHistory()
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
      cancelOpenAIRequests()
      cancelAnthropicRequests()

      if (window.electronAPI && window.electronAPI.removeAllListeners) {
        window.electronAPI.removeAllListeners('app-cleanup')
      }
    })

    return { layout, onLayoutUpdated }
  },
}
</script>
