import { ref, watch, onScopeDispose } from 'vue';
import { afterNativeRender } from './nativeRender.js';
import { homeMenuGeometry } from '../domain/home-menu.js';

export function kitchenOrderAnchor(index) { return `kitchen-meal-${index}`; }

function scrollToCard(anchor, isCurrent, options = {}) {
  return new Promise(resolve => {
    const info = uni.getSystemInfoSync();
    const inset = homeMenuGeometry(info, info.uniPlatform === 'mp-weixin' ? uni.getMenuButtonBoundingClientRect?.() : null).kitchenTop;
    const query = uni.createSelectorQuery();
    if (options.scope) query.in(options.scope);
    query.select(`#${anchor}`).boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec(([card, viewport]) => {
      if (card && isCurrent()) uni.pageScrollTo({ scrollTop: Math.max(0, card.top + (viewport?.scrollTop || 0) - inset), duration: 0 });
      resolve();
    });
  });
}

export function useKitchenFocus(orders, visible, locked, scrollTo = scrollToCard, options = {}) {
  const requested = ref(null);
  const focusedId = ref('');
  let revision = 0;
  function cancel() { revision += 1; requested.value = null; focusedId.value = ''; }
  function focus(id) { requested.value = { id }; focusedId.value = id; }
  watch([requested, visible, locked, orders], async () => {
    const token = ++revision;
    const id = requested.value?.id;
    if (!id || !visible.value || locked.value) return;
    await afterNativeRender();
    if (token !== revision || !visible.value || locked.value) return;
    const index = orders.value.findIndex((order) => order.id === id);
    if (index < 0) { cancel(); return; }
    if (index === 0 && options.firstAtTop) uni.pageScrollTo({ scrollTop: 0, duration: 0 });
    else await scrollTo((options.anchor || kitchenOrderAnchor)(index), () => token === revision && visible.value && !locked.value && orders.value[index]?.id === id, options);
    if (token === revision) requested.value = null;
  }, { flush: 'post' });
  watch(visible, shown => { if (!shown) cancel(); });
  onScopeDispose(cancel);
  return { focusedId, focus, cancel };
}
