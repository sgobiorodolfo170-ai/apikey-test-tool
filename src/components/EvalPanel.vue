<template>
  <div class="flex flex-col h-full w-full min-h-0 overflow-y-auto">
    <div v-if="!config" class="flex-1 flex items-center justify-center text-text-muted text-sm">
      请先在「配置」面板填写并测试连接，即可对检测到的模型进行指纹匹配与能力测评
    </div>

    <div v-else class="flex flex-col min-h-0 flex-1">
      <!-- 模型选择 -->
      <div class="mb-3">
        <select v-model="selectedModel" class="select w-full">
          <option value="">选择要测评的模型</option>
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>

      <!-- 标签页 -->
      <div
        class="flex items-center justify-between gap-2 border-b border-border pb-2 mb-3 flex-shrink-0"
      >
        <div class="flex gap-1 flex-wrap">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            class="px-2.5 py-1 text-xs rounded-card transition-colors"
            :class="
              activeTab === tab.id
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-surface-hover'
            "
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>

        <button
          v-if="activeTab === 'checkup'"
          type="button"
          class="px-3 py-1.5 text-sm whitespace-nowrap"
          :class="evalStore.checkup.loading ? 'btn-ghost' : 'btn-primary'"
          @click="evalStore.checkup.loading ? stopCheckup() : runCheckup()"
        >
          {{ evalStore.checkup.loading ? '停止' : '开始体检' }}
        </button>
        <button
          v-else
          type="button"
          class="btn-primary px-3 py-1.5 text-sm whitespace-nowrap"
          :disabled="!selectedModel || activeState.loading"
          @click="runActive"
        >
          {{ actionLabel }}
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto space-y-3">
        <!-- 指纹匹配页 -->
        <div v-if="activeTab === 'fingerprint'">
          <div
            v-if="evalStore.fingerprint.error"
            class="bg-danger/10 border border-danger/30 rounded-input p-3 text-danger text-sm"
          >
            {{ evalStore.fingerprint.error }}
          </div>

          <div
            v-if="evalStore.fingerprint.result"
            class="bg-surface-alt rounded-input p-4 space-y-3"
          >
            <div class="flex items-center justify-between">
              <div>
                <span class="text-sm text-text-secondary">最佳匹配：</span>
                <span class="font-bold text-accent">
                  {{ evalStore.fingerprint.result.bestName || '未能识别' }}
                </span>
                <span
                  v-if="evalStore.fingerprint.result.bestPercent"
                  class="text-text-muted text-sm ml-1"
                >
                  ({{ evalStore.fingerprint.result.bestPercent }}%)
                </span>
              </div>
              <div class="text-xs text-text-muted">
                样本 {{ evalStore.fingerprint.result.answers.length }} 个
              </div>
            </div>

            <div
              v-for="(m, i) in evalStore.fingerprint.result.matches"
              :key="m.id"
              class="flex items-center gap-3"
            >
              <span class="w-40 text-sm text-text-primary truncate" :title="m.name">
                {{ m.name }}
              </span>
              <div class="flex-1 h-2 bg-surface-hover rounded overflow-hidden">
                <div
                  class="h-full"
                  :class="i === 0 ? 'bg-accent' : 'bg-blue-600'"
                  :style="{ width: m.percent + '%' }"
                ></div>
              </div>
              <span
                class="w-12 text-right text-sm font-bold"
                :class="i === 0 ? 'text-accent' : 'text-text-primary'"
              >
                {{ m.percent }}%
              </span>
              <span class="w-14 text-right text-xs text-text-muted">
                {{ m.matched }}/{{ m.applicable }}
              </span>
            </div>

            <details class="text-sm">
              <summary class="cursor-pointer text-text-secondary hover:text-text-primary">
                查看探测问答
              </summary>
              <div class="mt-2 space-y-2">
                <div
                  v-for="a in evalStore.fingerprint.result.answers"
                  :key="a.probe"
                  class="border-b border-border-light pb-2"
                >
                  <div class="text-text-secondary text-xs">{{ a.prompt }}</div>
                  <div class="text-text-primary text-xs break-all mt-1">
                    {{ a.error || a.answer || (a.cancelled ? '（已取消）' : '（无回复）') }}
                  </div>
                </div>
              </div>
            </details>
          </div>
        </div>

        <!-- 能力测评页 -->
        <div v-else-if="activeTab === 'capability'">
          <div
            v-if="evalStore.capability.error"
            class="bg-danger/10 border border-danger/30 rounded-input p-3 text-danger text-sm"
          >
            {{ evalStore.capability.error }}
          </div>

          <div v-if="evalStore.capability.result" class="space-y-3">
            <div
              v-if="evalStore.capability.result.incompleteCount > 0"
              class="bg-warning/10 border border-warning/30 rounded-input p-3 text-warning text-sm"
            >
              有
              {{ evalStore.capability.result.incompleteCount }}
              道题因限流/超时未完成，当前展示已完成题目的评分。
            </div>
            <div class="bg-surface-alt rounded-input p-4 flex items-center justify-between">
              <div>
                <span class="text-sm text-text-secondary">综合评分：</span>
                <span class="text-2xl font-bold text-accent">
                  {{ evalStore.capability.result.overall }}
                </span>
                <span class="text-text-secondary text-sm"> / 100</span>
              </div>
              <div class="text-right">
                <span
                  class="text-sm font-bold px-3 py-1 rounded-full"
                  :class="{
                    'bg-success/15 text-success':
                      evalStore.capability.result.grade.color === 'success',
                    'bg-warning/15 text-warning':
                      evalStore.capability.result.grade.color === 'warning',
                    'bg-danger/15 text-danger':
                      evalStore.capability.result.grade.color === 'danger',
                  }"
                >
                  {{ evalStore.capability.result.grade.label }}
                </span>
                <div class="text-xs text-text-muted mt-1">
                  答对 {{ evalStore.capability.result.correctCount }}/{{
                    evalStore.capability.result.total
                  }}
                  <span v-if="evalStore.capability.result.generatedCount">
                    （含 {{ evalStore.capability.result.generatedCount }} 道随机题）
                  </span>
                </div>
              </div>
            </div>

            <div
              v-for="dim in evalStore.capability.result.dimensions"
              :key="dim.dimension"
              class="bg-surface-alt rounded-input p-4 space-y-2"
            >
              <div class="flex items-center justify-between">
                <span class="text-sm font-medium text-text-primary">
                  {{ dim.name }}
                  <span class="text-text-muted text-xs">({{ dim.correct }}/{{ dim.total }})</span>
                </span>
                <span
                  class="text-sm font-bold"
                  :class="dim.score >= 60 ? 'text-success' : 'text-danger'"
                >
                  {{ dim.score }}
                </span>
              </div>
              <div class="h-2 bg-surface-hover rounded overflow-hidden">
                <div
                  class="h-full"
                  :class="dim.score >= 60 ? 'bg-success' : 'bg-danger'"
                  :style="{ width: dim.score + '%' }"
                ></div>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="q in dim.questions"
                  :key="q.id"
                  class="text-xs px-2 py-0.5 rounded-full"
                  :class="
                    q.correct
                      ? 'bg-success/15 text-success'
                      : q.skipped
                        ? 'bg-surface-hover text-text-muted'
                        : 'bg-danger/15 text-danger'
                  "
                  :title="questionTip(q)"
                >
                  {{ q.title }} {{ q.correct ? '✓' : q.skipped ? '–' : '✗' }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 稳定性页 -->
        <div v-else-if="activeTab === 'stability'">
          <div
            v-if="evalStore.stability.error"
            class="bg-danger/10 border border-danger/30 rounded-input p-3 text-danger text-sm"
          >
            {{ evalStore.stability.error }}
          </div>

          <div v-if="evalStore.stability.result" class="space-y-3">
            <div class="bg-surface-alt rounded-input p-4 flex items-center justify-between">
              <div>
                <span class="text-sm text-text-secondary">成功率：</span>
                <span
                  class="text-2xl font-bold"
                  :class="
                    evalStore.stability.result.successRate >= 80 ? 'text-success' : 'text-danger'
                  "
                >
                  {{ evalStore.stability.result.successRate }}%
                </span>
              </div>
              <div class="text-right text-xs text-text-muted">
                {{ evalStore.stability.result.success }}/{{
                  evalStore.stability.result.rounds
                }}
                成功 · 限流 {{ evalStore.stability.result.rateLimited }} 次
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="bg-surface-alt rounded-input p-3">
                <div class="text-xs text-text-muted">P50</div>
                <div class="text-lg font-bold text-text-primary">
                  {{ evalStore.stability.result.p50 }}ms
                </div>
              </div>
              <div class="bg-surface-alt rounded-input p-3">
                <div class="text-xs text-text-muted">P95</div>
                <div class="text-lg font-bold text-text-primary">
                  {{ evalStore.stability.result.p95 }}ms
                </div>
              </div>
              <div class="bg-surface-alt rounded-input p-3">
                <div class="text-xs text-text-muted">平均</div>
                <div class="text-lg font-bold text-text-primary">
                  {{ evalStore.stability.result.avg }}ms
                </div>
              </div>
              <div class="bg-surface-alt rounded-input p-3">
                <div class="text-xs text-text-muted">最慢</div>
                <div class="text-lg font-bold text-text-primary">
                  {{ evalStore.stability.result.max }}ms
                </div>
              </div>
            </div>

            <div
              v-if="evalStore.stability.result.errors.length"
              class="bg-danger/10 border border-danger/30 rounded-input p-3 text-danger text-xs space-y-1"
            >
              <div v-for="(err, i) in evalStore.stability.result.errors" :key="i">{{ err }}</div>
            </div>
          </div>
        </div>

        <!-- 一致性页 -->
        <div v-else-if="activeTab === 'consistency'">
          <div
            v-if="evalStore.consistency.error"
            class="bg-danger/10 border border-danger/30 rounded-input p-3 text-danger text-sm"
          >
            {{ evalStore.consistency.error }}
          </div>

          <div v-if="evalStore.consistency.result" class="space-y-3">
            <div class="bg-surface-alt rounded-input p-4">
              <div class="flex items-center justify-between">
                <div class="text-sm text-text-secondary">
                  一致率
                  <span class="text-xl font-bold text-accent ml-1">
                    {{ evalStore.consistency.result.agreement }}%
                  </span>
                  <span class="ml-3">正确率</span>
                  <span class="text-xl font-bold text-accent ml-1">
                    {{ evalStore.consistency.result.accuracy }}%
                  </span>
                </div>
                <span
                  class="text-xs font-bold px-2 py-1 rounded-full"
                  :class="{
                    'bg-success/15 text-success':
                      evalStore.consistency.result.verdict.color === 'success',
                    'bg-warning/15 text-warning':
                      evalStore.consistency.result.verdict.color === 'warning',
                    'bg-danger/15 text-danger':
                      evalStore.consistency.result.verdict.color === 'danger',
                  }"
                >
                  {{ evalStore.consistency.result.verdict.label }}
                </span>
              </div>
              <div class="text-xs text-text-muted mt-2">
                {{ evalStore.consistency.result.verdict.note }} · 每題采样
                {{ evalStore.consistency.result.rounds }} 次
              </div>
            </div>

            <div
              v-for="probe in evalStore.consistency.result.probes"
              :key="probe.id"
              class="bg-surface-alt rounded-input p-3 space-y-2"
            >
              <div class="flex items-center justify-between text-xs">
                <span class="text-text-primary font-medium">期望 {{ probe.expected }}</span>
                <span class="text-text-muted">
                  一致 {{ probe.agreement }}% · 正确 {{ probe.accuracy }}%
                  <span v-if="probe.failed"> · 失败 {{ probe.failed }}</span>
                </span>
              </div>
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="(answer, i) in probe.answers"
                  :key="i"
                  class="text-xs px-1.5 py-0.5 rounded"
                  :class="
                    answer === probe.expected
                      ? 'bg-success/15 text-success'
                      : answer === 'error'
                        ? 'bg-danger/15 text-danger'
                        : 'bg-warning/15 text-warning'
                  "
                >
                  {{ answer }}
                </span>
              </div>
            </div>
          </div>

          <div
            v-if="!evalStore.consistency.loading && !evalStore.consistency.result"
            class="text-text-muted text-sm"
          >
            同一问题重复采样，区分「前后矛盾」（疑似多模型轮换）与「稳定答错」（疑似降级成小模型）。
          </div>
        </div>

        <!-- 渠道体检页 -->
        <div v-else>
          <div
            v-if="evalStore.checkup.error"
            class="bg-danger/10 border border-danger/30 rounded-input p-3 text-danger text-sm"
          >
            {{ evalStore.checkup.error }}
          </div>

          <div v-if="evalStore.checkup.loading" class="bg-surface-alt rounded-input p-4 space-y-3">
            <div class="flex items-center justify-between text-sm">
              <span class="text-text-primary">{{ evalStore.checkup.progress.label }}</span>
              <span class="text-text-muted">
                {{
                  Math.min(evalStore.checkup.progress.index + 1, evalStore.checkup.progress.total)
                }}
                / {{ evalStore.checkup.progress.total }}
              </span>
            </div>
            <div class="h-2 bg-surface-hover rounded overflow-hidden">
              <div
                class="h-full bg-accent transition-all"
                :style="{
                  width:
                    Math.round(
                      (evalStore.checkup.progress.index / evalStore.checkup.progress.total) * 100,
                    ) + '%',
                }"
              ></div>
            </div>
            <div class="text-xs text-text-muted">
              体检会依次执行连通、模型列表、抽样测速、指纹、能力测评与稳定性采样，约需数分钟。
            </div>
          </div>

          <div v-if="evalStore.checkup.result" class="space-y-3">
            <div class="bg-surface-alt rounded-input p-4">
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-sm text-text-secondary">综合评分：</span>
                  <span class="text-2xl font-bold text-accent">
                    {{ evalStore.checkup.result.verdict.score }}
                  </span>
                  <span class="text-text-secondary text-sm"> / 100</span>
                </div>
                <span
                  class="text-sm font-bold px-3 py-1 rounded-full"
                  :class="{
                    'bg-success/15 text-success':
                      evalStore.checkup.result.verdict.color === 'success',
                    'bg-warning/15 text-warning':
                      evalStore.checkup.result.verdict.color === 'warning',
                    'bg-danger/15 text-danger': evalStore.checkup.result.verdict.color === 'danger',
                  }"
                >
                  {{ evalStore.checkup.result.verdict.level }}
                </span>
              </div>

              <ul class="mt-3 space-y-1">
                <li
                  v-for="(note, i) in evalStore.checkup.result.verdict.notes"
                  :key="i"
                  class="text-sm text-text-primary flex gap-1.5"
                >
                  <span class="text-text-muted">·</span>
                  <span>{{ note }}</span>
                </li>
              </ul>
            </div>

            <div class="grid grid-cols-3 gap-2 text-center">
              <div class="bg-surface-alt rounded-input p-2">
                <div class="text-xs text-text-muted">模型数</div>
                <div class="text-base font-bold text-text-primary">
                  {{ evalStore.checkup.result.models.total }}
                </div>
              </div>
              <div class="bg-surface-alt rounded-input p-2">
                <div class="text-xs text-text-muted">能力分</div>
                <div class="text-base font-bold text-text-primary">
                  {{ evalStore.checkup.result.capability?.overall ?? '-' }}
                </div>
              </div>
              <div class="bg-surface-alt rounded-input p-2">
                <div class="text-xs text-text-muted">稳定性</div>
                <div class="text-base font-bold text-text-primary">
                  {{ evalStore.checkup.result.stability?.successRate ?? '-' }}%
                </div>
              </div>
            </div>

            <div class="flex gap-2">
              <button class="btn-ghost text-xs px-2 py-1" @click="copyReport">复制报告</button>
              <button class="btn-ghost text-xs px-2 py-1" @click="saveReport">保存为 .md</button>
              <span class="text-xs text-text-muted self-center">
                耗时 {{ Math.round((evalStore.checkup.result.durationMs || 0) / 1000) }}s
              </span>
            </div>

            <pre
              class="bg-surface-alt rounded-input p-3 text-xs text-text-primary whitespace-pre-wrap break-all max-h-72 overflow-y-auto"
              >{{ evalStore.checkup.result.report }}</pre
            >
          </div>

          <div
            v-if="!evalStore.checkup.loading && !evalStore.checkup.result"
            class="text-text-muted text-sm"
          >
            一键跑完连通、模型、速度、指纹、能力与稳定性，生成可分享的渠道体检报告。
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed } from 'vue'
import { useTestStore } from '../stores/testStore.js'
import { useEvalStore } from '../stores/evalStore.js'
import { useToastStore } from '../stores/toastStore.js'
import { cancelAllRequests } from '../api/utils.js'

const TABS = [
  { id: 'fingerprint', label: '指纹' },
  { id: 'capability', label: '能力' },
  { id: 'stability', label: '稳定' },
  { id: 'consistency', label: '一致' },
  { id: 'checkup', label: '体检' },
]

export default {
  name: 'EvalPanel',
  setup() {
    const testStore = useTestStore()
    const evalStore = useEvalStore()
    const toastStore = useToastStore()

    const selectedModel = ref('')
    const activeTab = ref('fingerprint')
    const tabs = TABS

    const config = computed(() => testStore.currentResult?.config || null)

    const modelOptions = computed(() => {
      if (testStore.availableModels && testStore.availableModels.length > 0) {
        return testStore.availableModels
      }
      const ids = (testStore.currentResult?.models || []).map((m) => m.model).filter(Boolean)
      return [...new Set(ids)]
    })

    const activeState = computed(() => evalStore[activeTab.value] || { loading: false })

    const actionLabel = computed(() => {
      if (activeTab.value === 'fingerprint') {
        return evalStore.fingerprint.loading
          ? `匹配中... ${evalStore.fingerprint.progress.done}/${evalStore.fingerprint.progress.total}`
          : '开始指纹匹配'
      }
      if (activeTab.value === 'capability') {
        return evalStore.capability.loading
          ? `测评中... ${evalStore.capability.progress.done}/${evalStore.capability.progress.total}`
          : '开始能力测评'
      }
      if (activeTab.value === 'consistency') {
        return evalStore.consistency.loading
          ? `探测中... ${evalStore.consistency.progress.done}/${evalStore.consistency.progress.total}`
          : '开始一致性探测'
      }
      return evalStore.stability.loading
        ? `采样中... ${evalStore.stability.progress.done}/${evalStore.stability.progress.total}`
        : '开始稳定性测试'
    })

    const runActive = () => {
      if (!config.value || !selectedModel.value) return
      if (activeTab.value === 'fingerprint') {
        evalStore.runFingerprint(config.value, selectedModel.value)
      } else if (activeTab.value === 'capability') {
        evalStore.runCapability(config.value, selectedModel.value)
      } else if (activeTab.value === 'stability') {
        evalStore.runStability(config.value, selectedModel.value, 5)
      } else {
        evalStore.runConsistency(config.value, selectedModel.value, 4)
      }
    }

    // 代码题把本地执行明细放进 tooltip，便于排查“为什么判错”
    const questionTip = (q) => {
      if (q.execution) {
        const head = q.execution.executed
          ? q.execution.passed
            ? '本地执行通过'
            : '本地执行未通过'
          : `未执行：${q.execution.reason || '环境不支持'}`
        const detail = (q.execution.results || [])
          .map(
            (r) =>
              `${JSON.stringify(r.input)} → ${JSON.stringify(r.actual)}（期望 ${JSON.stringify(r.expected)}）`,
          )
          .join('\n')
        return detail ? `${head}\n${detail}` : head
      }
      return q.answer || q.error || ''
    }

    const runCheckup = () => {
      if (!config.value) return
      evalStore.runFullCheckup(config.value, selectedModel.value)
    }

    const stopCheckup = () => {
      cancelAllRequests()
      toastStore.addToast('已请求停止，正在收尾', 'warning')
    }

    const copyReport = async () => {
      const report = evalStore.checkup.result?.report
      if (!report) return
      try {
        await navigator.clipboard.writeText(report)
        toastStore.addToast('报告已复制到剪贴板', 'success')
      } catch {
        toastStore.addToast('复制失败，请手动选择文本', 'error')
      }
    }

    const saveReport = async () => {
      const report = evalStore.checkup.result?.report
      if (!report) return
      const api = window.electronAPI
      if (!api?.writeFile || !api?.getUserDataPath) {
        toastStore.addToast('仅桌面端支持保存文件', 'warning')
        return
      }
      try {
        const dir = await api.getUserDataPath()
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const path = `${dir}/exports/checkup-${stamp}.md`
        const result = await api.writeFile(path, report)
        if (result?.success) {
          toastStore.addToast(`报告已保存：${path}`, 'success')
        } else {
          toastStore.addToast('保存失败：' + (result?.error || '未知错误'), 'error')
        }
      } catch (error) {
        toastStore.addToast('保存失败：' + error.message, 'error')
      }
    }

    return {
      testStore,
      evalStore,
      toastStore,
      config,
      selectedModel,
      activeTab,
      tabs,
      activeState,
      actionLabel,
      modelOptions,
      runActive,
      questionTip,
      runCheckup,
      stopCheckup,
      copyReport,
      saveReport,
    }
  },
}
</script>

<style scoped></style>
