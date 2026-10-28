<script setup>
import { computed, ref, watch } from 'vue';
import { mutationStatus, retryMutation, dismissMutation } from '../services/cloud.js';
import { sheetOpen } from '../composables/sheetStack.js';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';

const retrying = ref('');
const localError = ref('');
const failure = computed(() => mutationStatus.value.failures[0]);
watch(() => failure.value?.id, () => { localError.value = ''; retrying.value = ''; });
async function retry() {
  if (!failure.value || retrying.value) return;
  const id = failure.value.id;
  retrying.value = id; localError.value = '';
  try { await retryMutation(id); }
  catch (error) { if (failure.value?.id === id) localError.value = error.message || '暂时未能同步，请稍后重试'; }
  finally { if (retrying.value === id) retrying.value = ''; }
}
function dismiss() {
  const entry = failure.value;
  if (!entry || entry.status === 'uncertain' || entry.canDismiss === false || retrying.value) return;
  uni.showModal({ title: '放弃这项未同步修改？', content: '仅移除这次未完成的修改，保留当前云端内容。', confirmText: '放弃修改', cancelText: '保留', confirmColor: NATIVE_UI_COLORS.danger, success: async result => {
    if (!result.confirm || failure.value?.id !== entry.id) return;
    try { await dismissMutation(entry.id); }
    catch (error) { if (failure.value?.id === entry.id) localError.value = error.message || '暂时无法放弃，请重试'; }
  } });
}
</script>

<template>
  <view v-if="failure && !sheetOpen" class="cloud-sync-warning mutation-failure" role="alert">
    <view class="mutation-failure-copy"><text class="mutation-copy-line mutation-failure-title">{{ failure.label || '修改' }}未同步{{ mutationStatus.failures.length > 1 ? `（${mutationStatus.failures.length}项）` : '' }}</text><text class="mutation-copy-line">{{ localError || failure.message }}</text></view>
    <button v-if="failure.canRetry !== false" role="button" class="text-button mutation-action" :disabled="Boolean(retrying)" @click="retry" hover-class="touch-feedback">{{ retrying ? '重试中' : '重试' }}</button>
    <button v-if="failure.status !== 'uncertain' && failure.canDismiss !== false" role="button" class="text-button mutation-action mutation-dismiss" :disabled="Boolean(retrying)" @click="dismiss" hover-class="touch-feedback">放弃</button>
  </view>
</template>

<style scoped>
.mutation-failure { align-items: center; gap: 8px; padding: 6px 10px; }
.mutation-failure-copy { flex: 1; min-width: 0; font-size: var(--type-caption); line-height: 18px; overflow-wrap: anywhere; }
.mutation-copy-line { display: block; }
.mutation-failure-title { font-size: var(--type-meta); font-weight: 600; }
.mutation-action { flex: 0 0 auto; min-width: 44px; min-height: 44px; margin: 0; padding: 0 4px; font-size: var(--type-meta); }
.mutation-dismiss { color: var(--danger); }
</style>
