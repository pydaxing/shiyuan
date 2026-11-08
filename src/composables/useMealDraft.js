import { computed, ref, watch } from 'vue';

export function useMealDraft(memberId, currentSelection, menuEntries) {
  const drafts = ref({});
  const cart = computed({
    get: () => drafts.value[memberId.value]?.cart ?? {},
    set: (value) => { drafts.value[memberId.value] = { cart: value, note: note.value }; },
  });
  const note = computed({
    get: () => drafts.value[memberId.value]?.note ?? '',
    set: (value) => { drafts.value[memberId.value] = { cart: { ...cart.value }, note: value }; },
  });
  const dirty = computed(() => Object.keys(cart.value).length > 0 || Boolean(note.value.trim()));

  function retain() { drafts.value[memberId.value] = { cart: { ...cart.value }, note: note.value }; }
  function empty() { drafts.value[memberId.value] = { cart: {}, note: '' }; }
  function clear() { delete drafts.value[memberId.value]; }
  function reset() { drafts.value = {}; }

  watch(menuEntries, (entries) => {
    for (const draft of Object.values(drafts.value)) draft.cart = Object.fromEntries(Object.entries(draft.cart).filter(([key]) => entries.some((entry) => entry.key === key)));
  });

  return { cart, note, dirty, retain, empty, clear, reset };
}
