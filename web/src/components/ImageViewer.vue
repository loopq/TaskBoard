<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import Icon from './Icon.vue';

/**
 * 居中图片预览（参照 B 站）：深色遮罩、计数、旋转、原图、左右翻页、底部缩略图。
 * 原生 <dialog> + showModal()：系统自带遮罩层、焦点限制和 Esc 关闭，不引入依赖。
 */
const dlg = ref<HTMLDialogElement>();
const list = ref<string[]>([]);
const index = ref(0);
const turn = ref(0); // 旋转角度，90 的倍数
const src = computed(() => list.value[index.value]);
const sideways = computed(() => Math.abs(turn.value / 90) % 2 === 1);

function go(i: number) {
  const n = list.value.length;
  index.value = (i + n) % n;
  turn.value = 0;
}
async function open(srcs: string[], i: number) {
  list.value = srcs;
  go(i);
  await nextTick();
  if (!dlg.value?.open) dlg.value?.showModal();
  dlg.value?.focus(); // showModal 默认聚焦第一个按钮会冒出焦点环；聚焦弹窗本身，Esc / ←→ 照常可用
}
const close = () => dlg.value?.close();
function onKey(e: KeyboardEvent) {
  if (list.value.length < 2) return;
  if (e.key === 'ArrowLeft') go(index.value - 1);
  if (e.key === 'ArrowRight') go(index.value + 1);
}
/** 点空白处关闭：弹窗铺满全屏，空白处的点击目标是 dialog 本身或图片舞台 */
const onClick = (e: MouseEvent) => (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('viewer-stage')) && close();

defineExpose({ open });
</script>

<template>
  <dialog ref="dlg" tabindex="-1" class="viewer" :class="{ multi: list.length > 1 }" aria-label="图片预览" @click="onClick" @keydown="onKey" @close="list = []">
    <template v-if="src">
      <header class="viewer-bar">
        <span v-if="list.length > 1" class="viewer-count mono">{{ index + 1 }} / {{ list.length }}</span>
        <span class="spacer" />
        <button class="viewer-btn" aria-label="向左旋转" title="向左旋转" @click="turn -= 90"><Icon name="rotateLeft" :size="18" /></button>
        <button class="viewer-btn" aria-label="向右旋转" title="向右旋转" @click="turn += 90"><Icon name="rotateRight" :size="18" /></button>
        <a class="viewer-btn" :href="src" target="_blank" rel="noopener" aria-label="查看原图" title="查看原图"><Icon name="external" :size="18" /></a>
        <button class="viewer-btn" aria-label="关闭预览" title="关闭（Esc）" @click="close"><Icon name="close" :size="20" /></button>
      </header>

      <div class="viewer-stage">
        <img class="viewer-img" :class="{ sideways }" :src="src" :style="{ transform: `rotate(${turn}deg)` }" alt="" />
      </div>

      <template v-if="list.length > 1">
        <button class="viewer-nav prev" aria-label="上一张" @click="go(index - 1)"><Icon name="chevronLeft" :size="26" /></button>
        <button class="viewer-nav next" aria-label="下一张" @click="go(index + 1)"><Icon name="chevronRight" :size="26" /></button>
        <nav class="viewer-thumbs" aria-label="缩略图">
          <button v-for="(s, i) in list" :key="i" :class="{ on: i === index }" :aria-label="`第 ${i + 1} 张`" :aria-current="i === index" @click="go(i)">
            <img :src="s" alt="" />
          </button>
        </nav>
      </template>
    </template>
  </dialog>
</template>
