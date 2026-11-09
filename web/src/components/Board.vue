<script setup lang="ts">
import type Sortable from 'sortablejs';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { today } from '../format';
import { sortable } from '../sortable';
import { addColumn, byColumn, columns, findTask, logout, moveColumn, state } from '../store';
import AddInput from './AddInput.vue';
import BoardColumn from './BoardColumn.vue';
import Icon from './Icon.vue';
import TaskDrawer from './TaskDrawer.vue';

const todo = computed(() => columns.value.find((c) => c.kind === 'todo'));
const normals = computed(() => columns.value.filter((c) => c.kind === 'normal'));
const done = computed(() => columns.value.find((c) => c.kind === 'done'));
const selectedId = ref('');
const addingColumn = ref(false);
const mobileQuery = window.matchMedia('(max-width: 640px)');
const mobile = ref(mobileQuery.matches);
const onViewport = () => (mobile.value = mobileQuery.matches);
mobileQuery.addEventListener('change', onViewport);
onBeforeUnmount(() => mobileQuery.removeEventListener('change', onViewport));

watch(columns, (cols) => {
  if (!cols.some((c) => c.id === selectedId.value)) selectedId.value = todo.value?.id ?? '';
}, { immediate: true });
watch(() => state.openId ? findTask(state.openId)?.column_id : undefined, (id) => {
  if (id) {
    selectedId.value = id;
    addingColumn.value = false;
  }
}, { immediate: true });

async function submitColumn(name: string) {
  const col = await addColumn(name);
  if (!col) return false;
  selectedId.value = col.id;
  addingColumn.value = false;
  return true;
}

// 只有普通列放进可排序容器，「待处理」「已完成」在容器外，天然拖不动、也插不到它们外侧
const normalsEl = ref<HTMLElement>();
let colSortable: Sortable | undefined;
watch([normalsEl, mobile], ([el, isMobile]) => {
  colSortable?.destroy();
  colSortable = el && !isMobile
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
onBeforeUnmount(() => colSortable?.destroy());
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="wordmark">taskboard</span>
        <span class="mono topbar-date">{{ today() }}</span>
      </div>
      <div class="me">
        <span class="avatar" aria-hidden="true">{{ state.user?.[0]?.toUpperCase() }}</span>
        <span class="me-name">{{ state.user }}</span>
        <button class="btn ghost small" @click="logout"><Icon name="logout" :size="14" />退出</button>
      </div>
    </header>

    <nav v-if="state.loaded" class="mobile-nav" aria-label="看板分组">
      <select v-model="selectedId" class="field" aria-label="当前分组" @change="addingColumn = false">
        <option v-for="c in columns" :key="c.id" :value="c.id">{{ c.name }} · {{ byColumn[c.id]?.length ?? 0 }}</option>
      </select>
      <button class="btn" :aria-expanded="addingColumn" @click="addingColumn = !addingColumn">
        {{ addingColumn ? '返回列表' : '新建分组' }}
      </button>
    </nav>

    <main class="board" :class="{ 'adding-column': addingColumn }">
      <template v-if="state.loaded && todo && done">
        <BoardColumn :col="todo" :mobile="mobile" :class="{ 'mobile-current': selectedId === todo.id && !addingColumn }" />
        <div ref="normalsEl" class="normals">
          <BoardColumn v-for="c in normals" :key="c.id" :col="c" :mobile="mobile" :class="{ 'mobile-current': selectedId === c.id && !addingColumn }" />
        </div>
        <BoardColumn :col="done" :mobile="mobile" :class="{ 'mobile-current': selectedId === done.id && !addingColumn }" />

        <div class="col col-add">
          <AddInput placeholder="新建列" :maxlength="50" :add="submitColumn" />
        </div>
      </template>
      <p v-else class="board-loading mono">载入中…</p>
    </main>

    <TaskDrawer />
  </div>
</template>
