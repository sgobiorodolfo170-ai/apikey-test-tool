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
        <label
          class="flex items-center gap-1"
          title="允许局域网内其它设备访问中转站（默认关闭）。开启前必须设置访问 Key，且需重启中转站生效。"
        >
          <input type="checkbox" :checked="relayStore.lanEnabled" @change="setLanEnabled($event)" />
          局域网访问
        </label>
      </div>

      <!-- 默认上游：模型未命中时回退到它；只写 defaultProviderId，不碰凭据 -->
      <div class="flex flex-wrap items-center gap-2 text-[14px] text-text-muted">
        <span class="flex-shrink-0">默认上游</span>
        <select
          class="default-provider-select bg-surface border border-border-light rounded px-1.5 py-0.5 text-text-primary max-w-[16rem]"
          :value="relayStore.defaultProviderId"
          title="模型名未命中任何上游时回退到该上游；留空则未命中即 404"
          @change="setDefaultProvider($event.target.value)"
        >
          <option value="">无（未命中即 404）</option>
          <option
            v-for="provider in relayStore.providers"
            :key="provider.id"
            :value="provider.id"
            :disabled="provider.enabled === false"
          >
            {{ provider.name }}{{ provider.enabled === false ? '（已禁用）' : '' }}
          </option>
        </select>
        <span class="text-[13px] text-text-muted">模型未命中时回退 · 禁用或无 Key 时返回 503</span>
      </div>

      <!-- 局域网访问开启后的风险提示与可用地址 -->
      <div
        v-if="relayStore.lanEnabled"
        class="flex flex-col gap-1 rounded-card border border-warning/40 bg-warning/10 px-2 py-1.5 text-[13px]"
      >
        <div class="text-warning leading-relaxed">
          局域网访问已开启：同一网络内的其它设备可调用本中转站。请确保已设置访问
          Key，并只在可信网络中使用；关闭后需重启中转站生效。
        </div>
        <div v-if="relayStore.running && !relayStore.lanActive" class="text-text-muted">
          当前仍在监听本机回环，停止并重新启动中转站后才会对局域网开放。
        </div>
        <div v-if="relayStore.lanAddresses.length > 0" class="flex flex-col gap-0.5">
          <span class="text-text-muted">局域网端点（点击复制）：</span>
          <button
            v-for="nic in relayStore.lanAddresses"
            :key="nic.address"
            type="button"
            class="text-left text-text-primary hover:text-accent truncate"
            :title="`网卡：${nic.name}`"
            @click="copyLanUrl(nic.address)"
          >
            <code class="text-[13px]">http://{{ nic.address }}:{{ relayStore.port }}/v1</code>
            <span class="text-text-muted"> · {{ nic.name }}</span>
          </button>
        </div>
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
        <div class="flex items-center gap-2">
          <select
            v-model="form.presetId"
            class="preset-select select text-xs py-1 w-1/2"
            @change="applyPreset"
          >
            <option value="">自定义</option>
            <option v-for="preset in RELAY_PRESETS" :key="preset.id" :value="preset.id">
              {{ preset.name }}
            </option>
          </select>
          <label
            class="provider-enabled-toggle flex items-center gap-1.5 text-[14px] text-text-muted cursor-pointer select-none flex-shrink-0"
            :title="form.enabled ? '该提供商已启用，点击停用' : '该提供商已停用，点击启用'"
          >
            <input v-model="form.enabled" type="checkbox" class="sr-only peer" />
            <span
              class="relative w-7 h-4 rounded-full bg-border-light peer-checked:bg-accent transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-3 after:h-3 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-3"
            ></span>
            {{ form.enabled ? '启用' : '停用' }}
          </label>
        </div>
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
                title="逐个测试上方所有 Key：未选模型时只连通 /models，选中模型时对该模型发一次最小对话请求"
                @click="testAllKeys"
              >
                {{ keyTesting ? '测通中…' : '一键测通' }}
              </button>
              <select
                v-model="testModel"
                class="select text-[13px] py-0.5 max-w-[180px]"
                title="测通模型：选中后一键测通对该模型发一次最小对话请求验证真实可调通；留空则只测 /models 连通"
              >
                <option value="">默认（/models）</option>
                <option v-for="name in testModelOptions" :key="name" :value="name">
                  {{ name }}
                </option>
              </select>
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
                  title="把该 Key 加入共享账号组；同组 Key 共享真实 429 锁定"
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
                <span>共享账号组</span>
                <span>{{ form.quotaGroups.length }} 个 · 同组共享真实 429 锁定</span>
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
              title="按真实上游响应自动保护：连续真实 429 才锁定，成功即恢复；不预估积分 / 次数 / 墨点"
            >
              <input v-model="form.quotaEnabled" type="checkbox" />
              自动额度保护
            </label>
            <template v-if="form.quotaEnabled">
              <label
                class="flex items-center gap-1"
                title="连续多次、且彼此间隔足够的真实 429 才判定额度耗尽，避免把瞬时限流误判为额度用完"
              >
                429 判定
                <input
                  v-model.number="form.quotaStrikes"
                  type="number"
                  min="1"
                  max="10"
                  class="w-10 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                  title="需要累计几次真实 429 才确认"
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
              <button
                v-if="editingId && quotaKeysOf(activeProvider).some((item) => item.locked)"
                type="button"
                class="btn-ghost text-[13px] px-1.5 py-0.5 text-danger hover:bg-danger/10"
                title="清除该提供商全部 Key 的真实 429 锁定，立即重新探测上游"
                @click="unlockQuota(activeProvider)"
              >
                解除额度锁定
              </button>
            </template>
            <span v-if="form.quotaEnabled" class="text-[13px] text-text-muted">
              普通连续 429：5 分钟探测 → 5 小时 → 7 天；明确额度耗尽直接锁 5 小时，成功即恢复
            </span>
            <label
              class="flex items-center gap-1"
              title="周期性对每把 Key 发一次最小化真实调用（max_tokens=1），自动发现额度恢复 / 耗尽与无效 Key；探测会消耗少量积分"
            >
              <input v-model="form.probeEnabled" type="checkbox" />
              自动探测每把 Key
            </label>
            <template v-if="form.probeEnabled">
              <label class="flex items-center gap-1" title="每轮探测的间隔（分钟）">
                间隔
                <input
                  v-model.number="form.probeInterval"
                  type="number"
                  min="1"
                  max="720"
                  class="w-14 bg-surface-alt border border-border-light rounded px-1 py-1 text-center text-text-primary"
                />
                分钟
              </label>
              <label class="flex items-center gap-1" title="探测用的模型 ID；建议选最便宜的一个">
                探测模型
                <input
                  v-model="form.probeModel"
                  type="text"
                  placeholder="留空=列表第一个"
                  class="w-44 bg-surface-alt border border-border-light rounded px-1.5 py-1 text-text-primary"
                />
              </label>
            </template>
            <span v-if="form.probeEnabled" class="text-[13px] text-text-muted">
              官方无余额查询 API：额度状态来自自动探测 + 真实 429 记账；探测本身消耗少量积分
            </span>
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
              <div class="text-text-primary min-w-0">
                <template v-if="activeProvider.quota?.enabled">
                  <div class="flex flex-wrap items-center gap-1">
                    <span class="text-[13px] break-words">{{ quotaSummary(activeProvider) }}</span>
                    <button
                      v-if="quotaKeysOf(activeProvider).length > 0"
                      type="button"
                      class="btn-ghost text-[13px] px-1 py-0.5 flex-shrink-0"
                      @click="showQuotaKeyDetails = !showQuotaKeyDetails"
                    >
                      {{ showQuotaKeyDetails ? '收起明细' : '展开明细' }}
                    </button>
                  </div>
                  <div v-if="showQuotaKeyDetails" class="mt-0.5 space-y-0.5">
                    <div
                      v-for="item in quotaKeysOf(activeProvider)"
                      :key="item.id"
                      class="text-[13px]"
                    >
                      …{{ item.keyTail }}：{{ quotaItemLabel(item) }}
                    </div>
                  </div>
                </template>
                <span v-else class="text-text-muted">未启用</span>
              </div>

              <span class="text-text-muted pt-0.5">Key 探测</span>
              <div class="text-text-primary min-w-0">
                <div class="flex flex-wrap items-center gap-1">
                  <span class="text-[13px] break-words">{{ probeSummary(activeProvider) }}</span>
                  <button
                    type="button"
                    class="btn-ghost text-[13px] px-1 py-0.5 flex-shrink-0"
                    :disabled="relayStore.keyProbing"
                    title="立即对每把 Key 发一次最小化调用，刷新额度 / 有效性状态（消耗少量积分）"
                    @click="probeProviderKeys(activeProvider)"
                  >
                    {{ relayStore.keyProbing ? '探测中…' : '立即探测' }}
                  </button>
                  <button
                    v-if="probeRowsOf(activeProvider).length > 0"
                    type="button"
                    class="btn-ghost text-[13px] px-1 py-0.5 flex-shrink-0"
                    @click="showProbeKeyDetails = !showProbeKeyDetails"
                  >
                    {{ showProbeKeyDetails ? '收起明细' : '展开明细' }}
                  </button>
                </div>
                <div v-if="showProbeKeyDetails" class="mt-0.5 space-y-0.5">
                  <div
                    v-for="row in probeRowsOf(activeProvider)"
                    :key="row.keyTail"
                    class="text-[13px]"
                  >
                    …{{ row.keyTail }}：{{ probeRowLabel(row) }}
                  </div>
                </div>
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
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
      // 该提供商是否参与路由；停用后仍保留配置，只是不再被选中
      enabled: true,
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
      quotaStrikes: 3,
      quotaInterval: 1,
      quotaGroup: '',
      quotaStrikesSpan: 9,
      quotaBurstStrikes: 0,
      quotaWarmupMinutes: 5,
      // 自动探测每把 Key：官方无余额查询 API，用最小化真实调用推断额度与有效性
      probeEnabled: false,
      probeInterval: 30,
      probeModel: '',
    })

    const presetNote = computed(() => findPreset(form.presetId)?.note || '')
    const presetDocs = computed(() => findPreset(form.presetId)?.docs || '')

    // 共享组管理：新建组名输入
    const newQuotaGroupName = ref('')
    // 逐 Key 额度明细默认折叠，避免一长串 Key 淹没编辑表单
    const showQuotaKeyDetails = ref(false)
    // 逐 Key 探测明细同样默认折叠
    const showProbeKeyDetails = ref(false)
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

    // API Key 区：一键明文 / 一键测通（结果按输入行保存）
    const showApiKeys = ref(false)
    // 默认只展开第一把 Key，其余折叠；点「显示更多」再展开
    const showAllKeys = ref(false)
    const keyTesting = ref(false)
    const keyTests = ref([])
    // 一键测通的运行令牌：切换提供商 / 重新进入编辑后，迟到结果直接丢弃
    let keyTestRun = 0
    // 一键测通的模型选择：留空走 /models 连通测试，选中后对该模型发最小对话请求
    const testModel = ref('')
    // 下拉选项 = 表单里已填的模型名（去空、去重）
    const testModelOptions = computed(() => [
      ...new Set(form.modelInputs.map((item) => String(item).trim()).filter(Boolean)),
    ])

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
      form.enabled = true
      form.apiKeyInputs = ['']
      form.apiKeyGroups = ['']
      form.quotaGroups = []
      newQuotaGroupName.value = ''
      showAllQuotaGroups.value = false
      addingQuotaGroup.value = false
      showQuotaKeyDetails.value = false
      form.modelInputs = ['']
      form.modelAliasInputs = ['']
      showApiKeys.value = false
      showAllKeys.value = false
      keyTesting.value = false
      keyTestRun += 1
      keyTests.value = []
      form.maxConcurrency = 4
      form.rpmLimit = 0
      form.strategy = ''
      form.queueTimeoutMs = 0
      form.quotaEnabled = false
      form.quotaStrikes = 3
      form.quotaInterval = 1
      form.quotaGroup = ''
      form.quotaStrikesSpan = 9
      form.quotaBurstStrikes = 0
      form.quotaWarmupMinutes = 5
      form.probeEnabled = false
      form.probeInterval = 30
      form.probeModel = ''
      showProbeKeyDetails.value = false
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
      form.enabled = provider.enabled !== false
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
      showQuotaKeyDetails.value = false
      keyTestRun += 1
      keyTesting.value = false
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
      form.quotaStrikes = Number(quota.confirmStrikes) > 0 ? Number(quota.confirmStrikes) : 3
      form.quotaInterval =
        Number(quota.confirmIntervalMinutes) > 0 ? Number(quota.confirmIntervalMinutes) : 1
      form.quotaGroup = quota.group || ''
      form.quotaStrikesSpan =
        Number(quota.confirmSpanMinutes) > 0 ? Number(quota.confirmSpanMinutes) : 9
      form.quotaBurstStrikes = Number(quota.burstStrikes) || 0
      form.quotaWarmupMinutes = Number(quota.warmupMinutes) > 0 ? Number(quota.warmupMinutes) : 5
      const probe = provider.autoProbe || {}
      form.probeEnabled = probe.enabled === true
      form.probeInterval = Number(probe.intervalMinutes) > 0 ? Number(probe.intervalMinutes) : 30
      form.probeModel = typeof probe.model === 'string' ? probe.model : ''
      showProbeKeyDetails.value = false
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
        enabled: form.enabled !== false,
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
          confirmStrikes: Number(form.quotaStrikes) || 0,
          confirmIntervalMinutes: Number(form.quotaInterval) || 0,
          confirmSpanMinutes: Number(form.quotaStrikesSpan) || 0,
          burstStrikes: Number(form.quotaBurstStrikes) || 0,
          burstWindowMinutes: 10,
          warmupMinutes: Number(form.quotaWarmupMinutes) || 0,
          // 默认组仅用于老配置回填；新保存完全由每把 Key 的归组决定
          group: '',
          groups: quotaGroups,
          keyGroups,
        },
        autoProbe: {
          enabled: form.probeEnabled,
          intervalMinutes: Number(form.probeInterval) || 0,
          model: form.probeModel.trim(),
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
        form.enabled,
        form.apiKeyInputs.join('\u0000'),
        form.apiKeyGroups.join('\u0000'),
        form.quotaGroups.join('\u0000'),
        form.modelInputs.join('\u0000'),
        form.modelAliasInputs.join('\u0000'),
        form.maxConcurrency,
        form.rpmLimit,
        form.quotaEnabled,
        form.quotaStrikes,
        form.quotaInterval,
        form.quotaGroup,
        form.quotaStrikesSpan,
        form.quotaBurstStrikes,
        form.quotaWarmupMinutes,
        form.probeEnabled,
        form.probeInterval,
        form.probeModel,
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

    // 切换页签会卸载组件：把还没到时间的自动保存立即写出，避免再次进入时读到旧数据
    onBeforeUnmount(() => {
      keyTestRun += 1
      void flushAutoSave()
    })

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

    // 一键测通：每个输入框单独请求一次上游，互不掩盖失败；
    // 未选模型时只连通 /models，选中模型时对该模型发一次最小对话请求
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
      const model = testModel.value.trim()

      keyTesting.value = true
      keyTests.value = keys.map(() => null)
      // 切换提供商 / 重新进入编辑会重置表单；用运行令牌丢弃上一轮的迟到结果
      const run = (keyTestRun += 1)
      const providerId = editingId.value
      const stillCurrent = () => run === keyTestRun && providerId === editingId.value
      try {
        await Promise.all(
          keys.map(async (key, index) => {
            if (!key) {
              if (stillCurrent()) keyTests.value[index] = { status: 'empty' }
              return
            }
            try {
              const result = await relayStore.testKey(baseUrl, key, model)
              if (!stillCurrent()) return
              keyTests.value[index] = result?.ok
                ? { status: 'ok', ms: result.ms, models: result.models, model }
                : { status: 'fail', ms: result?.ms, error: result?.error || '测通失败', model }
            } catch (error) {
              if (!stillCurrent()) return
              keyTests.value[index] = { status: 'fail', error: error.message || '测通失败', model }
            }
          }),
        )
        if (!stillCurrent()) return
        const filled = keys.filter(Boolean).length
        const passed = keyTests.value.filter((item) => item?.status === 'ok').length
        toastStore.addToast(
          model
            ? `测通完成：${passed}/${filled} 把 Key 可调通模型 ${model}`
            : `测通完成：${passed}/${filled} 把 Key 可用`,
          passed === filled ? 'success' : 'warning',
        )
      } finally {
        if (run === keyTestRun) keyTesting.value = false
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
        const detail = result.model ? `模型 ${result.model} 可调通` : `返回 ${result.models} 个模型`
        return `可用 · ${detail} · 耗时 ${result.ms}ms`
      }
      if (result?.status === 'fail') {
        const prefix = result.model ? `模型 ${result.model}：` : ''
        return `${prefix}${result.error || '测通失败'}`
      }
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
      form.quotaStrikes = Number(quota?.confirmStrikes) > 0 ? Number(quota?.confirmStrikes) : 3
      form.quotaInterval =
        Number(quota?.confirmIntervalMinutes) > 0 ? Number(quota?.confirmIntervalMinutes) : 1
      form.quotaGroup = quota?.group || ''
      form.quotaStrikesSpan =
        Number(quota?.confirmSpanMinutes) > 0 ? Number(quota?.confirmSpanMinutes) : 9
      form.quotaBurstStrikes = Number(quota?.burstStrikes) || 0
      form.quotaWarmupMinutes = Number(quota?.warmupMinutes) > 0 ? Number(quota?.warmupMinutes) : 5
      const probe = preset.autoProbe
      form.probeEnabled = probe?.enabled === true
      form.probeInterval = Number(probe?.intervalMinutes) > 0 ? Number(probe?.intervalMinutes) : 30
      form.probeModel = typeof probe?.model === 'string' ? probe.model : ''
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

    const setDefaultProvider = async (id) => {
      await relayStore.setDefaultProvider(id)
    }

    const setLanEnabled = async (event) => {
      await relayStore.setLanEnabled(event.target.checked)
      // 无访问 Key 时 store 会拒绝开启，状态不变则 Vue 不回填 DOM，
      // 这里手动把勾选态同步回真实状态，避免「看起来开了其实没开」
      event.target.checked = relayStore.lanEnabled
    }

    const copyLanUrl = async (address) => {
      const url = `http://${address}:${relayStore.port}/v1`
      try {
        await navigator.clipboard.writeText(url)
        toastStore.addToast('已复制局域网端点', 'success')
      } catch {
        toastStore.addToast('复制失败，请手动选择', 'error')
      }
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

    const quotaItemLabel = (item) => {
      const stateText =
        item.state === 'week'
          ? '7 天锁定'
          : item.state === '5h'
            ? '5 小时锁定'
            : item.state === 'probe'
              ? '5 分钟探测'
              : item.state === 'warmup'
                ? '恢复中'
                : '正常'
      const minutes = Math.max(1, Math.round((Number(item.retryAfter) || 0) / 60))
      const recent = ` · 最近 5h ${Number(item.calls5h) || 0} 次 / 成功 ${Number(item.success5h) || 0}`
      const last = item.lastStatus ? ` · 最近响应 ${item.lastStatus}` : ''
      if (item.locked) return `${stateText} · ${minutes} 分钟后重试${recent}${last}`
      if (item.state === 'warmup') {
        return `恢复中（${item.warmup === 'probing' ? '探测' : '放量'}）${recent}${last}`
      }
      return `正常${recent}${last}`
    }

    // 详情区只显示一行汇总；完整明细点「展开明细」再看
    const quotaSummary = (provider) => {
      const quota = provider?.quota
      if (!quota?.enabled) return '未启用'
      const keys = quotaKeysOf(provider)
      if (keys.length === 0) return '按真实响应自动保护 · 5 分钟探测 → 5 小时 → 7 天'
      const keyCount = new Set(keys.map((item) => item.keyTail)).size
      const limited = keys.filter((item) => item.locked).length
      const calls = keys.reduce((sum, item) => sum + (Number(item.calls5h) || 0), 0)
      return `自动保护 · ${keyCount} 把 Key · ${limited > 0 ? `${limited} 项受限` : '全部正常'} · 最近 5h ${calls} 次`
    }

    // 每 Key 探测快照：主进程周期 / 手动探测的结果（status.keyProbe）
    const probeRowsOf = (provider) =>
      (relayStore.status?.keyProbe || []).find((item) => item.providerId === provider.id)?.keys ||
      []

    const probeSummary = (provider) => {
      const entry = (relayStore.status?.keyProbe || []).find(
        (item) => item.providerId === provider.id,
      )
      if (!entry) return '尚未探测'
      const total = entry.keys.length
      if (total === 0) return '没有可探测的 Key'
      const ok = entry.keys.filter((row) => row.result === 'ok' && !row.locked).length
      const locked = entry.keys.filter((row) => row.locked).length
      const invalid = entry.keys.filter((row) => row.result === 'invalid').length
      const limited = entry.keys.filter(
        (row) => row.result === 'rate_limited' && !row.locked,
      ).length
      const parts = [`${ok}/${total} 可用`]
      if (locked > 0) parts.push(`${locked} 锁定`)
      if (invalid > 0) parts.push(`${invalid} 无效`)
      if (limited > 0) parts.push(`${limited} 速率受限`)
      const schedule = entry.probeEnabled
        ? ` · 每 ${entry.intervalMinutes} 分钟自动探测`
        : ' · 自动探测未开启'
      return parts.join('，') + schedule
    }

    const probeRowLabel = (row) => {
      const time = row.lastProbeAt
        ? new Date(row.lastProbeAt).toLocaleTimeString('zh-CN', { hour12: false })
        : ''
      const suffix = time ? ` · ${time}` : ''
      if (row.result === 'invalid') {
        return `Key 无效（HTTP ${row.status}，检查 Key 是否被注销）${suffix}`
      }
      if (row.locked) {
        const minutes = Math.max(1, Math.ceil((Number(row.lockRetryAfter) || 0) / 60))
        return `额度锁定 · ${minutes} 分钟后重试${suffix}`
      }
      if (row.result === 'rate_limited') return `429 速率受限（待连续确认）${suffix}`
      if (row.result === 'ok') return `可用 · ${row.latencyMs} ms${suffix}`
      if (row.result === 'error') {
        return `探测失败${row.message ? `：${row.message}` : ''}${suffix}`
      }
      return '尚未探测'
    }

    const probeProviderKeys = (provider) => relayStore.probeNow(provider.id)

    const quotaLabel = (provider) => {
      const quota = provider.quota
      if (!quota?.enabled) return ''
      const groups = [
        ...new Set([quota.group, ...Object.values(quota.keyGroups || {})].filter(Boolean)),
      ]
      const group = groups.length > 0 ? ` · 共享账号组 ${groups.length} 个` : ''
      const keys = quotaKeysOf(provider)
      if (keys.length > 0) {
        const limited = keys.filter((item) => item.locked).length
        const calls = keys.reduce((sum, item) => sum + (Number(item.calls5h) || 0), 0)
        return ` · 自动保护 · ${limited > 0 ? `${limited} 项受限` : '全部正常'} · 最近 5h ${calls} 次${group}`
      }
      return ` · 真实响应自动保护${group}`
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
          `按真实响应自动保护：5 分钟探测 → 5 小时 → 7 天${
            groups.length ? ` · 共享账号组 ${groups.join(' / ')}` : ''
          }`,
        )
      }
      const keys = quotaKeysOf(provider)
      if (keys.length > 0) {
        lines.push('', '按 Key / 模型的真实调用：')
        for (const item of keys.slice(0, 20)) {
          const model = item.model ? ` [${item.model}]` : ''
          const group = item.keyGroup ? ` · 组 ${item.keyGroup}` : ''
          const weight = Number.isFinite(item.weight) ? ` · 权重 ${item.weight}` : ''
          const warm = item.warmup
            ? ` · ${item.warmup === 'probing' ? '半开探测' : '渐进恢复'}`
            : ''
          const state =
            item.state === 'week'
              ? '7 天锁定'
              : item.state === '5h'
                ? '5 小时锁定'
                : item.state === 'probe'
                  ? '5 分钟探测'
                  : item.state === 'warmup'
                    ? '恢复中'
                    : '正常'
          const status = item.locked ? ` · ${state}（${item.retryAfter}s 后探测）` : ` · ${state}`
          lines.push(
            `…${item.keyTail}${model}: 最近 5h ${Number(item.calls5h) || 0} 次 / 成功 ${
              Number(item.success5h) || 0
            } / 429 ${Number(item.rateLimited5h) || 0}${group}${weight}${warm}${status}`,
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

    // 429 误判/额度已恢复时手动解锁：只清锁定，不抹掉用量记账
    const unlockQuota = async (provider) => {
      if (!provider) return
      await relayStore.unlockQuota(provider.id)
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
      quotaSummary,
      quotaItemLabel,
      showQuotaKeyDetails,
      probeRowsOf,
      probeSummary,
      probeRowLabel,
      probeProviderKeys,
      showProbeKeyDetails,
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
      testModel,
      testModelOptions,
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
      setDefaultProvider,
      setLanEnabled,
      copyLanUrl,
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
      unlockQuota,
      limitLabel,
      limitTitle,
    }
  },
}
</script>

<style scoped></style>
