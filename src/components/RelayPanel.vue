<template>
  <div class="flex flex-col h-full w-full min-h-0 gap-2">
    <!-- 端点与启停 -->
    <div class="flex-shrink-0 rounded-card bg-surface-alt px-2 py-1.5 space-y-1.5">
      <div class="flex items-center gap-2">
        <span
          class="inline-flex items-center gap-1 text-[14px] px-1.5 py-0.5 rounded-full leading-none flex-shrink-0"
          :class="relayStore.running ? 'bg-success/15 text-success' : 'bg-surface text-text-muted'"
        >
          <span
            class="w-1.5 h-1.5 rounded-full"
            :class="relayStore.running ? 'bg-success animate-pulse' : 'bg-text-muted'"
          ></span>
          {{ relayStore.running ? '运行中' : '已停止' }}
        </span>
        <button
          type="button"
          class="text-xs px-3 py-1 rounded-card flex-shrink-0"
          :class="relayStore.running ? 'btn-danger' : 'btn-primary'"
          @click="toggleServer"
        >
          {{ relayStore.running ? '停止' : '启动' }}
        </button>
      </div>
      <button
        type="button"
        class="block w-full text-left min-w-0"
        title="点击复制端点地址"
        @click="copyBaseUrl"
      >
        <code class="block w-full text-xs text-text-primary truncate">
          {{ relayStore.baseUrl }}
        </code>
      </button>
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1 text-[14px] text-text-muted flex-shrink-0">
          端口
          <input
            v-model.number="portInput"
            type="number"
            min="1024"
            max="65535"
            class="w-14 bg-surface border border-border-light rounded px-1 py-0.5 text-center text-text-primary disabled:opacity-60"
            :disabled="relayStore.running"
            @change="applyPort"
          />
        </label>
        <span class="text-[14px] text-text-muted truncate">
          · {{ relayStore.enabledCount }} 个提供商 · {{ relayStore.modelCount }} 个模型
        </span>
      </div>
      <div class="flex items-center gap-1.5 text-[14px] text-text-muted">
        <span class="flex-shrink-0">访问 Key</span>
        <button
          type="button"
          class="flex-1 min-w-0 text-left"
          :title="relayStore.apiKey ? '点击复制访问 Key' : '未设置：本机调用不需要 Key'"
          @click="copyApiKey"
        >
          <code
            class="block truncate text-[14px]"
            :class="relayStore.apiKey ? 'text-text-primary' : 'text-text-muted'"
          >
            {{ relayStore.apiKey || '未设置（本机免鉴权）' }}
          </code>
        </button>
        <button
          type="button"
          class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0"
          title="生成新的本地访问 Key"
          @click="generateApiKey"
        >
          {{ relayStore.apiKey ? '重新生成' : '生成' }}
        </button>
        <button
          v-if="relayStore.apiKey"
          type="button"
          class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0 text-danger hover:bg-danger/10"
          title="清除访问 Key，恢复本机免鉴权"
          @click="clearApiKey"
        >
          清除
        </button>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-text-muted">
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            :checked="relayStore.cacheEnabled"
            @change="setCacheEnabled($event.target.checked)"
          />
          精确缓存
        </label>
        <label v-if="relayStore.cacheEnabled" class="flex items-center gap-1">
          <input
            v-model.number="cacheTtlInput"
            type="number"
            min="1"
            max="1440"
            class="w-12 bg-surface border border-border-light rounded px-1 py-0.5 text-center text-text-primary"
            @change="applyCacheTtl"
          />
          分钟
        </label>
        <label class="flex items-center gap-1" title="应用启动时自动启动中转站">
          <input
            type="checkbox"
            :checked="relayStore.autoStart"
            @change="setAutoStart($event.target.checked)"
          />
          随应用启动
        </label>
        <label
          class="flex items-center gap-1"
          title="同一会话优先路由到同一个上游 Key，减少跨家漂移（默认关闭）"
        >
          <input
            type="checkbox"
            :checked="relayStore.sticky"
            @change="setSticky($event.target.checked)"
          />
          会话粘性
        </label>
      </div>

      <!-- 多客户端 Key：每个工具一把，日志与调用监控按名称归因 -->
      <div class="flex flex-col gap-1 text-[14px] text-text-muted">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="flex-shrink-0">客户端 Key</span>
          <span class="text-text-muted">已设 {{ relayStore.clientKeys.length }} 个</span>
          <button
            type="button"
            class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0"
            title="为某个工具生成一把专用 Key，调用监控里会显示它的名称"
            @click="addClientKey('')"
          >
            + 添加客户端
          </button>
        </div>
        <div v-if="relayStore.clientKeys.length > 0" class="flex flex-col gap-1">
          <div
            v-for="(item, index) in relayStore.clientKeys"
            :key="item.key"
            class="client-key-row flex items-center gap-1.5"
          >
            <input
              :value="item.label"
              type="text"
              maxlength="20"
              class="w-28 bg-surface border border-border-light rounded px-1.5 py-0.5 text-text-primary"
              @change="renameClientKey(index, $event.target.value)"
            />
            <code class="flex-1 min-w-0 truncate text-[13px] text-text-primary" :title="item.key">
              {{ item.key }}
            </code>
            <button
              type="button"
              class="btn-ghost text-[13px] px-1.5 py-0.5 flex-shrink-0"
              @click="copyClientKey(item)"
            >
              复制
            </button>
            <button
              type="button"
              class="btn-ghost text-[13px] px-1.5 py-0.5 flex-shrink-0 text-danger hover:bg-danger/10"
              @click="removeClientKey(index)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 添加提供商 -->
    <details
      ref="formDetails"
      class="flex-shrink-0 rounded-card border border-border-light bg-surface"
    >
      <summary
        class="flex items-center justify-center gap-1 px-2.5 py-2.5 text-sm text-text-secondary cursor-pointer select-none hover:bg-surface-hover rounded-card transition-colors"
        :title="editingId ? '修改后点「保存修改」' : '模板预填 · 字段可改'"
      >
        <span class="font-medium text-accent">{{ editingId ? '编辑提供商' : '+ 添加提供商' }}</span>
      </summary>
      <div class="px-2 pb-2 space-y-1.5 max-h-72 overflow-y-auto">
        <select v-model="form.presetId" class="select text-xs py-1" @change="applyPreset">
          <option value="">自定义</option>
          <option v-for="preset in RELAY_PRESETS" :key="preset.id" :value="preset.id">
            {{ preset.name }}
          </option>
        </select>
        <div class="grid grid-cols-[auto,1fr] items-start gap-x-2 gap-y-1.5 text-[14px]">
          <span class="text-text-muted pt-2">名称</span>
          <input v-model="form.name" class="input text-xs py-1" placeholder="提供商名称" />
          <span class="text-text-muted pt-2">Base URL</span>
          <input
            v-model="form.baseUrl"
            class="input text-xs py-1"
            placeholder="https://api.example.com/v1"
          />
          <span class="text-text-muted pt-2">API Key</span>
          <div class="space-y-1">
            <div
              v-for="(item, index) in form.apiKeyInputs"
              :key="index"
              class="flex items-center gap-1"
            >
              <input
                :value="item"
                type="password"
                class="input text-xs py-1 flex-1 min-w-0"
                :placeholder="index === 0 ? 'sk-…（可留空）' : `Key ${index + 1}`"
                @input="form.apiKeyInputs[index] = $event.target.value"
              />
              <button
                type="button"
                class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0"
                title="增加一个 API Key 输入框"
                @click="addApiKeyInput"
              >
                添加
              </button>
              <button
                v-if="form.apiKeyInputs.length > 1"
                type="button"
                class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0 text-danger hover:bg-danger/10"
                title="删除这一行"
                @click="removeApiKeyInput(index)"
              >
                −
              </button>
            </div>
          </div>
          <span class="text-text-muted pt-2">模型</span>
          <div class="space-y-1">
            <div
              v-for="(item, index) in form.modelInputs"
              :key="index"
              class="flex items-center gap-1"
            >
              <div class="relative flex-1 min-w-0">
                <input
                  :value="item"
                  class="input text-xs py-1 pr-7 w-full"
                  :placeholder="index === 0 ? '模型名，如 gpt-4o' : `模型 ${index + 1}`"
                  @input="form.modelInputs[index] = $event.target.value"
                />
                <button
                  type="button"
                  class="absolute right-1 top-1/2 -translate-y-1/2 text-[13px] text-text-muted hover:text-accent leading-none px-0.5"
                  title="从上游拉取模型并选择一个"
                  @click="openModelPicker(index)"
                >
                  ▾
                </button>
              </div>
              <button
                type="button"
                class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0"
                title="增加一个模型输入框"
                @click="addModelInput"
              >
                添加
              </button>
              <button
                v-if="form.modelInputs.length > 1"
                type="button"
                class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0 text-danger hover:bg-danger/10"
                title="删除这一行"
                @click="removeModelInput(index)"
              >
                −
              </button>
            </div>
          </div>
          <span class="text-text-muted pt-2">别名</span>
          <div class="space-y-1">
            <div
              v-for="(item, index) in form.aliasInputs"
              :key="index"
              class="flex items-center gap-1"
            >
              <input
                :value="item"
                class="input text-xs py-1 flex-1 min-w-0"
                placeholder="客户端模型名=上游真实模型"
                @input="form.aliasInputs[index] = $event.target.value"
              />
              <button
                type="button"
                class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0"
                title="增加一个模型别名"
                @click="addAliasInput"
              >
                添加
              </button>
              <button
                v-if="form.aliasInputs.length > 1"
                type="button"
                class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0 text-danger hover:bg-danger/10"
                title="删除这一行"
                @click="removeAliasInput(index)"
              >
                −
              </button>
            </div>
          </div>
          <span class="text-text-muted pt-2">限流</span>
          <div class="flex items-center gap-2">
            <label class="flex items-center gap-1 text-[14px] text-text-muted">
              并发
              <input
                v-model.number="form.maxConcurrency"
                type="number"
                min="1"
                max="64"
                class="w-11 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                title="同一上游同时进行的最大请求数"
              />
            </label>
            <label class="flex items-center gap-1 text-[14px] text-text-muted">
              每分钟
              <input
                v-model.number="form.rpmLimit"
                type="number"
                min="0"
                max="100000"
                class="w-14 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                title="每分钟最大请求数，0 表示不限"
              />
            </label>
          </div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-text-muted">
            <label
              class="flex items-center gap-1"
              title="按 5 小时 / 7 天滑动窗口限制用量，用尽后自动切到下一个提供商（同提供商的多把 Key 共享额度）"
            >
              <input v-model="form.quotaEnabled" type="checkbox" />
              额度窗口
            </label>
            <template v-if="form.quotaEnabled">
              <select
                v-model="form.quotaMetric"
                class="select text-xs py-0.5"
                title="按请求次数，或按积分 / 墨点（由 tokens 估算）"
              >
                <option value="request">按次数</option>
                <option value="credit">按积分 / 墨点</option>
              </select>
              <label class="flex items-center gap-1">
                5 小时
                <input
                  v-model.number="form.quotaLimit5h"
                  type="number"
                  min="0"
                  class="w-16 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                  title="5 小时窗口上限，0 表示不限"
                />
              </label>
              <label class="flex items-center gap-1">
                7 天
                <input
                  v-model.number="form.quotaLimitWeek"
                  type="number"
                  min="0"
                  class="w-20 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                  title="7 天窗口上限，0 表示不限"
                />
              </label>
              <label
                v-if="form.quotaMetric === 'credit'"
                class="flex items-center gap-1"
                title="每百万 tokens 折算的积分（可按模型输出单价保守估算）"
              >
                每百万 tokens 记
                <input
                  v-model.number="form.quotaCreditsPerMillion"
                  type="number"
                  min="0"
                  step="0.1"
                  class="w-14 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                />
                墨点
              </label>
              <label
                class="flex items-center gap-1"
                title="连续多次、且彼此间隔足够的 429 才判定额度耗尽，避免把瞬时限流误判为额度用完"
              >
                429 判定
                <input
                  v-model.number="form.quotaStrikes"
                  type="number"
                  min="1"
                  max="10"
                  class="w-10 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                  title="需要累计几次 429 才确认"
                />
                次 · 间隔
                <input
                  v-model.number="form.quotaInterval"
                  type="number"
                  min="1"
                  max="60"
                  class="w-12 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                  title="两次 429 之间至少隔多少分钟才计一次"
                />
                分钟
              </label>
            </template>
          </div>
        </div>
        <div v-if="presetNote" class="text-[14px] text-text-muted">{{ presetNote }}</div>
        <div class="flex gap-1 pt-0.5">
          <button class="btn-primary text-sm px-3 py-1.5 flex-1" @click="submitProvider">
            {{ editingId ? '保存修改' : '添加提供商' }}
          </button>
          <button v-if="editingId" class="btn-ghost text-sm px-3 py-1.5" @click="cancelEdit">
            取消
          </button>
          <button
            v-if="!editingId && form.presetId && presetDocs"
            class="btn-ghost text-sm px-3 py-1.5"
            @click="openDocs"
          >
            文档
          </button>
        </div>
      </div>
    </details>

    <!-- 提供商列表 -->
    <div class="flex-1 min-h-0 overflow-y-auto space-y-1.5">
      <div
        v-if="relayStore.providers.length === 0"
        class="h-full flex flex-col items-center justify-center text-center gap-1.5 px-4"
      >
        <div class="text-text-muted text-sm">还没有提供商</div>
        <div class="text-[14px] text-text-muted leading-relaxed">
          添加上游后启动服务，把客户端的 Base URL 指向本地端点，即按模型名自动路由
        </div>
      </div>

      <div
        v-for="provider in relayStore.providers"
        :key="provider.id"
        class="rounded-card border p-2 transition-colors"
        :class="
          provider.enabled === false
            ? 'border-border bg-surface-alt/60'
            : 'border-border-light bg-surface-alt'
        "
      >
        <div class="flex items-start gap-2">
          <span
            class="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5"
            :class="provider.enabled === false ? 'bg-text-muted' : 'bg-success'"
          ></span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1">
              <span
                class="text-sm font-medium text-text-primary truncate flex-1 min-w-0"
                :title="provider.name"
              >
                {{ provider.name }}
              </span>
              <button
                class="btn-ghost text-[13px] px-1 py-0 leading-none flex-shrink-0"
                title="编辑该提供商的名称 / Key / 模型 / 限流"
                @click="startEdit(provider)"
              >
                编辑
              </button>
              <button
                class="btn-ghost text-[13px] px-1 py-0 leading-none flex-shrink-0 text-danger hover:bg-danger/10"
                title="删除该提供商"
                @click="removeProvider(provider)"
              >
                删除
              </button>
            </div>
            <div class="text-[14px] text-text-muted truncate" :title="provider.baseUrl">
              {{ provider.baseUrl }}
            </div>
          </div>
          <label
            class="relative inline-flex items-center cursor-pointer flex-shrink-0 mt-1"
            :title="provider.enabled === false ? '已停用，点击启用' : '已启用，点击停用'"
          >
            <input
              type="checkbox"
              class="sr-only peer"
              :checked="provider.enabled !== false"
              @change="relayStore.toggleProvider(provider.id)"
            />
            <span
              class="relative w-7 h-4 rounded-full bg-border-light peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-3 after:h-3 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-3"
            ></span>
          </label>
        </div>

        <div class="flex items-center gap-2 mt-1.5 pl-3.5">
          <span class="text-[14px] text-text-muted truncate flex-1" :title="limitTitle(provider)">
            {{ (provider.models || []).length }} 模型 · {{ limitLabel(provider) }}
          </span>
          <div class="flex items-center gap-0.5 flex-shrink-0">
            <button
              class="btn-ghost text-[14px] w-5 h-5 leading-none"
              title="上移（优先使用）"
              :disabled="provider === relayStore.providers[0]"
              @click="relayStore.moveProvider(provider.id, -1)"
            >
              ↑
            </button>
            <button
              class="btn-ghost text-[14px] w-5 h-5 leading-none"
              title="下移（故障时后备用）"
              :disabled="provider === relayStore.providers[relayStore.providers.length - 1]"
              @click="relayStore.moveProvider(provider.id, 1)"
            >
              ↓
            </button>
          </div>
        </div>
      </div>
    </div>

    <details class="flex-shrink-0" @toggle="onLogsToggle">
      <summary
        class="flex items-center gap-1 text-[14px] text-text-secondary cursor-pointer select-none hover:text-text-primary transition-colors"
      >
        <span>请求日志</span>
        <span class="px-1 rounded-full bg-surface-alt text-[13px] text-text-muted leading-4">
          {{ relayStore.logs.length }}
        </span>
      </summary>
      <div class="mt-1.5 max-h-32 overflow-y-auto rounded-card border border-border bg-surface-alt">
        <div
          v-if="relayStore.logs.length === 0"
          class="text-[14px] text-text-muted text-center py-2"
        >
          暂无请求
        </div>
        <div
          v-for="log in relayStore.logs.slice(0, 30)"
          :key="log.id"
          class="flex items-center gap-1.5 px-1.5 py-0.5 text-[13px] border-b border-border last:border-b-0"
        >
          <span class="text-text-muted flex-shrink-0 tabular-nums">{{ shortTime(log.at) }}</span>
          <span class="text-text-primary truncate flex-1" :title="log.model">{{ log.model }}</span>
          <span class="text-text-muted truncate max-w-[64px]" :title="log.provider">
            {{ log.provider }}
          </span>
          <span
            class="flex-shrink-0 px-1 rounded leading-4"
            :class="log.error ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'"
            :title="log.error || '成功'"
          >
            {{ log.status || 'ERR' }}
          </span>
          <span class="text-text-muted flex-shrink-0 tabular-nums">{{ log.ms }}ms</span>
        </div>
      </div>
      <div class="flex gap-1 mt-1">
        <button class="btn-ghost text-[13px] px-1.5 py-0.5" @click="relayStore.loadLogs()">
          刷新
        </button>
        <button class="btn-ghost text-[13px] px-1.5 py-0.5" @click="relayStore.clearLogs()">
          清空
        </button>
      </div>
    </details>

    <Teleport to="body">
      <div
        v-if="modelPicker.visible"
        class="fixed inset-0 z-[60] bg-black/30 flex items-center justify-center p-4"
        @click.self="closeModelPicker"
      >
        <div
          class="bg-surface rounded-card shadow-elevated w-96 max-w-full max-h-[70vh] flex flex-col p-3 gap-2"
        >
          <div class="flex items-center justify-between flex-shrink-0">
            <span class="text-sm font-medium text-text-primary">选择模型</span>
            <button
              type="button"
              class="btn-ghost text-[14px] px-2 py-0.5"
              :disabled="modelPicker.loading"
              @click="loadFormModels"
            >
              {{ modelPicker.loading ? '拉取中' : '重新拉取' }}
            </button>
          </div>
          <div class="text-[14px] text-text-muted truncate flex-shrink-0" :title="form.baseUrl">
            {{ form.baseUrl || '请先填写 Base URL' }}
          </div>
          <div
            class="flex-1 min-h-0 overflow-y-auto rounded-card border border-border bg-surface-alt"
          >
            <div v-if="modelPicker.loading" class="text-xs text-text-muted text-center py-6">
              拉取中…
            </div>
            <div
              v-else-if="modelPicker.models.length === 0"
              class="text-xs text-text-muted text-center py-6 px-3 leading-relaxed"
            >
              没有拉到模型，可直接在输入框手动填写
            </div>
            <button
              v-for="model in modelPicker.models"
              :key="model"
              type="button"
              class="w-full text-left text-xs px-2 py-1.5 hover:bg-surface-hover text-text-primary truncate"
              :title="model"
              @click="chooseModel(model)"
            >
              {{ model }}
            </button>
          </div>
          <div class="flex justify-end flex-shrink-0">
            <button type="button" class="btn-ghost text-xs px-2 py-1" @click="closeModelPicker">
              关闭
            </button>
          </div>
        </div>
      </div>
    </Teleport>
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
      // 一个输入框只放一个值：Key / 模型 / 别名都可以按需追加多行
      apiKeyInputs: [''],
      modelInputs: [''],
      aliasInputs: [''],
      maxConcurrency: 4,
      rpmLimit: 0,
      quotaEnabled: false,
      quotaMetric: 'request',
      quotaLimit5h: 0,
      quotaLimitWeek: 0,
      quotaCreditsPerMillion: 4,
      quotaStrikes: 3,
      quotaInterval: 1,
    })

    const presetNote = computed(() => findPreset(form.presetId)?.note || '')
    const presetDocs = computed(() => findPreset(form.presetId)?.docs || '')

    const formDetails = ref(null)
    const editingId = ref(null)
    const modelPicker = reactive({ visible: false, index: 0, models: [], loading: false })

    const loadFormModels = async () => {
      const baseUrl = form.baseUrl.trim()
      if (!baseUrl) {
        toastStore.addToast('先填写 Base URL 再拉取模型', 'warning')
        return
      }
      modelPicker.loading = true
      try {
        const apiKeys = form.apiKeyInputs.map((item) => item.trim()).filter(Boolean)
        modelPicker.models = await relayStore.previewModels(baseUrl, apiKeys)
      } finally {
        modelPicker.loading = false
      }
    }

    // 模型输入框的下拉：拉取上游模型，选中后填进对应的输入框
    const openModelPicker = (index) => {
      modelPicker.index = index
      modelPicker.visible = true
      loadFormModels()
    }

    const closeModelPicker = () => {
      modelPicker.visible = false
    }

    const chooseModel = (model) => {
      form.modelInputs[modelPicker.index] = model
      modelPicker.visible = false
    }

    const resetForm = () => {
      modelPicker.visible = false
      form.presetId = ''
      form.name = ''
      form.baseUrl = ''
      form.apiKeyInputs = ['']
      form.modelInputs = ['']
      form.aliasInputs = ['']
      form.maxConcurrency = 4
      form.rpmLimit = 0
      form.quotaEnabled = false
      form.quotaMetric = 'request'
      form.quotaLimit5h = 0
      form.quotaLimitWeek = 0
      form.quotaCreditsPerMillion = 4
      form.quotaStrikes = 3
      form.quotaInterval = 1
      editingId.value = null
    }

    // 编辑已有提供商：把 Key / 模型拆回一行一个的输入框
    const startEdit = (provider) => {
      const keys =
        Array.isArray(provider.apiKeys) && provider.apiKeys.length > 0
          ? provider.apiKeys
          : [provider.apiKey || '']
      const models =
        Array.isArray(provider.models) && provider.models.length > 0 ? provider.models : ['']
      const aliases =
        provider.modelAliases && typeof provider.modelAliases === 'object'
          ? provider.modelAliases
          : {}
      form.presetId = provider.presetId || ''
      form.name = provider.name || ''
      form.baseUrl = provider.baseUrl || ''
      form.apiKeyInputs = [...keys]
      form.modelInputs = [...models]
      form.aliasInputs = Object.keys(aliases).length
        ? Object.entries(aliases).map(([from, to]) => `${from}=${to}`)
        : ['']
      form.maxConcurrency = Number(provider.maxConcurrency) > 0 ? provider.maxConcurrency : 4
      form.rpmLimit = Number(provider.rpmLimit) > 0 ? provider.rpmLimit : 0
      const quota = provider.quota || {}
      form.quotaEnabled = quota.enabled === true
      form.quotaMetric = quota.metric === 'credit' ? 'credit' : 'request'
      form.quotaLimit5h = Number(quota.limit5h) || 0
      form.quotaLimitWeek = Number(quota.limitWeek) || 0
      form.quotaCreditsPerMillion = Number(quota.creditsPerMillionTokens) || 4
      form.quotaStrikes = Number(quota.confirmStrikes) > 0 ? Number(quota.confirmStrikes) : 3
      form.quotaInterval =
        Number(quota.confirmIntervalMinutes) > 0 ? Number(quota.confirmIntervalMinutes) : 1
      editingId.value = provider.id
      modelPicker.visible = false
      if (formDetails.value) formDetails.value.open = true
    }

    const cancelEdit = () => {
      resetForm()
      if (formDetails.value) formDetails.value.open = false
    }

    const addApiKeyInput = () => form.apiKeyInputs.push('')
    const removeApiKeyInput = (index) => {
      if (form.apiKeyInputs.length > 1) form.apiKeyInputs.splice(index, 1)
    }
    const addModelInput = () => form.modelInputs.push('')
    const removeModelInput = (index) => {
      if (form.modelInputs.length > 1) form.modelInputs.splice(index, 1)
    }

    const addAliasInput = () => form.aliasInputs.push('')
    const removeAliasInput = (index) => {
      if (form.aliasInputs.length > 1) form.aliasInputs.splice(index, 1)
    }

    // 每行格式：客户端模型名=上游真实模型名
    const parseAliases = (inputs) => {
      const map = {}
      for (const line of inputs) {
        const text = String(line || '').trim()
        const eq = text.indexOf('=')
        if (eq <= 0) continue
        const from = text.slice(0, eq).trim()
        const to = text.slice(eq + 1).trim()
        if (from && to) map[from] = to
      }
      return map
    }

    const applyPreset = () => {
      const preset = findPreset(form.presetId)
      if (!preset) return
      form.name = preset.name
      form.baseUrl = preset.baseUrl
      form.modelInputs = preset.models.length > 0 ? [...preset.models] : ['']
      if (Number(preset.rpmLimit) > 0) form.rpmLimit = Number(preset.rpmLimit)
      const quota = preset.quota
      form.quotaEnabled = quota?.enabled === true
      form.quotaMetric = quota?.metric === 'credit' ? 'credit' : 'request'
      form.quotaLimit5h = Number(quota?.limit5h) || 0
      form.quotaLimitWeek = Number(quota?.limitWeek) || 0
      form.quotaCreditsPerMillion = Number(quota?.creditsPerMillionTokens) || 4
      form.quotaStrikes = Number(quota?.confirmStrikes) > 0 ? Number(quota?.confirmStrikes) : 3
      form.quotaInterval =
        Number(quota?.confirmIntervalMinutes) > 0 ? Number(quota?.confirmIntervalMinutes) : 1
    }

    const submitProvider = async () => {
      if (!form.name.trim() || !form.baseUrl.trim()) {
        toastStore.addToast('名称和 Base URL 必填', 'warning')
        return
      }
      const payload = {
        name: form.name,
        baseUrl: form.baseUrl,
        apiKeys: form.apiKeyInputs.map((item) => item.trim()).filter(Boolean),
        models: form.modelInputs.map((item) => item.trim()).filter(Boolean),
        modelAliases: parseAliases(form.aliasInputs),
        maxConcurrency: Number(form.maxConcurrency) || 4,
        rpmLimit: Number(form.rpmLimit) || 0,
        quota: {
          enabled: form.quotaEnabled,
          metric: form.quotaMetric,
          limit5h: Number(form.quotaLimit5h) || 0,
          limitWeek: Number(form.quotaLimitWeek) || 0,
          creditsPerMillionTokens: Number(form.quotaCreditsPerMillion) || 0,
          confirmStrikes: Number(form.quotaStrikes) || 0,
          confirmIntervalMinutes: Number(form.quotaInterval) || 0,
        },
      }

      if (editingId.value) {
        await relayStore.updateProvider(editingId.value, payload)
        toastStore.addToast(`已更新提供商「${payload.name}」`, 'success')
        resetForm()
        return
      }

      await relayStore.addProvider({ ...payload, presetId: form.presetId || undefined })
      resetForm()
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

    const cacheTtlInput = ref(relayStore.cacheTtlMinutes)

    const setCacheEnabled = async (enabled) => {
      await relayStore.setCacheEnabled(enabled)
      toastStore.addToast(enabled ? '已开启精确缓存' : '已关闭精确缓存', 'info')
    }

    const applyCacheTtl = () => {
      relayStore.setCacheTtlMinutes(cacheTtlInput.value)
      cacheTtlInput.value = relayStore.cacheTtlMinutes
    }

    const setAutoStart = async (enabled) => {
      await relayStore.setAutoStart(enabled)
    }

    const setSticky = async (enabled) => {
      await relayStore.setSticky(enabled)
      toastStore.addToast(enabled ? '已开启会话粘性' : '已关闭会话粘性', 'info')
    }

    const addClientKey = async (label) => {
      await relayStore.addClientKey(label)
    }

    const renameClientKey = async (index, label) => {
      await relayStore.renameClientKey(index, label)
    }

    const removeClientKey = async (index) => {
      const item = relayStore.clientKeys[index]
      if (!item) return
      if (!confirm(`确定删除客户端「${item.label}」的 Key 吗？删除后该工具将无法调用。`)) return
      await relayStore.removeClientKey(index)
    }

    const copyClientKey = async (item) => {
      try {
        await navigator.clipboard.writeText(item.key)
        toastStore.addToast(`已复制「${item.label}」的 Key`, 'success')
      } catch {
        toastStore.addToast('复制失败，请手动选择', 'error')
      }
    }

    const copyBaseUrl = async () => {
      try {
        await navigator.clipboard.writeText(relayStore.baseUrl)
        toastStore.addToast('已复制端点地址', 'success')
      } catch {
        toastStore.addToast('复制失败，请手动选择', 'error')
      }
    }

    const copyApiKey = async () => {
      if (!relayStore.apiKey) {
        toastStore.addToast('还没有生成访问 Key', 'warning')
        return
      }
      try {
        await navigator.clipboard.writeText(relayStore.apiKey)
        toastStore.addToast('已复制访问 Key', 'success')
      } catch {
        toastStore.addToast('复制失败，请手动选择', 'error')
      }
    }

    const generateApiKey = async () => {
      await relayStore.generateApiKey()
    }

    const clearApiKey = async () => {
      if (!confirm('确定清除访问 Key 吗？清除后本机调用不再校验 Key。')) return
      await relayStore.clearApiKey()
    }

    const quotaKeysOf = (provider) =>
      relayStore.running
        ? (relayStore.status?.quota || []).filter((item) => item.providerId === provider.id)
        : []

    const quotaLabel = (provider) => {
      const quota = provider.quota
      if (!quota?.enabled) return ''
      const unit = quota.metric === 'credit' ? '墨点' : '次'
      const keys = quotaKeysOf(provider)
      if (keys.length > 0) {
        const usable = keys.filter((item) => !item.exhausted).length
        const maxUsed = Math.max(...keys.map((item) => Number(item.used5h) || 0))
        return ` · 5h 最高 ${maxUsed}/${quota.limit5h || '∞'} · Key 可用 ${usable}/${keys.length}`
      }
      return ` · 5h≤${quota.limit5h || '∞'} ${unit} / 7d≤${quota.limitWeek || '∞'}（每 Key 独立）`
    }

    const limitLabel = (provider) => {
      const rpm = Number(provider.rpmLimit) > 0 ? `${provider.rpmLimit} RPM` : '不限速'
      const live = relayStore.running ? relayStore.status?.load?.[provider.id] : null
      const conc = Number(provider.maxConcurrency) > 0 ? provider.maxConcurrency : 4
      const base = live ? `${live.inflight}/${conc} 并发 · ${rpm}` : `${conc} 并发 · ${rpm}`
      return `${base}${quotaLabel(provider)}`
    }

    const limitTitle = (provider) => {
      const models = (provider.models || []).join(', ')
      const lines = [models ? `模型：${models}` : '尚未配置模型']
      const keys = quotaKeysOf(provider)
      if (keys.length > 0) {
        lines.push('', '按 Key 用量（每把 Key 独立账号）：')
        for (const item of keys) {
          const unit = item.metric === 'credit' ? '墨点' : '次'
          const status = item.exhausted
            ? ` · ${item.locked ? '429 确认额度耗尽' : '额度已用尽'}（${item.retryAfter}s 后恢复）`
            : ''
          lines.push(`…${item.keyTail}: 5h ${item.used5h}/${item.limit5h || '∞'} ${unit}${status}`)
        }
      }
      return lines.join('\n')
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
      cacheTtlInput.value = relayStore.cacheTtlMinutes
    })

    return {
      relayStore,
      portInput,
      form,
      formDetails,
      editingId,
      modelPicker,
      presetNote,
      presetDocs,
      RELAY_PRESETS,
      applyPreset,
      startEdit,
      cancelEdit,
      resetForm,
      openModelPicker,
      closeModelPicker,
      loadFormModels,
      chooseModel,
      copyApiKey,
      generateApiKey,
      clearApiKey,
      addApiKeyInput,
      removeApiKeyInput,
      addModelInput,
      removeModelInput,
      addAliasInput,
      removeAliasInput,
      cacheTtlInput,
      setCacheEnabled,
      applyCacheTtl,
      setAutoStart,
      setSticky,
      addClientKey,
      renameClientKey,
      removeClientKey,
      copyClientKey,
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
