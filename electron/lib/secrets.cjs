// 密钥字段遍历规则，供主进程 safeStorage 加密 / 解密共用。
// - apiKey / api_key：单个字符串字段
// - apiKeys：字符串数组（多 Key 提供商的主存储）
// - clientKeys：数组元素的 key 字段
// - keyGroups：对象键本身是 Key（Key -> 共享组映射）
// 旧版明文数据解密时原样保留，加密时统一包成 enc:<base64>。

const SECRET_FIELDS = new Set(['apiKey', 'api_key'])
const SECRET_ARRAY_FIELDS = new Set(['apiKeys'])
const SECRET_KEY_MAP_FIELDS = new Set(['keyGroups'])
const SECRET_LIST_ITEM_FIELDS = new Map([['clientKeys', 'key']])
const MAX_DEPTH = 8

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function walkSecrets(node, fn, depth = 0, field = '') {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return node

  if (Array.isArray(node)) {
    const list = []
    if (SECRET_ARRAY_FIELDS.has(field)) {
      for (const item of node) {
        list.push(
          typeof item === 'string' ? await fn(item) : await walkSecrets(item, fn, depth + 1),
        )
      }
      return list
    }
    const itemField = SECRET_LIST_ITEM_FIELDS.get(field)
    for (const item of node) {
      if (itemField && isPlainObject(item) && typeof item[itemField] === 'string') {
        list.push({ ...item, [itemField]: await fn(item[itemField]) })
      } else {
        list.push(await walkSecrets(item, fn, depth + 1))
      }
    }
    return list
  }

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (SECRET_FIELDS.has(key) && typeof value === 'string') {
      out[key] = await fn(value)
      continue
    }
    if (SECRET_KEY_MAP_FIELDS.has(key) && isPlainObject(value)) {
      const map = {}
      for (const [mapKey, mapValue] of Object.entries(value)) {
        // 解密失败时 fn 返回空串，保留原键，避免多条失败记录互相覆盖
        const nextKey = await fn(mapKey)
        map[nextKey || mapKey] = mapValue
      }
      out[key] = map
      continue
    }
    out[key] = await walkSecrets(value, fn, depth + 1, key)
  }
  return out
}

module.exports = { SECRET_FIELDS, walkSecrets }
