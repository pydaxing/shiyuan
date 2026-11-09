import { onScopeDispose, unref, watch } from 'vue';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';

// The topmost visible page owns the native status bar. Closing an editor restores
// the page underneath, including the family cover and the dark avatar viewer.
const layers = [];
let lastAppearance;
function applyAppearance() {
  let appearance;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    appearance = unref(layers[index].appearance);
    if (appearance) break;
  }
  const dark = appearance === 'dark';
  if (lastAppearance?.dark === dark || !uni.setNavigationBarColor) return;
  const request = { dark };
  lastAppearance = request;
  try { uni.setNavigationBarColor({
    frontColor: dark ? '#ffffff' : '#000000',
    backgroundColor: dark ? NATIVE_UI_COLORS.avatarViewer : '#ffffff',
    fail: () => { if (lastAppearance === request) lastAppearance = undefined; },
  }); } catch { if (lastAppearance === request) lastAppearance = undefined; }
}

export function useNavigationAppearance(appearance) {
  const layer = { appearance };
  layers.push(layer);
  const stop = watch(() => unref(appearance), applyAppearance, { immediate: true, flush: 'sync' });
  onScopeDispose(() => {
    stop();
    layers.splice(layers.indexOf(layer), 1);
    applyAppearance();
    if (!layers.length) lastAppearance = undefined;
  });
}
