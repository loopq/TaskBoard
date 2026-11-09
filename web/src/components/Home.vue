<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { today } from '../format';
import { login } from '../store';
import Icon from './Icon.vue';

const USERS = ['zhuhu', 'lvcui'];
const picked = ref<string | null>(null);
const password = ref('');
const error = ref('');
const busy = ref(false);
const pw = ref<HTMLInputElement[]>([]);

async function pick(u: string) {
  if (picked.value === u) return;
  picked.value = u;
  password.value = '';
  error.value = '';
  await nextTick();
  pw.value[0]?.focus();
}

async function submit() {
  if (!picked.value || !password.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await login(picked.value, password.value);
  } catch (e) {
    error.value = (e as Error).message;
    password.value = '';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="home">
    <header class="home-head">
      <p class="mono home-date">{{ today() }}</p>
      <h1 class="wordmark home-mark">taskboard</h1>
      <p class="home-sub">两个人，各一本。</p>
    </header>

    <div class="users">
      <form
        v-for="(u, i) in USERS"
        :key="u"
        class="user-card"
        :class="{ open: picked === u }"
        :style="{ '--i': i }"
        @click="pick(u)"
        @submit.prevent="submit"
      >
        <span class="avatar big" aria-hidden="true">{{ u[0].toUpperCase() }}</span>
        <span class="user-name">{{ u }} <Icon name="lock" :size="15" class="user-lock" /></span>
        <div v-if="picked === u" class="user-login">
          <!-- 给密码管理器 / iCloud 钥匙串关联用户名 -->
          <input class="sr-only" type="text" name="username" autocomplete="username" :value="u" readonly tabindex="-1" />
          <input
            ref="pw"
            v-model="password"
            class="field"
            type="password"
            name="password"
            autocomplete="current-password"
            placeholder="密码"
            :aria-label="`${u} 的密码`"
          />
          <button class="btn primary" :disabled="busy || !password">{{ busy ? '…' : '进入' }}</button>
        </div>
        <p v-if="picked === u && error" class="user-err" role="alert">{{ error }}</p>
      </form>
    </div>
  </main>
</template>
