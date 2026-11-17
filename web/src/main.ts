import { createApp } from 'vue';
import App from './App.vue';
import { session } from './api';
import { flushPending, syncPush } from './push';
import './style.css';

createApp(App).mount('#app');

// 离线退出留下的退订先补做；已登录则把服务端订阅状态对齐
flushPending();
if (session.token) syncPush();

// 开发环境不注册，免得缓存干扰热更新
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
