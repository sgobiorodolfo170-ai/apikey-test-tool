<template>
  <Teleport to="body">
    <div class="toast-container fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      <div
        v-for="toast in toastStore.toasts"
        :key="toast.id"
        class="pointer-events-auto px-4 py-3 rounded-card shadow-elevated text-white text-sm transition-all duration-300 max-w-sm break-words flex items-center gap-2"
        :class="toastClass(toast.type)"
      >
        <span v-if="toast.type === 'success'">✔</span>
        <span v-else-if="toast.type === 'error'">✖</span>
        <span v-else-if="toast.type === 'warning'">⚠</span>
        {{ toast.message }}
      </div>
    </div>
  </Teleport>
</template>

<script>
import { useToastStore } from '../stores/toastStore.js'

export default {
  name: 'ToastContainer',
  setup() {
    const toastStore = useToastStore()

    const toastClass = (type) => {
      switch (type) {
        case 'success':
          return 'bg-success'
        case 'error':
          return 'bg-danger'
        case 'warning':
          return 'bg-warning'
        default:
          return 'bg-surface-alt'
      }
    }

    return { toastStore, toastClass }
  },
}
</script>

<style scoped>
.toast-container > div {
  animation: slideIn 0.2s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
</style>
