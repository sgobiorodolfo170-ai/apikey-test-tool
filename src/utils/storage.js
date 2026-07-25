const HISTORY_FILE = 'history.json'
const PROVIDERS_FILE = 'providers.json'

let userDataPath = null

const writeQueue = new Map()
const pendingWrites = new Set()

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

async function readJsonFile(fileName, defaultValue = {}) {
  try {
    const filePath = await getFilePath(fileName)
    if (window.electronAPI) {
      const result = await window.electronAPI.readFile(filePath)
      if (result.success) {
        return normalizeData(JSON.parse(result.data))
      }
    }
    return defaultValue
  } catch (error) {
    console.error(`读取${fileName}失败:`, error)
    return defaultValue
  }
}

async function writeJsonFile(fileName, data, isRetry = false) {
  if (!isRetry && pendingWrites.has(fileName)) {
    writeQueue.set(fileName, data)
    return true
  }
  if (!isRetry) {
    pendingWrites.add(fileName)
  }
  try {
    const filePath = await getFilePath(fileName)
    if (window.electronAPI) {
      const payload = addVersion(data)
      await window.electronAPI.writeFile(filePath, JSON.stringify(payload, null, 2))
      return true
    }
    return false
  } finally {
    if (!isRetry) {
      pendingWrites.delete(fileName)
    }
    if (!isRetry && writeQueue.has(fileName)) {
      const queued = writeQueue.get(fileName)
      writeQueue.delete(fileName)
      writeJsonFile(fileName, queued, true)
    }
  }
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
  const providers = await readJsonFile(PROVIDERS_FILE, {})
  return Object.keys(providers)
}

export async function readProviderSettings(providerName) {
  const providers = await readJsonFile(PROVIDERS_FILE, {})
  return providers[providerName] || null
}

export async function saveProvider(providerName, settings) {
  const providers = await readJsonFile(PROVIDERS_FILE, {})
  providers[providerName] = {
    ...providers[providerName],
    ...settings,
    updatedAt: new Date().toISOString(),
  }
  return await writeJsonFile(PROVIDERS_FILE, providers)
}

export async function deleteProvider(providerName) {
  const providers = await readJsonFile(PROVIDERS_FILE, {})
  delete providers[providerName]
  return await writeJsonFile(PROVIDERS_FILE, providers)
}

export async function readHistory() {
  return await readJsonFile(HISTORY_FILE, [])
}

export async function writeHistory(data) {
  return await writeJsonFile(HISTORY_FILE, data)
}

export async function saveTestRecord(record) {
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

  await writeHistory(history)
  return newRecord
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
  const history = await readHistory()
  const filtered = history.filter((record) => record.id !== id)
  await writeHistory(filtered)
  return filtered
}

export async function clearHistory() {
  await writeHistory([])
  return []
}

function generateId() {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '')
  const suffix = crypto.randomUUID().slice(0, 4)
  return `${date}_${time}_${suffix}`
}
