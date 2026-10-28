import { defineConfig } from 'vite';
import uniModule from '@dcloudio/vite-plugin-uni';
import { syncNativeTaps } from './scripts/sync-taps.mjs';

const uni = uniModule.default || uniModule;

const appStyleScope = {
  postcssPlugin: 'shiyuan-app-style-scope',
  Rule(rule) {
    if (!rule.source?.input.file?.endsWith('/src/styles.css') || rule.selector.includes('.app-shell')) return;
    if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    if (rule.selector.includes(':root') || /^(page|body|uni-page-body)(,|$)/.test(rule.selector)) return;
    rule.selector = rule.selector.split(',').map((selector) => `.app-shell ${selector.trim()}`).join(', ');
  },
};

export default defineConfig({ plugins: [uni({ vueOptions: { template: { compilerOptions: { nodeTransforms: process.env.UNI_PLATFORM === 'mp-weixin' ? [syncNativeTaps] : [] } } } })], css: { postcss: { plugins: [appStyleScope] } } });
