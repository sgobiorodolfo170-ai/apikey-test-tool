import { defineStore } from 'pinia'

export const useToastStore = defineStore('toast', {
  state: () => ({
    toasts: [],
    nextId: 0,
  }),
  actions: {
    addToast(message, type = 'info', duration = 3000) {
      const id = this.nextId++
      this.toasts.push({ id, message, type })
      if (duration > 0) {
        setTimeout(() => this.removeToast(id), duration)
      }
      return id
    },
    removeToast(id) {
      const idx = this.toasts.findIndex((t) => t.id === id)
      if (idx !== -1) {
        this.toasts.splice(idx, 1)
      }
    },
  },
})
