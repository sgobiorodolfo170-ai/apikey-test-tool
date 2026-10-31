<template>
  <div class="flex-1 min-h-0 w-full overflow-y-auto flex flex-col" @scroll="closeDropdowns">
    <div class="flex items-center justify-between border-b border-border pb-2 flex-shrink-0">
      <div class="flex items-center gap-2">
        <span class="text-[14px] text-text-muted leading-none"
          >v{{ updateStore.currentVersion }}</span
        >
        <button
          v-if="updateStore.hasUpdate"
          type="button"
          class="text-[14px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent hover:bg-accent/25 leading-none"
          :title="`发现新版本 v${updateStore.latestVersion}，点击查看发布页`"
          @click="openReleasePage"
        >
          ↑ 更新
        </button>
      </div>
      <button
        type="button"
        class="btn-ghost text-xs px-2 py-1"
        :disabled="!isValid"
        title="把当前 Base URL / API Key 保存为可切换的渠道"
        @click="saveAsChannel"
      >
        存为渠道
      </button>
    </div>

    <div class="grid grid-cols-2 gap-4 mt-4">
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
              <div v-if="savedProviders.length === 0" class="px-3 py-2 text-text-muted text-sm">
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
          class="input flex-1"
          @contextmenu.prevent="showContextMenu($event, 'baseUrl')"
        />
        <button class="btn-ghost px-3 text-sm" title="清空Base URL" @click="config.baseUrl = ''">
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
        <div class="relative flex-1">
          <input
            ref="apiKeyInput"
            v-model="config.apiKey"
            :type="showApiKey ? 'text' : 'password'"
            placeholder="sk-..."
            autocomplete="off"
            spellcheck="false"
            class="input w-full pr-14"
            @contextmenu.prevent="showContextMenu($event, 'apiKey')"
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
        <button class="btn-ghost px-3 text-sm" title="清空API Key" @click="config.apiKey = ''">
          清空
        </button>
        <button class="btn-ghost px-3 text-sm" title="复制API Key" @click="copyText(config.apiKey)">
          复制
        </button>
      </div>
    </div>

    <div>
      <div class="flex items-center justify-between">
        <label class="label">可用模型 (自动获取)</label>
        <button
          class="btn-ghost px-2 py-1 text-xs"
          :disabled="testStore.isFetchingModels || !isValid"
          title="重新获取模型列表"
          @click="fetchModels"
        >
          重新获取
        </button>
      </div>
      <div class="flex items-center gap-2 mb-2">
        <input
          v-model="modelFilter"
          type="text"
          placeholder="搜索模型名..."
          class="input flex-1 text-xs py-1"
        />
        <button
          class="btn-ghost text-xs px-2 py-1"
          :disabled="filteredModels.length === 0"
          title="选中当前筛选结果"
          @click="selectAllVisible"
        >
          全选
        </button>
        <button
          class="btn-ghost text-xs px-2 py-1"
          :disabled="selectedModels.length === 0"
          title="清空已选"
          @click="clearSelection"
        >
          清空
        </button>
      </div>

      <div
        class="bg-surface-alt border border-border-light rounded-input px-3 py-2 min-h-[180px] max-h-[180px] overflow-y-auto"
      >
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
        <div v-else class="flex flex-wrap gap-2">
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
            <span
              class="px-2 py-1 cursor-pointer hover:bg-blue-700"
              title="点击填入指定模型测试框"
              @click="selectModel(model)"
            >
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

      <div v-if="selectedModels.length > 0" class="flex items-center justify-between mt-2">
        <span class="text-xs text-text-secondary">
          已选 {{ selectedModels.length }} 个模型
          <span v-if="modelFilter.trim()">（筛选出 {{ filteredModels.length }} 个）</span>
        </span>
        <button
          class="btn-primary text-xs px-3 py-1"
          :disabled="testStore.isTesting"
          @click="onTestSelected"
        >
          测试选中
        </button>
      </div>
    </div>

    <div>
      <label class="label">指定模型测试</label>
      <div class="flex gap-2">
        <div ref="modelFieldRef" class="relative flex-1">
          <input
            ref="modelToTestInput"
            v-model="modelToTest"
            type="text"
            placeholder="从检测出的模型中选择或手动输入"
            class="input w-full pr-8"
            @contextmenu.prevent="showContextMenu($event, 'modelToTest')"
          />
          <button
            type="button"
            class="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center text-text-secondary hover:text-text-primary"
            title="展开模型列表"
            @mousedown.stop.prevent="toggleModelDropdown"
          >
            ▾
          </button>
          <Teleport to="body">
            <div
              v-if="modelDropdown.visible"
              class="fixed z-50 bg-surface-alt border border-border-light rounded-card shadow-elevated py-1 max-h-64 overflow-y-auto"
              :style="{
                left: modelDropdown.x + 'px',
                top: modelDropdown.y + 'px',
                width: modelDropdown.width + 'px',
              }"
            >
              <div
                v-if="testStore.availableModels.length === 0"
                class="px-3 py-2 text-text-muted text-sm"
              >
                暂无检测到的模型
              </div>
              <button
                v-for="model in testStore.availableModels"
                :key="model"
                type="button"
                class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-hover truncate"
                @mousedown.stop.prevent
                @click="selectModel(model)"
              >
                {{ model }}
              </button>
            </div>
          </Teleport>
        </div>
        <button
          class="btn-primary px-3 text-sm whitespace-nowrap"
          :disabled="!modelToTest.trim() || testStore.isTesting || !isValid"
          title="仅测试该模型的连通性"
          @click="onTestSingleModel()"
        >
          测试该模型
        </button>
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

    <div class="mt-4 pt-3 border-t border-border flex-shrink-0 flex flex-col h-64">
      <div class="text-sm font-semibold text-text-primary mb-2 flex-shrink-0">测试结果</div>
      <ResultPanel />
    </div>
  </div>
</template>

<script>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useTestStore } from '../stores/testStore.js'
import { useChannelStore } from '../stores/channelStore.js'
import ResultPanel from './ResultPanel.vue'
import { useUpdateStore } from '../stores/updateStore.js'
import { useToastStore } from '../stores/toastStore.js'
import { API_MODES, apiModeNeedsKey } from '../api/modes.js'
import { readProviders, readProviderSettings, readHistory } from '../utils/storage.js'

export default {
  name: 'ConfigPanel',
  components: { ResultPanel },
  setup() {
    const testStore = useTestStore()
    const channelStore = useChannelStore()
    const updateStore = useUpdateStore()
    const toastStore = useToastStore()

    const config = ref({
      provider: '',
      baseUrl: '',
      apiMode: 'openai',
      apiKey: '',
    })

    const savedProviders = ref([])
    const modelToTest = ref('')
    const showApiKey = ref(false)
    const modelFilter = ref('')
    const selectedModels = ref([])
    const apiModes = API_MODES
    const providerFieldRef = ref(null)
    const modelFieldRef = ref(null)
    const providerDropdown = ref({ visible: false, x: 0, y: 0, width: 0 })
    const modelDropdown = ref({ visible: false, x: 0, y: 0, width: 0 })
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

    const isValid = computed(() => {
      if (config.value.baseUrl.trim() === '') return false
      if (!needsApiKey.value) return true
      return config.value.apiKey.trim() !== ''
    })

    let fetchTimer = null

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
      try {
        const settings = await readProviderSettings(name)
        const history = await readHistory()
        const record = history.find((r) => r.config?.provider === name)

        const merged = {
          baseUrl: settings?.baseUrl || record?.config?.baseUrl,
          apiMode: settings?.apiMode || record?.config?.apiMode,
          apiKey: record?.config?.apiKey,
        }

        if (!merged.baseUrl && !merged.apiMode && !merged.apiKey) return
        if (merged.baseUrl) config.value.baseUrl = merged.baseUrl
        if (merged.apiMode) config.value.apiMode = merged.apiMode
        // 只补空值：用户已经输入/粘贴新 Key 时，不被历史里的旧 Key 覆盖
        if (merged.apiKey && !config.value.apiKey.trim()) config.value.apiKey = merged.apiKey
      } catch (error) {
        console.error('加载提供商配置失败:', error)
      }
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

    const toggleModelDropdown = () => {
      if (modelDropdown.value.visible) {
        modelDropdown.value.visible = false
        return
      }
      openDropdown(modelDropdown, modelFieldRef.value)
    }

    const selectProvider = (name) => {
      config.value.provider = name
      providerDropdown.value.visible = false
      applyProviderConfig(name)
    }

    const closeDropdowns = () => {
      providerDropdown.value.visible = false
      modelDropdown.value.visible = false
    }

    const onProviderChange = () => {
      const name = config.value.provider.trim()
      if (!name) return
      applyProviderConfig(name)
    }

    const onTest = () => {
      if (!isValid.value || testStore.isTesting) return
      testStore.testConnection({ ...config.value })
    }

    const selectModel = (model) => {
      modelToTest.value = model
      modelDropdown.value.visible = false
    }

    const onTestSingleModel = (model) => {
      const target = typeof model === 'string' ? model.trim() : modelToTest.value.trim()
      if (!target || !isValid.value || testStore.isTesting) return
      if (typeof model === 'string') {
        modelToTest.value = target
      }
      testStore.testSingleModel({ ...config.value }, target)
    }

    const onSave = async () => {
      if (!testStore.hasResult) return
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
        case 'modelToTest':
          textToCopy = modelToTest.value
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
          case 'modelToTest':
            modelToTest.value = text
            break
        }
      } catch (error) {
        console.error('粘贴失败:', error)
      }
      hideContextMenu()
    }

    const handleMousedownOutside = () => {
      providerDropdown.value.visible = false
      modelDropdown.value.visible = false
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
        toastStore.addToast('请先填写 Base URL 与 API Key', 'warning')
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

    // 从「渠道」页签点「使用」时，把渠道配置填回表单
    watch(
      () => channelStore.pendingApply,
      (channel) => {
        if (!channel) return
        config.value = {
          provider: channel.name ?? config.value.provider,
          baseUrl: channel.baseUrl ?? config.value.baseUrl,
          apiMode: channel.apiMode ?? config.value.apiMode,
          apiKey: channel.apiKey ?? config.value.apiKey,
        }
        channelStore.consumeApply()
      },
    )

    // 用系统浏览器打开发布页（主进程会校验域名）
    const openReleasePage = () => {
      const url = updateStore.releaseUrl
      if (!url) return
      const bridge = typeof window !== 'undefined' ? window.electronAPI : null
      if (bridge?.openExternal) {
        bridge.openExternal(url)
      } else {
        window.open(url, '_blank', 'noopener')
      }
    }

    onMounted(() => {
      if (!channelStore.initialized) channelStore.load()
      updateStore.check()
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
      apiModes,
      savedProviders,
      modelToTest,
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
      updateStore,
      openReleasePage,
      contextMenu,
      onProviderChange,
      onTest,
      selectModel,
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
      toggleModelDropdown,
      selectProvider,
      providerDropdown,
      modelDropdown,
      providerFieldRef,
      modelFieldRef,
      loadSavedProviders,
    }
  },
}
</script>

<style scoped></style>
