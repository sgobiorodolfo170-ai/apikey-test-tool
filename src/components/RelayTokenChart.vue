<template>
  <section class="flex flex-col gap-2 flex-shrink-0">
    <header class="flex flex-wrap items-center gap-2">
      <span class="text-[14px] font-medium text-text-primary">Token 用量</span>
      <div class="flex rounded-card border border-border overflow-hidden">
        <button
          v-for="item in GRANULARITIES"
          :key="item.id"
          type="button"
          class="px-2.5 py-1 text-[13px] transition-colors"
          :class="
            active === item.id
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-hover'
          "
          @click="active = item.id"
        >
          {{ item.label }}统计
        </button>
      </div>
      <span class="text-[13px] text-text-muted ml-auto">
        合计 {{ formatTokenAmount(summary.total) }} tokens · 峰值
        {{ formatTokenAmount(summary.peak) }} · 有量 {{ summary.active }} {{ unit }}
      </span>
    </header>

    <div
      v-if="!hasData"
      class="rounded-card border border-border bg-surface-alt px-3 py-6 text-center text-[13px] text-text-muted"
    >
      还没有可展示的 token 数据，启动中转站并产生调用后自动统计
    </div>

    <div v-else class="rounded-card border border-border bg-surface px-1.5 pt-1.5 pb-1">
      <svg
        :viewBox="`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`"
        class="w-full block"
        role="img"
        :aria-label="`中转站 token ${activeLabel}统计`"
      >
        <!-- 横向参考线 + 纵轴刻度 -->
        <g>
          <line
            v-for="tick in yTicks"
            :key="`grid-${tick.value}`"
            :x1="PAD_LEFT"
            :x2="VIEW_WIDTH - PAD_RIGHT"
            :y1="tick.y"
            :y2="tick.y"
            stroke="#e5e7eb"
            stroke-width="1"
            stroke-dasharray="4 4"
          />
          <text
            v-for="tick in yTicks"
            :key="`tick-${tick.value}`"
            :x="PAD_LEFT - 8"
            :y="tick.y + 5"
            text-anchor="end"
            class="text-text-muted"
            fill="currentColor"
            font-size="17"
          >
            {{ tick.label }}
          </text>
        </g>

        <!-- 柱形图（背景层）：柱高表示该时间片的 token 用量，颜色越深用量越大 -->
        <g>
          <g v-for="(slot, index) in series" :key="slot.key">
            <title>{{ tooltip(slot) }}</title>
            <rect
              :x="blockX(index)"
              :y="barY(slot.total)"
              :width="cellWidth"
              :height="barHeight(slot.total)"
              rx="2"
              :fill="heatColor(slot.total)"
            />
          </g>
        </g>

        <!-- 各模型使用曲线：叠加在像素热力背景之上（允许重叠），白色描边保证可读性 -->
        <g>
          <g v-for="line in lines" :key="line.model">
            <polyline
              :points="line.points"
              fill="none"
              stroke="#ffffff"
              stroke-width="5.5"
              stroke-opacity="0.8"
              stroke-linejoin="round"
              stroke-linecap="round"
              pointer-events="none"
            />
            <polyline
              :points="line.points"
              fill="none"
              :stroke="line.color"
              stroke-width="2.2"
              stroke-linejoin="round"
              stroke-linecap="round"
              pointer-events="none"
            />
            <template v-for="(dot, index) in line.dots" :key="`${line.model}-${index}`">
              <circle
                v-if="dot.value > 0"
                :cx="dot.x"
                :cy="dot.y"
                r="2.6"
                :fill="line.color"
                pointer-events="none"
              />
            </template>
          </g>
        </g>

        <!-- 时间轴标签 -->
        <g>
          <template v-for="(slot, index) in series" :key="`x-${slot.key}`">
            <text
              v-if="showLabel(index)"
              :x="slotX(index)"
              :y="LABEL_Y"
              text-anchor="middle"
              class="text-text-muted"
              fill="currentColor"
              font-size="17"
            >
              {{ slot.label }}
            </text>
          </template>
        </g>
      </svg>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1.5 pt-0.5">
        <span
          v-for="line in lines"
          :key="line.model"
          class="inline-flex items-center gap-1 text-[13px] text-text-secondary max-w-[190px]"
        >
          <i
            class="inline-block w-2.5 h-2.5 rounded-[2px] flex-shrink-0"
            :style="{ background: line.color }"
          ></i>
          <span class="truncate" :title="line.model">{{ line.model }}</span>
        </span>
        <span v-if="lines.length === 0" class="text-[13px] text-text-muted">暂无模型用量</span>
        <span class="ml-auto inline-flex items-center gap-1 text-[13px] text-text-muted">
          低
          <template v-for="level in HEAT_COLORS.length" :key="`heat-${level}`">
            <i
              class="inline-block w-2.5 h-2.5 rounded-[2px]"
              :style="{ background: HEAT_COLORS[level - 1] }"
            ></i>
          </template>
          高
        </span>
      </div>
    </div>
  </section>
</template>

<script>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRelayStore } from '../stores/relayStore.js'
import {
  CHART_GRANULARITIES,
  buildTokenSeries,
  collectTopModels,
  formatTokenAmount,
  heatLevel,
  summarizeTokenSeries,
} from '../utils/tokenChart.js'

const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 250
const PAD_LEFT = 64
const PAD_RIGHT = 20
const PLOT_TOP = 18
const PLOT_BOTTOM = 206
const LABEL_Y = 238

// 柱形图使用实色柱体，颜色越深代表 token 用量越大
const HEAT_COLORS = ['#e8e0d6', '#bfdbfe', '#93c5fd', '#3b82f6', '#1d4ed8']
const LINE_COLORS = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9']

// 让纵轴上界是一个好看的整数，曲线不会顶到画布边缘
function niceMax(value) {
  const max = Math.max(1, Number(value) || 0)
  const magnitude = 10 ** Math.floor(Math.log10(max))
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  const step = steps.find((item) => max / magnitude <= item) || 10
  return step * magnitude
}

export default {
  name: 'RelayTokenChart',
  setup() {
    const relayStore = useRelayStore()
    const active = ref('day')
    let timer = null

    const series = computed(() => buildTokenSeries(relayStore.tokenHistory, active.value))
    const summary = computed(() => summarizeTokenSeries(series.value))
    const hasData = computed(() => series.value.some((slot) => slot.total > 0))
    const maxTotal = computed(() => Math.max(1, ...series.value.map((slot) => slot.total)))
    const yMax = computed(() => niceMax(maxTotal.value))
    const step = computed(
      () => (VIEW_WIDTH - PAD_LEFT - PAD_RIGHT) / Math.max(1, series.value.length),
    )
    const cellWidth = computed(() => Math.min(40, Math.max(6, step.value - 4)))
    const plotHeight = PLOT_BOTTOM - PLOT_TOP
    const unit = computed(
      () => CHART_GRANULARITIES.find((item) => item.id === active.value)?.label || '日',
    )
    const activeLabel = computed(() => unit.value)

    const slotX = (index) => PAD_LEFT + step.value * (index + 0.5)
    const blockX = (index) => slotX(index) - cellWidth.value / 2
    const yOf = (value) => PLOT_BOTTOM - (Math.max(0, Number(value) || 0) / yMax.value) * plotHeight

    // 柱形图：柱高按 token 量映射，0 值不画柱
    const barHeight = (value) => {
      const total = Math.max(0, Number(value) || 0)
      if (total <= 0) return 0
      return Math.max(2, PLOT_BOTTOM - yOf(total))
    }
    const barY = (value) => PLOT_BOTTOM - barHeight(value)

    const yTicks = computed(() => {
      const ratios = [0, 1 / 3, 2 / 3, 1]
      return ratios.map((ratio) => {
        const value = yMax.value * ratio
        return { value, y: yOf(value), label: formatTokenAmount(value) }
      })
    })

    const topModels = computed(() => collectTopModels(series.value, 5))

    const lines = computed(() =>
      topModels.value.map((model, index) => ({
        model,
        color: LINE_COLORS[index % LINE_COLORS.length],
        points: series.value
          .map((slot, i) => `${slotX(i).toFixed(2)},${yOf(slot.models[model] || 0).toFixed(2)}`)
          .join(' '),
        dots: series.value.map((slot, i) => ({
          x: slotX(i),
          y: yOf(slot.models[model] || 0),
          value: slot.models[model] || 0,
        })),
      })),
    )

    const showLabel = (index) => {
      const length = series.value.length
      if (length <= 12) return true
      return index % 5 === 0 || index === length - 1
    }

    const heatColor = (value) => HEAT_COLORS[heatLevel(value, maxTotal.value, HEAT_COLORS.length)]

    const tooltip = (slot) => {
      const head = `${slot.key} · ${formatTokenAmount(slot.total)} tokens · ${slot.calls} 次调用`
      const models = Object.entries(slot.models)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([model, total]) => `${model} ${formatTokenAmount(total)}`)
      return models.length > 0 ? `${head}（${models.join(' · ')}）` : head
    }

    const load = () => relayStore.loadTokenHistory()

    onMounted(() => {
      load()
      timer = setInterval(load, 15000)
    })

    onUnmounted(() => {
      if (timer) clearInterval(timer)
      timer = null
    })

    return {
      GRANULARITIES: CHART_GRANULARITIES,
      HEAT_COLORS,
      VIEW_WIDTH,
      VIEW_HEIGHT,
      PAD_LEFT,
      PAD_RIGHT,
      LABEL_Y,
      active,
      activeLabel,
      unit,
      series,
      summary,
      hasData,
      yTicks,
      cellWidth,
      lines,
      slotX,
      blockX,
      barY,
      barHeight,
      showLabel,
      heatColor,
      tooltip,
      formatTokenAmount,
    }
  },
}
</script>

<style scoped></style>
