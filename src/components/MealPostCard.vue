<script setup>
import { computed, ref, watch, onUnmounted, inject } from 'vue';
import { mealPublicationAge, mealOrigin, MEAL_ICONS } from '../domain/meal-social.js';
import AppIcon from './AppIcon.vue';
import LazyImage from './LazyImage.vue';
import MealMoodTags from './MealMoodTags.vue';
import MealLikeNames from './MealLikeNames.vue';
import { previewImages } from '../services/images.js';
import { singleFeedImageWidth } from '../domain/feed-image-layout.js';
import { mealPostMedia } from '../domain/meal-post-media.js';
import { cloudStatus, invokeCloud } from '../services/cloud.js';
import { notify } from '../store.js';
import CommunityView from './CommunityView.vue';
import OrderActionMenu from './OrderActionMenu.vue';
const editCommunityEntry = inject('editCommunityEntry', () => {});
const props = defineProps({ post: Object, now: { type: Number, default: () => Date.now() }, busy: Boolean, timeline: Boolean, personalDiary: Boolean, feed: Boolean, last: Boolean, manageable: { type: Boolean, default: true } });
const emit = defineEmits(['like', 'react', 'visibility', 'remove']);
const mealIcons = MEAL_ICONS;
const origin = computed(() => mealOrigin(props.post));
const dishMedia = computed(() => mealPostMedia(props.post));
const media = computed(() => dishMedia.value.filter(item => !item.defaultCover));
const dishesWithoutCover = computed(() => dishMedia.value.filter(item => item.defaultCover));
const singleImageSizes = ref({});
const singleImageStyle = computed(() => {
  if (!props.feed || media.value.length !== 1) return {};
  const size = singleImageSizes.value[media.value[0].image] || {};
  return { width: `${singleFeedImageWidth(size.width, size.height)}px` };
});
function rememberImageSize(image, size) { if (props.feed && media.value.length === 1) singleImageSizes.value = { [image]: size }; }
const recipeDetail = ref(null);
const openingDish = ref(false);
let detailRequest = 0;
const resolvedPostIds = new Map();
function closeDetail() { detailRequest += 1; openingDish.value = false; recipeDetail.value = null; }
watch(() => JSON.stringify([props.post.id, props.post.visibility, cloudStatus?.value?.userId, cloudStatus?.value?.familyId,
  props.post.kind, (props.post.dishes || []).map(dish => [dish.recipeId, dish.image, dish.sourceKind])]), () => { resolvedPostIds.clear(); closeDetail(); }, { flush: 'sync' });
onUnmounted(closeDetail);
async function openMedia(item) {
  // Resolve the tap against the current card: a late tap must not keep an old
  // public classification after the post has changed. Text-only dishes are
  // deliberately not actionable, including on older unclassified records.
  const current = media.value.find(candidate => candidate.image === item.image
    && Boolean(candidate.isDish) === Boolean(item.isDish) && candidate.dishIndex === item.dishIndex);
  if (!current?.image) return;
  if (!current.canOpenRecipe) { void previewImages(media.value.map(photo => photo.image), current.image); return; }
  if (openingDish.value) return;
  const request = ++detailRequest;
  openingDish.value = true;
  try {
    const dish = props.post.dishes[current.dishIndex];
    const cachedId = dish.communityPostId || resolvedPostIds.get(current.dishIndex) || '';
    const seed = { id: cachedId, kind: 'dish', title: current.title, image: current.image, recipes: [{ id: dish.recipeId, title: current.title, image: current.image }] };
    // Open with the visible title and image before resolving legacy post links.
    recipeDetail.value = seed;
    const postId = cachedId || (await invokeCloud('mealDishDetail', { postId: props.post.id, dishIndex: current.dishIndex })).communityPostId;
    if (request !== detailRequest) return;
    if (!postId) { closeDetail(); notify('这道美食已下架或暂不可用'); return; }
    resolvedPostIds.set(current.dishIndex, postId);
    if (!cachedId) recipeDetail.value = { ...seed, id: postId };

  } catch (error) {
    if (request === detailRequest) { recipeDetail.value = null; notify(error.message === '不支持的请求' ? '菜品详情正在更新，请稍后重试' : error.message || '菜品详情暂不可用'); }
  } finally { if (request === detailRequest) openingDish.value = false; }
}
const dishNames = computed(() => (props.post.dishes || []).map(dish => typeof dish.title === 'string' ? dish.title.trim() : '').filter(Boolean));
const familyMeal = computed(() => props.post.mealSharingVersion === 2 && props.post.mealContext === 'family');
const visibilityActions = computed(() => familyMeal.value
  ? [{ value: 'public', label: '设为公开' }, { value: 'family', label: '仅饮食日记' }].filter(action => action.value !== props.post.visibility)
  : [props.post.visibility === 'public' ? { value: 'private', label: '仅饮食日记' } : { value: 'public', label: '设为公开' }]);
const audienceLabel = computed(() => props.post.visibility === 'public' ? '发现 · 公开' : ['family', 'private'].includes(props.post.visibility) ? '仅饮食日记' : '');
const audienceIcon = computed(() => props.post.visibility === 'public' ? 'moments' : 'lock');
const canManage = computed(() => props.manageable !== false && (props.post.canDelete || props.post.canChangeVisibility || props.post.isOwner));
const menuOpened = ref(false);
const sharedLikeMenu = inject('mealLikeMenu', ref(''));
const likeMenuOpened = computed({ get: () => sharedLikeMenu.value === props.post.id, set: open => { if (open) sharedLikeMenu.value = props.post.id; else if (sharedLikeMenu.value === props.post.id) sharedLikeMenu.value = ''; } });
const likeNames = computed(() => (props.post.likeUsers || []).map(user => user.name).join('，'));
function toggleLike() {
  if (props.busy) return;
  likeMenuOpened.value = false;
  emit('like', !props.post.liked);
}
watch(() => [props.post.id, props.post.visibility, props.busy], () => { likeMenuOpened.value = false; });

const menuActions = computed(() => [
  ...(props.post.canChangeVisibility === false ? [] : [{ action: 'visibility', label: visibilityActions.value[0].label }]),
  ...(props.post.canDelete === false ? [] : [{ action: 'remove', label: '删除' }]),
]);
watch(() => JSON.stringify([props.post.id, props.post.visibility, props.busy, props.manageable,
  props.post.canDelete, props.post.canChangeVisibility, cloudStatus?.value?.userId, cloudStatus?.value?.familyId]),
  () => { menuOpened.value = false; }, { flush: 'sync' });
function closeMenu(selectedAction) { if (!selectedAction) menuOpened.value = false; }
function more() { if (!props.busy && canManage.value) menuOpened.value = true; }
function chooseMenu(action) {
  if (props.busy || !canManage.value || !menuOpened.value) return;
  menuOpened.value = false;
  if (!menuActions.value.some(option => option.action === action)) return;
  if (action === 'visibility') emit('visibility', visibilityActions.value[0].value);
  if (action === 'remove') emit('remove');
}
</script>
<template>
  <view class="meal-post-card" :class="{ 'in-timeline': timeline, 'in-feed': feed, 'is-saving': busy, 'is-last': last }">
    <view class="meal-post-heading">
      <view v-if="timeline" class="meal-post-meal"><view class="meal-post-slot"><text v-if="personalDiary && origin" class="meal-origin-badge source-badge source-badge-compact" :class="origin === 'family' ? 'source-badge-community' : 'source-badge-custom'">{{ origin === 'family' ? '家庭' : '独享' }}</text><AppIcon :name="mealIcons[post.meal] || 'menu'" :size="14" /><text>{{ post.meal }}</text></view><view v-if="audienceLabel" class="meal-post-state"><AppIcon :name="audienceIcon" :size="13" /><text>{{ audienceLabel }}</text></view></view>
      <view v-else class="meal-post-author"><view class="meal-post-avatar"><LazyImage :src="post.author.avatar" variant="avatar" avatar round /></view><view class="meal-post-author-copy"><view class="meal-post-author-name"><text class="meal-post-name">{{ post.author.name }}</text></view><text v-if="!feed" class="meal-post-meta">{{ post.date }} · {{ post.meal }}</text></view></view>
      <OrderActionMenu v-if="canManage" elevated :label="post.meal || '这条餐食'" :opened="menuOpened" :busy="busy" :actions="menuActions" @activate="more" @close="closeMenu" @visibility="chooseMenu('visibility')" @remove="chooseMenu('remove')" />
    </view>
    <view v-if="media.length" class="meal-post-images" :style="singleImageStyle" :class="{ single: media.length === 1, paired: media.length === 2 || media.length === 4, 'has-dishes': post.kind === 'plan' }">
      <button v-for="(item, index) in media" :key="`${index}:${item.image}`" class="meal-post-image" :aria-label="item.canOpenRecipe ? `查看${item.title}菜品详情` : item.isDish ? `查看${item.title}大图` : `查看${post.meal}第${index + 1}张照片`" @click="openMedia(item)" hover-class="touch-feedback"><view class="meal-post-image-frame"><LazyImage :src="item.image" @natural-size="rememberImageSize(item.image, $event)" :variant="feed ? 'original' : 'card'" :mode="feed && media.length === 1 ? 'widthFix' : 'aspectFill'" /><text v-if="feed && item.sourceLabel" class="meal-post-image-source source-badge source-badge-compact" :class="item.sourceLabel === '美食' ? 'source-badge-community' : item.sourceLabel === '自建' ? 'source-badge-custom' : 'source-badge-photo'">{{ feed && ['美食', '自建'].includes(item.sourceLabel) ? `${item.sourceLabel}菜` : item.sourceLabel }}</text><view v-if="item.isDish" class="meal-post-dish-caption"><text class="meal-post-dish-title">{{ item.title }}</text></view></view></button>
    </view>
    <view v-if="dishesWithoutCover.length" class="meal-post-text-dishes" :class="{ 'after-images': media.length }">
      <view v-for="item in dishesWithoutCover" :key="item.dishIndex" class="meal-post-text-dish"><text class="meal-post-text-dish-name">{{ item.title }}</text><text v-if="item.sourceLabel" class="meal-post-text-dish-source source-badge source-badge-compact" :class="item.sourceLabel === '美食' ? 'source-badge-community' : 'source-badge-custom'">{{ feed && ['美食', '自建'].includes(item.sourceLabel) ? `${item.sourceLabel}菜` : item.sourceLabel }}</text></view>
    </view>
    <view v-if="!media.length && !dishesWithoutCover.length" class="meal-post-no-photo">
      <template v-if="dishNames.length"><text v-for="(name, index) in dishNames" :key="index" class="meal-post-dish-name">{{ name }}</text></template>
      <text v-else class="meal-post-missing-content">这一餐已记下，暂无照片和菜品详情</text>
    </view>
    <view v-if="feed" class="meal-post-feed-date"><view class="meal-post-date-copy"><text v-if="mealPublicationAge(post.createdAt, now)" class="meal-post-published" :aria-label="`发布于${mealPublicationAge(post.createdAt, now)}`">{{ mealPublicationAge(post.createdAt, now) }}</text><view class="meal-post-dined"><text>{{ post.date }} ·</text><view class="meal-post-slot"><AppIcon :name="mealIcons[post.meal] || 'menu'" :size="12" /><text>{{ post.meal }}</text></view></view></view>
      <view v-if="likeMenuOpened" class="meal-social-dismiss" @click.stop="likeMenuOpened = false" />
      <view class="meal-social-actions" :class="{ opened: likeMenuOpened }">
        <button v-if="likeMenuOpened" class="meal-social-popover" @click.stop="toggleLike" hover-class="none"><AppIcon class="meal-social-heart" :name="post.liked ? 'heart-liked' : 'heart-inverse'" :size="19" /><text>{{ post.liked ? '取消' : '点赞' }}</text></button>
        <button class="meal-social-more" :aria-expanded="likeMenuOpened" aria-label="点赞操作" @click.stop="likeMenuOpened = !likeMenuOpened" hover-class="none"><view class="meal-social-dots" aria-hidden="true"><view class="meal-social-dot" /><view class="meal-social-dot" /></view></button>
      </view>
    </view>
    <view v-if="post.moods?.length" class="meal-post-moods"><MealMoodTags :tags="post.moods" :feed="feed" /></view>
    <view v-if="(feed || timeline) && post.likeCount > 0" class="meal-social-likes"><AppIcon class="meal-social-likes-heart" name="heart-social" :size="16" /><view class="meal-social-likes-names"><MealLikeNames :reset-key="post.id" :text="`${likeNames || (post.liked ? '我' : '')}${post.likeCount > (post.likeUsers?.length || 0) ? `${likeNames || post.liked ? ' 等' : ''}${post.likeCount}人点赞` : ''}`" /></view></view>
    <view v-if="!feed && !timeline && post.visibility === 'public'" class="meal-post-reactions">
      <button class="meal-like" :class="{ selected: post.liked }" :disabled="busy" :aria-pressed="post.liked" :aria-label="`${post.liked ? '取消喜欢' : '喜欢'}，${post.likeCount || 0}人喜欢`" @click="$emit('like', !post.liked)" hover-class="touch-feedback"><text class="meal-like-heart" aria-hidden="true">{{ post.liked ? '♥' : '♡' }}</text><text>{{ post.likeCount || '喜欢' }}</text></button>
      <template v-if="!timeline"><button v-for="tag in post.reactions" :key="tag.id" class="meal-reaction" :class="{ selected: tag.selected }" :disabled="busy" :aria-pressed="tag.selected" :aria-label="`${tag.label}，${tag.count}人认同，${tag.selected ? '点击取消' : '点击认同'}`" @click="$emit('react', { tagId: tag.id, selected: !tag.selected })" hover-class="touch-feedback"><text>{{ tag.label }}</text><text v-if="tag.count">{{ tag.count }}</text></button></template>
    </view>

    <CommunityView v-if="recipeDetail" detail-only :active="false" :initial-post="recipeDetail" @close="closeDetail" @edit-entry="editCommunityEntry" />
  </view>
</template>
<style scoped>
.meal-post-image-frame { position: relative; }
.meal-post-image-source { position: absolute; top: 3px; right: 3px; pointer-events: none; }
.meal-post-dish-caption { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; padding: 16px 7px 6px; background: linear-gradient(transparent, rgba(0,0,0,.58)); color: #fff; font-size: var(--type-caption); text-align: left; line-height: 1.4; }
.meal-post-dish-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.meal-post-text-dishes { display: flex; flex-direction: column; gap: 5px; }
.meal-post-text-dishes.after-images { margin-top: 8px; }
.meal-post-text-dish { display: block; min-width: 0; padding: 0; margin: 0; color: var(--ink); font-family: var(--font-body); font-size: var(--type-body); font-weight: 400; line-height: 1.6; text-align: left; }
.meal-post-text-dish-name { overflow-wrap: anywhere; }
.meal-post-text-dish-source { margin-left: 6px; vertical-align: middle; }

.meal-post-no-photo { display: flex; flex-direction: column; gap: 5px; color: var(--ink); font-size: var(--type-body); line-height: 1.6; }
.meal-post-dish-name { display: block; overflow-wrap: anywhere; }
.meal-post-missing-content { color: var(--muted); font-size: var(--type-meta); }
.is-saving .meal-like, .is-saving .meal-reaction { opacity: 1; }
.meal-post-more { display: flex; align-items: center; justify-content: center; flex-shrink: 0; min-width: 44px; min-height: 44px; padding: 0; margin: -6px -6px -6px 0; background: transparent; color: var(--muted); font-size: var(--type-heading); }
.meal-post-moods { margin-top: 10px; }
.meal-post-meal { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--ink); font-size: var(--type-meta); }
.meal-origin-badge { padding: 1px 4px; line-height: 13px; }
.meal-post-state { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; line-height: 18px; color: var(--muted); font-size: var(--type-caption); }
.meal-post-card { background: var(--white); border: 1px solid var(--line); border-radius: var(--radius-card); padding: var(--panel-padding); }
.meal-post-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.meal-post-author { min-width: 0; display: flex; gap: 8px; align-items: center; }
.meal-post-author-copy { min-width: 0; }
.meal-post-author-name { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.meal-post-avatar { width: 32px; height: 32px; flex: 0 0 32px; border-radius: 50%; overflow: hidden; }
.meal-post-name { display: block; font-size: var(--type-meta); color: var(--ink); }
.meal-post-meta { display: block; font-size: var(--type-caption); color: var(--muted); margin-top: 2px; }
.meal-post-images { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.meal-post-image { width: 100%; height: 100px; padding: 0; margin: 0; border-radius: 3px; overflow: hidden; }
.meal-post-image-frame { width: 100%; height: 100%; }
.meal-post-image .lazy-photo { width: 100%; height: 100%; }
.meal-post-images.single { grid-template-columns: 1fr; }
.meal-post-images.single .meal-post-image { height: 230px; }
.meal-post-reactions { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 8px; }
.meal-reaction, .meal-like { display: flex; align-items: center; gap: 4px; min-height: 44px; margin: 0; padding: 0 8px; background: transparent; color: var(--muted); font-size: var(--type-caption); }
.meal-reaction.selected, .meal-like.selected { color: var(--green); background: var(--green-light); border-radius: var(--radius-control); }
.meal-like-heart { font-size: var(--type-display); line-height: 24px; }
.meal-like.selected { color: var(--mood-rose-ink); background: var(--mood-rose-surface); }
.meal-post-card.in-timeline { border: 0; border-radius: 0; padding: 0; }
.in-timeline .meal-post-heading { min-height: 28px; margin-bottom: 6px; }
.in-timeline .meal-post-more { min-height: 44px; margin: -8px 0; }
.in-timeline .meal-post-images.single { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.in-timeline .meal-post-image, .in-timeline .meal-post-images.single .meal-post-image { height: 70px; }
.in-timeline .meal-post-reactions { margin-top: 2px; }
.in-timeline .meal-like { padding-left: 0; min-height: 36px; }
.meal-post-card.in-feed { position: relative; padding: 18px 16px 18px 64px; margin: 0; border: 0; border-bottom: 0.5px solid var(--line); border-radius: 0; }
.meal-post-card.in-feed.is-last { border-bottom: 0; }
.in-feed .meal-post-heading { min-height: 24px; margin-bottom: 8px; }
.in-feed .meal-post-author-copy { min-width: 0; }
.in-feed .meal-post-avatar { position: absolute; left: 16px; top: 18px; width: 36px; height: 36px; }
.in-feed .meal-post-name { font-size: var(--type-body); font-weight: 600; color: var(--feed-author); overflow-wrap: anywhere; line-height: 24px; }
.in-feed { --feed-media-width: 276px; }
.in-feed .meal-post-images { max-width: var(--feed-media-width); gap: 4px; }
.in-feed .meal-post-images.paired .meal-post-image:nth-child(3) { grid-column: 1; }
.in-feed .meal-post-image { position: relative; height: 0; padding-bottom: 100%; border-radius: 3px; }
.in-feed .meal-post-image-frame { position: absolute; inset: 0; width: auto; height: auto; }
.in-feed .meal-post-images.single { width: 160px; max-width: 100%; }
.in-feed .meal-post-images.single .meal-post-image { height: auto; padding-bottom: 0; }
.in-feed .meal-post-images.single .meal-post-image-frame { position: relative; height: auto; }
.in-feed .meal-post-images.single .is-missing-cover { width: 96px; height: 96px; }
.in-feed .meal-post-images.single .is-missing-cover .meal-post-image-frame { height: 100%; }
.in-feed .meal-post-moods { margin-top: 15px; }
.meal-post-dined, .meal-post-slot { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.meal-post-feed-date { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 10px; color: var(--feed-time); font-size: var(--type-caption); font-weight: 400; line-height: 18px; }
.meal-post-dined { white-space: nowrap; }

.meal-post-feed-date { flex-wrap: nowrap; justify-content: space-between; gap: 8px; }
.meal-post-date-copy { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; min-width: 0; }
.meal-social-actions { position: relative; flex-shrink: 0; }
.meal-social-more { display: flex; align-items: center; justify-content: flex-end; width: 32px; height: 32px; padding: 0; margin: -5px 0; background: transparent; }
.meal-social-dots { display: flex; align-items: center; justify-content: center; gap: 4px; width: 26px; height: 19px; border-radius: var(--radius-small); background: #f5f5f5; }
.meal-social-dot { width: 3.5px; height: 3.5px; border-radius: 50%; background: var(--feed-author); }
.meal-social-popover { position: absolute; z-index: 5; right: 36px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; gap: 6px; width: 88px; height: 36px; padding: 0; margin: 0; border-radius: var(--radius-small); background: #4c4c4c; color: white; font-size: var(--type-control); line-height: 20px; white-space: nowrap; }
.meal-social-heart { display: block; flex-shrink: 0; }
.meal-social-likes { display: flex; align-items: center; gap: 6px; margin-top: 12px; padding: 8px 10px; border-radius: var(--radius-control); background: #f7f7f7; color: var(--feed-author); font-size: var(--type-meta); line-height: 20px; overflow-wrap: anywhere; }
.meal-social-likes-heart { display: block; flex-shrink: 0; align-self: flex-start; margin-top: 2px; }
.meal-social-likes-names { display: block; flex: 1; min-width: 0; line-height: 20px; }
.meal-social-dismiss { position: fixed; inset: 0; z-index: 4; background: transparent; }
.meal-social-actions.opened { z-index: 5; }
</style>
