<script setup>
import { computed, onUnmounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import LazyImage from './LazyImage.vue';
import Sheet from './Sheet.vue';
import StepImagePicker from './StepImagePicker.vue';
import InlineMealDate from './InlineMealDate.vue';
import MealMoodTags from './MealMoodTags.vue';
import { MEAL_MOODS, MEAL_ICONS, MEAL_SLOTS, mealMoodDisplayLabel } from '../domain/meal-social.js';
import { localDate } from '../domain/kitchen.js';
import { foodCover } from '../domain/presentation.js';
import { cloudStatus, currentIdentity, invokeCloud } from '../services/cloud.js';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
const props = defineProps({ order: Object, orders: { type: Array, default: () => [] } });
const selectedOrderId = ref('');
const arrangementsExpanded = ref(false);
const availableOrders = computed(() => (props.orders || []).filter(item => item.date === localDate() && ['pending', 'accepted'].includes(item.status) && item.items?.length));
const arrangementPreviews = computed(() => Object.fromEntries(availableOrders.value.map(order => [order.id, order.items.map(item => item.recipe?.image).filter(image => typeof image === 'string' && image.trim()).map(image => image.trim())])));
function arrangementImageStyle(index, count) {
  return { left: count <= 1 ? '0px' : `calc(${index / (count - 1) * 100}% - ${index / (count - 1) * 32}px)`, zIndex: index + 1 };
}
const selectedOrder = computed(() => props.order || availableOrders.value.find(item => item.id === selectedOrderId.value) || null);
function selectArrangement(id) {
  if (locked.value || uploading.value || props.order) return;
  const order = availableOrders.value.find(item => item.id === id);
  if (id && !order) return;
  if (images.value.length + (order?.items || []).filter(item => item.recipe?.image).length > 9) { error.value = '菜品图和实拍合计最多 9 张，请先减少照片'; return; }
  selectedOrderId.value = id;
  if (order) { date.value = order.date; meal.value = order.meal; }
  arrangementsExpanded.value = false;
}

const emit = defineEmits(['close', 'saved']);
const date = ref(props.order?.date && props.order.date <= localDate() ? props.order.date : localDate());
const meal = ref(MEAL_SLOTS.includes(props.order?.meal) ? props.order.meal : '晚餐');
const images = ref([]), moodIds = ref([]);
const moodsExpanded = ref(false);
const mealExpanded = ref(false);
const mealIcons = MEAL_ICONS;
function toggleMealOptions() {
  if (locked.value || uploading.value) return;
  mealExpanded.value = !mealExpanded.value;
}
function selectMeal(value) {
  if (locked.value || uploading.value || !MEAL_SLOTS.includes(value)) return;
  meal.value = value;
  mealExpanded.value = false;
}
// Freeze the confirmed capability and workspace for this draft. A background
// bootstrap must not change the audience while someone is composing a meal.
const sharedDiary = cloudStatus.value.mealSharingVersion === 2;
const familyMeal = Boolean(currentIdentity?.value?.family?.id && currentIdentity.value.family.kind !== 'personal');
const visibility = ref('public'), visibilityExpanded = ref(false);
const visibilityOptions = [{ value: 'public', label: '发现 · 公开', icon: 'moments' }, sharedDiary && familyMeal
  ? { value: 'family', label: '仅饮食日记', icon: 'lock' }
  : { value: 'private', label: '仅饮食日记', icon: 'lock' }];
const showMealBadge = ref(true);
const visibilityIcon = computed(() => visibilityOptions.find(option => option.value === visibility.value).icon);
const visibilityLabel = computed(() => visibilityOptions.find(option => option.value === visibility.value).label);
function toggleVisibilityOptions() {
  if (locked.value || uploading.value) return;
  visibilityExpanded.value = !visibilityExpanded.value;
}
function selectVisibility(value) {
  if (locked.value || uploading.value || !visibilityOptions.some(option => option.value === value)) return;
  visibility.value = value;
  visibilityExpanded.value = false;
}
const selectedMoods = computed(() => moodIds.value.map(id => MEAL_MOODS.find(mood => mood.id === id)).filter(Boolean));
const moodSummary = computed(() => moodIds.value.map(id => mealMoodDisplayLabel(MEAL_MOODS.find(mood => mood.id === id))).filter(Boolean).join('、') || '未选择');
const kind = computed(() => selectedOrder.value && !images.value.length ? 'plan' : 'actual');
const orderImages = computed(() => (selectedOrder.value?.items || []).filter(item => item.recipe?.image).map(item => foodCover(item.recipe.image)).slice(0, 9));
function toggleMoodOptions() {
  if (locked.value || uploading.value) return;
  moodsExpanded.value = !moodsExpanded.value;
}
function toggleMood(id) {
  if (locked.value || uploading.value) return;
  if (moodIds.value.includes(id)) moodIds.value = moodIds.value.filter(value => value !== id);
  else if (moodIds.value.length < 3) moodIds.value = [...moodIds.value, id];
}
const busy = ref(false), uploading = ref(false), error = ref('');
const pendingRequest = ref(null);
const locked = computed(() => busy.value || Boolean(pendingRequest.value));
let disposed = false;
onUnmounted(() => { disposed = true; });
const requestId = `meal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const spaceId = cloudStatus.value.familyId;
const title = '记下这餐';
async function close() {
  if (busy.value || uploading.value) return;
  if (images.value.length || pendingRequest.value) {
    const discard = await new Promise(resolve => uni.showModal({ title: '离开这条餐食记录？', content: pendingRequest.value ? '上次保存结果尚未确认。建议先重试确认，避免重复发布。' : '这次选择的照片还没有保存为餐食记录。', confirmText: '离开', cancelText: '继续编辑', confirmColor: NATIVE_UI_COLORS.primary, success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (!discard || busy.value || uploading.value) return;
  }
  emit('close');
}
async function save() {
  if (busy.value || uploading.value) return;
  error.value = '';
  if (!pendingRequest.value && selectedOrderId.value && !selectedOrder.value) { error.value = '这条安排已变更，请重新选择'; return; }
  if (!pendingRequest.value && images.value.length + orderImages.value.length > 9) { error.value = '菜品图和实拍合计最多 9 张'; return; }
  if (!pendingRequest.value && kind.value === 'actual' && !images.value.length) { error.value = '先添加这餐的照片'; return; }
  if (!pendingRequest.value && kind.value === 'actual' && date.value > localDate()) { error.value = '实际餐食不能记录在未来日期'; return; }
  busy.value = true;
  try {
    pendingRequest.value ||= { spaceId, requestId, visibility: visibility.value, moodIds: [...moodIds.value], ...(sharedDiary ? { mealSharingVersion: 2, showMealBadge: showMealBadge.value } : {}), ...(selectedOrder.value ? { orderId: selectedOrder.value.id } : {}), ...(kind.value === 'plan' ? { kind: 'plan' } : { kind: 'actual', images: [...images.value], date: date.value, meal: meal.value }) };
    const result = await invokeCloud(pendingRequest.value.orderId ? 'finishMeal' : 'publishMeal', pendingRequest.value);
    if (disposed || cloudStatus.value.familyId !== spaceId) return;
    if (sharedDiary && (result.post?.mealSharingVersion !== 2 || result.post.visibility !== pendingRequest.value.visibility || result.post.showMealBadge !== pendingRequest.value.showMealBadge)) throw new Error('餐食记录的共享范围尚未确认，请重试确认');
    pendingRequest.value = null;
    emit('saved', result.post);
  } catch (failure) {
    if (disposed || cloudStatus.value.familyId !== spaceId) return;
    if (failure.serverRejected && failure.code !== 'INTERNAL') pendingRequest.value = null;
    error.value = pendingRequest.value ? '保存结果暂未确认，请点重试确认，重复请求不会重复发布。' : failure.message || '没有保存成功，请重试';
  }
  finally { busy.value = false; }
}
</script>
<template>
  <Sheet page :title="title" variant="meal-editor" @close="close">
    <view class="meal-composer">
      <view v-if="!order" class="meal-composer-arrangements">
        <button class="meal-composer-setting meal-composer-mood-toggle" :disabled="locked || uploading" :aria-expanded="arrangementsExpanded" @click="arrangementsExpanded = !arrangementsExpanded" hover-class="touch-feedback">
          <text class="meal-composer-setting-label">关联安排</text>
          <text class="meal-composer-setting-value">{{ selectedOrder ? `今天 · ${selectedOrder.meal}` : '不关联' }}</text>
          <AppIcon name="chevron" :size="16" class="meal-composer-chevron" :class="{ 'is-expanded': arrangementsExpanded }" />
        </button>
        <view v-if="arrangementsExpanded">
          <button class="meal-composer-inline-option" :disabled="locked || uploading" @click="selectArrangement('')" hover-class="touch-feedback"><text>不关联，仅记实拍</text><AppIcon v-if="!selectedOrderId" name="check" :size="18" /></button>
          <button v-for="item in availableOrders" :key="item.id" class="meal-composer-inline-option" :disabled="locked || uploading" @click="selectArrangement(item.id)" hover-class="touch-feedback">
            <text class="meal-arrangement-copy">今天 · {{ item.meal }}</text>
            <view class="meal-arrangement-trailing">
              <view v-if="arrangementPreviews[item.id].length" class="meal-arrangement-images" :style="{ width: `${Math.min(108, arrangementPreviews[item.id].length * 38 - 6)}px` }">
                <view v-for="(image, index) in arrangementPreviews[item.id]" :key="index" class="meal-arrangement-image" :style="arrangementImageStyle(index, arrangementPreviews[item.id].length)"><LazyImage :src="image" variant="card" /></view>
              </view>
              <view class="meal-arrangement-check"><AppIcon v-if="selectedOrderId === item.id" name="check" :size="18" /></view>
            </view>
          </button>
          <text v-if="!availableOrders.length" class="meal-arrangement-empty">今天暂无可记录的安排</text>
        </view>
      </view>
      <StepImagePicker v-model="images" :fallback-images="orderImages" :reserved-count="orderImages.length" label="餐食实拍" purpose="meal" variant="meal" :disabled="locked" @busy="uploading = $event" />
      <text v-if="error" class="form-error meal-composer-error" role="alert">{{ error }}</text>
      <view class="meal-composer-settings">
        <button role="button" class="meal-composer-setting meal-composer-mood-toggle" :disabled="locked || uploading" :aria-expanded="moodsExpanded" :aria-controls="moodsExpanded ? 'meal-composer-mood-options' : undefined" :aria-label="`标签：${moodSummary}，${moodsExpanded ? '收起' : '展开'}选择`" @click="toggleMoodOptions" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
          <text class="meal-composer-setting-label">标签</text>
          <view v-if="moodIds.length" class="meal-composer-mood-summary"><MealMoodTags selection-summary :tags="selectedMoods" :selected="moodIds" /></view>
          <text v-else class="meal-composer-setting-value">未选择</text>
          <AppIcon name="chevron" :size="16" class="meal-composer-chevron" :class="{ 'is-expanded': moodsExpanded }" />
        </button>
        <view v-if="moodsExpanded" id="meal-composer-mood-options" class="meal-composer-moods">
          <MealMoodTags editable :selected="moodIds" :disabled="locked || uploading" @toggle="toggleMood" />
        </view>
        <template v-if="selectedOrder">
          <view class="meal-composer-setting">
            <text class="meal-composer-setting-label">用餐日期</text>
            <text class="meal-composer-setting-value">{{ Number(selectedOrder.date.slice(0, 4)) }}年{{ Number(selectedOrder.date.slice(5, 7)) }}月{{ Number(selectedOrder.date.slice(8)) }}日</text>
          </view>
          <view class="meal-composer-setting">
            <text class="meal-composer-setting-label">餐次</text>
            <view class="meal-composer-setting-value meal-composer-visibility-label"><AppIcon :name="mealIcons[selectedOrder.meal] || 'menu'" :size="18" /><text>{{ selectedOrder.meal }}</text></view>
          </view>
        </template>
        <template v-else>
          <InlineMealDate v-model="date" :disabled="locked || uploading" />
          <button class="meal-composer-setting meal-composer-mood-toggle" :disabled="locked || uploading" :aria-expanded="mealExpanded" @click="toggleMealOptions" hover-class="touch-feedback">
            <text class="meal-composer-setting-label">餐次</text>
            <view class="meal-composer-setting-value meal-composer-visibility-label"><AppIcon :name="mealIcons[meal]" :size="18" /><text>{{ meal }}</text></view>
            <AppIcon name="chevron" :size="16" class="meal-composer-chevron" :class="{ 'is-expanded': mealExpanded }" />
          </button>
          <view v-if="mealExpanded">
            <button v-for="option in MEAL_SLOTS" :key="option" class="meal-composer-inline-option" :disabled="locked || uploading" :aria-label="`${option}${meal === option ? '，已选择' : ''}`" @click="selectMeal(option)" hover-class="touch-feedback">
              <view class="meal-composer-visibility-label"><AppIcon :name="mealIcons[option]" :size="18" /><text>{{ option }}</text></view>
              <AppIcon v-if="meal === option" name="check" :size="18" />
            </button>
          </view>
        </template>
        <button class="meal-composer-setting meal-composer-mood-toggle" :disabled="locked || uploading" :aria-expanded="visibilityExpanded" @click="toggleVisibilityOptions" hover-class="touch-feedback">
          <text class="meal-composer-setting-label">谁可以看</text>
          <view class="meal-composer-setting-value meal-composer-visibility-label"><AppIcon :name="visibilityIcon" :size="18" /><text>{{ visibilityLabel }}</text></view>
          <AppIcon name="chevron" :size="16" class="meal-composer-chevron" :class="{ 'is-expanded': visibilityExpanded }" />
        </button>
        <view v-if="visibilityExpanded" class="meal-composer-visibility-options">
          <button v-for="option in visibilityOptions" :key="option.value" class="meal-composer-inline-option" :disabled="locked || uploading" :aria-label="`${option.label}${visibility === option.value ? '，已选择' : ''}`" @click="selectVisibility(option.value)" hover-class="touch-feedback">
            <view class="meal-composer-visibility-label"><AppIcon :name="option.icon" :size="18" /><text>{{ option.label }}</text></view>
            <AppIcon v-if="visibility === option.value" name="check" :size="18" />
          </button>
        </view>

      </view>
      <view class="meal-composer-actions">
        <button class="meal-publish-confirm" :class="{ 'is-pending': busy || uploading }" :disabled="busy || uploading" @click="save" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ busy ? '记录中…' : uploading ? '上传中…' : pendingRequest ? '重试确认' : '记录' }}</button>
      </view>
    </view>
  </Sheet>
</template>
<style scoped>
.meal-composer { --meal-photo-size: calc((100vw - var(--page-gutter) * 2 - 28px - 12px) / 3); padding: 0 14px; background: var(--white); }
.meal-composer-arrangements { margin-bottom: 16px; }
.meal-arrangement-copy { flex-shrink: 0; white-space: nowrap; }
.meal-arrangement-trailing { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; flex: 1; margin-left: 8px; }
.meal-arrangement-images { position: relative; height: 32px; max-width: 100%; flex-shrink: 1; min-width: 32px; }
.meal-arrangement-image { position: absolute; top: 0; width: 32px; height: 32px; overflow: hidden; box-sizing: border-box; border: 1px solid var(--white, #fff); border-radius: 3px; background: var(--paper); }
.meal-arrangement-image :deep(.lazy-photo) { width: 100%; height: 100%; }
.meal-arrangement-check { width: 18px; flex: 0 0 18px; display: flex; align-items: center; }
.meal-arrangement-empty { display: block; padding: 16px 0 16px 40px; color: var(--muted); font-size: var(--type-caption); }
.meal-composer-actions { display: flex; align-items: center; justify-content: center; padding: 24px 0 16px; }
.meal-publish-confirm { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 100%; min-height: 44px; margin: 0; padding: 0 20px; border: 0; border-radius: var(--radius-card); background: var(--green); color: var(--white); font-size: var(--type-control); font-weight: 500; line-height: 22px; }
.meal-publish-confirm.is-pending { background: var(--green); color: var(--white); opacity: .6; }
.meal-composer-error { display: block; margin: 12px 0 0; }
.meal-composer-moods { padding: 12px 0 18px; border-bottom: 1px solid #f0f3f3; }
.meal-composer-settings { margin-top: 20px; border-top: 1px solid #f0f3f3; }
.meal-composer-setting { display: flex; align-items: center; gap: 16px; min-height: 56px; border-bottom: 1px solid #f0f3f3; }
.meal-composer-mood-toggle { width: 100%; margin: 0; padding: 0; border-radius: 0; background: transparent; text-align: left; }
.meal-composer-visibility-label { display: flex; align-items: center; gap: 10px; }
.meal-composer-inline-option { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 52px; margin: 0; padding: 0 0 0 40px; border: 0; border-bottom: 1px solid #f0f3f3; border-radius: 0; background: transparent; color: var(--ink); font-size: var(--type-body); line-height: 24px; text-align: left; }
.meal-composer-mood-summary { flex: 0 1 auto; min-width: 0; max-width: calc(100% - 60px); padding: 10px 0; }
.meal-composer-mood-summary :deep(.meal-mood-tags) { justify-content: flex-end; gap: 6px; }
.meal-composer-chevron { flex-shrink: 0; margin-left: -8px; transition: transform 160ms ease; }
.meal-composer-chevron.is-expanded { transform: rotate(90deg); }
.meal-composer-setting-label { flex: 1; min-width: 0; font-size: var(--type-body); line-height: 24px; }
.meal-composer-setting-value { color: var(--muted); font-size: var(--type-control); line-height: 24px; text-align: right; }
.meal-composer-setting-control { flex: 0 1 170px; min-width: 0; }
.meal-composer-setting-control :deep(.choice-trigger), .meal-composer-setting-control :deep(.meal-date) { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; min-height: 44px; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--muted); font-size: var(--type-control); text-align: right; }
@media (min-width: 761px) { .meal-composer { --meal-photo-size: 160px; } }
</style>
