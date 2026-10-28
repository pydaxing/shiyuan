import { nextTick } from 'vue';

export async function afterNativeRender() {
  await nextTick();
  if (typeof wx !== 'undefined' && wx.nextTick) await new Promise(resolve => wx.nextTick(resolve));
}
