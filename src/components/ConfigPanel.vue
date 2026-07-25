<template>
  <div class="card p-6 flex flex-col h-full w-full">
    <h2 class="text-xl font-bold text-text-primary border-b border-border pb-2">配置</h2>

    <div class="grid grid-cols-2 gap-4 mt-4">
      <div>
        <label class="label">提供商名称</label>
        <div class="relative">
          <input
            ref="providerInput"
            v-model="config.provider"
            type="text"
            placeholder="选择或输入提供商"
            list="provider-list"
            class="input"
            @contextmenu.prevent="showContextMenu($event, 'provider')"
          />
          <datalist id="provider-list">
            <option v-for="p in savedProviders" :key="p" :value="p"></option>
          </datalist>
        </div>
      </div>

      <div>
        <label class="label">API 模式</label>
        <select
          v-model="config.apiMode"
          class="select"
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai-like">OpenAI-like</option>
        </select>
      </div>
    </div>

    <div>
      <label class="label">Base URL</label>
      <div class="flex gap-2">
        <input
          ref="baseUrlInput"
          v-model="config.baseUrl"
          type="text"
          placeholder="https://api.openai.com/v1"
          class="input flex-1"
          @contextmenu.prevent="showContextMenu($event, 'baseUrl')"
        />
        <button
          class="btn-ghost px-3 text-sm"
          title="清空Base URL"
          @click="config.baseUrl = ''"
        >
          清空
        </button>
        <button
          class="btn-ghost px-3 text-sm"
          title="复制Base URL"
          @click="copyText(config.baseUrl)"
        >
          复制
        </button>
      </div>
    </div>

    <div>
      <label class="label">API Key</label>
      <div class="flex gap-2">
        <input
          ref="apiKeyInput"
          v-model="config.apiKey"
          type="text"
          placeholder="sk-..."
          class="input flex-1"
          @contextmenu.prevent="showContextMenu($event, 'apiKey')"
        />
        <button
          class="btn-ghost px-3 text-sm"
          title="清空API Key"
          @click="config.apiKey = ''"
        >
          清空
        </button>
        <button
          class="btn-ghost px-3 text-sm"
          title="复制API Key"
          @click="copyText(config.apiKey)"
        >
          复制
        </button>
      </div>
    </div>

    <div>
      <label class="label">可用模型 (自动获取)</label>
      <div
        class="bg-surface-alt border border-border-light rounded-input px-3 py-2 min-h-[240px] max-h-[240px] overflow-y-auto"
      >
        <div v-if="testStore.availableModels.length === 0" class="text-text-muted text-sm">
          输入API Key后自动获取
        </div>
        <div v-else class="flex flex-wrap gap-2">
          <span
            v-for="model in testStore.availableModels"
            :key="model"
            class="bg-blue-600 text-white text-xs px-2 py-1 rounded cursor-pointer hover:bg-blue-700"
            :title="model"
            @click="copyModel(model)"
          >
            {{ model.length > 20 ? model.substring(0, 20) + '...' : model }}
          </span>
        </div>
      </div>
    </div>

    <div class="flex gap-3 pt-2">
      <button
        :disabled="testStore.isTesting || !isValid"
        class="btn-primary flex-1 py-3 px-4"
        @click="onTest"
      >
        {{ testStore.isTesting ? '测试中...' : '开始测试' }}
      </button>
      <button
        :disabled="!testStore.hasResult || testStore.isTesting"
        class="btn-success flex-1 py-3 px-4"
        @click="onSave"
      >
        保存结果
      </button>
    </div>

    <!-- 右键菜单 -->
    <div
      v-if="contextMenu.visible"
      class="context-menu fixed bg-surface-alt border border-border-light rounded-card shadow-elevated py-1 z-50"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
    >
      <button
        class="w-full px-4 py-2 text-left text-text-primary hover:bg-surface-hover text-sm transition-colors"
        @click="handleCopy"
      >
        复制
      </button>
      <button
        class="w-full px-4 py-2 text-left text-text-primary hover:bg-surface-hover text-sm transition-colors"
        @click="handlePaste"
      >
        粘贴
      </button>
    </div>
  </div>
</template>

<script>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useTestStore } from '../stores/testStore.js'
import { readProviders } from '../utils/storage.js'

export default {
  name: 'ConfigPanel',
  setup() {
    const testStore = useTestStore()

    const config = ref({
      provider: '',
      baseUrl: 'https://api.openai.com/v1',
      apiMode: 'openai',
      apiKey: '',
    })

    const savedProviders = ref([])
    const contextMenu = ref({
      visible: false,
      x: 0,
      y: 0,
      target: null,
    })

    const isValid = computed(() => {
      return config.value.baseUrl.trim() !== '' && config.value.apiKey.trim() !== ''
    })

    let fetchTimer = null

    const loadSavedProviders = async () => {
      try {
        savedProviders.value = await readProviders()
      } catch (error) {
        console.error('加载提供商失败:', error)
        savedProviders.value = []
      }
    }

    const onTest = () => {
      if (!isValid.value || testStore.isTesting) return
      testStore.testConnection({ ...config.value })
    }

    const onSave = () => {
      if (!testStore.hasResult) return
      testStore.saveResult({ ...config.value })
    }

    const fetchModels = () => {
      testStore.fetchModels({ ...config.value })
    }

    const copyText = async (text) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch (error) {
        console.error('复制失败:', error)
      }
    }

    const copyModel = async (model) => {
      try {
        await navigator.clipboard.writeText(model)
      } catch (error) {
        console.error('复制模型名失败:', error)
      }
    }

    const showContextMenu = (event, target) => {
      contextMenu.value = {
        visible: true,
        x: event.clientX,
        y: event.clientY,
        target: target,
      }
    }

    const hideContextMenu = () => {
      contextMenu.value.visible = false
    }

    const handleCopy = async () => {
      let textToCopy = ''
      switch (contextMenu.value.target) {
        case 'provider':
          textToCopy = config.value.provider
          break
        case 'baseUrl':
          textToCopy = config.value.baseUrl
          break
        case 'apiKey':
          textToCopy = config.value.apiKey
          break
      }

      if (textToCopy) {
        try {
          await navigator.clipboard.writeText(textToCopy)
        } catch (error) {
          console.error('复制失败:', error)
        }
      }
      hideContextMenu()
    }

    const handlePaste = async () => {
      try {
        const text = await navigator.clipboard.readText()
        switch (contextMenu.value.target) {
          case 'provider':
            config.value.provider = text
            break
          case 'baseUrl':
            config.value.baseUrl = text
            break
          case 'apiKey':
            config.value.apiKey = text
            break
        }
      } catch (error) {
        console.error('粘贴失败:', error)
      }
      hideContextMenu()
    }

    const handleClickOutside = () => {
      if (contextMenu.value.visible) {
        hideContextMenu()
      }
    }

    watch(
      () => testStore.currentConfig,
      (newConfig) => {
        if (newConfig) {
          config.value = {
            provider: newConfig.provider ?? config.value.provider,
            baseUrl: newConfig.baseUrl ?? config.value.baseUrl,
            apiMode: newConfig.apiMode ?? config.value.apiMode,
            apiKey: newConfig.apiKey ?? config.value.apiKey,
          }
        }
      },
    )

    watch(
      [() => config.value.baseUrl, () => config.value.apiKey],
      () => {
        if (fetchTimer) clearTimeout(fetchTimer)
        if (config.value.baseUrl.trim() && config.value.apiKey.trim()) {
          fetchTimer = setTimeout(() => fetchModels(), 500)
        }
      },
    )

    onMounted(() => {
      loadSavedProviders()
      document.addEventListener('click', handleClickOutside)
    })

    onUnmounted(() => {
      if (fetchTimer) clearTimeout(fetchTimer)
      document.removeEventListener('click', handleClickOutside)
    })

    return {
      testStore,
      config,
      isValid,
      savedProviders,
      contextMenu,
      onTest,
      onSave,
      copyText,
      copyModel,
      showContextMenu,
      handleCopy,
      handlePaste,
    }
  },
}
</script>

<style scoped>
</style>
