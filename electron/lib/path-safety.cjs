// 仅允许访问 root 目录内的路径。
// 不能用 startsWith 判断：同前缀的兄弟目录（如 root + "X"）会被误判为合法。
const path = require('path')

function isPathSafe(root, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') return false
  const resolved = path.resolve(targetPath)
  const base = path.resolve(root)
  const relative = path.relative(base, resolved)
  if (relative === '') return true
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

module.exports = { isPathSafe }
