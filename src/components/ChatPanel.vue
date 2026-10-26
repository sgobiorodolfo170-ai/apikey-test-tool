<template>
  <div class="card p-6 flex flex-col h-full w-full">
    <h2 class="text-xl font-bold text-text-primary border-b border-border pb-2 mb-4 flex-shrink-0">
      聊天测试
    </h2>

    <div class="bg-surface-alt rounded-card p-4 flex-1 flex flex-col min-h-0">
      <div class="rounded-card p-4 flex-1 min-h-0 overflow-y-auto mb-4 chat-bg">
        <div v-if="chatStore.messages.length === 0" class="text-text-muted text-center">
          输入消息开始聊天
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="(msg, index) in chatStore.messages"
            :key="index"
            class="flex flex-col"
            :class="msg.role === 'user' ? 'items-end' : 'items-start'"
          >
            <div
              class="max-w-[80%] rounded-card px-4 py-2 whitespace-pre-wrap break-words"
              :class="
                msg.role === 'user' ? 'bg-accent text-white' : 'bg-surface-hover text-text-primary'
              "
            >
              {{ msg.content }}<span v-if="msg.streaming" class="stream-cursor">▌</span>
            </div>
            <div v-if="msg.latency" class="text-xs text-text-muted mt-1">
              响应时间: {{ msg.latency }}ms
            </div>
          </div>
          <div v-if="loadingResponse" class="text-text-secondary text-sm">模型正在思考...</div>
        </div>
      </div>

      <div class="flex gap-3 items-stretch mb-3">
        <textarea
          ref="chatInputRef"
          v-model="chatInput"
          placeholder="输入消息，按回车发送..."
          rows="2"
          class="input resize-none chat-bg"
          @keydown.enter.exact="onEnterKey"
          @compositionstart="isComposing = true"
          @compositionend="isComposing = false"
        ></textarea>
        <button
          v-if="sending"
          class="btn-ghost px-4 py-2"
          title="停止生成（保留已输出内容）"
          @click="stopStreaming"
        >
          停止
        </button>
        <button
          :disabled="!selectedModel || !chatInput.trim() || sending"
          class="btn-primary px-4 py-2"
          @click="sendMessage"
        >
          {{ sending ? '生成中...' : '发送' }}
        </button>
      </div>

      <div class="flex items-center gap-3">
        <div class="relative flex-1">
          <select v-model="selectedModel" class="select chat-bg">
            <option value="">选择模型</option>
            <option v-for="model in successModels" :key="model.model" :value="model.model">
              {{ model.model }} ({{ model.latency }}ms)
            </option>
          </select>
          <div
            class="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-text-secondary"
          >
            ▼
          </div>
        </div>
        <div
          v-if="modelTestResult"
          class="text-sm whitespace-nowrap"
          :class="modelTestResult.success ? 'text-success' : 'text-danger'"
        >
          {{ modelTestResult.success ? '连接成功' : '连接失败' }}: {{ modelTestResult.latency }}ms
          <span v-if="!modelTestResult.success"> - {{ modelTestResult.error }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed, watch } from 'vue'
import { useTestStore } from '../stores/testStore.js'
import { useChatStore } from '../stores/chatStore.js'
import { getApiAdapter } from '../api/modes.js'

export default {
  name: 'ChatPanel',
  setup() {
    const testStore = useTestStore()
    const chatStore = useChatStore()

    const chatInput = ref('')
    const chatInputRef = ref(null)
    const isComposing = ref(false)
    const sending = ref(false)
    const loadingResponse = ref(false)
    const testingModel = ref(false)
    const modelTestResult = ref(null)
    const selectedModel = ref('')
    const activeController = ref(null)

    const successModels = computed(() => {
      if (!testStore.currentResult?.models) return []
      return testStore.currentResult.models.filter((m) => m.status === 'success')
    })

    watch(
      () => testStore.currentResult,
      (newResult, oldResult) => {
        if (!newResult) return
        const configChanged =
          newResult.config?.baseUrl !== oldResult?.config?.baseUrl ||
          newResult.config?.apiMode !== oldResult?.config?.apiMode ||
          newResult.config?.apiKey !== oldResult?.config?.apiKey
        if (configChanged) {
          chatStore.clearMessages()
          selectedModel.value = ''
          modelTestResult.value = null
        }
      },
    )

    watch(selectedModel, (newModel) => {
      if (newModel) {
        testCurrentModel()
      } else {
        modelTestResult.value = null
      }
    })

    const testCurrentModel = async () => {
      if (!selectedModel.value || !testStore.currentResult?.config) return

      testingModel.value = true
      modelTestResult.value = null

      const config = testStore.currentResult.config

      try {
        const adapter = getApiAdapter(config.apiMode)
        const result = await adapter.testModelLatency(config, selectedModel.value)

        modelTestResult.value = {
          success: result.status === 'success',
          latency: result.latency,
          error: result.error,
        }
      } catch (error) {
        modelTestResult.value = {
          success: false,
          latency: 0,
          error: error.response?.data?.error?.message || error.message,
        }
      }

      testingModel.value = false
    }

    const onEnterKey = (e) => {
      if (isComposing.value) return
      e.preventDefault()
      sendMessage()
    }

    const sendMessage = async () => {
      if (!chatInput.value.trim() || !selectedModel.value || sending.value) return

      const userMessage = chatInput.value.trim()
      chatInput.value = ''
      if (chatInputRef.value) chatInputRef.value.value = ''
      chatStore.addMessage({ role: 'user', content: userMessage })

      const config = testStore.currentResult?.config
      if (!config) {
        chatStore.addMessage({ role: 'assistant', content: '错误：缺少API配置信息' })
        return
      }

      const history = chatStore.messages.map((m) => ({ role: m.role, content: m.content }))
      const adapter = getApiAdapter(config.apiMode)
      const canStream = typeof adapter.chatStream === 'function'

      const controller = new AbortController()
      activeController.value = controller
      sending.value = true
      loadingResponse.value = true
      const startTime = Date.now()

      try {
        if (canStream) {
          // 先占位，再逐块追加，避免整段等待
          chatStore.addMessage({ role: 'assistant', content: '', streaming: true })
          const target = chatStore.messages[chatStore.messages.length - 1]
          let firstChunk = true

          const text = await adapter.chatStream(
            config,
            {
              model: selectedModel.value,
              messages: history,
              maxTokens: 500,
              timeout: 120000,
              signal: controller.signal,
            },
            (delta) => {
              if (firstChunk) {
                firstChunk = false
                loadingResponse.value = false
              }
              target.content += delta
            },
          )

          if (!target.content && text) target.content = text
          if (!target.content) target.content = '（模型未返回内容）'
          target.streaming = false
          target.latency = Date.now() - startTime
        } else {
          const assistantMessage = await adapter.chat(config, {
            model: selectedModel.value,
            messages: history,
            maxTokens: 500,
          })

          chatStore.addMessage({
            role: 'assistant',
            content: assistantMessage,
            latency: Date.now() - startTime,
          })
        }
      } catch (error) {
        const aborted =
          error?.name === 'CanceledError' ||
          error?.name === 'AbortError' ||
          error?.code === 'ERR_CANCELED'
        const last = chatStore.messages[chatStore.messages.length - 1]
        const reason = error?.response?.data?.error?.message || error?.message || '请求失败'

        // 已经输出了一部分：保留内容并标注，而不是整段丢弃
        if (last && last.role === 'assistant' && last.streaming) {
          last.streaming = false
          if (!last.content) {
            last.content = aborted ? '（已停止，未收到内容）' : `错误: ${reason}`
          } else {
            last.content += aborted ? '\n\n[已停止]' : `\n\n[中断: ${reason}]`
          }
          last.latency = Date.now() - startTime
        } else {
          chatStore.addMessage({
            role: 'assistant',
            content: aborted ? '（已停止）' : `错误: ${reason}`,
          })
        }
      } finally {
        sending.value = false
        loadingResponse.value = false
        activeController.value = null
      }
    }

    const stopStreaming = () => {
      activeController.value?.abort()
    }

    return {
      testStore,
      chatStore,
      chatInput,
      chatInputRef,
      isComposing,
      sending,
      loadingResponse,
      testingModel,
      modelTestResult,
      selectedModel,
      successModels,
      onEnterKey,
      sendMessage,
      stopStreaming,
    }
  },
}
</script>

<style scoped>
.chat-bg {
  background-color: #ffffff;
}
.stream-cursor {
  display: inline-block;
  margin-left: 2px;
  animation: stream-blink 1s steps(2, start) infinite;
}
@keyframes stream-blink {
  to {
    visibility: hidden;
  }
}
</style>
