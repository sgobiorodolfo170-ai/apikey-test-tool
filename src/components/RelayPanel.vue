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
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="flex-1 min-w-0 text-left"
          title="点击复制端点地址"
          @click="copyBaseUrl"
        >
          <code class="block w-full text-xs text-text-primary truncate">
            {{ relayStore.baseUrl }}
          </code>
        </button>
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
        <span class="text-[14px] text-text-muted whitespace-nowrap">
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

    <!-- 每个提供商一个选项卡，末尾 + / - 用于新增和管理删除 -->
    <div class="flex items-center gap-1 overflow-x-auto flex-shrink-0 pb-0.5">
      <div
        v-for="(provider, index) in relayStore.providers"
        :key="provider.id"
        class="provider-tab flex items-center gap-1 px-2 py-1 rounded-card border text-[14px] whitespace-nowrap transition-colors cursor-pointer select-none"
        :class="
          !addingProvider && activeProvider?.id === provider.id
            ? 'bg-accent text-white border-accent'
            : 'bg-surface-alt text-text-secondary border-border-light hover:bg-surface-hover'
        "
        :title="provider.baseUrl"
        role="button"
        tabindex="0"
        @click="selectProvider(provider)"
        @keydown.enter="selectProvider(provider)"
      >
        <span
          class="w-1.5 h-1.5 rounded-full flex-shrink-0"
          :class="provider.enabled === false ? 'bg-text-muted' : 'bg-success'"
        ></span>
        {{ index + 1 }}. {{ provider.name }}
        <button
          v-if="deleteMode"
          type="button"
          class="provider-delete-icon flex-shrink-0 text-danger hover:bg-danger/10 rounded px-1 leading-none"
          title="删除该提供商"
          @click.stop="removeProvider(provider)"
        >
          ×
        </button>
      </div>
      <button
        type="button"
        class="provider-add-tab flex items-center justify-center px-2 py-1 rounded-card border text-[14px] whitespace-nowrap transition-colors"
        :class="
          addingProvider
            ? 'bg-accent text-white border-accent'
            : 'bg-surface-alt text-text-secondary border-border-light hover:bg-surface-hover'
        "
        title="添加提供商"
        @click="startAdd"
      >
        +
      </button>
      <button
        type="button"
        class="provider-delete-tab flex items-center justify-center px-2 py-1 rounded-card border text-[14px] whitespace-nowrap transition-colors"
        :class="
          deleteMode
            ? 'bg-danger text-white'
            : 'bg-surface-alt text-text-secondary border-border-light hover:bg-surface-hover'
        "
        title="管理删除：开启后点击选项卡上的 × 删除提供商"
        @click="deleteMode = !deleteMode"
      >
        -
      </button>
    </div>

    <div
      v-if="relayStore.providers.length === 0"
      class="flex-shrink-0 rounded-card border border-border bg-surface-alt px-3 py-2 text-center"
    >
      <div class="text-text-muted text-sm">还没有提供商</div>
      <div class="text-[14px] text-text-muted leading-relaxed">
        添加上游后启动服务，把客户端的 Base URL 指向本地端点，即按模型名自动路由
      </div>
    </div>

    <!-- 提供商编辑页 -->
    <div class="flex-1 min-h-0 flex flex-col rounded-card border border-border-light bg-surface">
      <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1.5">
        <div
          v-if="editingId && activeProvider?.quota?.enabled"
          class="text-[13px] text-text-muted leading-relaxed"
        >
          <div v-for="item in quotaKeysOf(activeProvider)" :key="item.id">
            …{{ item.keyTail }}：5h {{ item.used5h }}/{{ item.limit5h || '∞' }}
            {{ item.metric === 'credit' ? '墨点' : '次' }} · 7d {{ item.usedWeek }}/{{
              item.limitWeek || '∞'
            }}
            <span v-if="item.exhausted" class="text-danger">· 已用尽</span>
          </div>
          <div v-if="quotaKeysOf(activeProvider).length === 0">
            5h ≤ {{ activeProvider.quota.limit5h || '∞' }} · 7d ≤
            {{ activeProvider.quota.limitWeek || '∞' }}（每 Key 独立）
          </div>
        </div>
        <select v-model="form.presetId" class="select text-xs py-1" @change="applyPreset">
          <option value="">自定义</option>
          <option v-for="preset in RELAY_PRESETS" :key="preset.id" :value="preset.id">
            {{ preset.name }}
          </option>
        </select>
        <div class="grid grid-cols-[auto,minmax(0,1fr)] items-start gap-x-2 gap-y-1.5 text-[14px]">
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
            <div class="flex flex-wrap items-center gap-1">
              <button
                type="button"
                class="btn-ghost text-[13px] px-1.5 py-0.5"
                :title="showApiKeys ? '隐藏所有 Key 的明文' : '显示所有 Key 的明文'"
                @click="showApiKeys = !showApiKeys"
              >
                {{ showApiKeys ? '隐藏明文' : '一键明文' }}
              </button>
              <button
                type="button"
                class="btn-ghost text-[13px] px-1.5 py-0.5"
                :disabled="keyTesting"
                title="逐个测试上方所有 Key 能否连通上游 /models"
                @click="testAllKeys"
              >
                {{ keyTesting ? '测通中…' : '一键测通' }}
              </button>
            </div>
            <template v-for="(item, index) in form.apiKeyInputs" :key="index">
              <div v-if="showAllKeys || index === 0" class="flex flex-wrap items-center gap-1">
                <input
                  :value="item"
                  :type="showApiKeys ? 'text' : 'password'"
                  class="input text-xs py-1 flex-1 min-w-0 basis-40"
                  :placeholder="index === 0 ? 'sk-…（可留空）' : `Key ${index + 1}`"
                  @input="onApiKeyInput(index, $event.target.value)"
                />
                <select
                  v-if="form.quotaEnabled"
                  v-model="form.apiKeyGroups[index]"
                  class="select text-xs py-1 w-24 flex-shrink-0"
                  title="把该 Key 加入共享额度组；同组 Key 共用额度池"
                >
                  <option value="">未分组</option>
                  <option v-for="group in form.quotaGroups" :key="group" :value="group">
                    {{ group }}
                  </option>
                </select>
                <span
                  v-if="keyTests[index]"
                  class="text-[13px] whitespace-nowrap flex-shrink-0"
                  :class="keyTestClass(keyTests[index])"
                  :title="keyTestTitle(keyTests[index])"
                >
                  {{ keyTestText(keyTests[index]) }}
                </span>
                <button
                  v-if="index === form.apiKeyInputs.length - 1"
                  type="button"
                  class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0"
                  :disabled="keyTesting"
                  title="增加一个 API Key 输入框"
                  @click="addApiKeyInput"
                >
                  添加
                </button>
                <button
                  v-if="form.apiKeyInputs.length > 1"
                  type="button"
                  class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0 text-danger hover:bg-danger/10"
                  :disabled="keyTesting"
                  title="删除这一行"
                  @click="removeApiKeyInput(index)"
                >
                  −
                </button>
              </div>
            </template>
            <button
              v-if="form.apiKeyInputs.length > 1"
              type="button"
              class="btn-ghost text-[13px] px-1.5 py-0.5"
              @click="showAllKeys = !showAllKeys"
            >
              {{ showAllKeys ? '收起 Key' : `显示更多（共 ${form.apiKeyInputs.length} 把）` }}
            </button>
            <div
              v-if="form.quotaEnabled"
              class="mt-1 min-w-0 rounded-md border border-border-light bg-surface-alt/60 px-2 py-1.5 space-y-1"
            >
              <div class="flex items-center justify-between text-[13px] text-text-muted">
                <span>共享额度组</span>
                <span>{{ form.quotaGroups.length }} 个 · 仅当前提供商内生效</span>
              </div>
              <div
                v-for="(group, index) in visibleQuotaGroups"
                :key="group"
                class="flex flex-wrap items-center gap-1"
              >
                <input
                  :value="group"
                  class="input text-xs py-1 flex-1 min-w-0 basis-24"
                  title="修改组名会同步更新已加入该组的 Key"
                  @change="renameQuotaGroup(group, $event)"
                />
                <span class="text-[12px] text-text-muted whitespace-nowrap">
                  {{ groupKeyCount(group) }} 把
                </span>
                <button
                  type="button"
                  class="btn-ghost text-[13px] px-1.5 py-0.5 text-danger hover:bg-danger/10"
                  title="删除该组；组内 Key 会变成未分组"
                  @click="removeQuotaGroup(group)"
                >
                  删除
                </button>
                <button
                  v-if="!addingQuotaGroup && index === visibleQuotaGroups.length - 1"
                  type="button"
                  class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0"
                  title="新建一个共享额度组"
                  @click="startAddQuotaGroup"
                >
                  新建组
                </button>
              </div>
              <div
                v-if="visibleQuotaGroups.length === 0 && !addingQuotaGroup"
                class="flex flex-wrap items-center gap-1"
              >
                <span class="text-[12px] text-text-muted">还没有共享组</span>
                <button
                  type="button"
                  class="btn-ghost text-[14px] px-1.5 py-0.5 flex-shrink-0"
                  title="新建一个共享额度组"
                  @click="startAddQuotaGroup"
                >
                  新建组
                </button>
              </div>
              <button
                v-if="form.quotaGroups.length > 1"
                type="button"
                class="btn-ghost text-[13px] px-1.5 py-0.5"
                @click="showAllQuotaGroups = !showAllQuotaGroups"
              >
                {{ showAllQuotaGroups ? '收起组' : `显示更多（共 ${form.quotaGroups.length} 个）` }}
              </button>
              <div v-if="addingQuotaGroup" class="flex flex-wrap items-center gap-1">
                <input
                  ref="newGroupInput"
                  v-model="newQuotaGroupName"
                  class="input text-xs py-1 flex-1 min-w-0 basis-24"
                  placeholder="新组名，如 account-a"
                  @keyup.enter="addQuotaGroup"
                  @keyup.esc="cancelAddQuotaGroup"
                />
                <button
                  type="button"
                  class="btn-ghost text-[13px] px-1.5 py-0.5"
                  @click="addQuotaGroup"
                >
                  确定
                </button>
                <button
                  type="button"
                  class="btn-ghost text-[13px] px-1.5 py-0.5"
                  @click="cancelAddQuotaGroup"
                >
                  取消
                </button>
              </div>
              <div v-else-if="form.quotaGroups.length === 0" class="text-[12px] text-text-muted">
                新建组后，在每行 Key 右侧的下拉里选择它
              </div>
            </div>
          </div>
          <span class="text-text-muted pt-2">模型</span>
          <div class="space-y-1">
            <div
              v-for="(item, index) in form.modelInputs"
              :key="index"
              class="flex flex-wrap items-center gap-1"
            >
              <div class="relative flex-1 min-w-0 basis-32">
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
              <input
                :value="form.modelAliasInputs[index]"
                class="input text-xs py-1 flex-1 min-w-0 basis-32"
                :placeholder="index === 0 ? '别名（可选，多个用逗号）' : '别名'"
                title="客户端可用这个别名调用该模型；多个别名用逗号分隔"
                @input="form.modelAliasInputs[index] = $event.target.value"
              />
              <button
                v-if="index === form.modelInputs.length - 1"
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
          <span class="text-text-muted pt-2">限流</span>
          <div class="flex flex-wrap items-center gap-2">
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
          <div
            class="col-span-2 min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-text-muted"
          >
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
              <template v-if="form.quotaWindowMode !== 'calendar-month'">
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
              </template>
              <label
                v-else
                class="flex items-center gap-1"
                title="自然月额度：每月 1 日清零（端砚墨点口径），用尽后锁定到下月 1 日"
              >
                每月
                <input
                  v-model.number="form.quotaLimitMonth"
                  type="number"
                  min="0"
                  step="0.1"
                  class="w-16 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
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
              <label
                class="flex items-center gap-1"
                title="商汤等按模型分别限次的上游：每个模型单独记账、单独锁定"
              >
                <input v-model="form.quotaPerModel" type="checkbox" />
                按模型独立
              </label>
              <label
                class="flex items-center gap-1"
                title="预留一部分额度给突发与故障转移重试，避免同一时刻把所有 Key 打满"
              >
                预留
                <input
                  v-model.number="form.quotaReservePercent"
                  type="number"
                  min="0"
                  max="80"
                  class="w-10 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                />
                %
              </label>
              <label
                class="flex items-center gap-1"
                title="锁定到期后先小流量探测，成功后再逐步恢复到全速，避免解锁即再次撞墙"
              >
                渐进
                <input
                  v-model.number="form.quotaWarmupMinutes"
                  type="number"
                  min="0"
                  max="60"
                  class="w-10 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                />
                分钟
              </label>
              <label
                class="flex items-center gap-1"
                title="超过这个时间跨度仍未凑齐的 429 视为不同事件，避免隔几天误锁"
              >
                观察窗
                <input
                  v-model.number="form.quotaStrikesSpan"
                  type="number"
                  min="1"
                  max="120"
                  class="w-10 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                />
                分钟
              </label>
              <label
                class="flex items-center gap-1"
                title="高频持续 429 达到该次数也直接判定耗尽；0 表示关闭"
              >
                突发
                <input
                  v-model.number="form.quotaBurstStrikes"
                  type="number"
                  min="0"
                  max="100"
                  class="w-10 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                />
                次
              </label>
            </template>
          </div>
        </div>
        <div
          v-if="form.quotaEnabled && form.quotaPerModel"
          class="rounded-md border border-border-light bg-surface-alt/60 px-2 py-1.5 flex flex-col gap-1"
        >
          <div class="text-[13px] text-text-muted">按模型上限（留 0 表示沿用上面的默认值）</div>
          <div
            v-for="model in quotaModelList"
            :key="model"
            class="flex items-center gap-1.5 text-[13px] text-text-muted"
          >
            <span class="min-w-0 flex-1 truncate" :title="model">{{ model }}</span>
            <input
              v-model.number="form.quotaModelLimits[model].limit5h"
              type="number"
              min="0"
              class="w-16 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
              title="该模型的 5 小时上限"
            />
            <input
              v-model.number="form.quotaModelLimits[model].limitWeek"
              type="number"
              min="0"
              class="w-20 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
              title="该模型的 7 天上限"
            />
            <input
              v-if="form.quotaMetric === 'credit'"
              v-model.number="form.quotaModelRates[model]"
              type="number"
              min="0"
              step="0.1"
              class="w-16 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
              title="该模型每百万 tokens 折算的积分；0 表示沿用全局值"
            />
          </div>
          <div v-if="quotaModelList.length === 0" class="text-[13px] text-text-muted">
            先在上方填写模型名
          </div>
        </div>
        <div v-if="presetNote" class="text-[14px] text-text-muted">{{ presetNote }}</div>
        <div class="flex items-center gap-2 pt-0.5">
          <button
            v-if="!editingId"
            class="btn-primary text-sm px-3 py-1.5 flex-1"
            @click="submitProvider"
          >
            添加提供商
          </button>
          <button
            v-if="!editingId && form.presetId && presetDocs"
            class="btn-ghost text-sm px-3 py-1.5"
            @click="openDocs"
          >
            文档
          </button>
          <span v-if="editingId" class="text-[13px] text-text-muted">{{ autoSaveText }}</span>
        </div>
      </div>
    </div>

    <!-- 提供商选项卡 -->
    <div v-if="false" class="flex-1 min-h-0 flex flex-col gap-1.5">
      <div
        v-if="relayStore.providers.length === 0"
        class="h-full flex flex-col items-center justify-center text-center gap-1.5 px-4"
      >
        <div class="text-text-muted text-sm">还没有提供商</div>
        <div class="text-[14px] text-text-muted leading-relaxed">
          添加上游后启动服务，把客户端的 Base URL 指向本地端点，即按模型名自动路由
        </div>
      </div>

      <template v-else>
        <!-- 每个提供商一个选项卡 -->
        <div class="flex items-center gap-1 overflow-x-auto flex-shrink-0 pb-0.5">
          <button
            v-for="(provider, index) in relayStore.providers"
            :key="provider.id"
            type="button"
            class="provider-tab flex items-center gap-1 px-2 py-1 rounded-card border text-[14px] whitespace-nowrap transition-colors"
            :class="
              activeProvider?.id === provider.id
                ? 'bg-accent text-white border-accent'
                : 'bg-surface-alt text-text-secondary border-border-light hover:bg-surface-hover'
            "
            :title="provider.baseUrl"
            @click="activeProviderId = provider.id"
          >
            <span
              class="w-1.5 h-1.5 rounded-full flex-shrink-0"
              :class="provider.enabled === false ? 'bg-text-muted' : 'bg-success'"
            ></span>
            {{ index + 1 }}. {{ provider.name }}
          </button>
        </div>

        <!-- 当前选项卡的提供商信息 -->
        <div v-if="activeProvider" class="flex-1 min-h-0 overflow-y-auto">
          <div
            class="rounded-card border p-2 space-y-2"
            :class="
              activeProvider.enabled === false
                ? 'border-border bg-surface-alt/60'
                : 'border-border-light bg-surface-alt'
            "
          >
            <div class="flex items-start gap-1.5">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1">
                  <span
                    class="text-sm font-medium text-text-primary truncate"
                    :title="activeProvider.name"
                  >
                    {{ activeProvider.name }}
                  </span>
                  <span v-if="activeProvider.enabled === false" class="text-[13px] text-text-muted">
                    （已停用）
                  </span>
                </div>
                <div
                  class="text-[14px] text-text-muted truncate cursor-pointer hover:text-accent"
                  :title="`点击复制 ${activeProvider.baseUrl}`"
                  @click="copyProviderUrl(activeProvider)"
                >
                  {{ activeProvider.baseUrl }}
                </div>
              </div>
              <label
                class="relative inline-flex items-center cursor-pointer flex-shrink-0 mt-1"
                :title="activeProvider.enabled === false ? '已停用，点击启用' : '已启用，点击停用'"
              >
                <input
                  type="checkbox"
                  class="sr-only peer"
                  :checked="activeProvider.enabled !== false"
                  @change="relayStore.toggleProvider(activeProvider.id)"
                />
                <span
                  class="relative w-7 h-4 rounded-full bg-border-light peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-3 after:h-3 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-3"
                ></span>
              </label>
              <button
                class="btn-ghost text-[13px] px-1 py-0 leading-none flex-shrink-0"
                title="编辑该提供商的名称 / Key / 模型 / 限流"
                @click="startEdit(activeProvider)"
              >
                编辑
              </button>
              <button
                class="btn-ghost text-[13px] px-1 py-0 leading-none flex-shrink-0 text-danger hover:bg-danger/10"
                title="删除该提供商"
                @click="removeProvider(activeProvider)"
              >
                删除
              </button>
            </div>

            <div class="grid grid-cols-[auto,1fr] items-start gap-x-2 gap-y-1 text-[14px]">
              <span class="text-text-muted pt-0.5">Key</span>
              <div class="flex flex-wrap items-center gap-1 min-w-0">
                <code
                  v-for="key in providerKeys(activeProvider)"
                  :key="key"
                  class="text-[13px] text-text-primary"
                  :title="'只显示 Key 尾号'"
                >
                  …{{ key.slice(-6) }}
                </code>
                <span v-if="providerKeys(activeProvider).length === 0" class="text-text-muted">
                  未配置 Key
                </span>
                <span v-else class="text-[13px] text-text-muted">
                  共 {{ providerKeys(activeProvider).length }} 把
                </span>
              </div>

              <span class="text-text-muted pt-0.5">模型</span>
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1">
                  <span
                    v-for="model in activeProvider.models || []"
                    :key="model"
                    class="px-1.5 py-0.5 rounded bg-surface text-[13px] text-text-primary border border-border-light"
                    :title="model"
                  >
                    {{ model }}
                  </span>
                  <span v-if="(activeProvider.models || []).length === 0" class="text-text-muted">
                    尚未配置模型
                  </span>
                </div>
                <div
                  v-if="aliasEntries(activeProvider).length > 0"
                  class="text-[13px] text-text-muted mt-1 break-words"
                >
                  别名：<template
                    v-for="(entry, index) in aliasEntries(activeProvider)"
                    :key="entry[0]"
                  >
                    <span v-if="index > 0">，</span>{{ entry[0] }} → {{ entry[1] }}
                  </template>
                </div>
              </div>

              <span class="text-text-muted pt-0.5">限流</span>
              <span class="text-text-primary break-words" :title="limitTitle(activeProvider)">
                {{ limitLabel(activeProvider) }}
              </span>

              <span class="text-text-muted pt-0.5">额度</span>
              <div class="text-text-primary">
                <template v-if="activeProvider.quota?.enabled">
                  <div
                    v-for="item in quotaKeysOf(activeProvider)"
                    :key="item.id"
                    class="text-[13px]"
                  >
                    …{{ item.keyTail }}：5h {{ item.used5h }}/{{ item.limit5h || '∞' }}
                    {{ item.metric === 'credit' ? '墨点' : '次' }} · 7d {{ item.usedWeek }}/{{
                      item.limitWeek || '∞'
                    }}
                    <span v-if="item.exhausted" class="text-danger">· 已用尽</span>
                  </div>
                  <div
                    v-if="quotaKeysOf(activeProvider).length === 0"
                    class="text-[13px] text-text-muted"
                  >
                    5h ≤ {{ activeProvider.quota.limit5h || '∞' }} · 7d ≤
                    {{ activeProvider.quota.limitWeek || '∞' }}（每 Key 独立）
                  </div>
                </template>
                <span v-else class="text-text-muted">未启用</span>
              </div>
            </div>

            <div class="flex items-center gap-2 pt-0.5">
              <span class="text-[13px] text-text-muted">
                优先级 {{ providerIndex(activeProvider) + 1 }} /
                {{ relayStore.providers.length }}
              </span>
              <div class="flex items-center gap-0.5 ml-auto">
                <button
                  class="btn-ghost text-[14px] w-5 h-5 leading-none"
                  title="上移（优先使用）"
                  :disabled="providerIndex(activeProvider) === 0"
                  @click="relayStore.moveProvider(activeProvider.id, -1)"
                >
                  ↑
                </button>
                <button
                  class="btn-ghost text-[14px] w-5 h-5 leading-none"
                  title="下移（故障时后备用）"
                  :disabled="providerIndex(activeProvider) === relayStore.providers.length - 1"
                  @click="relayStore.moveProvider(activeProvider.id, 1)"
                >
                  ↓
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

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
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
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
      // 一个输入框只放一个值：Key / 模型（含别名）都可以按需追加多行
      apiKeyInputs: [''],
      // 与 apiKeyInputs 一一对应：每把 Key 的共享额度组（留空表示未分组）
      apiKeyGroups: [''],
      // 当前提供商下已定义的共享组（允许空组，便于先建组再往里加 Key）
      quotaGroups: [],
      modelInputs: [''],
      modelAliasInputs: [''],
      maxConcurrency: 4,
      rpmLimit: 0,
      // 端砚专项策略：只有 duanyan 使用，其它提供商留空 / 0 走默认口径
      strategy: '',
      queueTimeoutMs: 0,
      quotaEnabled: false,
      quotaMetric: 'request',
      quotaWindowMode: 'rolling',
      quotaLimitMonth: 0,
      quotaLimit5h: 0,
      quotaLimitWeek: 0,
      quotaCreditsPerMillion: 4,
      quotaStrikes: 3,
      quotaInterval: 1,
      quotaPerModel: false,
      quotaGroup: '',
      quotaReservePercent: 10,
      quotaStrikesSpan: 9,
      quotaBurstStrikes: 0,
      quotaWarmupMinutes: 5,
      quotaModelLimits: {},
      quotaModelRates: {},
    })

    const presetNote = computed(() => findPreset(form.presetId)?.note || '')
    const presetDocs = computed(() => findPreset(form.presetId)?.docs || '')

    // 共享组管理：新建组名输入
    const newQuotaGroupName = ref('')
    // 组列表默认只展开第一组；新建组时用按钮唤出输入行，避免常驻空输入框
    const showAllQuotaGroups = ref(false)
    const addingQuotaGroup = ref(false)
    const newGroupInput = ref(null)
    const visibleQuotaGroups = computed(() =>
      showAllQuotaGroups.value ? form.quotaGroups : form.quotaGroups.slice(0, 1),
    )
    const groupKeyCount = (name) =>
      form.apiKeyInputs.reduce((count, key, index) => {
        const filled = String(key || '').trim()
        return filled && form.apiKeyGroups[index] === name ? count + 1 : count
      }, 0)
    const startAddQuotaGroup = () => {
      addingQuotaGroup.value = true
      nextTick(() => newGroupInput.value?.focus?.())
    }
    const cancelAddQuotaGroup = () => {
      addingQuotaGroup.value = false
      newQuotaGroupName.value = ''
    }
    const addQuotaGroup = () => {
      const name = newQuotaGroupName.value.trim()
      if (!name) {
        cancelAddQuotaGroup()
        return
      }
      if (form.quotaGroups.includes(name)) {
        toastStore.addToast(`共享组「${name}」已存在`, 'warning')
        return
      }
      form.quotaGroups.push(name)
      newQuotaGroupName.value = ''
      addingQuotaGroup.value = false
      // 新组落在折叠区外时自动展开，避免“点了确定却看不到”
      if (form.quotaGroups.length > 1) showAllQuotaGroups.value = true
    }
    const renameQuotaGroup = (oldName, event) => {
      const name = String(event?.target?.value || '').trim()
      if (!name || name === oldName) {
        if (event?.target) event.target.value = oldName
        return
      }
      if (form.quotaGroups.includes(name)) {
        toastStore.addToast(`共享组「${name}」已存在`, 'warning')
        if (event?.target) event.target.value = oldName
        return
      }
      const index = form.quotaGroups.indexOf(oldName)
      if (index === -1) return
      form.quotaGroups.splice(index, 1, name)
      form.apiKeyGroups = form.apiKeyGroups.map((group) => (group === oldName ? name : group))
      if (form.quotaGroup === oldName) form.quotaGroup = name
    }
    const removeQuotaGroup = (name) => {
      form.quotaGroups = form.quotaGroups.filter((group) => group !== name)
      form.apiKeyGroups = form.apiKeyGroups.map((group) => (group === name ? '' : group))
      if (form.quotaGroup === name) form.quotaGroup = ''
      if (form.quotaGroups.length <= 1) showAllQuotaGroups.value = false
    }

    // 按模型独立额度：以表单里的模型行为准，自动补齐缺失的限额行
    const quotaModelNames = computed(() =>
      form.modelInputs.map((item) => String(item || '').trim()).filter(Boolean),
    )
    // 模板只渲染已经补齐限额的模型，避免 v-model 读写到 undefined
    const quotaModelList = computed(() =>
      quotaModelNames.value.filter((model) => form.quotaModelLimits[model]),
    )
    function ensureQuotaModelLimits() {
      const next = {}
      for (const model of quotaModelNames.value) {
        const current = form.quotaModelLimits?.[model]
        next[model] = current
          ? {
              limit5h: Number(current.limit5h) || 0,
              limitWeek: Number(current.limitWeek) || 0,
            }
          : {
              limit5h: Number(form.quotaLimit5h) || 0,
              limitWeek: Number(form.quotaLimitWeek) || 0,
            }
      }
      form.quotaModelLimits = next
      // 积分模式下允许每个模型有不同的 tokens→积分换算率
      const nextRates = {}
      for (const model of quotaModelNames.value) {
        nextRates[model] = Number(form.quotaModelRates?.[model]) || 0
      }
      form.quotaModelRates = nextRates
    }

    // API Key 区：一键明文 / 一键测通（结果按输入行保存）
    const showApiKeys = ref(false)
    // 默认只展开第一把 Key，其余折叠；点「显示更多」再展开
    const showAllKeys = ref(false)
    const keyTesting = ref(false)
    const keyTests = ref([])

    const addingProvider = ref(false)
    // 删除模式：开启后每个提供商选项卡显示 × 图标
    const deleteMode = ref(false)
    // 提供商选项卡：选中的 id 失效时自动回退到第一个
    const activeProviderId = ref('')
    const activeProvider = computed(() => {
      const list = relayStore.providers
      return list.find((item) => item.id === activeProviderId.value) || list[0] || null
    })
    const providerIndex = (provider) =>
      relayStore.providers.findIndex((item) => item.id === provider?.id)
    const providerKeys = (provider) =>
      [...(provider?.apiKeys || []), provider?.apiKey]
        .map((key) => (typeof key === 'string' ? key.trim() : ''))
        .filter(Boolean)
        .filter((key, index, list) => list.indexOf(key) === index)
    const aliasEntries = (provider) => Object.entries(provider?.modelAliases || {})
    const copyProviderUrl = async (provider) => {
      try {
        await navigator.clipboard.writeText(provider.baseUrl)
        toastStore.addToast('已复制 Base URL', 'success')
      } catch {
        toastStore.addToast('复制失败，请手动选择', 'error')
      }
    }
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
      suppressAutoSave = true
      modelPicker.visible = false
      form.presetId = ''
      form.name = ''
      form.baseUrl = ''
      form.apiKeyInputs = ['']
      form.apiKeyGroups = ['']
      form.quotaGroups = []
      newQuotaGroupName.value = ''
      showAllQuotaGroups.value = false
      addingQuotaGroup.value = false
      form.modelInputs = ['']
      form.modelAliasInputs = ['']
      showApiKeys.value = false
      showAllKeys.value = false
      keyTesting.value = false
      keyTests.value = []
      form.maxConcurrency = 4
      form.rpmLimit = 0
      form.strategy = ''
      form.queueTimeoutMs = 0
      form.quotaEnabled = false
      form.quotaMetric = 'request'
      form.quotaWindowMode = 'rolling'
      form.quotaLimitMonth = 0
      form.quotaLimit5h = 0
      form.quotaLimitWeek = 0
      form.quotaCreditsPerMillion = 4
      form.quotaStrikes = 3
      form.quotaInterval = 1
      form.quotaPerModel = false
      form.quotaGroup = ''
      form.quotaReservePercent = 10
      form.quotaStrikesSpan = 9
      form.quotaBurstStrikes = 0
      form.quotaWarmupMinutes = 5
      form.quotaModelLimits = {}
      form.quotaModelRates = {}
      editingId.value = null
      autoSaveState.value = 'idle'
      nextTick(() => {
        suppressAutoSave = false
      })
    }

    // 编辑已有提供商：把 Key / 模型拆回一行一个的输入框
    const startEdit = (provider) => {
      suppressAutoSave = true
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
      const keyGroups = provider.quota?.keyGroups || {}
      const defaultGroup = provider.quota?.group || ''
      // 每把 Key 优先取自己的组，没填则回落到默认组，方便老配置继续显示
      form.apiKeyGroups = keys.map((key) => keyGroups[String(key).trim()] || defaultGroup)
      // 组列表：新配置读 groups；老配置从 Key 归属与默认组派生，保证组件里能看到现有组
      const savedGroups = Array.isArray(provider.quota?.groups) ? provider.quota.groups : []
      form.quotaGroups = [
        ...new Set(
          [...savedGroups, ...Object.values(keyGroups).filter(Boolean), defaultGroup].filter(
            Boolean,
          ),
        ),
      ]
      showApiKeys.value = false
      showAllKeys.value = false
      // 切换提供商时重置共享组的折叠与新建状态
      showAllQuotaGroups.value = false
      addingQuotaGroup.value = false
      newQuotaGroupName.value = ''
      keyTests.value = keys.map(() => null)
      form.modelInputs = [...models]
      // 别名按上游模型归位：同一模型有多个客户端别名时用逗号合并到该行
      form.modelAliasInputs = models.map((model) =>
        Object.entries(aliases)
          .filter(([, to]) => to === model)
          .map(([from]) => from)
          .join(', '),
      )
      form.maxConcurrency = Number(provider.maxConcurrency) > 0 ? provider.maxConcurrency : 4
      form.rpmLimit = Number(provider.rpmLimit) > 0 ? provider.rpmLimit : 0
      form.strategy = provider.strategy || (provider.presetId === 'duanyan' ? 'duanyan' : '')
      form.queueTimeoutMs = Number(provider.queueTimeoutMs) || 0
      const quota = provider.quota || {}
      form.quotaEnabled = quota.enabled === true
      form.quotaMetric = quota.metric === 'credit' ? 'credit' : 'request'
      form.quotaWindowMode = quota.windowMode === 'calendar-month' ? 'calendar-month' : 'rolling'
      form.quotaLimitMonth = Number(quota.limitMonth) || 0
      form.quotaLimit5h = Number(quota.limit5h) || 0
      form.quotaLimitWeek = Number(quota.limitWeek) || 0
      form.quotaCreditsPerMillion = Number(quota.creditsPerMillionTokens) || 4
      form.quotaStrikes = Number(quota.confirmStrikes) > 0 ? Number(quota.confirmStrikes) : 3
      form.quotaInterval =
        Number(quota.confirmIntervalMinutes) > 0 ? Number(quota.confirmIntervalMinutes) : 1
      form.quotaPerModel = quota.perModel === true
      form.quotaGroup = quota.group || ''
      form.quotaReservePercent = Math.round((Number(quota.reserveRatio) || 0) * 100)
      form.quotaStrikesSpan =
        Number(quota.confirmSpanMinutes) > 0 ? Number(quota.confirmSpanMinutes) : 9
      form.quotaBurstStrikes = Number(quota.burstStrikes) || 0
      form.quotaWarmupMinutes = Number(quota.warmupMinutes) > 0 ? Number(quota.warmupMinutes) : 5
      form.quotaModelLimits = {}
      form.quotaModelRates = {}
      for (const [model, value] of Object.entries(quota.modelLimits || {})) {
        form.quotaModelLimits[model] = {
          limit5h: Number(value?.limit5h) || 0,
          limitWeek: Number(value?.limitWeek) || 0,
        }
      }
      for (const [model, value] of Object.entries(quota.modelRates || {})) {
        form.quotaModelRates[model] = Number(value) || 0
      }
      ensureQuotaModelLimits()
      editingId.value = provider.id
      modelPicker.visible = false
      autoSaveState.value = 'idle'
      nextTick(() => {
        suppressAutoSave = false
      })
    }

    const autoSaveState = ref('idle')
    let autoSaveTimer = null
    // 程序化填充表单时不要触发自动保存
    let suppressAutoSave = false

    const autoSaveText = computed(() => {
      if (autoSaveState.value === 'saving') return '保存中…'
      if (autoSaveState.value === 'saved') return '已自动保存'
      if (autoSaveState.value === 'invalid') return '名称和 Base URL 必填'
      return '修改后自动保存'
    })

    const buildProviderPayload = () => {
      const models = form.modelInputs.map((item) => item.trim()).filter(Boolean)
      // 每个模型行后面的别名输入框：客户端模型名 -> 该行的上游真实模型
      const modelAliases = {}
      form.modelInputs.forEach((item, index) => {
        const target = String(item || '').trim()
        if (!target) return
        for (const part of String(form.modelAliasInputs[index] || '').split(/[,，]/)) {
          const alias = part.trim()
          if (alias) modelAliases[alias] = target
        }
      })

      // 每把 Key 的共享组：Key 是明文（配置里本来就存明文），直接作为映射键
      const keyGroups = {}
      form.apiKeyInputs.forEach((item, index) => {
        const key = String(item || '').trim()
        const group = String(form.apiKeyGroups[index] || '').trim()
        if (key && group) keyGroups[key] = group
      })
      const quotaGroups = [
        ...new Set([...form.quotaGroups, ...Object.values(keyGroups)].filter(Boolean)),
      ]

      return {
        name: form.name,
        baseUrl: form.baseUrl,
        apiKeys: form.apiKeyInputs.map((item) => item.trim()).filter(Boolean),
        models,
        modelAliases,
        maxConcurrency: Number(form.maxConcurrency) || 4,
        rpmLimit: Number(form.rpmLimit) || 0,
        // 端砚专项策略透传；其它提供商为空即保持原有限流口径
        strategy: form.strategy || '',
        queueTimeoutMs: Number(form.queueTimeoutMs) || 0,
        quota: {
          enabled: form.quotaEnabled,
          metric: form.quotaMetric,
          windowMode: form.quotaWindowMode === 'calendar-month' ? 'calendar-month' : 'rolling',
          limitMonth: Number(form.quotaLimitMonth) || 0,
          limit5h: Number(form.quotaLimit5h) || 0,
          limitWeek: Number(form.quotaLimitWeek) || 0,
          creditsPerMillionTokens: Number(form.quotaCreditsPerMillion) || 0,
          confirmStrikes: Number(form.quotaStrikes) || 0,
          confirmIntervalMinutes: Number(form.quotaInterval) || 0,
          confirmSpanMinutes: Number(form.quotaStrikesSpan) || 0,
          burstStrikes: Number(form.quotaBurstStrikes) || 0,
          reserveRatio: Math.min(0.9, Math.max(0, Number(form.quotaReservePercent) || 0) / 100),
          warmupMinutes: Number(form.quotaWarmupMinutes) || 0,
          perModel: form.quotaPerModel,
          // 默认组仅用于老配置回填；新保存完全由每把 Key 的归组决定
          group: '',
          groups: quotaGroups,
          keyGroups,
          modelLimits: form.quotaPerModel ? { ...form.quotaModelLimits } : {},
          modelRates: form.quotaPerModel ? { ...form.quotaModelRates } : {},
        },
      }
    }

    const saveCurrentProvider = async () => {
      const id = editingId.value
      if (!id) return
      const payload = buildProviderPayload()
      if (!payload.name.trim() || !payload.baseUrl.trim()) {
        autoSaveState.value = 'invalid'
        return
      }
      autoSaveState.value = 'saving'
      await relayStore.updateProvider(id, payload)
      autoSaveState.value = 'saved'
    }

    const flushAutoSave = async () => {
      if (!autoSaveTimer) return
      clearTimeout(autoSaveTimer)
      autoSaveTimer = null
      await saveCurrentProvider()
    }

    watch(
      () => [
        form.name,
        form.baseUrl,
        form.apiKeyInputs.join('\u0000'),
        form.modelInputs.join('\u0000'),
        form.modelAliasInputs.join('\u0000'),
        form.maxConcurrency,
        form.rpmLimit,
        form.quotaEnabled,
        form.quotaMetric,
        form.quotaLimit5h,
        form.quotaLimitWeek,
        form.quotaCreditsPerMillion,
        form.quotaStrikes,
        form.quotaInterval,
        form.quotaPerModel,
        form.quotaGroup,
        form.quotaReservePercent,
        form.quotaStrikesSpan,
        form.quotaBurstStrikes,
        form.quotaWarmupMinutes,
        JSON.stringify(form.quotaModelLimits),
        JSON.stringify(form.quotaModelRates),
      ],
      () => {
        if (!editingId.value || suppressAutoSave) return
        autoSaveState.value = 'saving'
        if (autoSaveTimer) clearTimeout(autoSaveTimer)
        autoSaveTimer = setTimeout(() => {
          autoSaveTimer = null
          saveCurrentProvider()
        }, 500)
      },
    )

    watch(
      () => [form.quotaPerModel, form.modelInputs.join('\u0000')],
      () => {
        ensureQuotaModelLimits()
      },
    )

    // 选中选项卡：先保存待写入的修改，再加载该提供商的编辑页
    const selectProvider = async (provider) => {
      if (!provider) return
      await flushAutoSave()
      activeProviderId.value = provider.id
      addingProvider.value = false
      deleteMode.value = false
      startEdit(provider)
    }

    // 末尾加号选项卡：切换到空白新增表单
    const startAdd = async () => {
      await flushAutoSave()
      addingProvider.value = true
      activeProviderId.value = ''
      deleteMode.value = false
      resetForm()
    }

    watch(
      () => relayStore.providers.map((item) => item.id).join(','),
      () => {
        if (addingProvider.value) return
        const exists = relayStore.providers.some((item) => item.id === activeProviderId.value)
        if (exists) return
        if (relayStore.providers.length > 0) selectProvider(relayStore.providers[0])
        else resetForm()
      },
      { immediate: true },
    )

    const onApiKeyInput = (index, value) => {
      form.apiKeyInputs[index] = value
      // Key 被修改后，之前的测通结果立即失效
      if (keyTests.value[index]) keyTests.value[index] = null
    }

    const addApiKeyInput = () => {
      form.apiKeyInputs.push('')
      form.apiKeyGroups.push('')
      keyTests.value.push(null)
      // 新增后展开，确保新行立即可见
      showAllKeys.value = true
    }
    const removeApiKeyInput = (index) => {
      if (form.apiKeyInputs.length > 1) {
        form.apiKeyInputs.splice(index, 1)
        form.apiKeyGroups.splice(index, 1)
        keyTests.value.splice(index, 1)
      }
    }

    // 一键测通：每个输入框单独请求一次上游 /models，互不掩盖失败
    const testAllKeys = async () => {
      const baseUrl = form.baseUrl.trim()
      if (!baseUrl) {
        toastStore.addToast('先填写 Base URL 再测通', 'warning')
        return
      }
      const keys = form.apiKeyInputs.map((item) => item.trim())
      if (!keys.some(Boolean)) {
        toastStore.addToast('请先填写至少一个 API Key', 'warning')
        return
      }

      keyTesting.value = true
      keyTests.value = keys.map(() => null)
      try {
        await Promise.all(
          keys.map(async (key, index) => {
            if (!key) {
              keyTests.value[index] = { status: 'empty' }
              return
            }
            try {
              const result = await relayStore.testKey(baseUrl, key)
              keyTests.value[index] = result?.ok
                ? { status: 'ok', ms: result.ms, models: result.models }
                : { status: 'fail', ms: result?.ms, error: result?.error || '测通失败' }
            } catch (error) {
              keyTests.value[index] = { status: 'fail', error: error.message || '测通失败' }
            }
          }),
        )
        const filled = keys.filter(Boolean).length
        const passed = keyTests.value.filter((item) => item?.status === 'ok').length
        toastStore.addToast(
          `测通完成：${passed}/${filled} 把 Key 可用`,
          passed === filled ? 'success' : 'warning',
        )
      } finally {
        keyTesting.value = false
      }
    }

    const keyTestText = (result) => {
      if (!result) return ''
      if (result.status === 'ok') return `✓ ${result.ms}ms`
      if (result.status === 'fail') return '✗ 失败'
      return '空'
    }

    const keyTestClass = (result) => {
      if (result?.status === 'ok') return 'text-success'
      if (result?.status === 'fail') return 'text-danger'
      return 'text-text-muted'
    }

    const keyTestTitle = (result) => {
      if (result?.status === 'ok') {
        return `可用 · 返回 ${result.models} 个模型 · 耗时 ${result.ms}ms`
      }
      if (result?.status === 'fail') return result.error || '测通失败'
      return '这一行还没有填写 Key'
    }

    const addModelInput = () => {
      form.modelInputs.push('')
      form.modelAliasInputs.push('')
    }
    const removeModelInput = (index) => {
      if (form.modelInputs.length > 1) {
        form.modelInputs.splice(index, 1)
        form.modelAliasInputs.splice(index, 1)
      }
    }

    const applyPreset = () => {
      const preset = findPreset(form.presetId)
      if (!preset) return
      form.name = preset.name
      form.baseUrl = preset.baseUrl
      form.modelInputs = preset.models.length > 0 ? [...preset.models] : ['']
      form.modelAliasInputs = form.modelInputs.map(() => '')
      // 应用预设只补齐组输入的行数，不覆盖用户已经填好的 Key 分组
      form.apiKeyGroups = form.apiKeyInputs.map((_, index) => form.apiKeyGroups[index] || '')
      form.quotaGroups = [...new Set([...form.quotaGroups, ...form.apiKeyGroups.filter(Boolean)])]
      if (Number(preset.maxConcurrency) > 0) form.maxConcurrency = Number(preset.maxConcurrency)
      if (Number(preset.rpmLimit) > 0) form.rpmLimit = Number(preset.rpmLimit)
      form.strategy = preset.strategy || ''
      form.queueTimeoutMs = Number(preset.queueTimeoutMs) || 0
      const quota = preset.quota
      form.quotaEnabled = quota?.enabled === true
      form.quotaMetric = quota?.metric === 'credit' ? 'credit' : 'request'
      form.quotaWindowMode = quota?.windowMode === 'calendar-month' ? 'calendar-month' : 'rolling'
      form.quotaLimitMonth = Number(quota?.limitMonth) || 0
      form.quotaLimit5h = Number(quota?.limit5h) || 0
      form.quotaLimitWeek = Number(quota?.limitWeek) || 0
      form.quotaCreditsPerMillion = Number(quota?.creditsPerMillionTokens) || 4
      form.quotaStrikes = Number(quota?.confirmStrikes) > 0 ? Number(quota?.confirmStrikes) : 3
      form.quotaInterval =
        Number(quota?.confirmIntervalMinutes) > 0 ? Number(quota?.confirmIntervalMinutes) : 1
      form.quotaPerModel = quota?.perModel === true
      form.quotaGroup = quota?.group || ''
      form.quotaReservePercent = Math.round((Number(quota?.reserveRatio) || 0) * 100)
      form.quotaStrikesSpan =
        Number(quota?.confirmSpanMinutes) > 0 ? Number(quota?.confirmSpanMinutes) : 9
      form.quotaBurstStrikes = Number(quota?.burstStrikes) || 0
      form.quotaWarmupMinutes = Number(quota?.warmupMinutes) > 0 ? Number(quota?.warmupMinutes) : 5
      form.quotaModelLimits = {}
      form.quotaModelRates = {}
      for (const [model, value] of Object.entries(quota?.modelLimits || {})) {
        form.quotaModelLimits[model] = {
          limit5h: Number(value?.limit5h) || 0,
          limitWeek: Number(value?.limitWeek) || 0,
        }
      }
      for (const [model, value] of Object.entries(quota?.modelRates || {})) {
        form.quotaModelRates[model] = Number(value) || 0
      }
      ensureQuotaModelLimits()
    }

    const submitProvider = async () => {
      // 编辑模式由自动保存处理，这里只负责新增
      if (editingId.value) return
      const payload = buildProviderPayload()
      if (!payload.name.trim() || !payload.baseUrl.trim()) {
        toastStore.addToast('名称和 Base URL 必填', 'warning')
        return
      }

      const created = await relayStore.addProvider({
        ...payload,
        presetId: form.presetId || undefined,
      })
      // 新添加的提供商自动成为当前选项卡并展示编辑页
      if (created) selectProvider(created)
      else {
        addingProvider.value = false
        resetForm()
      }
    }

    const removeProvider = async (provider) => {
      if (!confirm(`确定删除提供商「${provider.name}」吗？`)) return
      await relayStore.removeProvider(provider.id)
      if (relayStore.providers.length > 0) selectProvider(relayStore.providers[0])
      else {
        deleteMode.value = false
        addingProvider.value = false
        resetForm()
      }
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
      const scope = quota.perModel ? '按模型' : '每 Key 独立'
      const groups = [
        ...new Set([quota.group, ...Object.values(quota.keyGroups || {})].filter(Boolean)),
      ]
      const group = groups.length > 0 ? ` · 共享组 ${groups.length} 个` : ''
      const keys = quotaKeysOf(provider)
      if (keys.length > 0) {
        const usable = keys.filter((item) => !item.exhausted).length
        const maxUsed = Math.max(...keys.map((item) => Number(item.used5h) || 0))
        return ` · ${scope} · 水位 ${usable}/${keys.length} · 5h 最高 ${maxUsed}${group}`
      }
      return ` · ${scope} · 5h≤${quota.limit5h || '∞'} ${unit} / 7d≤${quota.limitWeek || '∞'}${group}`
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
      const quota = provider.quota
      if (quota?.enabled) {
        const groups = [
          ...new Set([quota.group, ...Object.values(quota.keyGroups || {})].filter(Boolean)),
        ]
        lines.push(
          '',
          `${quota.perModel ? '按模型独立额度' : '每把 Key 独立额度'}${
            groups.length ? ` · 共享组 ${groups.join(' / ')}` : ''
          }`,
        )
      }
      const keys = quotaKeysOf(provider)
      if (keys.length > 0) {
        lines.push('', '按 Key / 模型用量：')
        for (const item of keys.slice(0, 20)) {
          const unit = item.metric === 'credit' ? '墨点' : '次'
          const model = item.model ? ` [${item.model}]` : ''
          const group = item.keyGroup ? ` · 组 ${item.keyGroup}` : ''
          const weight = Number.isFinite(item.weight) ? ` · 权重 ${item.weight}` : ''
          const warm = item.warmup
            ? ` · ${item.warmup === 'probing' ? '半开探测' : '渐进恢复'}`
            : ''
          const status = item.exhausted
            ? ` · ${item.locked ? '429 确认额度耗尽' : '额度已用尽'}（${item.retryAfter}s 后恢复）`
            : ''
          lines.push(
            `…${item.keyTail}${model}: 5h ${item.used5h}/${item.limit5h || '∞'} ${unit}${group}${weight}${warm}${status}`,
          )
        }
        if (keys.length > 20) lines.push(`…… 其余 ${keys.length - 20} 行已省略`)
      }
      return lines.join('\n')
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
      addingProvider,
      deleteMode,
      selectProvider,
      startAdd,
      autoSaveText,
      autoSaveState,
      flushAutoSave,
      editingId,
      modelPicker,
      activeProviderId,
      activeProvider,
      providerIndex,
      providerKeys,
      aliasEntries,
      copyProviderUrl,
      quotaKeysOf,
      quotaModelList,
      newQuotaGroupName,
      showAllQuotaGroups,
      addingQuotaGroup,
      newGroupInput,
      visibleQuotaGroups,
      startAddQuotaGroup,
      cancelAddQuotaGroup,
      groupKeyCount,
      addQuotaGroup,
      renameQuotaGroup,
      removeQuotaGroup,
      showApiKeys,
      showAllKeys,
      keyTesting,
      keyTests,
      onApiKeyInput,
      testAllKeys,
      keyTestText,
      keyTestClass,
      keyTestTitle,
      presetNote,
      presetDocs,
      RELAY_PRESETS,
      applyPreset,
      startEdit,
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
      limitLabel,
      limitTitle,
    }
  },
}
</script>

<style scoped></style>
