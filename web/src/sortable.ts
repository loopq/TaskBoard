import Sortable, { type SortableEvent } from 'sortablejs';

let lastDrop = 0;
/** 拖完松手时浏览器可能补发一次 click，卡片据此忽略，不误开详情 */
export const justDropped = () => Date.now() - lastDrop < 250;

/**
 * Sortable 直接搬 DOM，会和 Vue 的虚拟 DOM 打架。做法：松手后先把节点放回拖动前的位置
 * （精确到原来的下一个兄弟节点，包括 Vue 的锚点文本节点），再改数据让 Vue 自己重排。
 */
export function sortable(el: HTMLElement, opts: Sortable.Options & { onDrop: (e: SortableEvent) => void }) {
  let next: Node | null = null;
  return Sortable.create(el, {
    animation: 160,
    delay: 200, // 触屏长按后才开始拖，保留正常滑动浏览任务的手势
    delayOnTouchOnly: true,
    touchStartThreshold: 8,
    ...opts,
    onStart(e) {
      next = e.item.nextSibling;
    },
    onEnd(e) {
      lastDrop = Date.now();
      e.from.insertBefore(e.item, next);
      if (e.from !== e.to || e.oldIndex !== e.newIndex) opts.onDrop(e);
    },
  });
}
