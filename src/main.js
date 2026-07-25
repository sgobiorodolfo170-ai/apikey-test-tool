import { createApp } from 'vue'
import { createPinia } from 'pinia'
import VueGridLayout from 'vue-grid-layout'
import App from './App.vue'
import './style.css'

const app = createApp(App)
app.use(createPinia())
app.use(VueGridLayout)
app.mount('#app')
