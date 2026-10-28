// 更新检查：向 GitHub 查询最新 Release，和本地版本比较。
// 纯逻辑与网络分离，便于单测。

import http from '../api/http.js'

export const REPO = 'sgobiorodolfo170-ai/apikey-test-tool'
export const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`

export function normalizeVersion(version) {
  return String(version ?? '')
    .trim()
    .replace(/^v/i, '')
}

// 返回 1（a 更新）/ -1（b 更新）/ 0（相同）。按段比较，缺失段按 0 处理。
export function compareVersions(a, b) {
  const left = normalizeVersion(a).split('.')
  const right = normalizeVersion(b).split('.')
  const length = Math.max(left.length, right.length)

  for (let i = 0; i < length; i++) {
    const x = parseInt(left[i], 10) || 0
    const y = parseInt(right[i], 10) || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

export function parseRelease(payload) {
  if (!payload || typeof payload !== 'object') return null
  const tag = payload.tag_name || payload.name
  if (!tag) return null

  return {
    version: normalizeVersion(tag),
    url: payload.html_url || RELEASES_PAGE,
    name: payload.name || '',
    publishedAt: payload.published_at || null,
  }
}

// 查询最新 Release；失败时抛错，由调用方决定是否提示（更新检查不该打扰用户）
export async function fetchLatestRelease({ timeout = 8000 } = {}) {
  const response = await http.get(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json' },
    timeout,
  })

  const release = parseRelease(response?.data)
  if (!release) throw new Error('未获取到版本信息')
  return release
}

// 判断是否需要提示更新
export function isNewerVersion(latestVersion, currentVersion) {
  return compareVersions(latestVersion, currentVersion) > 0
}
