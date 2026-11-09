<script setup lang="ts">
import type Sortable from 'sortablejs';
import { computed, nextTick, ref, watch } from 'vue';
import { today } from '../format';
import { dragging, sortable } from '../sortable';
import { addColumn, columns, logout, moveColumn, state } from '../store';
import BoardColumn from './BoardColumn.vue';
import Icon from './Icon.vue';
import TaskDrawer from './TaskDrawer.vue';

const todo = computed(() => columns.value.find((c) => c.kind === 'todo'));
const normals = computed(() => columns.value.filter((c) => c.kind === 'normal'));
const done = computed(() => columns.value.find((c) => c.kind === 'done'));

// 只有普通列放进可排序容器，「待处理」「已完成」在容器外，天然拖不动、也插不到它们外侧
const normalsEl = ref<HTMLElement>();
let colSortable: Sortable | undefined;
watch(normalsEl, (el) => {
  colSortable?.destroy();
  colSortable = el
    ? sortable(el, {
        group: 'columns',
        handle: '.col-head',
        draggable: '.col',
        filter: 'input, button',
        preventOnFilter: false,
        ghostClass: 'col-ghost',
        onDrop: (e) => moveColumn(e.item.dataset.col!, e.newIndex!),
      })
    : undefined;
});

const adding = ref(false);
const newName = ref('');
const nameInput = ref<HTMLInputElement>();
async function startAdd() {
  adding.value = true;
  await nextTick();
  nameInput.value?.focus();
}
async function submitColumn() {
  const name = newName.value.trim();
  if (!name) return (adding.value = false);
  newName.value = '';
  await addColumn(name);
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="wordmark">taskboard</span>
        <span class="mono topbar-date">{{ today() }}</span>
      </div>
      <div class="me">
        <span class="me-name">{{ state.user }}</span>
        <button class="btn ghost small" @click="logout"><Icon name="logout" :size="14" />退出</button>
      </div>
    </header>

    <main class="board" :class="{ dragging }">
      <template v-if="state.loaded && todo && done">
        <BoardColumn :col="todo" />
        <div ref="normalsEl" class="normals">
          <BoardColumn v-for="c in normals" :key="c.id" :col="c" />
        </div>
        <BoardColumn :col="done" />

        <div class="col col-add">
          <form v-if="adding" class="col-add-form" @submit.prevent="submitColumn">
            <input
              ref="nameInput"
              v-model="newName"
              class="field"
              maxlength="50"
              placeholder="列名称，回车创建"
              @blur="!newName.trim() && (adding = false)"
              @keydown.esc="adding = false"
            />
          </form>
          <button v-else class="col-add-btn" @click="startAdd"><Icon name="plus" />新建列</button>
        </div>
      </template>
      <p v-else class="board-loading mono">载入中…</p>
    </main>

    <TaskDrawer />
  </div>
</template>
