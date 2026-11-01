const fs = require('fs')
const path = require('path')

// 跟随数据目录迁移的项目数据文件（app-settings / window-state 属于应用配置，留在默认 userData）
const DATA_FILES = [
  'history.json',
  'providers.json',
  'channels.json',
  'relay.json',
  'relay-usage.json',
  'ERROR_LOG.md',
]

// 读取保存的数据目录；目录不存在或无效时回退到默认目录
function resolveDataDir(configRoot, savedDir) {
  if (typeof savedDir !== 'string' || savedDir.trim() === '') return configRoot
  const target = path.resolve(savedDir.trim())
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return target
  } catch {
    // 目录不可读时回退
  }
  return configRoot
}

// 把数据文件从旧目录复制到新目录。
// 目标已有同名文件时保留目标，支持切回已有数据目录 / 从备份恢复；
// 只复制源目录存在的文件，首次运行没有数据时也能正常切换。
function migrateDataFiles(fromDir, toDir, files = DATA_FILES) {
  const result = { copied: [], kept: [] }
  if (path.resolve(fromDir) === path.resolve(toDir)) return result
  fs.mkdirSync(toDir, { recursive: true })

  for (const name of files) {
    const destination = path.join(toDir, name)
    if (fs.existsSync(destination)) {
      result.kept.push(name)
      continue
    }
    const source = path.join(fromDir, name)
    if (!fs.existsSync(source)) continue
    fs.copyFileSync(source, destination)
    result.copied.push(name)
  }

  return result
}

module.exports = { DATA_FILES, resolveDataDir, migrateDataFiles }
