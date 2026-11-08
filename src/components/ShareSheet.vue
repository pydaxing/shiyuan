<script setup>
import AppIcon from './AppIcon.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import RecipeListMeta from './RecipeListMeta.vue';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { state, workspaceName, cloudMode, publishToCommunity } from '../store.js';
import { refreshCloud, invokeCloud } from '../services/cloud.js';
import { publicationStatusMatches, readLegacyPublicationStatus } from '../services/legacy-publication-status.js';
import { publishedFamilyKeys } from '../domain/community-publications.js';
import { recipeFieldErrors } from '../domain/kitchen.js';
import { hasRecipeCover } from '../domain/presentation.js';
import { isUnchangedCommunityRecipe } from '../domain/recipe-identity.js';
import Sheet from './Sheet.vue';
const props = defineProps({ itemId: String, kind: { type: String, default: 'dish' } });
const emit = defineEmits(['close', 'published', 'supplement']);
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
  ...state.value.mealSets.map((item) => ({ id: item.id, key: `set:${item.id}`, kind: 'set', title: item.title, image: item.image, label: '套餐', count: item.recipeIds.length })),
  ...state.value.recipes.map((item) => ({ id: item.id, key: `dish:${item.id}`, kind: 'dish', title: item.title, image: item.image, label: item.category, minutes: item.minutes, fromCommunity: isUnchangedCommunityRecipe(item, state.value.posts) })),
].map(item => ({ ...item, shared: sharedKeys.value.has(item.key) })));
const filtered = computed(() => entries.value.filter((item) => type.value === '全部' || item.kind === (type.value === '套餐' ? 'set' : 'dish')));
const selected = computed(() => entries.value.find((entry) => entry.key === selectedKey.value));
const incompleteRecipe = computed(() => {
  const entry = selected.value;
  if (!entry || entry.shared || entry.fromCommunity) return null;
  const ids = entry.kind === 'dish' ? [entry.id] : state.value.mealSets.find(item => item.id === entry.id)?.recipeIds || [];
  return state.value.recipes.find(recipe => ids.includes(recipe.id) && Object.keys(recipeFieldErrors(recipe, { requireCover: true, requireDetails: true })).length) || null;
});
const missingFields = computed(() => {
  if (!incompleteRecipe.value) return [];
  const keys = Object.keys(recipeFieldErrors(incompleteRecipe.value, { requireCover: true, requireDetails: true }));
  return [
    { label: '封面', prefixes: ['image'] },
    { label: '基本信息', prefixes: ['title', 'category', 'servings', 'minutes'] },
    { label: '食材', prefixes: ['ingredients'] },
    { label: '做法', prefixes: ['steps'] },
  ].filter(item => keys.some(key => item.prefixes.some(prefix => key === prefix || key.startsWith(`${prefix}.`))));
});
const canPublish = computed(() => ready.value && !syncing.value && selected.value && !selected.value.shared);
function select(entry) {
  if (busy.value || syncing.value || !ready.value || entry.shared) return;
  selectedKey.value = entry.key;
  error.value = '';
}
function checkCover() {
  const entry = selected.value;
  if (!entry) return false;
  if (entry.fromCommunity) {
    error.value = '美食已有，此菜品来自美食';
    return false;
  }
  const recipes = entry.kind === 'dish'
    ? state.value.recipes.filter(recipe => recipe.id === entry.id)
    : state.value.recipes.filter(recipe => state.value.mealSets.find(item => item.id === entry.id)?.recipeIds.includes(recipe.id));
  const missing = recipes.find(recipe => !hasRecipeCover(recipe.image));
  if (missing) {
    error.value = `请先为「${missing.title}」添加封面图，再分享到美食`;
    return false;
  }
  for (const recipe of recipes) {
    const issue = Object.values(recipeFieldErrors(recipe, { requireCover: true, requireDetails: true }))[0];
    if (issue) { error.value = `请先补充「${recipe.title}」的详细信息：${issue}`; return false; }
  }
  return true;
}
function next() { if (canPublish.value && checkCover()) confirming.value = true; }
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
  if (!checkCover()) return;
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
  <Sheet :title="confirming ? '分享到美食' : '分享我家的拿手菜'" variant="publication" :fit-content="confirming" :preferred-height="confirming ? 520 : 620" @close="$emit('close')">
    <view v-if="confirming && selected" class="share-preview">
      <view class="share-preview-card"><FoodThumbnail class="share-preview-cover" :src="selected.image" :kind="selected.kind" /><view class="share-preview-copy"><text class="share-preview-title food-list-title">{{ selected.title }}</text><RecipeListMeta :category="selected.label" :minutes="selected.minutes" :origin="selected.kind === 'dish' ? (selected.fromCommunity ? '美食' : '自建') : ''" :count="selected.count" /></view></view>
      <view v-if="incompleteRecipe" class="publication-guide">
        <view class="publication-guide-heading"><text class="publication-guide-title">发布前，还差一点</text><text class="publication-guide-count">{{ missingFields.length }} 项待完善</text></view>
        <text v-if="selected.kind === 'set'" class="publication-guide-copy">{{ incompleteRecipe.title }}</text>
        <view class="publication-missing"><view v-for="field in missingFields" :key="field.label" class="publication-missing-row"><text>{{ field.label }}</text><text class="publication-missing-status">待补充</text></view></view>
      </view>
      <text class="share-preview-note">{{ selected.fromCommunity ? '美食已有，此菜品来自美食' : selected.shared ? '已分享，此内容已在美食页中，无需重复发布。' : `发布身份 · ${workspaceName}` }}</text>
    </view>
    <view v-else>
      <view class="content-types share-types"><button role="button" v-for="entry in ['全部', '菜品', '套餐']" :key="entry" :class="{ active: type === entry }" @click="$feedback(); type = entry" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ entry }}</button></view>
      <view class="set-pick-list">
        <button role="button" v-for="entry in filtered" :key="entry.key" class="set-pick-row share-pick-row" :class="{ selected: selectedKey === entry.key && !entry.shared, 'is-shared': entry.shared, 'is-disabled': busy || syncing || !ready || entry.shared }" :disabled="busy || syncing || !ready || entry.shared" :aria-disabled="busy || syncing || !ready || entry.shared" :aria-label="`${entry.title}${entry.shared ? '，已分享' : ''}`" :aria-pressed="selectedKey === entry.key && !entry.shared" @click="select(entry)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
          <FoodThumbnail :src="entry.image" :kind="entry.kind" />
          <view class="share-pick-copy"><text class="stock-name food-list-title">{{ entry.title }}</text><RecipeListMeta :category="entry.label" :minutes="entry.minutes" :origin="entry.kind === 'dish' ? (entry.fromCommunity ? '美食' : '自建') : ''" :count="entry.count" /></view>
          <view class="share-pick-action">
            <text v-if="entry.shared" class="share-published-label">已分享</text>
            <text v-else-if="entry.fromCommunity" class="share-published-label">美食已有</text>
            <view v-else class="pick-check"><AppIcon :name="selectedKey === entry.key ? 'check-inverse' : 'plus-inverse'" :size="14" /></view>
          </view>
        </button>
      </view>
      <text v-if="!filtered.length" class="hint">还没有可分享的内容，先在点餐页创建吧。</text>
    </view>
    <text v-if="syncing" class="hint" role="status">正在同步分享状态…</text>
    <button v-else-if="!ready" role="button" class="text-button" :disabled="busy" :aria-disabled="busy" @click="syncShares">重新同步分享状态</button>
    <text v-if="error" class="error-message" role="alert">{{ error }}</text>
    <template #footer><button v-if="confirming && incompleteRecipe" class="primary-button full" :disabled="busy" @click="$emit('supplement', incompleteRecipe)">去补充</button><button v-else-if="confirming" role="button" class="primary-button full" :disabled="busy || !canPublish" :aria-disabled="busy || !canPublish" :aria-busy="busy" @click="publish" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ busy ? '正在发布…' : selected?.shared ? '已分享' : '确认发布' }}</button><button v-else role="button" class="primary-button full" :disabled="busy || !canPublish" :aria-disabled="busy || !canPublish" @click="next" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">下一步</button></template>
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
.share-preview { gap: 0; }
.share-preview-card { padding: 0; border: 0; border-radius: 0; background: transparent; gap: 14px; }
.share-preview-cover { flex: 0 0 88px; width: 88px; }
.share-preview-note { margin-top: 12px; line-height: 1.6; font-size: var(--type-caption); }
.publication-guide { margin-top: 18px; padding: 18px 0 0; border-top: 1px solid var(--line); }
.publication-guide-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.publication-guide-title { font-size: var(--type-body); color: var(--ink); font-weight: 500; }
.publication-guide-count { font-size: var(--type-caption); color: var(--muted); white-space: nowrap; }
.publication-guide-copy { display: block; margin-top: 12px; color: var(--muted); font-size: var(--type-meta); line-height: 1.6; }
.publication-missing { margin-top: 8px; }
.publication-missing-row { display: flex; align-items: center; justify-content: space-between; min-height: 38px; gap: 12px; font-size: var(--type-meta); color: var(--ink); border-bottom: 1px solid var(--line); }
.publication-missing-status { color: var(--danger); font-size: var(--type-caption); }
</style>
