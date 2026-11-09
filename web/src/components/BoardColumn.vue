<script setup lang="ts">
import type Sortable from 'sortablejs';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { sortable } from '../sortable';
import { addTask, byColumn, type Column, deleteColumn, moveTask, renameColumn } from '../store';
import Icon from './Icon.vue';
import TaskCard from './TaskCard.vue';

const props = defineProps<{ col: Column }>();
const tasks = computed(() => byColumn.value[props.col.id] ?? []);
const locked = computed(() => props.col.kind !== 'normal');
const isDone = computed(() => props.col.kind === 'done');

// 「已完成」：pull/put 都关掉 → 拖不进也拖不出，只能组内排序（进出走完成/取消完成）
const listEl = ref<HTMLElement>();
let s: Sortable | undefined;
onMounted(() => {
  s = sortable(listEl.value!, {
    group: isDone.value ? { name: 'tasks', pull: false, put: false } : 'tasks',
    draggable: '.card',
    filter: '.tick',
    preventOnFilter: false,
    ghostClass: 'card-ghost',
    chosenClass: 'card-chosen',
    dragClass: 'card-drag',
    onDrop: (e) => moveTask(e.item.dataset.id!, (e.to as HTMLElement).dataset.col!, e.newIndex!),
  });
});
onBeforeUnmount(() => s?.destroy());

// ---- 列头菜单：改名 / 删除 ----
const menuOpen = ref(false);
const menuEl = ref<HTMLElement>();
const closeMenu = (e: PointerEvent) => !menuEl.value?.contains(e.target as Node) && toggleMenu(false);
function toggleMenu(open = !menuOpen.value) {
  menuOpen.value = open;
  document[open ? 'addEventListener' : 'removeEventListener']('pointerdown', closeMenu as EventListener);
}
onBeforeUnmount(() => toggleMenu(false));

const renaming = ref(false);
const nameDraft = ref('');
const renameInput = ref<HTMLInputElement>();
async function startRename() {
  toggleMenu(false);
  nameDraft.value = props.col.name;
  renaming.value = true;
  await nextTick();
  renameInput.value?.select();
}
function finishRename(save: boolean) {
  if (!renaming.value) return;
  renaming.value = false;
  const name = nameDraft.value.trim();
  if (save && name && name !== props.col.name) renameColumn(props.col.id, name);
}
function remove() {
  toggleMenu(false);
  if (confirm(`删除列「${props.col.name}」？`)) deleteColumn(props.col.id);
}

// ---- 添加任务 ----
const adding = ref(false);
const title = ref('');
const titleInput = ref<HTMLInputElement>();
async function startAdd() {
  adding.value = true;
  await nextTick();
  titleInput.value?.focus();
}
async function submitTask() {
  const t = title.value.trim();
  if (!t) return (adding.value = false);
  title.value = '';
  await addTask(props.col.id, t);
  await nextTick();
  listEl.value?.lastElementChild?.scrollIntoView({ block: 'nearest' });
}
</script>

<template>
  <section class="col" :class="`col-${col.kind}`" :data-col="col.id" :aria-label="col.name">
    <header class="col-head">
      <input
        v-if="renaming"
        ref="renameInput"
        v-model="nameDraft"
        class="field col-rename"
        maxlength="50"
        @keydown.enter="finishRename(true)"
        @keydown.esc="finishRename(false)"
        @blur="finishRename(true)"
      />
      <h2 v-else class="col-name">{{ col.name }}</h2>
      <span class="col-count mono">{{ tasks.length }}</span>
      <span v-if="locked" class="col-lock" title="锁定列：不能改名、排序或删除"><Icon name="lock" :size="13" /></span>
      <div v-else ref="menuEl" class="menu">
        <button class="icon-btn" aria-label="列操作" :aria-expanded="menuOpen" @click="toggleMenu()">
          <Icon name="more" :size="18" />
        </button>
        <div v-if="menuOpen" class="menu-pop" role="menu">
          <button role="menuitem" @click="startRename">改名</button>
          <button role="menuitem" class="danger" :disabled="tasks.length > 0" :title="tasks.length ? '列里还有任务，先移走才能删除' : ''" @click="remove">
            删除{{ tasks.length ? '（列里有任务）' : '' }}
          </button>
        </div>
      </div>
    </header>

    <div ref="listEl" class="cards" :data-col="col.id">
      <TaskCard v-for="t in tasks" :key="t.id" :task="t" />
    </div>

    <footer v-if="!isDone" class="col-foot">
      <form v-if="adding" @submit.prevent="submitTask">
        <input
          ref="titleInput"
          v-model="title"
          class="field"
          maxlength="200"
          placeholder="任务标题，回车添加"
          @keydown.esc="adding = false"
          @blur="!title.trim() && (adding = false)"
        />
      </form>
      <button v-else class="add-task" @click="startAdd"><Icon name="plus" :size="14" />添加任务</button>
    </footer>
    <p v-else-if="!tasks.length" class="col-hint">点任务的 ○ 或「完成任务」放到这里</p>
  </section>
</template>
