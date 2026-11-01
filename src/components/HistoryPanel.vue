<template>
  <div class="p-6 flex flex-col h-full w-full">
    <div
      class="flex items-center justify-between gap-2 border-b border-border pb-2 mb-3 flex-shrink-0"
    >
      <div class="flex flex-wrap gap-1 min-w-0">
        <button
          type="button"
          class="px-2.5 py-1 text-sm rounded-card transition-colors"
          :class="
            activeTab === 'config'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-hover'
          "
          @click="activeTab = 'config'"
        >
          配置
        </button>
        <button
          type="button"
          class="px-2.5 py-1 text-sm rounded-card transition-colors"
          :class="
            activeTab === 'history'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-hover'
          "
          @click="activeTab = 'history'"
        >
          历史 ({{ historyStore.records.length }})
        </button>
        <button
          type="button"
          class="px-2.5 py-1 text-sm rounded-card transition-colors"
          :class="
            activeTab === 'channels'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-hover'
          "
          @click="activeTab = 'channels'"
        >
          渠道 ({{ channelStore.count }})
        </button>
        <button
          type="button"
          class="px-2.5 py-1 text-sm rounded-card transition-colors"
          :class="
            activeTab === 'relay'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-hover'
          "
          @click="activeTab = 'relay'"
        >
          中转站 ({{ relayStore.providers.length }})
        </button>
        <button
          type="button"
          class="px-2.5 py-1 text-sm rounded-card transition-colors"
          :class="
            activeTab === 'stats'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-hover'
          "
          @click="activeTab = 'stats'"
        >
          调用监控 ({{ requestCount }})
        </button>
        <button
          type="button"
          class="px-2.5 py-1 text-sm rounded-card transition-colors"
          :class="
            activeTab === 'usage'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-hover'
          "
          @click="activeTab = 'usage'"
        >
          统计
        </button>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          class="w-8 h-8 flex items-center justify-center rounded-full text-text-secondary hover:bg-surface-hover hover:text-accent transition-colors flex-shrink-0"
          title="设置"
          aria-label="设置"
          @click="settingsOpen = true"
        >
          <svg
            viewBox="0 0 24 24"
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
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
        <slot name="actions"></slot>
      </div>
    </div>

    <template v-if="activeTab === 'history'">
      <div
        v-if="historyStore.records.length === 0"
        class="flex-1 flex items-center justify-center text-text-muted"
      >
        暂无历史记录
      </div>

      <div v-else class="flex-1 min-h-0 overflow-y-auto space-y-2">
        <div
          v-for="(record, index) in historyStore.records"
          :key="record.id"
          class="bg-surface-alt rounded p-3 hover:bg-surface-hover cursor-pointer transition-all duration-150 border-l-2"
          :class="
            record.result?.untested
              ? 'border-l-border'
              : record.result?.connected
                ? 'border-l-success'
                : 'border-l-danger'
          "
          @click="record.result?.untested ? null : testStore.setCurrentResult(record.result)"
        >
          <div class="flex justify-between items-start">
            <div class="flex-1">
              <div class="text-text-primary font-medium">
                {{ historyStore.records.length - index }}.
                {{ record.config?.provider || '未知提供商' }}
              </div>
              <div class="text-xs text-text-secondary mt-1">
                {{ formatTime(record.timestamp) }}
              </div>
            </div>

            <div class="flex items-center gap-2 ml-3 flex-shrink-0">
              <span
                class="text-sm whitespace-nowrap"
                :class="
                  record.result?.untested
                    ? 'text-text-muted'
                    : record.result?.connected
                      ? 'text-success'
                      : 'text-danger'
                "
              >
                {{
                  record.result?.untested ? '未测试' : record.result?.connected ? '已连接' : '失败'
                }}
              </span>
              <span
                v-if="record.result?.summary && !record.result?.untested"
                class="text-xs text-text-secondary whitespace-nowrap"
              >
                {{ record.result.summary.success }}个成功
              </span>
              <span
                v-if="record.checkup?.verdict"
                class="text-xs px-2 py-0.5 rounded-full whitespace-nowrap font-medium"
                :class="{
                  'bg-success/15 text-success': record.checkup.verdict.color === 'success',
                  'bg-warning/15 text-warning': record.checkup.verdict.color === 'warning',
                  'bg-danger/15 text-danger': record.checkup.verdict.color === 'danger',
                }"
                :title="`体检 ${record.checkup.verdict.score} 分 · ${record.checkup.verdict.level}（口径 v${record.checkup.verdict.scoreVersion || 1}）`"
              >
                体检 {{ record.checkup.verdict.score }}
              </span>
              <span
                v-if="scoreDelta(record, index) !== null"
                class="text-xs font-medium whitespace-nowrap"
                :class="
                  scoreDelta(record, index) > 0
                    ? 'text-success'
                    : scoreDelta(record, index) < 0
                      ? 'text-danger'
                      : 'text-text-muted'
                "
                :title="`与同渠道上一次体检相比（${previousScore(record, index)} 分）`"
              >
                {{ deltaText(scoreDelta(record, index)) }}
              </span>
              <span
                v-if="versionMismatch(record)"
                class="text-xs text-warning whitespace-nowrap"
                title="该记录使用旧评分口径，分数不可直接比较"
              >
                v{{ record.checkup.verdict.scoreVersion || 1 }}
              </span>
              <button class="btn-ghost text-xs px-2 py-1" @click.stop="handleReload(record)">
                重新测试
              </button>
              <button class="btn-danger text-xs px-2 py-1" @click.stop="handleDelete(record.id)">
                删除
              </button>
              <button
                class="text-xs px-2 py-1 rounded-btn bg-blue-400 text-white hover:bg-blue-500 transition-colors"
                title="把该提供商加入中转站（仅支持 OpenAI 兼容模式）"
                @click.stop="addToRelay(record)"
              >
                加入中转站
              </button>
              <button
                class="btn-primary text-xs px-2 py-1"
                @click.stop="historyStore.loadConfig(record)"
              >
                加载配置
              </button>
            </div>
          </div>

          <details v-if="record.checkup?.report" class="mt-2" @click.stop>
            <summary class="text-xs text-text-secondary cursor-pointer hover:text-text-primary">
              查看体检报告（{{ record.checkup.verdict?.level }} · {{ record.checkup.model }}）
            </summary>
            <pre
              class="mt-1 bg-surface rounded p-2 text-xs text-text-primary whitespace-pre-wrap break-all max-h-48 overflow-y-auto"
              >{{ record.checkup.report }}</pre
            >
          </details>
        </div>
      </div>
    </template>

    <ChannelPanel v-else-if="activeTab === 'channels'" />
    <RelayPanel v-else-if="activeTab === 'relay'" />
    <RelayStatsPanel v-else-if="activeTab === 'stats'" />
    <RelayUsagePanel v-else-if="activeTab === 'usage'" />
    <ConfigPanel v-else />
    <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<script>
import { computed, onMounted, ref } from 'vue'
import { useHistoryStore } from '../stores/historyStore.js'
import { useTestStore } from '../stores/testStore.js'
import { useChannelStore } from '../stores/channelStore.js'
import { useRelayStore } from '../stores/relayStore.js'
import { useToastStore } from '../stores/toastStore.js'
import { useUpdateStore } from '../stores/updateStore.js'
import { apiModeLabel } from '../api/modes.js'
import { SCORE_VERSION } from '../utils/report.js'
import ChannelPanel from './ChannelPanel.vue'
import RelayPanel from './RelayPanel.vue'
import RelayStatsPanel from './RelayStatsPanel.vue'
import RelayUsagePanel from './RelayUsagePanel.vue'
import ConfigPanel from './ConfigPanel.vue'
import SettingsDialog from './SettingsDialog.vue'

export default {
  name: 'HistoryPanel',
  components: {
    ChannelPanel,
    RelayPanel,
    RelayStatsPanel,
    RelayUsagePanel,
    ConfigPanel,
    SettingsDialog,
  },
  setup() {
    const historyStore = useHistoryStore()
    const testStore = useTestStore()
    const channelStore = useChannelStore()
    const relayStore = useRelayStore()
    const toastStore = useToastStore()
    const updateStore = useUpdateStore()
    const activeTab = ref('history')
    const settingsOpen = ref(false)
    const requestCount = computed(
      () => new Set(relayStore.logs.map((item) => item.requestId).filter(Boolean)).size,
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

    // 把历史里的提供商一键加入中转站（中转站只说 OpenAI 协议）
    const addToRelay = async (record) => {
      const config = record?.config || {}
      const mode = config.apiMode || 'openai'

      if (!['openai', 'openai-like'].includes(mode)) {
        toastStore.addToast(
          `中转站只支持 OpenAI 兼容模式，这条记录是 ${apiModeLabel(mode)}`,
          'error',
        )
        return
      }
      if (!config.baseUrl) {
        toastStore.addToast('该记录缺少 Base URL', 'error')
        return
      }

      // 没加载过就先读，避免覆盖已有的提供商列表
      if (!relayStore.initialized) await relayStore.load()

      const models = (record.result?.models || [])
        .filter((item) => item.status === 'success')
        .map((item) => item.model)

      await relayStore.addProvider({
        name: config.provider || config.baseUrl,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey || '',
        models,
      })
    }

    const handleDelete = async (id) => {
      if (!confirm('确定要删除该记录吗？')) return
      await historyStore.deleteRecord(id)
    }

    const handleReload = async (record) => {
      await historyStore.reloadRecord(record)
    }

    // 同一渠道（提供商 + Base URL）的上一次体检分数，用于展示分数变化
    const previousScore = (record, index) => {
      const list = historyStore.records
      for (let i = index + 1; i < list.length; i++) {
        const item = list[i]
        if (!item.checkup?.verdict) continue
        if (
          item.config?.provider === record.config?.provider &&
          item.config?.baseUrl === record.config?.baseUrl
        ) {
          return item.checkup.verdict.score
        }
      }
      return null
    }

    const scoreDelta = (record, index) => {
      if (!record.checkup?.verdict) return null
      const previous = previousScore(record, index)
      if (previous === null || previous === undefined) return null
      return record.checkup.verdict.score - previous
    }

    const deltaText = (delta) => {
      if (delta === null) return ''
      if (delta === 0) return '持平'
      return `${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}`
    }

    const versionMismatch = (record) => {
      const version = record.checkup?.verdict?.scoreVersion
      return version != null && version !== SCORE_VERSION
    }

    const formatTime = (timestamp) => {
      if (!timestamp) return ''
      const date = new Date(timestamp)
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    onMounted(() => {
      if (!historyStore.initialized && !historyStore.loading) {
        historyStore.loadHistory()
      }
      // 中转站与历史同卡，标签上的提供商数量需要先读一次配置
      if (!relayStore.initialized && !relayStore.loading) {
        relayStore.load()
      }
      relayStore.loadLogs()
    })

    return {
      historyStore,
      testStore,
      channelStore,
      relayStore,
      updateStore,
      openReleasePage,
      settingsOpen,
      activeTab,
      requestCount,
      handleDelete,
      handleReload,
      addToRelay,
      previousScore,
      scoreDelta,
      deltaText,
      versionMismatch,
      formatTime,
    }
  },
}
</script>
