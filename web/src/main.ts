import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');

// 开发环境不注册，免得缓存干扰热更新
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
