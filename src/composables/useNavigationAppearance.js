import { onScopeDispose, unref, watch } from 'vue';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';

// The topmost visible page owns the native status bar. Closing an editor restores
// the page underneath, including the family cover and the dark avatar viewer.
const layers = [];
function applyAppearance() {
  const current = [...layers].reverse().find(layer => unref(layer.appearance));
  const dark = current && unref(current.appearance) === 'dark';
  uni.setNavigationBarColor?.({
    frontColor: dark ? '#ffffff' : '#000000',
    backgroundColor: dark ? NATIVE_UI_COLORS.avatarViewer : '#ffffff',
  });
}

export function useNavigationAppearance(appearance) {
  const layer = { appearance };
  layers.push(layer);
  const stop = watch(() => unref(appearance), applyAppearance, { immediate: true, flush: 'sync' });
  onScopeDispose(() => {
    stop();
    layers.splice(layers.indexOf(layer), 1);
    applyAppearance();
  });
}
