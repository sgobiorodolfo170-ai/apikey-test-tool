import { vi } from 'vitest'
import { createPinia } from 'pinia'

const mockStore = {
  providers: {},
  history: [],
  userDataPath: '/mock/user/data',
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
}

export function setupElectronAPIMock() {
  window.electronAPI = {
    getUserDataPath: vi.fn().mockResolvedValue(mockStore.userDataPath),
    readFile: vi.fn().mockImplementation(async (filePath) => {
      const fileName = filePath.split('/').pop()
      const data = fileName === 'providers.json' ? mockStore.providers : mockStore.history
      return { success: true, data: JSON.stringify(data) }
    }),
    writeFile: vi.fn().mockImplementation(async (filePath, data) => {
      const fileName = filePath.split('/').pop()
      const parsed = JSON.parse(data)
      if (fileName === 'providers.json') {
        mockStore.providers = parsed
      } else {
        mockStore.history = parsed
      }
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
