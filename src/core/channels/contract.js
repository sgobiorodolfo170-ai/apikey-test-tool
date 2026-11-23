// 渠道适配器契约：核心只认契约，不认具体实现。
// 免费上游 / 账号渠道由外部适配器提供，凭据与条款确认由适配器作者 / 使用方负责；
// 核心不内置公共凭据，也不接受指纹伪造 / 提示词注入一类能力声明（白名单之外一律拒绝）。

export const CHANNEL_AUTH_TYPES = Object.freeze(['bearer', 'header', 'oauth', 'none'])

// 与 ProviderDescriptor.capabilities 同口径；白名单之外的能力（如伪造 / 注入）不予承认
export const CHANNEL_CAPABILITIES = Object.freeze([
  'chat',
  'stream',
  'embeddings',
  'messages',
  'responses',
  'quota',
  'dailyClaim',
])

// 适配器 manifest 可声明的权限；dailyClaim 必须显式声明才允许调用领取接口
export const CHANNEL_PERMISSIONS = Object.freeze(['network', 'credentials', 'quota', 'dailyClaim'])

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isFunction(value) {
  return typeof value === 'function'
}

function checkMethods(target, names, label, errors, { required = true } = {}) {
  if (target === undefined || target === null) {
    if (required) errors.push(`缺少 ${label}`)
    return
  }
  if (typeof target !== 'object' || Array.isArray(target)) {
    errors.push(`${label} 必须是对象`)
    return
  }
  for (const name of names) {
    if (target[name] === undefined) {
      if (required) errors.push(`${label}.${name} 缺失`)
    } else if (!isFunction(target[name])) {
      errors.push(`${label}.${name} 必须是函数`)
    }
  }
}

// 校验一个 ChannelAdapter 实例是否满足契约。
// 返回 { ok, errors }；ok=false 时宿主拒绝加载 / 调用。
export function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    return { ok: false, errors: ['适配器必须是对象'] }
  }
  const errors = []
  const meta = adapter.meta
  if (!meta || typeof meta !== 'object') {
    errors.push('缺少 meta')
  } else {
    if (!isNonEmptyString(meta.id)) errors.push('meta.id 缺失')
    if (!isNonEmptyString(meta.name)) errors.push('meta.name 缺失')
    if (!CHANNEL_AUTH_TYPES.includes(meta.authType)) {
      errors.push(`meta.authType 无效：${meta.authType}`)
    }
    if (!Array.isArray(meta.capabilities)) {
      errors.push('meta.capabilities 必须是数组')
    } else {
      for (const cap of meta.capabilities) {
        if (!CHANNEL_CAPABILITIES.includes(cap)) errors.push(`未知能力声明：${cap}`)
      }
    }
  }

  checkMethods(adapter.credentials, ['list', 'import', 'validate'], 'credentials', errors)
  checkMethods(adapter.models, ['list'], 'models', errors)
  checkMethods(adapter.chat, ['send', 'stream'], 'chat', errors)

  // auth 可选；但声明 oauth 的适配器必须提供 begin/complete（官方 OAuth / 设备码）
  if (adapter.auth !== undefined) {
    checkMethods(adapter.auth, ['begin', 'complete', 'refresh'], 'auth', errors, {
      required: false,
    })
    if (meta?.authType === 'oauth') {
      if (!isFunction(adapter.auth?.begin)) errors.push('oauth 适配器缺少 auth.begin')
      if (!isFunction(adapter.auth?.complete)) errors.push('oauth 适配器缺少 auth.complete')
    }
  } else if (meta?.authType === 'oauth') {
    errors.push('oauth 适配器缺少 auth')
  }

  // quota 可选；claimDaily 只有声明了 dailyClaim 能力才允许存在
  if (adapter.quota !== undefined) {
    checkMethods(adapter.quota, ['fetch', 'claimDaily'], 'quota', errors, { required: false })
    if (isFunction(adapter.quota?.claimDaily)) {
      const caps = Array.isArray(meta?.capabilities) ? meta.capabilities : []
      if (!caps.includes('dailyClaim')) {
        errors.push('quota.claimDaily 需要 meta.capabilities 声明 dailyClaim')
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

// 校验外部适配器的 manifest（loader 加载前调用）。
// entry 必须是渠道目录内的相对路径，禁止绝对路径与 .. 穿越。
export function validateChannelManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest 必须是对象'] }
  }
  const errors = []
  if (!isNonEmptyString(manifest.id)) errors.push('manifest.id 缺失')
  if (!isNonEmptyString(manifest.name)) errors.push('manifest.name 缺失')
  if (!isNonEmptyString(manifest.version)) errors.push('manifest.version 缺失')
  if (!isNonEmptyString(manifest.entry)) {
    errors.push('manifest.entry 缺失')
  } else if (
    /^([a-zA-Z]:|[\\/])/.test(manifest.entry) ||
    manifest.entry.split(/[\\/]/).includes('..')
  ) {
    errors.push('manifest.entry 必须是渠道目录内的相对路径')
  }
  if (!Array.isArray(manifest.permissions)) {
    errors.push('manifest.permissions 必须是数组')
  } else {
    for (const perm of manifest.permissions) {
      if (!CHANNEL_PERMISSIONS.includes(perm)) errors.push(`未知权限声明：${perm}`)
    }
  }
  return { ok: errors.length === 0, errors }
}
