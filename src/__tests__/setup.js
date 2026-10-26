import { vi } from 'vitest'
import { createPinia } from 'pinia'

const mockStore = {
  providers: {},
  history: [],
  channels: [],
  userDataPath: '/mock/user/data',
}

function fileKey(fileName) {
  if (fileName === 'providers.json') return 'providers'
  if (fileName === 'channels.json') return 'channels'
  return 'history'
}

let activePinia = null

export function createTestPinia() {
  activePinia = createPinia()
  return activePinia
}

export function getActivePinia() {
  return activePinia
}

export function resetMockStore() {
  mockStore.providers = {}
  mockStore.history = []
  mockStore.channels = []
}

export function setupElectronAPIMock() {
  window.electronAPI = {
    getUserDataPath: vi.fn().mockResolvedValue(mockStore.userDataPath),
    readFile: vi.fn().mockImplementation(async (filePath) => {
      const data = mockStore[fileKey(filePath.split('/').pop())]
      return { success: true, data: JSON.stringify(data) }
    }),
    writeFile: vi.fn().mockImplementation(async (filePath, data) => {
      mockStore[fileKey(filePath.split('/').pop())] = JSON.parse(data)
      return { success: true }
    }),
    logError: vi.fn().mockResolvedValue({ success: true }),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  }
}

export function clearElectronAPIMock() {
  delete window.electronAPI
}

export { mockStore }
