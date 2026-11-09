<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';

/**
 * 常驻输入框（新建任务 / 新建列 / 子任务共用）。点它就是原生聚焦，iOS 键盘稳定弹出。
 * 回车、点「添加」、失焦时有内容，三种方式都走 submit：手机上不依赖回车，打的字也不会悬着。
 * 提交后清空并保留焦点，方便连续录入；「添加」用 pointerdown.prevent 防失焦，键盘不收。
 */
defineProps<{ placeholder: string; maxlength: number }>();
const emit = defineEmits<{ add: [text: string] }>();
const text = ref('');
const input = ref<HTMLInputElement>();

function submit() {
  const v = text.value.trim();
  text.value = '';
  if (v) emit('add', v);
}
function cancel() {
  text.value = '';
  input.value?.blur();
}
</script>

<template>
  <form class="add-input" @submit.prevent="submit">
    <Icon name="plus" :size="15" />
    <input
      ref="input"
      v-model="text"
      :maxlength="maxlength"
      :placeholder="placeholder"
      :aria-label="placeholder"
      enterkeyhint="done"
      @blur="submit"
      @keydown.esc="cancel"
    />
    <button v-if="text.trim()" class="btn primary small" @pointerdown.prevent>添加</button>
  </form>
</template>
