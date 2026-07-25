const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const USER_DATA_PATH = app.getPath('userData')

function isPathSafe(targetPath) {
  const resolved = path.resolve(targetPath)
  return resolved.startsWith(USER_DATA_PATH)
}

let mainWindow = null

const LOG_FILE = 'ERROR_LOG.md'

// 存储所有事件监听器的引用，用于清理
const eventListeners = {
  uncaughtException: null,
  unhandledRejection: null,
  windowAllClosed: null,
  activate: null,
  willQuit: null,
  beforeQuit: null,
}

// IPC 处理函数列表
const ipcHandlers = ['get-user-data-path', 'read-file', 'write-file', 'exists-file', 'log-error']

function getLogFilePath() {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, LOG_FILE)
}

function formatDate() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function logError(errorType, errorMessage, stackTrace) {
  try {
    const logPath = getLogFilePath()
    const timestamp = formatDate()

    let existingContent = ''
    if (fs.existsSync(logPath)) {
      existingContent = fs.readFileSync(logPath, 'utf-8')
      const markerIndex = existingContent.indexOf('<!-- 错误日志将自动追加到此处 -->')
      if (markerIndex !== -1) {
        existingContent = existingContent.substring(0, markerIndex)
      }
    }

    const logEntry = `========================================
时间: ${timestamp}
========================================
错误类型: ${errorType}
错误信息: ${errorMessage}
堆栈跟踪: ${stackTrace || '无'}
----------------------------------------

`

    const newContent = existingContent + logEntry + '<!-- 错误日志将自动追加到此处 -->\n\n'

    fs.writeFileSync(logPath, newContent, 'utf-8')
    console.error(`[ERROR LOGGED] ${timestamp} - ${errorType}: ${errorMessage}`)
  } catch (e) {
    console.error('写入错误日志失败:', e)
  }
}

eventListeners.uncaughtException = (error) => {
  logError('Uncaught Exception', error.message, error.stack)
  console.error('未捕获的异常:', error)
}
process.on('uncaughtException', eventListeners.uncaughtException)

eventListeners.unhandledRejection = (reason, _promise) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason)
  const stackTrace = reason instanceof Error ? reason.stack : null
  logError('Unhandled Promise Rejection', errorMessage, stackTrace)
  console.error('未处理的 Promise 拒绝:', reason)
}
process.on('unhandledRejection', eventListeners.unhandledRejection)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../ico/icon-256x256.png'),
    autoHideMenuBar: true,
  })

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logError('Renderer Process Gone', details.reason, null)
  })

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    logError('Page Load Failed', `${errorCode}: ${errorDescription}`, null)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.loadURL('http://localhost:3000')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function cleanupResources() {
  console.log('正在清理资源...')

  if (mainWindow) {
    if (!mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('app-cleanup')
      } catch (e) {
        console.log('无法发送清理消息给渲染进程:', e.message)
      }
      mainWindow.destroy()
    }
    mainWindow = null
  }

  if (eventListeners.uncaughtException) {
    process.off('uncaughtException', eventListeners.uncaughtException)
    eventListeners.uncaughtException = null
  }

  if (eventListeners.unhandledRejection) {
    process.off('unhandledRejection', eventListeners.unhandledRejection)
    eventListeners.unhandledRejection = null
  }

  if (eventListeners.windowAllClosed) {
    app.removeListener('window-all-closed', eventListeners.windowAllClosed)
    eventListeners.windowAllClosed = null
  }

  if (eventListeners.activate) {
    app.removeListener('activate', eventListeners.activate)
    eventListeners.activate = null
  }

  if (eventListeners.beforeQuit) {
    app.removeListener('before-quit', eventListeners.beforeQuit)
    eventListeners.beforeQuit = null
  }

  if (eventListeners.willQuit) {
    app.removeListener('will-quit', eventListeners.willQuit)
    eventListeners.willQuit = null
  }

  ipcHandlers.forEach((handler) => {
    if (ipcMain.removeHandler) {
      ipcMain.removeHandler(handler)
    }
  })

  console.log('资源清理完成')
}

app.whenReady().then(createWindow)

eventListeners.windowAllClosed = () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
}
app.on('window-all-closed', eventListeners.windowAllClosed)

eventListeners.activate = () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
}
app.on('activate', eventListeners.activate)

eventListeners.beforeQuit = (_event) => {
  console.log('应用程序准备退出 (before-quit)')
}
app.on('before-quit', eventListeners.beforeQuit)

eventListeners.willQuit = () => {
  console.log('应用程序即将退出 (will-quit)')
  cleanupResources()
}
app.on('will-quit', eventListeners.willQuit)

ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData')
})

ipcMain.handle('read-file', async (event, filePath) => {
  if (!isPathSafe(filePath)) {
    return { success: false, error: 'Access denied' }
  }
  try {
    const data = fs.readFileSync(filePath, 'utf-8')
    return { success: true, data }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('write-file', async (event, filePath, data) => {
  if (!isPathSafe(filePath)) {
    return { success: false, error: 'Access denied' }
  }
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, data, 'utf-8')
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('exists-file', async (event, filePath) => {
  return { success: true, exists: isPathSafe(filePath) && fs.existsSync(filePath) }
})

ipcMain.handle('log-error', async (event, errorType, errorMessage, stackTrace) => {
  logError(errorType, errorMessage, stackTrace)
  return { success: true }
})
