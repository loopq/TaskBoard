<script setup lang="ts">
import { computed, ref } from 'vue';
import { PRIORITIES, dateLabel, isDueToday, isOverdue } from '../format';
import { justDropped } from '../sortable';
import { type Card, complete, state, uncomplete } from '../store';
import Icon from './Icon.vue';

/** index 只用来算首屏入场的错位延迟 */
const props = defineProps<{ task: Card; index: number }>();
const done = computed(() => props.task.done_at !== null);
const overdue = computed(() => isOverdue(props.task.due_at, props.task.done_at));
const dueToday = computed(() => isDueToday(props.task.due_at, props.task.done_at));
// 盖章动画只给「点下去完成」那一下；首屏已完成的卡片不动
const stamping = ref(false);

const open = () => !justDropped() && (state.openId = props.task.id);
function toggle() {
  if (stamping.value) return;
  if (done.value) return void uncomplete(props.task.id);
  // 先在原地盖章，再搬去「已完成」：complete() 是乐观更新，卡片会立刻换列重新挂载，不等一下动画根本看不见
  stamping.value = true;
  setTimeout(() => {
    stamping.value = false;
    complete(props.task.id);
  }, 380);
}
</script>

<template>
  <article
    class="card"
    :class="[`p${task.priority}`, { done, active: state.openId === task.id }]"
    :data-id="task.id"
    :style="{ '--i': Math.min(index, 12) }"
    role="button"
    tabindex="0"
    @click="open"
    @keydown.enter.self="open"
  >
    <button class="tick" :class="{ stamping }" :aria-label="done ? '取消完成' : '完成任务'" :aria-pressed="done || stamping" @click.stop="toggle">
      <Icon name="check" :size="12" />
    </button>
    <div class="card-body">
      <p class="card-title">{{ task.title }}</p>
      <!-- 底栏永远渲染（编号保证非空）：每张卡结构一致，高度自然整齐，不靠 min-height 硬撑 -->
      <div class="card-foot">
        <span v-if="task.done_at !== null" class="meta"><Icon name="check" :size="12" />{{ dateLabel(task.done_at) }}完成</span>
        <template v-else>
          <span v-if="task.due_at !== null" class="meta due" :class="{ overdue, today: dueToday }">
            <Icon :name="overdue ? 'clock' : 'calendar'" :size="12" />{{ dateLabel(task.due_at) }}
          </span>
          <span v-if="task.priority" class="meta flag" :title="`优先级：${PRIORITIES[task.priority]}`">
            <Icon name="flag" :size="12" />{{ PRIORITIES[task.priority] }}
          </span>
        </template>
        <span v-if="task.sub_total" class="meta" :class="{ alldone: task.sub_done === task.sub_total }">
          <Icon name="subtasks" :size="12" />{{ task.sub_done }}/{{ task.sub_total }}
        </span>
        <span v-if="task.comment_count" class="meta"><Icon name="comment" :size="12" />{{ task.comment_count }}</span>
        <span class="card-no mono" title="任务编号">#{{ task.no }}</span>
      </div>
    </div>
  </article>
</template>
