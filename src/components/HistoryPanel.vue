<template>
  <div class="card p-6 flex flex-col h-full w-full">
    <div class="flex items-center justify-between border-b border-border pb-2 mb-3 flex-shrink-0">
      <div class="flex gap-1">
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
      </div>
      <button
        v-if="activeTab === 'history' && historyStore.records.length > 0"
        class="btn-danger text-xs px-2 py-1"
        @click="handleClear"
      >
        清空
      </button>
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
          :class="record.result?.connected ? 'border-l-success' : 'border-l-danger'"
          @click="testStore.setCurrentResult(record.result)"
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
                :class="record.result?.connected ? 'text-success' : 'text-danger'"
              >
                {{ record.result?.connected ? '已连接' : '失败' }}
              </span>
              <span
                v-if="record.result?.summary"
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
                class="btn-ghost text-xs px-2 py-1"
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

    <ChannelPanel v-else />
  </div>
</template>

<script>
import { onMounted, ref } from 'vue'
import { useHistoryStore } from '../stores/historyStore.js'
import { useTestStore } from '../stores/testStore.js'
import { useChannelStore } from '../stores/channelStore.js'
import { useRelayStore } from '../stores/relayStore.js'
import { useToastStore } from '../stores/toastStore.js'
import { apiModeLabel } from '../api/modes.js'
import { SCORE_VERSION } from '../utils/report.js'
import ChannelPanel from './ChannelPanel.vue'

export default {
  name: 'HistoryPanel',
  components: { ChannelPanel },
  setup() {
    const historyStore = useHistoryStore()
    const testStore = useTestStore()
    const channelStore = useChannelStore()
    const relayStore = useRelayStore()
    const toastStore = useToastStore()
    const activeTab = ref('history')

    const handleClear = async () => {
      if (!confirm('确定要清空所有历史记录吗？')) return
      await historyStore.clearAll()
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
    })

    return {
      historyStore,
      testStore,
      channelStore,
      activeTab,
      handleClear,
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
