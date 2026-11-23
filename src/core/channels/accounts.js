// 账号池纯函数：apiKeys → accounts 迁移、可用性判定、冷却与领取记录。
// 账号只存 credentialRef（指向凭据存储），不复制明文 Key；apiKeys 保留只读兼容。
// 调度 / 429 锁定 / 冷却都以 account id 为维度，纯函数便于单测与主进程复用。

export const ACCOUNT_STATUSES = Object.freeze([
  'unknown',
  'ready',
  'cooldown',
  'rejected',
  'disabled',
])

export const QUOTA_LEVELS = Object.freeze(['none', 'ok', 'low', 'exhausted'])

export function newAccountId() {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function normalizeAccount(account, index = 0) {
  const src = account && typeof account === 'object' ? account : {}
  const id = typeof src.id === 'string' && src.id ? src.id : newAccountId()
  const status = ACCOUNT_STATUSES.includes(src.status) ? src.status : 'unknown'
  const level = QUOTA_LEVELS.includes(src.quota?.level) ? src.quota.level : 'none'
  return {
    id,
    label: typeof src.label === 'string' && src.label ? src.label : `Key ${index + 1}`,
    credentialRef: typeof src.credentialRef === 'string' ? src.credentialRef : '',
    group: typeof src.group === 'string' ? src.group : '',
    status,
    cooldownUntil: num(src.cooldownUntil),
    quota: { level, resetAt: num(src.quota?.resetAt) },
    dailyClaim: {
      lastAt: num(src.dailyClaim?.lastAt),
      result: typeof src.dailyClaim?.result === 'string' ? src.dailyClaim.result : '',
    },
  }
}

// 旧配置只有 apiKeys / apiKey：为每把 Key 生成一个账号；已有 accounts 则只做归一化。
// 不改动 apiKeys 本身，保证旧读法（provider.apiKeys / provider.apiKey）继续有效。
export function migrateProviderAccounts(provider) {
  const src = provider && typeof provider === 'object' ? provider : {}
  if (Array.isArray(src.accounts) && src.accounts.length > 0) {
    return { ...src, accounts: src.accounts.map((item, i) => normalizeAccount(item, i)) }
  }
  const keys = [...(Array.isArray(src.apiKeys) ? src.apiKeys : []), src.apiKey]
    .map((key) => (typeof key === 'string' ? key.trim() : ''))
    .filter(Boolean)
  const unique = [...new Set(keys)]
  const accounts = unique.map((_, i) => {
    const id = newAccountId()
    return normalizeAccount(
      {
        id,
        label: `Key ${i + 1}`,
        credentialRef: `relay:provider:${src.id || 'unknown'}:${id}`,
      },
      i,
    )
  })
  return { ...src, accounts }
}

// 可被调度选中：未禁用 / 未拒因、冷却已过、额度未耗尽
export function isAccountAvailable(account, now = Date.now()) {
  if (!account) return false
  if (account.status === 'disabled' || account.status === 'rejected') return false
  if (num(account.cooldownUntil) > now) return false
  if (account.quota?.level === 'exhausted') return false
  return true
}

// 选账号：粘性优先复用 lastId，否则取第一个可用；都不可用返回 null
export function pickAccount(accounts, now = Date.now(), lastId = '') {
  const list = Array.isArray(accounts) ? accounts : []
  const available = list.filter((item) => isAccountAvailable(item, now))
  if (available.length === 0) return null
  if (lastId) {
    const sticky = available.find((item) => item.id === lastId)
    if (sticky) return sticky
  }
  return available[0]
}

export function cooldownAccount(account, cooldownMs, now = Date.now()) {
  return { ...account, status: 'cooldown', cooldownUntil: now + Math.max(0, num(cooldownMs)) }
}

export function rejectAccount(account) {
  return { ...account, status: 'rejected' }
}

export function recordDailyClaim(account, result, now = Date.now()) {
  return { ...account, dailyClaim: { lastAt: now, result: String(result ?? '') } }
}
