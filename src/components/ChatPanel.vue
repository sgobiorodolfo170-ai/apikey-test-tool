<template>
  <div class="card p-6 flex flex-col h-full w-full">
    <h2 class="text-xl font-bold text-text-primary border-b border-border pb-2 mb-4 flex-shrink-0">聊天测试</h2>

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
              class="max-w-[80%] rounded-card px-4 py-2"
              :class="msg.role === 'user' ? 'bg-accent text-white' : 'bg-surface-hover text-text-primary'"
            >
              {{ msg.content }}
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
          :disabled="!selectedModel || !chatInput.trim() || sending"
          class="btn-primary px-4 py-2"
          @click="sendMessage"
        >
          {{ sending ? '发送中...' : '发送' }}
        </button>
      </div>

      <div class="flex items-center gap-3">
        <div class="relative flex-1">
          <select
            v-model="selectedModel"
            class="select chat-bg"
          >
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
import axios from 'axios'

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
      const startTime = Date.now()

      try {
        const baseUrl = config.baseUrl.replace(/\/$/, '')
        const isAnthropic = config.apiMode === 'anthropic'

        if (isAnthropic) {
          await axios.post(
            `${baseUrl}/messages`,
            {
              model: selectedModel.value,
              messages: [{ role: 'user', content: '测试连接' }],
              max_tokens: 10,
            },
            {
              headers: {
                'x-api-key': config.apiKey,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
              },
              timeout: 30000,
            },
          )
        } else {
          await axios.post(
            `${baseUrl}/chat/completions`,
            {
              model: selectedModel.value,
              messages: [{ role: 'user', content: '测试连接' }],
              max_tokens: 5,
            },
            {
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
              },
              timeout: 30000,
            },
          )
        }

        modelTestResult.value = {
          success: true,
          latency: Date.now() - startTime,
        }
      } catch (error) {
        modelTestResult.value = {
          success: false,
          latency: Date.now() - startTime,
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
      sending.value = true
      loadingResponse.value = true

      const config = testStore.currentResult?.config
      if (!config) {
        chatStore.addMessage({ role: 'assistant', content: '错误：缺少API配置信息' })
        sending.value = false
        loadingResponse.value = false
        return
      }

      try {
        const startTime = Date.now()
        const baseUrl = config.baseUrl.replace(/\/$/, '')
        const isAnthropic = config.apiMode === 'anthropic'

        let response
        if (isAnthropic) {
          response = await axios.post(
            `${baseUrl}/messages`,
            {
              model: selectedModel.value,
              messages: chatStore.messages.map((m) => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content,
              })),
              max_tokens: 500,
            },
            {
              headers: {
                'x-api-key': config.apiKey,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
              },
              timeout: 60000,
            },
          )
        } else {
          response = await axios.post(
            `${baseUrl}/chat/completions`,
            {
              model: selectedModel.value,
              messages: chatStore.messages.map((m) => ({
                role: m.role,
                content: m.content,
              })),
              max_tokens: 500,
            },
            {
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
              },
              timeout: 60000,
            },
          )
        }

        const latency = Date.now() - startTime
        let assistantMessage
        if (isAnthropic) {
          assistantMessage = response.data.content?.[0]?.text || '无响应'
        } else {
          assistantMessage = response.data.choices?.[0]?.message?.content || '无响应'
        }

        chatStore.addMessage({
          role: 'assistant',
          content: assistantMessage,
          latency,
        })
      } catch (error) {
        chatStore.addMessage({
          role: 'assistant',
          content: `错误: ${error.response?.data?.error?.message || error.message}`,
        })
      }

      sending.value = false
      loadingResponse.value = false
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
    }
  },
}
</script>

<style scoped>
.chat-bg {
  background-color: #ffffff;
}
</style>
