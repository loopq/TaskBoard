<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api';
import { PRIORITIES, dateLabel, dayFromToday, fromDateInput, isOverdue, timeLabel, toDateInput } from '../format';
import { renderMd } from '../md';
import { byColumn, columns, complete, deleteTask, findTask, lastChange, moveTask, patchTask, run, state, taskUrl, toast, uncomplete } from '../store';
import AddInput from './AddInput.vue';
import Icon from './Icon.vue';
import ImageViewer from './ImageViewer.vue';
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
const comment = ref('');
const sending = ref(false);
const drawerEl = ref<HTMLElement>();
// 标题随内容撑高（Safari 不支持 CSS field-sizing）
const fit = (el: HTMLTextAreaElement) => ((el.style.height = 'auto'), (el.style.height = `${el.scrollHeight}px`));
const vAutosize = { mounted: fit, updated: fit };
const timelineEl = ref<HTMLElement>();
const descInput = ref<InstanceType<typeof MdInput>>();
const viewer = ref<InstanceType<typeof ImageViewer>>();

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
// 图片预览（<dialog>）打开时 Esc 只关预览，不连带关掉抽屉
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && state.openId && !(e.target as HTMLElement).closest('input, textarea, select, dialog')) close();
};
window.addEventListener('keydown', onKey);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// ---- 字段 ----
const stamping = ref(false);
function toggleDone() {
  const t = card.value;
  if (!t) return;
  if (!done.value) {
    stamping.value = true;
    setTimeout(() => (stamping.value = false), 500);
  }
  (done.value ? uncomplete : complete)(t.id);
}
function changeColumn(colId: string) {
  const t = card.value;
  if (t && colId !== t.column_id) moveTask(t.id, colId, (byColumn.value[colId] ?? []).length);
}
const changePriority = (v: string) => card.value && patchTask(card.value.id, { priority: Number(v) });
const changeDue = (v: string) => card.value && patchTask(card.value.id, { due_at: fromDateInput(v) });
const setDue = (days: number) => card.value && patchTask(card.value.id, { due_at: dayFromToday(days) });
/** 「其他时间」：桌面浏览器点日期框本体不弹日历，主动 showPicker；iOS 点上去本来就弹 */
function showPicker(e: MouseEvent) {
  try {
    (e.currentTarget as HTMLInputElement).showPicker?.();
  } catch {
    // 不支持或不在用户手势里：退回浏览器默认行为
  }
}
/** 复制详情链接（给 AI / 自己用）。剪贴板不可用时退回 prompt，让用户手动复制 */
function copyLink() {
  const t = card.value;
  if (!t) return;
  const url = taskUrl(t.no);
  const fallback = () => void prompt('复制任务链接', url);
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(url).then(() => toast(`已复制 #${t.no} 的链接`), fallback);
}
function removeTask() {
  const t = card.value;
  if (t && confirm(`删除任务「${t.title}」？子任务和评论会一起删除。`)) deleteTask(t.id);
}

function showPreview() {
  saveDesc();
  descMode.value = 'preview';
}
async function editDesc() {
  descMode.value = 'edit';
  await nextTick();
  descInput.value?.focus();
}
function onPreviewClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (!(el instanceof HTMLImageElement) && !el.closest('a')) editDesc(); // 点图片交给 onImageClick
}
/** 描述和评论里的图片：点击打开居中预览，可在本任务的所有图片之间翻页（按页面顺序） */
function onImageClick(e: MouseEvent) {
  const img = (e.target as HTMLElement).closest<HTMLImageElement>('.md img');
  if (!img) return;
  e.preventDefault(); // 图片包在链接里时也不跳走
  const all = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLImageElement>('.md img')];
  viewer.value?.open(all.map((i) => i.src), all.indexOf(img));
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

async function addSub(t: string) {
  const id = loadedId.value;
  if (!id) return false;
  const s = await run(() => api<Subtask>('POST', `/tasks/${id}/subtasks`, { title: t }));
  if (!s) return false;
  if (loadedId.value === id) {
    subtasks.value.push(s);
    syncCounts();
  } else {
    const task = findTask(id);
    if (task) task.sub_total++;
  }
  return true;
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
          <button v-if="card" class="btn ghost small task-no" title="复制任务链接" @click="copyLink">
            <span class="mono">#{{ card.no }}</span><Icon name="link" :size="14" />
          </button>
          <span class="spacer" />
          <button class="icon-btn" aria-label="删除任务" title="删除任务" @click="removeTask"><Icon name="trash" :size="17" /></button>
          <button class="icon-btn" aria-label="关闭" title="关闭（Esc）" @click="close"><Icon name="close" :size="19" /></button>
        </header>

        <div v-if="card && loadedId === card.id" class="drawer-body" @click="onImageClick">
          <!-- 完成控件和卡片上是同一个 ○，放在标题前；不再单独做一个「完成任务」按钮 -->
          <div class="title-row">
            <button class="tick big" :class="{ stamping }" :aria-label="done ? '取消完成' : '完成任务'" :aria-pressed="done" @click="toggleDone">
              <Icon name="check" :size="14" />
            </button>
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
          </div>
          <p v-if="card.done_at !== null" class="done-line">
            <span class="stamp">已完成</span>
            <span>{{ timeLabel(card.done_at) }}</span>
            <button class="link-btn" @click="toggleDone">取消完成</button>
          </p>

          <dl class="props">
            <dt>所在列</dt>
            <dd>
              <select v-if="!done" class="pill-select" aria-label="所在列" :value="card.column_id" @change="changeColumn(($event.target as HTMLSelectElement).value)">
                <option v-for="c in movable" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <span v-else class="prop-static">已完成<small> · 取消完成后回到原列</small></span>
            </dd>

            <dt>截止</dt>
            <dd class="chips">
              <template v-if="card.due_at === null">
                <button class="chip" @click="setDue(0)"><Icon name="today" :size="14" />今天</button>
                <button class="chip" @click="setDue(1)"><Icon name="tomorrow" :size="14" />明天</button>
              </template>
              <label class="chip" :class="{ set: card.due_at !== null, overdue: isOverdue(card.due_at, card.done_at) }">
                <Icon name="calendar" :size="14" />{{ card.due_at === null ? '其他时间' : `${dateLabel(card.due_at)} 截止` }}
                <input
                  class="date-pick"
                  type="date"
                  aria-label="截止日期"
                  :value="toDateInput(card.due_at)"
                  @click="showPicker"
                  @change="changeDue(($event.target as HTMLInputElement).value)"
                />
              </label>
              <button v-if="card.due_at !== null" class="icon-btn small" aria-label="清除截止日期" title="清除截止日期" @click="changeDue('')">
                <Icon name="close" :size="14" />
              </button>
            </dd>

            <dt>优先级</dt>
            <dd>
              <select class="pill-select" :class="`p${card.priority}`" aria-label="优先级" :value="card.priority" @change="changePriority(($event.target as HTMLSelectElement).value)">
                <option v-for="(p, i) in PRIORITIES" :key="i" :value="i">{{ i ? p : '无优先级' }}</option>
              </select>
            </dd>
          </dl>

          <section class="sec">
            <h3 class="sec-title">描述</h3>
            <MdInput v-if="descMode === 'edit'" ref="descInput" v-model="desc" :rows="4" placeholder="添加描述……支持 Markdown，可以直接粘贴截图">
              <button class="btn small" @click="showPreview">完成</button>
            </MdInput>
            <div v-else-if="desc.trim()" class="md desc-preview" title="点击编辑" @click="onPreviewClick" v-html="renderMd(desc)" />
            <button v-else class="placeholder-btn" @click="editDesc"><Icon name="plus" :size="14" />添加描述</button>
          </section>

          <section class="sec">
            <h3 class="sec-title">
              子任务
              <template v-if="subtasks.length">
                <span class="mono sec-n">{{ card.sub_done }}/{{ card.sub_total }}</span>
                <span class="progress" :class="{ full: card.sub_done === card.sub_total }"><i :style="{ width: `${(card.sub_done / card.sub_total) * 100}%` }" /></span>
              </template>
            </h3>
            <ul class="subs">
              <li v-for="s in subtasks" :key="s.id" :class="{ done: s.done }">
                <button class="tick" :aria-pressed="!!s.done" :aria-label="s.done ? '标记未完成' : '标记完成'" @click="toggleSub(s)">
                  <Icon name="check" :size="11" />
                </button>
                <input class="sub-title" :value="s.title" maxlength="200" aria-label="子任务标题" @change="renameSub(s, $event)" @keydown.enter="($event.target as HTMLElement).blur()" />
                <button class="icon-btn sub-del" aria-label="删除子任务" @click="removeSub(s)"><Icon name="close" :size="14" /></button>
              </li>
            </ul>
            <AddInput :key="loadedId!" placeholder="添加子任务" :maxlength="200" :add="addSub" />
          </section>

          <section class="sec">
            <h3 class="sec-title">动态</h3>
            <ol ref="timelineEl" class="timeline">
              <li v-for="c in timeline" :key="c.id" :class="c.kind">
                <span class="tl-dot" />
                <template v-if="c.kind === 'system'">
                  <span class="tl-text">{{ c.body_md }}</span>
                  <time>{{ timeLabel(c.created_at) }}</time>
                </template>
                <template v-else>
                  <div class="bubble md" v-html="renderMd(c.body_md)" />
                  <div class="bubble-meta">
                    <time>{{ timeLabel(c.created_at) }}</time>
                    <button class="link-btn" @click="removeComment(c)">删除</button>
                  </div>
                </template>
              </li>
            </ol>
          </section>
        </div>
        <p v-else class="drawer-loading mono">载入中…</p>

        <footer v-if="loadedId" class="composer">
          <MdInput v-model="comment" :rows="1" placeholder="输入评论" @submit="send">
            <button class="btn primary small" title="⌘/Ctrl + Enter" :disabled="!comment.trim() || sending" @click="send"><Icon name="send" :size="13" />发送</button>
          </MdInput>
        </footer>
        <ImageViewer ref="viewer" />
      </aside>
    </div>
  </Transition>
</template>
