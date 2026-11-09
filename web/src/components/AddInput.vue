<script setup lang="ts">
import { ref, useId } from 'vue';
import Icon from './Icon.vue';

/**
 * 常驻输入框（新建任务 / 新建列 / 子任务共用）。点它就是原生聚焦，iOS 键盘稳定弹出。
 * 只在明确提交且保存成功后清空；失焦保留草稿，三个调用方遵守同一成功/失败约定。
 */
const props = defineProps<{ placeholder: string; maxlength: number; add: (text: string) => Promise<boolean> }>();
const text = ref('');
const input = ref<HTMLInputElement>();
const pending = ref(false);
const composing = ref(false);
const error = ref('');
const errorId = useId();

async function submit() {
  const v = text.value.trim();
  if (!v || pending.value || composing.value) return;
  pending.value = true;
  error.value = '';
  try {
    if (await props.add(v)) text.value = '';
    else error.value = '添加失败，内容已保留，请重试';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '添加失败，内容已保留，请重试';
  } finally {
    pending.value = false;
  }
}
function onEnter(e: KeyboardEvent) {
  // Safari 确认中文候选词时可能提前结束 composition，229 仍表示输入法正在处理。
  if (composing.value || e.isComposing || e.keyCode === 229) e.preventDefault();
}
function cancel() {
  if (pending.value || composing.value) return;
  text.value = '';
  error.value = '';
  input.value?.blur();
}
</script>

<template>
  <div class="add-control">
    <form class="add-input" :aria-busy="pending" @submit.prevent="submit">
      <Icon name="plus" :size="15" />
      <input
        ref="input"
        v-model="text"
        :maxlength="maxlength"
        :placeholder="placeholder"
        :aria-label="placeholder"
        :aria-describedby="error ? errorId : undefined"
        :readonly="pending"
        enterkeyhint="done"
        @compositionstart="composing = true"
        @compositionend="composing = false"
        @keydown.enter="onEnter"
        @keydown.esc="cancel"
      />
      <button type="submit" class="btn primary small" :disabled="!text.trim() || pending">{{ pending ? '添加中…' : '添加' }}</button>
    </form>
    <p v-if="error" :id="errorId" class="add-error" role="alert">{{ error }}</p>
  </div>
</template>
