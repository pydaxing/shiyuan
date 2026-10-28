<script setup>
import AppIcon from './AppIcon.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { state, cloudMode, publishToCommunity } from '../store.js';
import { refreshCloud, invokeCloud } from '../services/cloud.js';
import { publicationStatusMatches, readLegacyPublicationStatus } from '../services/legacy-publication-status.js';
import { publishedFamilyKeys } from '../domain/community-publications.js';
import Sheet from './Sheet.vue';
const props = defineProps({ itemId: String, kind: { type: String, default: 'dish' } });
const emit = defineEmits(['close', 'published']);
const type = ref('全部');
const selectedKey = ref(props.itemId ? `${props.kind}:${props.itemId}` : '');
const confirming = ref(Boolean(props.itemId));
const busy = ref(false);
const error = ref('');
const syncing = ref(false);
const legacyStatus = ref(null);
const publications = computed(() => Array.isArray(state.value.sharedItems) ? state.value.sharedItems : publicationStatusMatches(legacyStatus.value, state.value) ? legacyStatus.value.items : undefined);
const sharedKeys = computed(() => publishedFamilyKeys(Array.isArray(publications.value) ? { sharedItems: publications.value } : state.value));
const ready = computed(() => !cloudMode || Array.isArray(publications.value));
let disposed = false;
const entries = computed(() => [
  ...state.value.mealSets.map((item) => ({ id: item.id, key: `set:${item.id}`, kind: 'set', title: item.title, image: item.image, label: `套餐 · ${item.recipeIds.length} 道菜` })),
  ...state.value.recipes.map((item) => ({ id: item.id, key: `dish:${item.id}`, kind: 'dish', title: item.title, image: item.image, label: item.category })),
].map(item => ({ ...item, shared: sharedKeys.value.has(item.key) })));
const filtered = computed(() => entries.value.filter((item) => type.value === '全部' || item.kind === (type.value === '套餐' ? 'set' : 'dish')));
const selected = computed(() => entries.value.find((entry) => entry.key === selectedKey.value));
const canPublish = computed(() => ready.value && !syncing.value && selected.value && !selected.value.shared);
function select(entry) {
  if (busy.value || syncing.value || !ready.value || entry.shared) return;
  selectedKey.value = entry.key;
  error.value = '';
}
function next() { if (canPublish.value) confirming.value = true; }
async function syncShares() {
  if (!cloudMode || busy.value || syncing.value) return;
  syncing.value = true;
  error.value = '';
  legacyStatus.value = null;
  const scope = `${state.value.family.id}:${state.value.activeMemberId}`;
  const isActive = () => !disposed && scope === `${state.value.family.id}:${state.value.activeMemberId}`;
  try {
    await refreshCloud();
    if (!isActive()) return;
    if (!ready.value) legacyStatus.value = await readLegacyPublicationStatus({ request: invokeCloud, getSnapshot: () => state.value, isActive });
  } catch (failure) { if (isActive()) error.value = failure.message || '分享状态同步失败，请重试'; }
  finally { syncing.value = false; }
}
async function publish() {
  if (busy.value || !canPublish.value) return;
  busy.value = true;
  error.value = '';
  const scope = `${state.value.family.id}:${state.value.activeMemberId}`;
  try {
    await publishToCommunity(selected.value.id, selected.value.kind);
    if (!disposed && scope === `${state.value.family.id}:${state.value.activeMemberId}`) emit('published');
  }
  catch (failure) { if (!disposed) error.value = failure.message; }
  finally { busy.value = false; }
}
watch([() => state.value.family.id, () => state.value.activeMemberId], () => { legacyStatus.value = null; selectedKey.value = ''; confirming.value = false; emit('close'); });
onMounted(() => { if (!ready.value) void syncShares(); });
onUnmounted(() => { disposed = true; });
</script>

<template>
  <Sheet :title="confirming ? '分享到美食？' : '分享我家的拿手菜'" :preferred-height="confirming ? 440 : 620" @close="$emit('close')">
    <view v-if="confirming && selected" class="share-preview">
      <view class="share-preview-card"><FoodThumbnail class="share-preview-cover" :src="selected.image" :kind="selected.kind" /><view class="share-preview-copy"><text class="share-preview-title food-list-title">{{ selected.title }}</text><text class="share-preview-category">{{ selected.label }}</text></view></view>
      <text class="share-preview-note">{{ selected.shared ? '已分享，此内容已在美食页中，无需重复发布。' : `将以「${state.family.name}」分享菜品、做法和图片。` }}</text>
    </view>
    <view v-else>
      <view class="content-types share-types"><button role="button" v-for="entry in ['全部', '菜品', '套餐']" :key="entry" :class="{ active: type === entry }" @click="$feedback(); type = entry" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ entry }}</button></view>
      <view class="set-pick-list">
        <button role="button" v-for="entry in filtered" :key="entry.key" class="set-pick-row share-pick-row" :class="{ selected: selectedKey === entry.key && !entry.shared, 'is-shared': entry.shared, 'is-disabled': busy || syncing || !ready || entry.shared }" :disabled="busy || syncing || !ready || entry.shared" :aria-disabled="busy || syncing || !ready || entry.shared" :aria-label="`${entry.title}${entry.shared ? '，已分享' : ''}`" :aria-pressed="selectedKey === entry.key && !entry.shared" @click="select(entry)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
          <FoodThumbnail :src="entry.image" :kind="entry.kind" />
          <view class="share-pick-copy"><text class="stock-name food-list-title">{{ entry.title }}</text><text class="muted">{{ entry.label }}</text></view>
          <view class="share-pick-action">
            <text v-if="entry.shared" class="share-published-label">已分享</text>
            <view v-else class="pick-check"><AppIcon :name="selectedKey === entry.key ? 'check-inverse' : 'plus'" /></view>
          </view>
        </button>
      </view>
      <text v-if="!filtered.length" class="hint">还没有可分享的内容，先在点餐页创建吧。</text>
    </view>
    <text v-if="syncing" class="hint" role="status">正在同步分享状态…</text>
    <button v-else-if="!ready" role="button" class="text-button" :disabled="busy" :aria-disabled="busy" @click="syncShares">重新同步分享状态</button>
    <text v-if="error" class="error-message" role="alert">{{ error }}</text>
    <template #footer><button v-if="confirming" role="button" class="primary-button full" :disabled="busy || !canPublish" :aria-disabled="busy || !canPublish" :aria-busy="busy" @click="publish" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ busy ? '正在发布…' : selected?.shared ? '已分享' : '确认发布' }}</button><button v-else role="button" class="primary-button full" :disabled="busy || !canPublish" :aria-disabled="busy || !canPublish" @click="next" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">下一步</button></template>
  </Sheet>
</template>

<style scoped>
.share-types { margin-bottom: 8px; }
.set-pick-row.share-pick-row { gap: 12px; padding: var(--food-row-padding) 12px; background: transparent; }
.share-pick-row.is-disabled { background: transparent; }
.share-pick-row.is-shared.is-disabled { opacity: 1; }
.share-pick-row > .share-pick-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.share-pick-copy .stock-name { line-height: 22px; }
.share-pick-row > .share-pick-action { display: flex; align-items: center; justify-content: center; flex: 0 0 48px; }
.share-pick-row .pick-check { margin: 0; }
.is-shared .stock-name { color: var(--muted); }
.share-published-label { color: var(--muted); font-family: var(--font-body); font-size: var(--type-caption); line-height: 20px; white-space: nowrap; }
</style>
