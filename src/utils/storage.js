import { normalizeClientKeys } from './relayConfig.js'

const HISTORY_FILE = 'history.json'
const PROVIDERS_FILE = 'providers.json'
const CHANNELS_FILE = 'channels.json'
const RELAY_FILE = 'relay.json'

let userDataPath = null

// 同一文件的读-改-写必须串行，否则并发保存会互相覆盖（后写的读到旧数据）
const fileLocks = new Map()

function withFileLock(fileName, task) {
  const previous = fileLocks.get(fileName) || Promise.resolve()
  const next = previous.then(task, task)
  fileLocks.set(
    fileName,
    next.catch(() => {}),
  )
  return next
}

// API Key 落盘前用 Electron safeStorage 加密（主进程侧 DPAPI / Keychain）。
// 没有桥接（浏览器调试、单测）时原样返回，保持旧行为。
async function sealSecrets(data) {
  if (!window.electronAPI?.secureStore) return data
  try {
    const result = await window.electronAPI.secureStore('encrypt', data)
    return result?.ok ? result.data : data
  } catch (error) {
    console.error('密钥加密失败，将按明文保存:', error)
    return data
  }
}

async function unsealSecrets(data) {
  if (!window.electronAPI?.secureStore) return data
  try {
    const result = await window.electronAPI.secureStore('decrypt', data)
    return result?.ok ? result.data : data
  } catch (error) {
    console.error('密钥解密失败:', error)
    return data
  }
}

export async function initStorage() {
  if (window.electronAPI) {
    userDataPath = await window.electronAPI.getUserDataPath()
  }
  return userDataPath
}

async function getFilePath(fileName) {
  if (!userDataPath) {
    await initStorage()
  }
  return `${userDataPath}/${fileName}`
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// 解析失败时不覆盖原文件：先把原始内容另存一份，便于事后恢复
async function preserveCorruptFile(fileName, raw) {
  if (!window.electronAPI?.writeFile || typeof raw !== 'string' || raw === '') return
  try {
    const filePath = await getFilePath(fileName)
    const backupPath = filePath.replace(/\.json$/i, `.corrupt-${Date.now()}.json`)
    await window.electronAPI.writeFile(backupPath, raw)
  } catch (error) {
    console.error(`备份损坏文件 ${fileName} 失败:`, error)
  }
}

async function readJsonFile(fileName, defaultValue = {}, validate = null) {
  try {
    const filePath = await getFilePath(fileName)
    if (window.electronAPI) {
      const result = await window.electronAPI.readFile(filePath)
      if (result.success) {
        let data
        try {
          data = normalizeData(JSON.parse(result.data))
        } catch (error) {
          await preserveCorruptFile(fileName, result.data)
          console.error(`解析${fileName}失败，已备份原文件:`, error)
          return defaultValue
        }
        if (validate && !validate(data)) {
          await preserveCorruptFile(fileName, result.data)
          console.error(`${fileName}结构不符合预期，已备份原文件`)
          return defaultValue
        }
        return await unsealSecrets(data)
      }
    }
    return defaultValue
  } catch (error) {
    console.error(`读取${fileName}失败:`, error)
    return defaultValue
  }
}

async function writeJsonFile(fileName, data) {
  const filePath = await getFilePath(fileName)
  if (window.electronAPI) {
    const payload = addVersion(await sealSecrets(data))
    const result = await window.electronAPI.writeFile(filePath, JSON.stringify(payload, null, 2))
    if (!result?.success) {
      throw new Error(result?.error || `写入 ${fileName} 失败`)
    }
    return true
  }
  return false
}

function addVersion(data) {
  return { version: 1, data }
}

function normalizeData(raw) {
  if (raw && typeof raw === 'object' && 'version' in raw) {
    return raw.data
  }
  return raw
}

export async function readProviders() {
  const providers = await readJsonFile(PROVIDERS_FILE, {}, isPlainObject)
  return Object.keys(providers)
}

export async function readProviderSettings(providerName) {
  const providers = await readJsonFile(PROVIDERS_FILE, {}, isPlainObject)
  return providers[providerName] || null
}

export async function saveProvider(providerName, settings) {
  return withFileLock(PROVIDERS_FILE, async () => {
    const providers = await readJsonFile(PROVIDERS_FILE, {})
    providers[providerName] = {
      ...providers[providerName],
      ...settings,
      updatedAt: new Date().toISOString(),
    }
    return await writeJsonFile(PROVIDERS_FILE, providers)
  })
}

export async function deleteProvider(providerName) {
  return withFileLock(PROVIDERS_FILE, async () => {
    const providers = await readJsonFile(PROVIDERS_FILE, {})
    delete providers[providerName]
    return await writeJsonFile(PROVIDERS_FILE, providers)
  })
}

// ---------- 渠道（多 Key / 多站点） ----------
// 与 providers.json 的区别：providers 只记「某名字对应的 Base URL/模式」，
// channels 是完整的可用配置（含加密后的 Key），用于在多条渠道间切换与对比。

export async function readChannels() {
  const list = await readJsonFile(CHANNELS_FILE, [], Array.isArray)
  return Array.isArray(list) ? list : []
}

export async function saveChannel(channel) {
  return withFileLock(CHANNELS_FILE, async () => {
    const list = await readChannels()
    const now = new Date().toISOString()
    const index = list.findIndex((item) => item.id === channel.id)

    let next
    if (index >= 0) {
      next = [...list]
      next[index] = { ...list[index], ...channel, updatedAt: now }
    } else {
      next = [...list, { id: generateId(), createdAt: now, updatedAt: now, ...channel }]
    }

    await writeJsonFile(CHANNELS_FILE, next)
    return next
  })
}

export async function deleteChannel(id) {
  return withFileLock(CHANNELS_FILE, async () => {
    const list = await readChannels()
    const next = list.filter((item) => item.id !== id)
    await writeJsonFile(CHANNELS_FILE, next)
    return next
  })
}

// ---------- 中转站配置 ----------
const DEFAULT_RELAY = {
  port: 8787,
  providers: [],
  apiKey: '',
  clientKeys: [],
  sticky: false,
  autoStart: true,
  cache: { enabled: false, ttlMs: 300000, maxEntries: 200 },
}

// 多客户端 Key 的归一化由 relayConfig.js 共用，避免与中转站 store / relay.cjs 口径漂移

export async function readRelay() {
  const config = await readJsonFile(RELAY_FILE, DEFAULT_RELAY, isPlainObject)
  if (!config || typeof config !== 'object') return { ...DEFAULT_RELAY }
  return {
    port: Number(config.port) || DEFAULT_RELAY.port,
    providers: Array.isArray(config.providers) ? config.providers : [],
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : '',
    clientKeys: normalizeClientKeys(config.clientKeys),
    sticky: config.sticky === true,
    autoStart: config.autoStart !== false,
    cache: {
      enabled: config.cache?.enabled === true,
      ttlMs: Math.max(1000, Number(config.cache?.ttlMs) || DEFAULT_RELAY.cache.ttlMs),
      maxEntries: Math.max(10, Number(config.cache?.maxEntries) || 200),
    },
  }
}

export async function saveRelay(config) {
  return withFileLock(RELAY_FILE, async () => {
    const payload = {
      port: Number(config?.port) || DEFAULT_RELAY.port,
      providers: Array.isArray(config?.providers) ? config.providers : [],
      apiKey: typeof config?.apiKey === 'string' ? config.apiKey : '',
      clientKeys: normalizeClientKeys(config?.clientKeys),
      sticky: config?.sticky === true,
      autoStart: config?.autoStart !== false,
      cache: {
        enabled: config?.cache?.enabled === true,
        ttlMs: Math.max(1000, Number(config?.cache?.ttlMs) || DEFAULT_RELAY.cache.ttlMs),
        maxEntries: Math.max(10, Number(config?.cache?.maxEntries) || 200),
      },
    }
    await writeJsonFile(RELAY_FILE, payload)
    return payload
  })
}

export async function readHistory() {
  const history = await readJsonFile(HISTORY_FILE, [], Array.isArray)
  return Array.isArray(history) ? history : []
}

export async function writeHistory(data) {
  return withFileLock(HISTORY_FILE, () => writeJsonFile(HISTORY_FILE, data))
}

export async function saveTestRecord(record) {
  return withFileLock(HISTORY_FILE, async () => {
    const history = await readHistory()
    const newRecord = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      ...record,
    }
    history.unshift(newRecord)

    if (history.length > 100) {
      history.splice(100)
    }

    const written = await writeJsonFile(HISTORY_FILE, history)
    return written ? newRecord : null
  })
}

export async function saveProviderFromRecord(record) {
  if (record.config?.provider) {
    await saveProvider(record.config.provider, {
      baseUrl: record.config.baseUrl,
      apiMode: record.config.apiMode,
    })
  }
}

export async function deleteTestRecord(id) {
  return withFileLock(HISTORY_FILE, async () => {
    const history = await readHistory()
    const filtered = history.filter((record) => record.id !== id)
    await writeJsonFile(HISTORY_FILE, filtered)
    return filtered
  })
}

export async function clearHistory() {
  return withFileLock(HISTORY_FILE, async () => {
    await writeJsonFile(HISTORY_FILE, [])
    return []
  })
}

function generateId() {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '')
  const suffix = crypto.randomUUID().slice(0, 4)
  return `${date}_${time}_${suffix}`
}
