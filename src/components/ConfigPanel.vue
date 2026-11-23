<template>
  <div class="config-panel flex-1 min-h-0 w-full flex flex-col">
    <!-- 表单区：宽面板双栏展示，窄面板或矮卡片中自身滚动 -->
    <div class="min-h-0 flex-1 overflow-y-auto" @scroll="closeDropdowns">
      <div class="config-content">
        <div class="config-fields">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="label">提供商名称</label>
              <div ref="providerFieldRef" class="relative">
                <input
                  ref="providerInput"
                  v-model="config.provider"
                  type="text"
                  placeholder="选择或输入提供商"
                  class="input pr-8"
                  @change="onProviderChange"
                  @contextmenu.prevent="showContextMenu($event, 'provider')"
                />
                <button
                  type="button"
                  class="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center text-text-secondary hover:text-text-primary"
                  title="展开提供商列表"
                  @mousedown.stop.prevent="toggleProviderDropdown"
                >
                  ▾
                </button>
                <Teleport to="body">
                  <div
                    v-if="providerDropdown.visible"
                    class="fixed z-50 bg-surface-alt border border-border-light rounded-card shadow-elevated py-1 max-h-64 overflow-y-auto"
                    :style="{
                      left: providerDropdown.x + 'px',
                      top: providerDropdown.y + 'px',
                      width: providerDropdown.width + 'px',
                    }"
                  >
                    <div
                      v-if="savedProviders.length === 0"
                      class="px-3 py-2 text-text-muted text-sm"
                    >
                      暂无已保存的提供商
                    </div>
                    <button
                      v-for="p in savedProviders"
                      :key="p"
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-hover truncate"
                      @mousedown.stop.prevent
                      @click="selectProvider(p)"
                    >
                      {{ p }}
                    </button>
                  </div>
                </Teleport>
              </div>
            </div>

            <div>
              <label class="label">API 模式</label>
              <select v-model="config.apiMode" class="select">
                <option v-for="mode in apiModes" :key="mode.value" :value="mode.value">
                  {{ mode.label }}
                </option>
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
                class="input flex-1 min-w-0"
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
              <div class="relative flex-1 min-w-0">
                <input
                  ref="apiKeyInput"
                  v-model="config.apiKey"
                  :type="showApiKey ? 'text' : 'password'"
                  placeholder="sk-..."
                  autocomplete="off"
                  spellcheck="false"
                  class="input w-full pr-14"
                  @contextmenu.prevent="showContextMenu($event, 'apiKey')"
                  @input="onApiKeyInput"
                />
                <button
                  type="button"
                  class="absolute right-1 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                  :title="showApiKey ? '隐藏API Key' : '显示API Key'"
                  @click="showApiKey = !showApiKey"
                >
                  {{ showApiKey ? '隐藏' : '显示' }}
                </button>
              </div>
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
            <p
              v-if="needsApiKey && config.apiKey.trim() === ''"
              class="mt-1 text-xs text-text-muted"
            >
              Key 留空时按免鉴权请求发送（本地中转 / 无鉴权网关场景）
            </p>
          </div>
        </div>

        <section class="model-section min-w-0" aria-label="模型选择">
          <div class="flex items-center justify-between gap-2">
            <label class="label mb-0">可用模型 (自动获取)</label>
            <button
              class="btn-ghost px-2 py-1 text-xs flex-shrink-0"
              :disabled="testStore.isFetchingModels || !isValid"
              title="重新获取模型列表"
              @click="fetchModels"
            >
              重新获取
            </button>
          </div>
          <div class="model-toolbar">
            <input
              v-model="modelFilter"
              type="text"
              placeholder="搜索模型名..."
              class="input min-w-0 flex-1 text-xs py-1"
            />
            <button
              class="btn-ghost text-xs px-2 py-1 flex-shrink-0"
              :disabled="filteredModels.length === 0"
              title="选中当前筛选结果"
              @click="selectAllVisible"
            >
              全选
            </button>
            <button
              class="btn-ghost text-xs px-2 py-1 flex-shrink-0"
              :disabled="selectedModels.length === 0"
              title="清空已选"
              @click="clearSelection"
            >
              清空
            </button>
          </div>

          <div class="model-list bg-surface-alt border border-border-light rounded-input p-2">
            <div v-if="testStore.isFetchingModels" class="text-text-muted text-sm">
              正在获取模型列表...
            </div>
            <div v-else-if="testStore.modelsError" class="text-danger text-sm break-all">
              {{ testStore.modelsError }}
            </div>
            <div v-else-if="testStore.availableModels.length === 0" class="text-text-muted text-sm">
              输入API Key后自动获取
            </div>
            <div v-else-if="filteredModels.length === 0" class="text-text-muted text-sm">
              没有匹配「{{ modelFilter }}」的模型
            </div>
            <div v-else class="flex flex-wrap gap-1.5">
              <span
                v-for="model in filteredModels"
                :key="model"
                class="bg-blue-600 text-white text-xs rounded flex items-stretch overflow-hidden"
                :title="model"
              >
                <span
                  class="w-5 flex items-center justify-center border-r border-white/40 cursor-pointer hover:bg-blue-800 select-none"
                  :title="isSelected(model) ? '取消选择' : '选择该模型'"
                  @click.stop="toggleModelSelection(model)"
                >
                  {{ isSelected(model) ? '✓' : '' }}
                </span>
                <span class="px-2 py-1" :title="model">
                  {{ model.length > 20 ? model.substring(0, 20) + '...' : model }}
                </span>
                <span
                  class="px-1.5 py-1 border-l border-white/40 cursor-pointer hover:bg-blue-800"
                  title="复制模型名称"
                  @click.stop="copyModel(model)"
                >
                  📋
                </span>
                <span
                  class="px-1.5 py-1 border-l border-white/40 cursor-pointer hover:bg-blue-800"
                  title="仅测试该模型的连通性"
                  @click.stop="onTestSingleModel(model)"
                >
                  ⚡
                </span>
              </span>
            </div>
          </div>

          <div v-if="selectedModels.length > 0" class="model-selection">
            <span class="text-xs text-text-secondary">
              已选 {{ selectedModels.length }} 个模型
              <span v-if="modelFilter.trim()">（筛选出 {{ filteredModels.length }} 个）</span>
            </span>
            <button
              class="btn-primary text-xs px-3 py-1 flex-shrink-0"
              :disabled="testStore.isTesting"
              @click="onTestSelected"
            >
              测试选中
            </button>
          </div>
        </section>

        <div class="config-actions-results min-w-0">
          <div class="form-actions">
            <button
              :disabled="testStore.isTesting || !isValid"
              class="btn-primary flex-1 px-4 py-2.5"
              @click="onTest"
            >
              {{ testStore.isTesting ? '测试中...' : '开始测试' }}
            </button>
            <button
              :disabled="testStore.isTesting"
              class="btn-success flex-1 px-4 py-2.5"
              @click="onSave"
            >
              保存结果
            </button>
            <button
              type="button"
              class="btn-ghost px-3 py-2.5 text-sm flex-shrink-0"
              :disabled="!isValid"
              title="把当前 Base URL / API Key 保存为可切换的渠道"
              @click="saveAsChannel"
            >
              存为渠道
            </button>
          </div>

          <div class="result-section pt-3 border-t border-border flex flex-col">
            <div class="text-sm font-semibold text-text-primary mb-2 flex-shrink-0">测试结果</div>
            <ResultPanel />
          </div>
        </div>
      </div>
    </div>

    <!-- 右键菜单 -->
    <Teleport to="body">
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
    </Teleport>
  </div>
</template>

<script>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useTestStore } from '../stores/testStore.js'
import { useHistoryStore } from '../stores/historyStore.js'
import { useChannelStore } from '../stores/channelStore.js'
import ResultPanel from './ResultPanel.vue'
import { useToastStore } from '../stores/toastStore.js'
import { API_MODES, apiModeNeedsKey } from '../api/modes.js'
import { readProviders, readProviderSettings, readHistory } from '../utils/storage.js'

export default {
  name: 'ConfigPanel',
  components: { ResultPanel },
  setup() {
    const testStore = useTestStore()
    const historyStore = useHistoryStore()
    const channelStore = useChannelStore()
    const toastStore = useToastStore()

    const config = ref({
      provider: '',
      baseUrl: '',
      apiMode: 'openai',
      apiKey: '',
    })

    const savedProviders = ref([])
    const showApiKey = ref(false)
    const modelFilter = ref('')
    const selectedModels = ref([])
    const apiModes = API_MODES
    const providerFieldRef = ref(null)
    const providerDropdown = ref({ visible: false, x: 0, y: 0, width: 0 })
    const contextMenu = ref({
      visible: false,
      x: 0,
      y: 0,
      target: null,
    })

    const needsApiKey = computed(() => apiModeNeedsKey(config.value.apiMode))

    // 模型列表：搜索 + 批量勾选（中转站常有 200+ 模型，标签云直接刷屏）
    const filteredModels = computed(() => {
      const keyword = modelFilter.value.trim().toLowerCase()
      const list = testStore.availableModels
      if (!keyword) return list
      return list.filter((model) => model.toLowerCase().includes(keyword))
    })

    const isSelected = (model) => selectedModels.value.includes(model)

    const toggleModelSelection = (model) => {
      if (isSelected(model)) {
        selectedModels.value = selectedModels.value.filter((m) => m !== model)
      } else {
        selectedModels.value = [...selectedModels.value, model]
      }
    }

    const selectAllVisible = () => {
      selectedModels.value = [...new Set([...selectedModels.value, ...filteredModels.value])]
    }

    const clearSelection = () => {
      selectedModels.value = []
    }

    const onTestSelected = () => {
      if (selectedModels.value.length === 0 || testStore.isTesting) return
      testStore.testSelectedModels({ ...config.value }, [...selectedModels.value])
    }

    watch(
      () => testStore.availableModels,
      () => {
        selectedModels.value = []
      },
    )

    // 只要求 Base URL：Key 留空 = 免鉴权请求（本地中转未设访问 Key / 无鉴权网关场景）
    const isValid = computed(() => config.value.baseUrl.trim() !== '')

    let fetchTimer = null
    let providerConfigSeq = 0
    let providerKeyOwner = ''

    const loadSavedProviders = async () => {
      try {
        const [providers, history] = await Promise.all([readProviders(), readHistory()])
        const names = new Set(providers)
        for (const record of history) {
          if (record?.config?.provider) {
            names.add(record.config.provider)
          }
        }
        savedProviders.value = [...names]
      } catch (error) {
        console.error('加载提供商失败:', error)
        savedProviders.value = []
      }
    }

    // 选中提供商后自动加载其配置：
    // baseUrl/apiMode 优先取 providers.json 中保存的设置；
    // apiKey 从该提供商最近一条历史记录中补取（providers.json 不保存 apiKey）
    const applyProviderConfig = async (name) => {
      const requestId = ++providerConfigSeq
      const preserveCurrentKey = providerKeyOwner === name
      const keyAtRequest = config.value.apiKey

      try {
        const [settings, history] = await Promise.all([readProviderSettings(name), readHistory()])
        if (requestId !== providerConfigSeq || config.value.provider.trim() !== name) return

        const record = history.find((r) => r.config?.provider === name)
        const merged = {
          baseUrl: settings?.baseUrl || record?.config?.baseUrl,
          apiMode: settings?.apiMode || record?.config?.apiMode,
          apiKey: record?.config?.apiKey,
        }

        providerKeyOwner = name
        const keyChangedDuringLoad = config.value.apiKey !== keyAtRequest
        if (!merged.baseUrl && !merged.apiMode && !merged.apiKey) {
          if (!preserveCurrentKey && !keyChangedDuringLoad) config.value.apiKey = ''
          return
        }
        if (merged.baseUrl) config.value.baseUrl = merged.baseUrl
        if (merged.apiMode) config.value.apiMode = merged.apiMode

        if (!preserveCurrentKey && !keyChangedDuringLoad) {
          config.value.apiKey = merged.apiKey || ''
        } else if (
          preserveCurrentKey &&
          !keyChangedDuringLoad &&
          !config.value.apiKey.trim() &&
          merged.apiKey
        ) {
          config.value.apiKey = merged.apiKey
        }
      } catch (error) {
        if (requestId !== providerConfigSeq || config.value.provider.trim() !== name) return
        console.error('加载提供商配置失败:', error)
        if (providerKeyOwner !== name && config.value.apiKey === keyAtRequest) {
          config.value.apiKey = ''
        }
      }
    }

    const onApiKeyInput = () => {
      providerKeyOwner = config.value.provider.trim()
    }

    const openDropdown = (dropdown, el) => {
      if (!el) return
      const rect = el.getBoundingClientRect()
      dropdown.value = {
        visible: true,
        x: rect.left,
        y: rect.bottom + 4,
        width: rect.width,
      }
    }

    const toggleProviderDropdown = () => {
      if (providerDropdown.value.visible) {
        providerDropdown.value.visible = false
        return
      }
      openDropdown(providerDropdown, providerFieldRef.value)
    }

    const selectProvider = (name) => {
      config.value.provider = name
      providerDropdown.value.visible = false
      applyProviderConfig(name)
    }

    const closeDropdowns = () => {
      providerDropdown.value.visible = false
    }

    const onProviderChange = () => {
      const name = config.value.provider.trim()
      if (!name) return
      config.value.provider = name
      applyProviderConfig(name)
    }

    const onTest = () => {
      if (!isValid.value || testStore.isTesting) return
      testStore.testConnection({ ...config.value })
    }

    const onTestSingleModel = (model) => {
      const target = typeof model === 'string' ? model.trim() : ''
      if (!target || !isValid.value || testStore.isTesting) return
      testStore.testSingleModel({ ...config.value }, target)
    }

    const onSave = async () => {
      await testStore.saveResult({ ...config.value })
      await loadSavedProviders()
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
            config.value.provider = text.trim()
            onProviderChange()
            break
          case 'baseUrl':
            config.value.baseUrl = text
            break
          case 'apiKey':
            config.value.apiKey = text
            onApiKeyInput()
            break
        }
      } catch (error) {
        console.error('粘贴失败:', error)
      }
      hideContextMenu()
    }

    const handleMousedownOutside = () => {
      providerDropdown.value.visible = false
    }

    const handleClickOutside = () => {
      if (contextMenu.value.visible) {
        hideContextMenu()
      }
    }

    // 把 testStore 里待应用的配置填充到表单（保留用户已填写的其它字段）
    const applyCurrentConfig = () => {
      const newConfig = testStore.currentConfig
      if (!newConfig) return
      config.value = {
        provider: newConfig.provider ?? config.value.provider,
        baseUrl: newConfig.baseUrl ?? config.value.baseUrl,
        apiMode: newConfig.apiMode ?? config.value.apiMode,
        apiKey: newConfig.apiKey ?? config.value.apiKey,
      }
      providerKeyOwner = config.value.provider.trim()
      testStore.clearCurrentConfig()
    }

    watch(
      () => testStore.currentConfig,
      () => applyCurrentConfig(),
    )

    // 历史/渠道点「加载」时会递增该计数：
    // 配置面板可能刚刚才挂载（v-else），因此在 immediate 时也按最新配置填充，
    // 而不是只监听后续变化
    const appliedConfigRequest = ref(0)
    watch(
      () => historyStore.configTabRequest,
      (value) => {
        if (value === appliedConfigRequest.value) return
        appliedConfigRequest.value = value
        applyCurrentConfig()
      },
      { immediate: true },
    )

    watch(
      [() => config.value.baseUrl, () => config.value.apiKey, () => config.value.apiMode],
      () => {
        if (fetchTimer) clearTimeout(fetchTimer)
        if (config.value.baseUrl.trim() && isValid.value) {
          fetchTimer = setTimeout(() => fetchModels(), 500)
        }
      },
    )

    const saveAsChannel = async () => {
      if (!isValid.value) {
        toastStore.addToast('请先填写 Base URL（API Key 可留空，按免鉴权请求）', 'warning')
        return
      }
      const name = config.value.provider.trim() || config.value.baseUrl.trim()
      const baseUrl = config.value.baseUrl.trim()
      // 同名字 + 同地址视为同一条渠道，避免反复点击产生重复项
      const existing = channelStore.channels.find(
        (item) => item.name === name && item.baseUrl === baseUrl,
      )

      await channelStore.upsert({
        ...(existing ? { id: existing.id } : {}),
        name,
        baseUrl,
        apiMode: config.value.apiMode,
        apiKey: config.value.apiKey,
      })
    }

    onMounted(() => {
      if (!channelStore.initialized) channelStore.load()
      loadSavedProviders()
      document.addEventListener('mousedown', handleMousedownOutside)
      document.addEventListener('click', handleClickOutside)
      window.addEventListener('resize', closeDropdowns)
    })

    onUnmounted(() => {
      if (fetchTimer) clearTimeout(fetchTimer)
      document.removeEventListener('mousedown', handleMousedownOutside)
      document.removeEventListener('click', handleClickOutside)
      window.removeEventListener('resize', closeDropdowns)
    })

    return {
      testStore,
      config,
      isValid,
      needsApiKey,
      apiModes,
      savedProviders,
      showApiKey,
      modelFilter,
      selectedModels,
      filteredModels,
      isSelected,
      toggleModelSelection,
      selectAllVisible,
      clearSelection,
      onTestSelected,
      saveAsChannel,
      contextMenu,
      onProviderChange,
      onApiKeyInput,
      onTest,
      onTestSingleModel,
      onSave,
      fetchModels,
      copyText,
      copyModel,
      showContextMenu,
      handleCopy,
      handlePaste,
      closeDropdowns,
      toggleProviderDropdown,
      selectProvider,
      providerDropdown,
      providerFieldRef,
      loadSavedProviders,
    }
  },
}
</script>

<style scoped>
.config-panel {
  container-name: config-panel;
  container-type: inline-size;
}

.config-content {
  display: grid;
  grid-template-areas:
    'fields'
    'models'
    'actions';
  gap: 1rem;
  min-height: calc(100% - 1rem);
  margin-top: 1rem;
}

.config-fields {
  display: grid;
  grid-area: fields;
  align-content: start;
  gap: 0.75rem;
  min-width: 0;
}

.config-actions-results {
  display: grid;
  grid-area: actions;
  align-content: start;
  gap: 0.75rem;
  min-width: 0;
}

.form-actions {
  display: flex;
  gap: 0.75rem;
}

.model-section {
  display: flex;
  grid-area: models;
  flex-direction: column;
  min-height: 0;
}

.model-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0;
}

.model-list {
  min-height: 9rem;
  max-height: 15rem;
  overflow-y: auto;
}

.model-selection {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

@container config-panel (min-width: 580px) {
  .config-content {
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
    grid-template-areas:
      'fields models'
      'actions models';
    align-items: stretch;
  }

  .model-list {
    flex: 1;
    max-height: none;
  }
}

@container config-panel (max-width: 579px) {
  .model-selection > span {
    min-width: 0;
  }
}
</style>
