import { computed, shallowRef } from 'vue';

const stack = shallowRef([]);
export const sheetOpen = computed(() => stack.value.length > 0);
export function registerSheet() {
  const token = Symbol('sheet');
  stack.value = [...stack.value, token];
  return {
    isTop: () => stack.value[stack.value.length - 1] === token,
    close: () => { stack.value = stack.value.filter((entry) => entry !== token); },
  };
}
