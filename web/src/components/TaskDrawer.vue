<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api';
import { PRIORITIES, fromDateInput, timeLabel, toDateInput } from '../format';
import { renderMd } from '../md';
import { byColumn, columns, complete, deleteTask, findTask, lastChange, moveTask, patchTask, run, state, toast, uncomplete } from '../store';
import Icon from './Icon.vue';
import MdInput from './MdInput.vue';

interface Subtask {
  id: string;
  title: string;
  done: number;
}
interface Entry {
  id: string;
  kind: 'user' | 'system';
  body_md: string;
  created_at: number;
}

// 列 / 优先级 / 截止 / 完成状态直接读看板里的卡片（单一数据源）；抽屉只额外持有描述、子任务、时间线
const card = computed(() => (state.openId ? findTask(state.openId) : undefined));
const done = computed(() => card.value?.done_at != null);
const movable = computed(() => columns.value.filter((c) => c.kind !== 'done'));

const loadedId = ref<string | null>(null);
const savedDesc = ref('');
const title = ref('');
const desc = ref('');
const descMode = ref<'edit' | 'preview'>('preview');
const subtasks = ref<Subtask[]>([]);
const timeline = ref<Entry[]>([]);
const subDraft = ref('');
const comment = ref('');
const sending = ref(false);
const drawerEl = ref<HTMLElement>();
// 标题随内容撑高（Safari 不支持 CSS field-sizing）
const fit = (el: HTMLTextAreaElement) => ((el.style.height = 'auto'), (el.style.height = `${el.scrollHeight}px`));
const vAutosize = { mounted: fit, updated: fit };
const timelineEl = ref<HTMLElement>();

async function fetchDetail(id: string, reset: boolean) {
  const r = await api<{ task: { title: string; desc_md: string }; subtasks: Subtask[]; timeline: Entry[] }>('GET', `/tasks/${id}`);
  if (state.openId !== id) return; // 请求期间切到了别的任务
  subtasks.value = r.subtasks;
  timeline.value = r.timeline;
  if (!reset) return;
  title.value = r.task.title;
  desc.value = savedDesc.value = r.task.desc_md;
  descMode.value = 'preview';
  loadedId.value = id;
}

// ---- 保存：标题失焦保存，描述停手 800ms 自动保存，关闭 / 切换任务时兜底保存 ----
let descTimer: ReturnType<typeof setTimeout> | undefined;
watch(desc, () => {
  clearTimeout(descTimer);
  descTimer = setTimeout(saveDesc, 800);
});
function saveDesc() {
  clearTimeout(descTimer);
  const id = loadedId.value;
  if (!id || !findTask(id) || desc.value === savedDesc.value) return;
  savedDesc.value = desc.value;
  patchTask(id, { desc_md: desc.value });
}
function saveTitle() {
  const t = card.value;
  const v = title.value.trim();
  if (!t || t.id !== loadedId.value) return;
  if (!v) title.value = t.title;
  else if (v !== t.title) patchTask(t.id, { title: v });
}
function flush() {
  saveTitle();
  saveDesc();
}

watch(
  () => state.openId,
  async (id) => {
    loadedId.value = null;
    subtasks.value = [];
    timeline.value = [];
    comment.value = '';
    subDraft.value = '';
    if (!id) return;
    await nextTick();
    drawerEl.value?.focus();
    fetchDetail(id, true).catch((e: Error) => {
      toast(e.message);
      state.openId = null;
    });
  },
);
// 移动 / 完成 / 取消完成之后，服务端写了系统动态，重拉时间线
watch(
  () => lastChange.n,
  () => state.openId && lastChange.id === state.openId && fetchDetail(state.openId, false).catch(() => {}),
);

function close() {
  flush();
  state.openId = null;
}
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && state.openId && !(e.target as HTMLElement).closest('input, textarea, select')) close();
};
window.addEventListener('keydown', onKey);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// ---- 字段 ----
const toggleDone = () => card.value && (done.value ? uncomplete : complete)(card.value.id);
function changeColumn(colId: string) {
  const t = card.value;
  if (t && colId !== t.column_id) moveTask(t.id, colId, (byColumn.value[colId] ?? []).length);
}
const changePriority = (v: string) => card.value && patchTask(card.value.id, { priority: Number(v) });
const changeDue = (v: string) => card.value && patchTask(card.value.id, { due_at: fromDateInput(v) });
function removeTask() {
  const t = card.value;
  if (t && confirm(`删除任务「${t.title}」？子任务和评论会一起删除。`)) deleteTask(t.id);
}

function showPreview() {
  saveDesc();
  descMode.value = 'preview';
}
function onPreviewClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (el instanceof HTMLImageElement) return window.open(el.src, '_blank', 'noopener');
  if (!el.closest('a')) descMode.value = 'edit';
}

// ---- 子任务 / 评论：改完同步卡片上的计数 ----
function syncCounts() {
  const t = card.value;
  if (!t) return;
  t.sub_total = subtasks.value.length;
  t.sub_done = subtasks.value.filter((s) => s.done).length;
  t.comment_count = timeline.value.filter((c) => c.kind === 'user').length;
}
const base = () => `/tasks/${loadedId.value}`;

async function addSub() {
  const t = subDraft.value.trim();
  if (!t || !loadedId.value) return;
  subDraft.value = '';
  const s = await run(() => api<Subtask>('POST', `${base()}/subtasks`, { title: t }));
  if (s) subtasks.value.push(s);
  syncCounts();
}
async function toggleSub(s: Subtask) {
  s.done = s.done ? 0 : 1;
  syncCounts();
  const r = await run(() => api<Subtask>('PATCH', `${base()}/subtasks/${s.id}`, { done: !!s.done }));
  if (!r) s.done = s.done ? 0 : 1;
  syncCounts();
}
async function renameSub(s: Subtask, e: Event) {
  const input = e.target as HTMLInputElement;
  const v = input.value.trim();
  if (!v || v === s.title) return void (input.value = s.title);
  const r = await run(() => api<Subtask>('PATCH', `${base()}/subtasks/${s.id}`, { title: v }));
  if (r) s.title = r.title;
}
async function removeSub(s: Subtask) {
  if (await run(() => api('DELETE', `${base()}/subtasks/${s.id}`).then(() => true))) {
    subtasks.value = subtasks.value.filter((x) => x !== s);
  }
  syncCounts();
}

async function send() {
  const body = comment.value.trim();
  if (!body || sending.value || !loadedId.value || body.includes('](#uploading-')) return;
  sending.value = true;
  const c = await run(() => api<Entry>('POST', `${base()}/comments`, { body_md: body }));
  sending.value = false;
  if (!c) return;
  timeline.value.push(c);
  comment.value = '';
  syncCounts();
  await nextTick();
  timelineEl.value?.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
async function removeComment(c: Entry) {
  if (!confirm('删除这条评论？')) return;
  if (await run(() => api('DELETE', `${base()}/comments/${c.id}`).then(() => true))) {
    timeline.value = timeline.value.filter((x) => x !== c);
  }
  syncCounts();
}
</script>

<template>
  <Transition name="drawer">
    <div v-if="state.openId" class="drawer-wrap" @click.self="close">
      <aside ref="drawerEl" class="drawer" role="dialog" aria-modal="true" aria-label="任务详情" tabindex="-1">
        <header class="drawer-top">
          <button v-if="card" class="btn" :class="done ? 'done-btn' : 'primary'" @click="toggleDone">
            <Icon name="check" :size="15" />{{ done ? '已完成 · 取消完成' : '完成任务' }}
          </button>
          <span class="spacer" />
          <button class="icon-btn" aria-label="删除任务" title="删除任务" @click="removeTask"><Icon name="trash" :size="17" /></button>
          <button class="icon-btn" aria-label="关闭" title="关闭（Esc）" @click="close"><Icon name="close" :size="19" /></button>
        </header>

        <div v-if="card && loadedId === card.id" class="drawer-body">
          <textarea
            v-model="title"
            v-autosize
            class="drawer-title"
            :class="{ done }"
            rows="1"
            maxlength="200"
            aria-label="任务标题"
            @blur="saveTitle"
            @keydown.enter.prevent="($event.target as HTMLElement).blur()"
          />

          <dl class="fields">
            <dt>所在列</dt>
            <dd>
              <select v-if="!done" class="field select" :value="card.column_id" @change="changeColumn(($event.target as HTMLSelectElement).value)">
                <option v-for="c in movable" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <span v-else class="field-static">已完成 <small>（取消完成后回到原列）</small></span>
            </dd>
            <dt>优先级</dt>
            <dd>
              <select class="field select" :class="`p${card.priority}`" :value="card.priority" @change="changePriority(($event.target as HTMLSelectElement).value)">
                <option v-for="(p, i) in PRIORITIES" :key="i" :value="i">{{ p }}</option>
              </select>
            </dd>
            <dt>截止日期</dt>
            <dd class="due-field">
              <input class="field" type="date" :value="toDateInput(card.due_at)" @change="changeDue(($event.target as HTMLInputElement).value)" />
              <button v-if="card.due_at" class="btn ghost small" @click="changeDue('')">清除</button>
            </dd>
          </dl>

          <section class="sec">
            <div class="sec-head">
              <h3>描述</h3>
              <div class="tabs" role="tablist">
                <button role="tab" :aria-selected="descMode === 'edit'" @click="descMode = 'edit'">编辑</button>
                <button role="tab" :aria-selected="descMode === 'preview'" @click="showPreview">预览</button>
              </div>
            </div>
            <MdInput v-if="descMode === 'edit'" v-model="desc" :rows="5" placeholder="写点什么……支持 Markdown，可以直接粘贴截图" />
            <div v-else-if="desc.trim()" class="md desc-preview" title="点击编辑" @click="onPreviewClick" v-html="renderMd(desc)" />
            <button v-else class="desc-empty" @click="descMode = 'edit'">添加描述…</button>
          </section>

          <section class="sec">
            <div class="sec-head">
              <h3>子任务</h3>
              <span v-if="subtasks.length" class="mono sec-count">{{ card.sub_done }}/{{ card.sub_total }}</span>
            </div>
            <div v-if="subtasks.length" class="progress"><i :style="{ width: `${(card.sub_done / card.sub_total) * 100}%` }" /></div>
            <ul class="subs">
              <li v-for="s in subtasks" :key="s.id" :class="{ done: s.done }">
                <button class="tick" :aria-pressed="!!s.done" :aria-label="s.done ? '标记未完成' : '标记完成'" @click="toggleSub(s)">
                  <Icon name="check" :size="11" />
                </button>
                <input class="sub-title" :value="s.title" maxlength="200" aria-label="子任务标题" @change="renameSub(s, $event)" @keydown.enter="($event.target as HTMLElement).blur()" />
                <button class="icon-btn sub-del" aria-label="删除子任务" @click="removeSub(s)"><Icon name="close" :size="14" /></button>
              </li>
            </ul>
            <form @submit.prevent="addSub">
              <input v-model="subDraft" class="field sub-add" maxlength="200" placeholder="+ 添加子任务，回车确认" />
            </form>
          </section>

          <section class="sec">
            <div class="sec-head"><h3>动态</h3></div>
            <ol ref="timelineEl" class="timeline">
              <li v-for="c in timeline" :key="c.id" :class="c.kind">
                <template v-if="c.kind === 'system'">
                  <span class="tl-dot" />
                  <span class="tl-text">{{ c.body_md }}</span>
                  <time class="mono">{{ timeLabel(c.created_at) }}</time>
                </template>
                <template v-else>
                  <div class="bubble md" v-html="renderMd(c.body_md)" />
                  <div class="bubble-meta">
                    <time class="mono">{{ timeLabel(c.created_at) }}</time>
                    <button class="link-btn" @click="removeComment(c)">删除</button>
                  </div>
                </template>
              </li>
            </ol>
          </section>
        </div>
        <p v-else class="drawer-loading mono">载入中…</p>

        <footer v-if="loadedId" class="composer">
          <MdInput v-model="comment" :rows="1" placeholder="写评论…" @submit="send">
            <button class="btn primary small" title="⌘/Ctrl + Enter" :disabled="!comment.trim() || sending" @click="send"><Icon name="send" :size="13" />发送</button>
          </MdInput>
        </footer>
      </aside>
    </div>
  </Transition>
</template>
