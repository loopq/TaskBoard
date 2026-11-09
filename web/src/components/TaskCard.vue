<script setup lang="ts">
import { computed } from 'vue';
import { PRIORITIES, dateLabel, isOverdue } from '../format';
import { justDropped } from '../sortable';
import { type Card, complete, state, uncomplete } from '../store';
import Icon from './Icon.vue';

const props = defineProps<{ task: Card }>();
const done = computed(() => props.task.done_at !== null);
const overdue = computed(() => isOverdue(props.task.due_at, props.task.done_at));

const open = () => !justDropped() && (state.openId = props.task.id);
const toggle = () => (done.value ? uncomplete : complete)(props.task.id);
</script>

<template>
  <article
    class="card"
    :class="[`p${task.priority}`, { done, active: state.openId === task.id }]"
    :data-id="task.id"
    role="button"
    tabindex="0"
    @click="open"
    @keydown.enter.self="open"
  >
    <button class="tick" :aria-label="done ? '取消完成' : '完成任务'" :aria-pressed="done" @click.stop="toggle">
      <Icon name="check" :size="12" />
    </button>
    <div class="card-body">
      <p class="card-title">{{ task.title }}</p>
      <div v-if="task.priority || task.due_at || task.sub_total || task.comment_count" class="card-meta">
        <span v-if="task.due_at" class="due" :class="{ overdue }"><Icon name="calendar" :size="13" />{{ dateLabel(task.due_at) }} 截止</span>
        <span v-if="task.priority" class="flag" :title="`优先级：${PRIORITIES[task.priority]}`">
          <Icon name="flag" :size="13" />{{ PRIORITIES[task.priority] }}
        </span>
        <span v-if="task.sub_total" :class="{ alldone: task.sub_done === task.sub_total }">
          <Icon name="subtasks" :size="13" />{{ task.sub_done }}/{{ task.sub_total }}
        </span>
        <span v-if="task.comment_count"><Icon name="comment" :size="13" />{{ task.comment_count }}</span>
      </div>
    </div>
    <span class="card-no mono" title="任务编号">#{{ task.no }}</span>
  </article>
</template>
