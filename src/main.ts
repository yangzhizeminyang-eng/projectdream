import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './style.css'

// 前端应用的总入口：
// 1. 创建 Vue 应用实例
// 2. 注册全局状态 Pinia
// 3. 注册路由
// 4. 挂载到 index.html 里的 #app 节点
const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')
