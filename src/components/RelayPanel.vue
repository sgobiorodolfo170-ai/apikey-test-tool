<template>
  <div class="card p-4 flex flex-col h-full w-full">
    <div class="relative flex items-center border-b border-border pb-2 flex-shrink-0">
      <div class="flex items-center gap-2">
        <h2 class="text-lg font-bold text-text-primary">中转站</h2>
        <span
          class="text-[11px] px-1.5 py-0.5 rounded-full leading-none"
          :class="
            relayStore.running ? 'bg-success/15 text-success' : 'bg-surface-hover text-text-muted'
          "
        >
          {{ relayStore.running ? '运行中' : '已停止' }}
        </span>
      </div>
      <button
        class="absolute left-1/2 -translate-x-1/2 text-xs px-3 py-1 rounded-card"
        :class="relayStore.running ? 'btn-danger' : 'btn-primary'"
        @click="toggleServer"
      >
        {{ relayStore.running ? '停止' : '启动' }}
      </button>
    </div>

    <!-- 本地端点 -->
    <div class="mt-2 flex items-center gap-2 flex-shrink-0">
      <code
        class="flex-1 min-w-0 text-xs bg-surface-alt rounded px-2 py-1 truncate text-text-primary"
      >
        {{ relayStore.baseUrl }}
      </code>
      <button class="btn-ghost text-xs px-2 py-1" title="复制端点地址" @click="copyBaseUrl">
        复制
      </button>
    </div>

    <div class="mt-1 flex items-center gap-2 text-[11px] text-text-muted flex-shrink-0">
      <label class="flex items-center gap-1">
        端口
        <input
          v-model.number="portInput"
          type="number"
          min="1024"
          max="65535"
          class="w-16 bg-surface-alt border border-border-light rounded px-1 py-0.5 text-center"
          :disabled="relayStore.running"
          @change="applyPort"
        />
      </label>
      <span>· {{ relayStore.enabledCount }} 个提供商</span>
      <span>· {{ relayStore.modelCount }} 个模型</span>
    </div>

    <!-- 添加提供商 -->
    <details class="mt-2 flex-shrink-0">
      <summary class="text-xs text-accent cursor-pointer select-none">+ 添加提供商</summary>
      <div class="mt-2 space-y-1.5 bg-surface-alt rounded p-2">
        <select v-model="form.presetId" class="select text-xs py-1" @change="applyPreset">
          <option value="">自定义</option>
          <option v-for="preset in RELAY_PRESETS" :key="preset.id" :value="preset.id">
            {{ preset.name }}
          </option>
        </select>
        <input v-model="form.name" class="input text-xs py-1" placeholder="名称" />
        <input v-model="form.baseUrl" class="input text-xs py-1" placeholder="Base URL（含 /v1）" />
        <input
          v-model="form.apiKey"
          type="password"
          class="input text-xs py-1"
          placeholder="API Key"
        />
        <input
          v-model="form.models"
          class="input text-xs py-1"
          placeholder="模型名，逗号分隔（可稍后拉取）"
        />
        <div class="flex gap-1">
          <label class="flex items-center gap-1 text-[11px] text-text-muted flex-1">
            并发
            <input
              v-model.number="form.maxConcurrency"
              type="number"
              min="1"
              max="64"
              class="w-12 bg-surface border border-border-light rounded px-1 py-0.5 text-center"
              title="同一上游同时进行的最大请求数"
            />
          </label>
          <label class="flex items-center gap-1 text-[11px] text-text-muted flex-1">
            每分钟
            <input
              v-model.number="form.rpmLimit"
              type="number"
              min="0"
              max="100000"
              class="w-14 bg-surface border border-border-light rounded px-1 py-0.5 text-center"
              title="每分钟最大请求数，0 表示不限"
            />
          </label>
        </div>
        <div v-if="presetNote" class="text-[11px] text-text-muted">{{ presetNote }}</div>
        <div class="flex gap-1">
          <button class="btn-primary text-xs px-2 py-1 flex-1" @click="submitProvider">添加</button>
          <button
            v-if="form.presetId && presetDocs"
            class="btn-ghost text-xs px-2 py-1"
            @click="openDocs"
          >
            文档
          </button>
        </div>
      </div>
    </details>

    <!-- 提供商列表 -->
    <div class="flex-1 min-h-0 overflow-y-auto mt-2 space-y-2">
      <div
        v-if="relayStore.providers.length === 0"
        class="text-xs text-text-muted text-center py-4"
      >
        还没有提供商。添加后启动服务，即可用 OpenAI SDK 指向本地端点。
      </div>

      <div
        v-for="provider in relayStore.providers"
        :key="provider.id"
        class="bg-surface-alt rounded p-2 border-l-2"
        :class="provider.enabled === false ? 'border-l-border opacity-60' : 'border-l-accent'"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="text-sm font-medium text-text-primary truncate">{{ provider.name }}</div>
            <div class="text-[11px] text-text-muted truncate" :title="provider.baseUrl">
              {{ provider.baseUrl }}
            </div>
          </div>
          <label class="flex items-center gap-1 text-[11px] text-text-muted flex-shrink-0">
            <input
              type="checkbox"
              :checked="provider.enabled !== false"
              @change="relayStore.toggleProvider(provider.id)"
            />
            启用
          </label>
        </div>

        <div class="flex items-center gap-1 mt-1.5">
          <span class="text-[11px] text-text-muted flex-1 truncate" :title="limitTitle(provider)">
            {{ (provider.models || []).length }} 模型 · {{ limitLabel(provider) }}
          </span>
          <button
            class="btn-ghost text-[10px] px-1 py-0.5 leading-none"
            title="上移（优先使用）"
            :disabled="provider === relayStore.providers[0]"
            @click="relayStore.moveProvider(provider.id, -1)"
          >
            ↑
          </button>
          <button
            class="btn-ghost text-[10px] px-1 py-0.5 leading-none"
            title="下移（故障时后备用）"
            :disabled="provider === relayStore.providers[relayStore.providers.length - 1]"
            @click="relayStore.moveProvider(provider.id, 1)"
          >
            ↓
          </button>
          <button
            class="btn-ghost text-[11px] px-1.5 py-0.5"
            :disabled="relayStore.busyProviderId === provider.id"
            title="从上游拉取模型列表"
            @click="relayStore.fetchModels(provider.id)"
          >
            {{ relayStore.busyProviderId === provider.id ? '拉取中' : '拉取模型' }}
          </button>
          <button class="btn-danger text-[11px] px-1.5 py-0.5" @click="removeProvider(provider)">
            删除
          </button>
        </div>
      </div>
    </div>

    <details class="mt-2 flex-shrink-0" @toggle="onLogsToggle">
      <summary class="text-[11px] text-accent cursor-pointer select-none">
        请求日志 ({{ relayStore.logs.length }})
      </summary>
      <div class="mt-1 max-h-28 overflow-y-auto bg-surface-alt rounded p-1.5 space-y-0.5">
        <div
          v-if="relayStore.logs.length === 0"
          class="text-[11px] text-text-muted text-center py-1"
        >
          暂无请求
        </div>
        <div
          v-for="log in relayStore.logs.slice(0, 30)"
          :key="log.id"
          class="flex items-center gap-1 text-[10px]"
        >
          <span class="text-text-muted flex-shrink-0">{{ shortTime(log.at) }}</span>
          <span class="text-text-primary truncate flex-1" :title="log.model">{{ log.model }}</span>
          <span class="text-text-muted truncate max-w-[64px]" :title="log.provider">
            {{ log.provider }}
          </span>
          <span
            class="flex-shrink-0"
            :class="log.error ? 'text-danger' : 'text-success'"
            :title="log.error || '成功'"
          >
            {{ log.status || 'ERR' }}
          </span>
          <span class="text-text-muted flex-shrink-0">{{ log.ms }}ms</span>
        </div>
      </div>
      <div class="flex gap-1 mt-1">
        <button class="btn-ghost text-[10px] px-1.5 py-0.5" @click="relayStore.loadLogs()">
          刷新
        </button>
        <button class="btn-ghost text-[10px] px-1.5 py-0.5" @click="relayStore.clearLogs()">
          清空
        </button>
      </div>
    </details>
  </div>
</template>

<script>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRelayStore } from '../stores/relayStore.js'
import { useToastStore } from '../stores/toastStore.js'
import { RELAY_PRESETS, findPreset } from '../data/relayPresets.js'

export default {
  name: 'RelayPanel',
  setup() {
    const relayStore = useRelayStore()
    const toastStore = useToastStore()

    const portInput = ref(relayStore.port)
    const form = reactive({
      presetId: '',
      name: '',
      baseUrl: '',
      apiKey: '',
      models: '',
      maxConcurrency: 4,
      rpmLimit: 0,
    })

    const presetNote = computed(() => findPreset(form.presetId)?.note || '')
    const presetDocs = computed(() => findPreset(form.presetId)?.docs || '')

    const applyPreset = () => {
      const preset = findPreset(form.presetId)
      if (!preset) return
      form.name = preset.name
      form.baseUrl = preset.baseUrl
      form.models = preset.models.join(', ')
    }

    const submitProvider = async () => {
      if (!form.name.trim() || !form.baseUrl.trim()) {
        toastStore.addToast('名称和 Base URL 必填', 'warning')
        return
      }
      await relayStore.addProvider({
        name: form.name,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        models: form.models
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        presetId: form.presetId || undefined,
      })
      form.name = ''
      form.baseUrl = ''
      form.apiKey = ''
      form.models = ''
      form.presetId = ''
      form.maxConcurrency = 4
      form.rpmLimit = 0
    }

    const removeProvider = async (provider) => {
      if (!confirm(`确定删除提供商「${provider.name}」吗？`)) return
      await relayStore.removeProvider(provider.id)
    }

    const toggleServer = async () => {
      if (relayStore.running) await relayStore.stop()
      else await relayStore.start()
    }

    const applyPort = () => {
      relayStore.setPort(portInput.value)
    }

    const copyBaseUrl = async () => {
      try {
        await navigator.clipboard.writeText(relayStore.baseUrl)
        toastStore.addToast('已复制端点地址', 'success')
      } catch {
        toastStore.addToast('复制失败，请手动选择', 'error')
      }
    }

    const limitLabel = (provider) => {
      const rpm = Number(provider.rpmLimit) > 0 ? `${provider.rpmLimit} RPM` : '不限速'
      const live = relayStore.running ? relayStore.status?.load?.[provider.id] : null
      const conc = Number(provider.maxConcurrency) > 0 ? provider.maxConcurrency : 4
      return live ? `${live.inflight}/${conc} 并发 · ${rpm}` : `${conc} 并发 · ${rpm}`
    }

    const limitTitle = (provider) => {
      const models = (provider.models || []).join(', ')
      return models ? `模型：${models}` : '尚未配置模型'
    }

    const shortTime = (iso) => {
      if (!iso) return '--:--:--'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '--:--:--'
      return date.toTimeString().slice(0, 8)
    }

    // 展开时才拉取，避免每次渲染都请求主进程
    const onLogsToggle = (event) => {
      if (event.target.open) relayStore.loadLogs()
    }

    const openDocs = () => {
      const url = presetDocs.value
      if (!url) return
      const api = window.electronAPI
      if (api?.openExternal) api.openExternal(url)
      else window.open(url, '_blank', 'noopener')
    }

    onMounted(async () => {
      if (!relayStore.initialized) await relayStore.load()
      portInput.value = relayStore.port
    })

    return {
      relayStore,
      portInput,
      form,
      presetNote,
      presetDocs,
      RELAY_PRESETS,
      applyPreset,
      submitProvider,
      removeProvider,
      toggleServer,
      applyPort,
      copyBaseUrl,
      openDocs,
      shortTime,
      onLogsToggle,
      limitLabel,
      limitTitle,
    }
  },
}
</script>

<style scoped></style>
