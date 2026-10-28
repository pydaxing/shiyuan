import { nextTick, ref } from 'vue';
import { dateOffset } from '../domain/kitchen.js';

export const DIARY_DAY_WIDTH = 60;
const PAGE_DAYS = 93;

export function useDiaryScroll(today) {
  const start = ref(dateOffset(-31, new Date(`${today}T12:00:00`)));
  const count = ref(PAGE_DAYS);
  const scrollLeft = ref(29 * DIARY_DAY_WIDTH);
  const month = ref(today.slice(0, 7));
  let observedLeft = scrollLeft.value;
  let viewportWidth = 300;
  let loading = false;
  let anchor = scrollLeft.value;
  function updateMonth() {
    const center = Math.min(count.value - 1, Math.floor((observedLeft + viewportWidth / 2) / DIARY_DAY_WIDTH));
    month.value = dateOffset(center, new Date(`${start.value}T12:00:00`)).slice(0, 7);
  }
  function onScroll(event) {
    const left = Math.max(0, event.detail.scrollLeft || 0);
    if (anchor !== null && left < anchor - DIARY_DAY_WIDTH) return;
    anchor = null;
    observedLeft = left;
    updateMonth();
  }
  function resize(width) {
    if (width > 0) viewportWidth = width;
    updateMonth();
  }
  async function earlier() {
    if (loading || anchor !== null) return;
    loading = true;
    scrollLeft.value = observedLeft;
    await nextTick();
    start.value = dateOffset(-PAGE_DAYS, new Date(`${start.value}T12:00:00`));
    count.value += PAGE_DAYS;
    observedLeft += PAGE_DAYS * DIARY_DAY_WIDTH;
    anchor = observedLeft;
    scrollLeft.value = observedLeft;
    await nextTick();
    loading = false;
  }
  function later() { count.value += PAGE_DAYS; }
  return { start, count, scrollLeft, month, onScroll, resize, earlier, later };
}
