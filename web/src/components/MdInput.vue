<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { uploadImage } from '../md';
import { toast } from '../store';
import Icon from './Icon.vue';

/** Markdown 输入：原生 textarea + 粘贴 / 拖入 / 选择图片 → 压缩上传 → 插入 ![](url) */
const model = defineModel<string>({ required: true });
const props = defineProps<{ placeholder?: string; rows?: number }>();
const emit = defineEmits<{ submit: [] }>();

const ta = ref<HTMLTextAreaElement>();
const picker = ref<HTMLInputElement>();
const uploading = ref(0);

function autosize() {
  const el = ta.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}
watch(model, () => nextTick(autosize));
onMounted(autosize);

function insert(text: string) {
  const el = ta.value!;
  const v = model.value;
  const [s, e] = [el.selectionStart ?? v.length, el.selectionEnd ?? v.length];
  const pad = s > 0 && v[s - 1] !== '\n' ? '\n' : '';
  model.value = v.slice(0, s) + pad + text + v.slice(e);
  nextTick(() => (el.selectionStart = el.selectionEnd = s + pad.length + text.length));
}

/** 先插占位符再异步替换：上传期间继续打字也不会把图片插错位置 */
async function addImages(files: File[]) {
  for (const f of files.filter((f) => f.type.startsWith('image/'))) {
    const mark = `![上传中…](#uploading-${Math.random().toString(36).slice(2, 10)})`;
    insert(mark);
    uploading.value++;
    try {
      const url = await uploadImage(f);
      model.value = model.value.replace(mark, `![](${url})`);
    } catch (e) {
      model.value = model.value.replace(mark, '');
      toast(`图片上传失败：${(e as Error).message}`);
    } finally {
      uploading.value--;
    }
  }
}

function fromTransfer(e: ClipboardEvent | DragEvent, dt: DataTransfer | null) {
  const files = [...(dt?.files ?? [])];
  if (!files.some((f) => f.type.startsWith('image/'))) return;
  e.preventDefault();
  addImages(files);
}
function onPick() {
  addImages([...(picker.value?.files ?? [])]);
  picker.value!.value = '';
}

defineExpose({ focus: () => ta.value?.focus() });
</script>

<template>
  <div class="md-input">
    <textarea
      ref="ta"
      v-model="model"
      class="md-text"
      :rows="props.rows ?? 3"
      :placeholder="placeholder"
      @paste="fromTransfer($event, $event.clipboardData)"
      @drop="fromTransfer($event, $event.dataTransfer)"
      @keydown.meta.enter.prevent="emit('submit')"
      @keydown.ctrl.enter.prevent="emit('submit')"
    />
    <div class="md-tools">
      <button type="button" class="tool" @click="picker?.click()"><Icon name="image" :size="14" />图片</button>
      <span v-if="uploading" class="mono uploading">上传中 ×{{ uploading }}</span>
      <span class="tool-hint">Markdown · 可粘贴截图</span>
      <slot />
      <input ref="picker" type="file" accept="image/*" multiple hidden @change="onPick" />
    </div>
  </div>
</template>
