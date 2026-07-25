const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, data) => ipcRenderer.invoke('write-file', filePath, data),
  existsFile: (filePath) => ipcRenderer.invoke('exists-file', filePath),
  logError: (errorType, errorMessage, stackTrace) =>
    ipcRenderer.invoke('log-error', errorType, errorMessage, stackTrace),
  on: (channel, callback) => {
    const validChannels = ['app-cleanup']
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args))
    }
  },
  removeAllListeners: (channel) => {
    const validChannels = ['app-cleanup']
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel)
    }
  },
})
