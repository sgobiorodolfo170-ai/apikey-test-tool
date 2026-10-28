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
              class="max-w-[80%] rounded-card px-4 py-2 break-words"
              :class="
                msg.role === 'user' ? 'bg-accent text-white' : 'bg-surface-hover text-text-primary'
              "
            >
              <div v-if="msg.images && msg.images.length" class="flex flex-wrap gap-2 mb-2">
                <img
                  v-for="(image, imageIndex) in msg.images"
                  :key="imageIndex"
                  :src="image.dataUrl"
                  :alt="image.name || '图片'"
                  class="max-h-40 max-w-[200px] rounded border border-white/40 object-cover"
                />
              </div>
              <span class="whitespace-pre-wrap">{{ msg.content }}</span
              ><span v-if="msg.streaming" class="stream-cursor">▌</span>
            </div>
            <div v-if="msg.latency" class="text-xs text-text-muted mt-1">
              响应时间: {{ msg.latency }}ms
            </div>
          </div>
          <div v-if="loadingResponse" class="text-text-secondary text-sm">模型正在思考...</div>
        </div>
      </div>

      <div v-if="attachments.length" class="flex flex-wrap gap-2 mb-2">
        <div v-for="(attachment, index) in attachments" :key="index" class="relative">
          <img
            :src="attachment.dataUrl"
            :alt="attachment.name"
            class="h-16 w-16 rounded object-cover border border-border-light"
          />
          <button
            type="button"
            class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger text-white text-xs leading-none"
            title="移除图片"
            @click="removeAttachment(index)"
          >
            ×
          </button>
        </div>
      </div>

      <div class="flex gap-3 items-stretch mb-3">
        <button
          type="button"
          class="btn-ghost px-3 py-2"
          :title="
            supportsVision
              ? '添加图片（也可以直接粘贴截图）'
              : `当前模式（${currentModeLabel}）不支持图片输入`
          "
          @click="pickImage"
        >
          🖼
        </button>
        <input
          ref="fileInputRef"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          class="hidden"
          @change="onFilesPicked"
        />
        <textarea
          ref="chatInputRef"
          v-model="chatInput"
          placeholder="输入消息，按回车发送...（可粘贴图片）"
          rows="2"
          class="input resize-none chat-bg"
          @keydown.enter.exact="onEnterKey"
          @paste="handlePaste"
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
          :disabled="!selectedModel || (!chatInput.trim() && attachments.length === 0) || sending"
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
import { useToastStore } from '../stores/toastStore.js'
import { getApiAdapter, apiModeLabel, apiModeSupportsVision } from '../api/modes.js'
import { prepareImage } from '../utils/image.js'

const MAX_ATTACHMENTS = 4

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
    const attachments = ref([])
    const fileInputRef = ref(null)
    const toastStore = useToastStore()

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

    const supportsVision = computed(() => {
      const mode = testStore.currentResult?.config?.apiMode
      return mode ? apiModeSupportsVision(mode) : false
    })

    const currentModeLabel = computed(() => apiModeLabel(testStore.currentResult?.config?.apiMode))

    const pickImage = () => {
      // 明确告知原因，比禁用按钮更好排查
      if (!supportsVision.value) {
        toastStore.addToast(
          `当前模式（${currentModeLabel.value}）不支持图片输入，请切换到 OpenAI / Anthropic / Gemini 等对话模式`,
          'warning',
        )
        return
      }
      fileInputRef.value?.click()
    }

    const addFiles = async (files) => {
      for (const file of files) {
        if (attachments.value.length >= MAX_ATTACHMENTS) {
          toastStore.addToast(`最多添加 ${MAX_ATTACHMENTS} 张图片`, 'warning')
          break
        }
        try {
          attachments.value.push(await prepareImage(file))
        } catch (error) {
          toastStore.addToast(error.message, 'error')
        }
      }
    }

    const onFilesPicked = async (event) => {
      const files = Array.from(event.target.files || [])
      event.target.value = ''
      await addFiles(files)
    }

    const handlePaste = async (event) => {
      const items = Array.from(event.clipboardData?.items || [])
      const files = items
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean)

      if (files.length > 0) {
        event.preventDefault()
        await addFiles(files)
      }
    }

    const removeAttachment = (index) => {
      attachments.value.splice(index, 1)
    }

    const onEnterKey = (e) => {
      if (isComposing.value) return
      e.preventDefault()
      sendMessage()
    }

    const sendMessage = async () => {
      const text = chatInput.value.trim()
      const images = attachments.value.map((item) => ({ dataUrl: item.dataUrl, name: item.name }))

      if ((!text && images.length === 0) || !selectedModel.value || sending.value) return

      const config = testStore.currentResult?.config
      if (!config) {
        chatStore.addMessage({ role: 'assistant', content: '错误：缺少API配置信息' })
        return
      }

      // 图片生成 / 语音 / 决策类模式没有视觉输入能力，提前拦下，避免把 base64 发过去才报错
      if (images.length > 0 && !apiModeSupportsVision(config.apiMode)) {
        toastStore.addToast(
          `当前模式（${apiModeLabel(config.apiMode)}）不支持图片输入，请切换到 OpenAI / Anthropic / Gemini 等对话模式`,
          'error',
        )
        return
      }

      chatInput.value = ''
      if (chatInputRef.value) chatInputRef.value.value = ''
      attachments.value = []
      chatStore.addMessage({ role: 'user', content: text, ...(images.length ? { images } : {}) })

      const history = chatStore.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images?.length ? { images: m.images } : {}),
      }))
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
      attachments,
      fileInputRef,
      supportsVision,
      currentModeLabel,
      pickImage,
      onFilesPicked,
      handlePaste,
      removeAttachment,
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
