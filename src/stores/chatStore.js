import { defineStore } from 'pinia'

export const useChatStore = defineStore('chat', {
  state: () => ({
    messages: [],
    selectedModel: null,
  }),
  actions: {
    addMessage(msg) {
      this.messages.push(msg)
    },
    clearMessages() {
      this.messages = []
    },
    setSelectedModel(model) {
      this.selectedModel = model
    },
  },
})
