<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import Board from './components/Board.vue';
import Home from './components/Home.vue';
import { load, state, toast } from './store';

const refresh = () => load().catch((e: Error) => toast(e.message));
// 只有自己在操作，不做实时推送：页面重新可见时拉一次
const onVisible = () => document.visibilityState === 'visible' && refresh();

onMounted(() => {
  refresh();
  document.addEventListener('visibilitychange', onVisible);
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible));
</script>

<template>
  <Board v-if="state.user" />
  <Home v-else />
  <Transition name="toast">
    <div v-if="state.toast" class="toast" role="status">{{ state.toast }}</div>
  </Transition>
</template>
