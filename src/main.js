import { createSSRApp } from 'vue';
import App from './App.vue';
import { tapFeedback } from './services/feedback.js';
import { resolveImage } from './services/cloud.js';

export function createApp() {
  const app = createSSRApp(App);
  app.config.globalProperties.$feedback = tapFeedback;
  app.config.globalProperties.$image = resolveImage;
  return { app };
}
