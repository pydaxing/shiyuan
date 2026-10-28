<script setup>
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import FormField from './FormField.vue';
import SelectField from './SelectField.vue';
import { computed, ref, watch, nextTick, onUnmounted } from 'vue';
import { communityPosts } from '../data/seed.js';
import { state, cloudMode, cloudStatus, addCollection, addComment, toggleCommentLike, deleteCommunityPost, runAction, notify } from '../store.js';
import { invokeCloud, rememberMedia, peekCommunityPost, readCommunityPost, resolveImage, mergeCloudCommunity } from '../services/cloud.js';
import { presentMutation } from '../services/mutation-feedback.js';
import { createCommunityFeed, communityFeedRevision } from '../services/community-feed.js';
import { tapFeedback } from '../services/feedback.js';
import { filterPosts, commentThreads, foodCover } from '../domain/presentation.js';
import { matchesImportedSource } from '../domain/kitchen.js';
import { FOOD_CATEGORIES, foodFeedQuery, orderFoodPosts, buildFoodWaterfall } from '../domain/food-feed.js';
import { COMMUNITY_COMMENTS_ENABLED } from '../domain/community-features.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import FoodDetailSheet from './FoodDetailSheet.vue';
import AppIcon from './AppIcon.vue';
import RecipeContent from './RecipeContent.vue';
import CommunityByline from './CommunityByline.vue';
import CommunityFamilyCount from './CommunityFamilyCount.vue';
import PageHeader from './PageHeader.vue';
import RecipeListMeta from './RecipeListMeta.vue';
import CommentItem from './CommentItem.vue';
import LazyImage from './LazyImage.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import { canDeleteCommunityPost, editableCommunityEntry, communityPublisherName } from '../domain/community-policy.js';
import { dishShareCard } from '../services/native-share.js';
import { useRecipeAccordion } from '../composables/useRecipeAccordion.js';
import { useCommunityNavigation } from '../composables/useCommunityNavigation.js';
import { useCommunityFeedViewport } from '../composables/useCommunityFeedViewport.js';
import { sheetOpen } from '../composables/sheetStack.js';
const emit = defineEmits(['edit-entry']);
const props = defineProps({ active: { type: Boolean, default: true } });
const category = ref('荤菜');
const mode = ref('recommended');
const recommendationSeed = ref(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const search = ref('');
const searchFocused = ref(false);
const searchFocus = ref(false);
const categoryOpen = ref(false);
const feedLocked = computed(() => !props.active || sheetOpen.value);
const navigation = useCommunityNavigation(feedLocked, computed(() => searchFocused.value || categoryOpen.value));
const navigationHidden = navigation.hidden;
let resetAfterSheet = false;
let disposed = false;
function resetResults() {
  if (disposed) return;
  navigation.reset();
  if (sheetOpen.value) resetAfterSheet = true;
  else feedViewport.reset();
}
watch([mode, category, search], resetResults);
watch(sheetOpen, async open => {
  if (!open && resetAfterSheet) {
    resetAfterSheet = false;
    await nextTick();
    resetResults();
  }
});
function selectCategory(value) { category.value = value; mode.value = 'category'; resetResults(); }
async function clearSearch() { search.value = ''; searchFocus.value = false; await nextTick(); searchFocus.value = true; }
const filters = computed(() => foodFeedQuery(mode.value, category.value, recommendationSeed.value));
const skeletonLanes = buildFoodWaterfall(Array.from({ length: 4 }, (placeholder, index) => ({ id: index, title: '' })));
const current = ref(null);
const friendCard = computed(() => current.value ? dishShareCard({ ...current.value, imageUrl: resolveImage(current.value.image) }) : null);
const detailLoading = ref(false);
const detailReady = ref(false);
const commentCursor = ref('');
const commentsLoading = ref(false);
let detailSequence = 0;
const { expanded, scrollAnchor, recipeAnchor, toggleRecipe, resetRecipes, cancelRecipeScroll } = useRecipeAccordion({ isActive: () => Boolean(current.value) });
const comment = ref('');
const commentError = ref('');
const sending = ref(false);
const removingPost = ref(false);
let removalSequence = 0;
const hiddenPosts = ref([]);
const addingPosts = ref([]);
watch(() => `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`, () => { hiddenPosts.value = []; addingPosts.value = []; });
const commentFocus = ref(false);
const replyTarget = ref(null);
const categories = FOOD_CATEGORIES;
const feedController = createCommunityFeed({ request: async query => { const result = await invokeCloud('feed', { ...query, compact: true }); if (query.sort && result.feedVersion !== 2) throw new Error('新版美食排序尚未同步，请更新云端服务后重试'); rememberMedia(result.media); return result; } });
const feed = feedController.state;
onUnmounted(() => { disposed = true; feedController.dispose(); detailSequence += 1; });
const filtered = computed(() => (cloudMode ? feed.value.posts : orderFoodPosts(filterPosts([...state.value.posts, ...communityPosts], filters.value.type, filters.value.category, search.value), mode.value, recommendationSeed.value)).filter(post => !hiddenPosts.value.includes(post.id)));
const lanes = computed(() => buildFoodWaterfall(filtered.value));
const loadFeed = (more = false) => feedController.refresh(more);
async function refreshFeed() { await loadFeed(); if (feed.value.error) throw new Error(feed.value.error); }
const feedViewport = useCommunityFeedViewport({ navigation, locked: feedLocked, enabled: computed(() => props.active && cloudMode && !searchFocused.value && !categoryOpen.value), loading: computed(() => feed.value.loading), refresh: refreshFeed, onError: error => notify(error.message || '刷新暂时没成功，请再试试') });
const { scrollTop: feedScrollTop, refreshing, pullReady, refreshThreshold, refresherEnabled } = feedViewport;
function loadMore() { if (!feedLocked.value && feed.value.cursor && !feed.value.error) return loadFeed(true); }
defineExpose({ onScroll: navigation.onScroll, loadMore });
watch([filters, search, () => cloudStatus.value.familyId, () => cloudStatus.value.userId, communityFeedRevision, () => props.active], (values, previous) => {
  if (cloudMode && props.active) feedController.select({ ...filters.value, search: search.value.trim() }, `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`, { delay: search.value.trim() && previous?.length && values[1] !== previous[1] ? 220 : 0, retain: true });
}, { immediate: true });
watch(() => props.active, active => {
  if (active) return;
  mode.value = 'recommended';
  current.value = null; categoryOpen.value = false; searchFocused.value = false; searchFocus.value = false;
  cancelRecipeScroll();
});
const comments = computed(() => COMMUNITY_COMMENTS_ENABLED ? (state.value.comments || []).filter((entry) => entry.postId === current.value?.id) : []);
const threads = computed(() => commentThreads(comments.value));
const canDelete = computed(() => canDeleteCommunityPost(cloudMode ? current.value : state.value.posts.find(post => post.id === current.value?.id), state.value.activeMemberId, state.value.family.id));
const editableEntry = computed(() => editableCommunityEntry(current.value, state.value));
const imported = (post) => {
  const sameFamily = Boolean(state.value.family.id) && post.familyId === state.value.family.id;
  return post.kind === 'menu'
    ? state.value.mealSets.some(entry => matchesImportedSource(entry, post.id, post) || (sameFamily && entry.id === post.familyItemId))
    : (sameFamily && state.value.recipes.some(entry => entry.id === post.familyItemId)) || post.recipes.every(recipe => state.value.recipes.some(entry => matchesImportedSource(entry, recipe.id, post)));
};
async function open(post) {
  tapFeedback();
  current.value = post; resetRecipes(); comment.value = ''; commentError.value = ''; replyTarget.value = null; commentFocus.value = false;
  detailReady.value = !cloudMode; detailLoading.value = cloudMode; commentCursor.value = ''; commentsLoading.value = false;
  const token = ++detailSequence;
  const scope = `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`;
  const cached = cloudMode ? peekCommunityPost(post.id, { includeComments: COMMUNITY_COMMENTS_ENABLED }) : undefined;
  if (cached) {
    current.value = cached.post;
    mergeCloudCommunity({ posts: [cached.post], comments: COMMUNITY_COMMENTS_ENABLED ? cached.comments : [] });
    if (COMMUNITY_COMMENTS_ENABLED) commentCursor.value = cached.commentCursor || '';
    detailReady.value = true;
    rememberMedia(cached.media);
  }
  if (cloudMode) try {
    const result = await readCommunityPost(post.id, { includeComments: COMMUNITY_COMMENTS_ENABLED });
    if (token !== detailSequence || current.value?.id !== post.id || scope !== `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`) return;
    current.value = result.post;
    mergeCloudCommunity({ posts: [result.post], comments: COMMUNITY_COMMENTS_ENABLED ? result.comments : [] });
    if (COMMUNITY_COMMENTS_ENABLED) commentCursor.value = result.commentCursor || '';
    detailReady.value = true;
    rememberMedia(result.media);
  } catch (error) {
    if (token !== detailSequence || error.code === 'CACHE_SUPERSEDED') return;
    if (['INVALID', 'FORBIDDEN', 'NO_FAMILY', 'UNAUTHENTICATED'].includes(error.code)) { current.value = null; notify(error.message); }
    else commentError.value = error.message;
  }
  finally { if (token === detailSequence) detailLoading.value = false; }
}
async function loadComments() {
  if (!COMMUNITY_COMMENTS_ENABLED || commentsLoading.value || !commentCursor.value || !current.value) return;
  const token = detailSequence;
  const scope = `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`;
  commentsLoading.value = true;
  try {
    const result = await invokeCloud('readComments', { postId: current.value.id, cursor: commentCursor.value });
    if (token !== detailSequence || scope !== `${cloudStatus.value.userId}:${cloudStatus.value.familyId}` || !current.value) return;
    mergeCloudCommunity({ comments: result.comments });
    commentCursor.value = result.commentCursor || '';
  } catch (error) { if (token === detailSequence) commentError.value = error.message; }
  finally { if (token === detailSequence) commentsLoading.value = false; }
}
function reply(entry) { replyTarget.value = entry; commentFocus.value = false; nextTick(() => { commentFocus.value = true; }); }
function add(post) {
  if (disposed || imported(post) || addingPosts.value.includes(post.id)) return;
  const detailToken = detailSequence;
  const scope = `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`;
  tapFeedback();
  uni.showModal({ cancelColor: NATIVE_UI_COLORS.muted, title: '加入我家菜单？', content: post.kind === 'menu' ? `将「${post.title}」及其中 ${post.recipes.length} 道菜加入我家菜单，加入后可自行编辑。` : `将「${post.title}」加入我家菜单，加入后可自行编辑。`, confirmText: '确认加入', confirmColor: NATIVE_UI_COLORS.primary, success: (result) => {
    if (result.confirm && !disposed && scope === `${cloudStatus.value.userId}:${cloudStatus.value.familyId}` && !imported(post) && !addingPosts.value.includes(post.id)) runAction(async () => {
      addingPosts.value = [...addingPosts.value, post.id];
      try {
        await addCollection(post);
        if (disposed || detailToken !== detailSequence || scope !== `${cloudStatus.value.userId}:${cloudStatus.value.familyId}` || current.value?.id !== post.id) return;
        const confirmed = state.value.posts.find(entry => entry.id === post.id);
        if (confirmed) current.value = confirmed;
      }
      finally { if (scope === `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`) addingPosts.value = addingPosts.value.filter(id => id !== post.id); }
    });
  } });
}
async function send() {
  if (!COMMUNITY_COMMENTS_ENABLED || sending.value || !current.value) return;
  sending.value = true;
  commentError.value = '';
  try { await addComment(current.value.id, comment.value, replyTarget.value?.id); comment.value = ''; replyTarget.value = null; commentFocus.value = false; dismissFocusedKeyboard(); }
  catch (failure) { commentError.value = failure.message; }
  finally { sending.value = false; }
}
function editPost() {
  if (!editableEntry.value || removingPost.value) return;
  const entry = editableEntry.value;
  current.value = null;
  emit('edit-entry', entry);
  notify('编辑我家菜单中的原菜品，已发布的分享保持不变');
}
async function removePost() {
  if (!canDelete.value || removingPost.value) return;
  const revision = ++removalSequence;
  const postId = current.value.id;
  const scope = `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`;
  removingPost.value = true;
  try {
    const result = await new Promise(resolve => uni.showModal({ cancelColor: NATIVE_UI_COLORS.muted, title: '删除这条分享？', content: '将从美食移除这条分享及其评论，已经加入家庭菜单的菜品和套餐不受影响。', confirmText: '确认删除', confirmColor: NATIVE_UI_COLORS.danger, success: resolve, fail: () => resolve({ confirm: false }) }));
    if (!result.confirm || disposed || current.value?.id !== postId || scope !== `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`) return;
    await runAction(async () => {
      try {
        await presentMutation(deleteCommunityPost(postId), () => {
          if (disposed || scope !== `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`) return;
          hiddenPosts.value = [...new Set([...hiddenPosts.value, postId])];
          if (current.value?.id === postId) current.value = null;
          removingPost.value = false;
        });
      } catch (error) {
        if (scope === `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`) hiddenPosts.value = hiddenPosts.value.filter(id => id !== postId);
        throw error;
      }
    });
  } finally { if (revision === removalSequence) removingPost.value = false; }
}
</script>

<template>
  <view class="community-view">
    <PageHeader title="美食">
      <template #extension>
        <view class="community-sticky-controls">
          <view class="community-navigation-clip" :aria-hidden="navigationHidden">
            <view class="community-navigation-surface" :class="{ 'is-hidden': navigationHidden }">
              <view class="community-sticky-frame">
                <view class="community-toolbar community-single-toolbar" aria-label="美食筛选与搜索">
                  <button role="button" class="community-order-button" :class="{ active: mode === 'recommended' }" :aria-pressed="mode === 'recommended'" :tabindex="navigationHidden ? -1 : 0" @click="$feedback(); mode = 'recommended'" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">推荐</button>
                  <button role="button" class="community-order-button" :class="{ active: mode === 'latest' }" :aria-pressed="mode === 'latest'" :tabindex="navigationHidden ? -1 : 0" @click="$feedback(); mode = 'latest'" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">最新</button>
                  <SelectField :model-value="category" :options="categories" label="美食分类" variant="feed" :active="mode === 'category'" :tabindex="navigationHidden ? -1 : 0" :disabled="navigationHidden" @update:model-value="selectCategory" @open-change="categoryOpen = $event" />
                  <view class="search-wrap community-search">
                    <view class="search-leading-icon" aria-hidden="true"><AppIcon name="search" :size="16" /></view>
                    <view class="search-input-slot"><FormField v-model="search" placeholder="搜索" aria-label="搜索美食菜品或套餐" maxlength="60" :focus="searchFocus" :disabled="navigationHidden" @focus="searchFocused = true" @blur="searchFocused = false; searchFocus = false" /></view>
                    <view class="search-clear-slot"><button v-if="search" role="button" class="search-clear" aria-label="清空美食搜索" :tabindex="navigationHidden ? -1 : 0" @click="clearSearch" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="close" :size="16" /></button></view>
                  </view>
                </view>
              </view>
            </view>
          </view>
        </view>
      </template>
    </PageHeader>
    <scroll-view class="community-feed-scroll" :scroll-y="!feedLocked" enhanced :show-scrollbar="false" :enable-back-to-top="true" :scroll-top="feedScrollTop" :scroll-with-animation="false" :lower-threshold="360" :refresher-enabled="refresherEnabled" :refresher-triggered="refreshing" :refresher-threshold="refreshThreshold" refresher-default-style="none" :refresher-background="NATIVE_UI_COLORS.feedBackground" aria-label="美食列表，下拉可刷新" @scroll="feedViewport.onScroll" @scrolltolower="loadMore" @refresherpulling="feedViewport.onPull" @refresherrefresh="feedViewport.onRefresh" @refresherrestore="feedViewport.stopPull" @refresherabort="feedViewport.stopPull">
      <view slot="refresher" class="community-refresher" :style="{ height: `${refreshThreshold}px` }" role="status"><view class="community-refresh-spinner" :class="{ 'is-refreshing': refreshing }" aria-hidden="true" /><text>{{ refreshing ? '正在刷新' : pullReady ? '松开刷新' : '下拉刷新' }}</text></view>
      <view class="community-feed-content">
    <view v-if="cloudMode && feed.loading && !feed.ready" class="feed-skeleton waterfall community-waterfall" aria-label="正在加载美食" aria-busy="true">
      <view v-for="(lane, laneIndex) in skeletonLanes" :key="laneIndex" class="waterfall-lane"><view v-for="entry in lane" :key="entry.post.id" class="feed-skeleton-card"><view class="feed-skeleton-cover" :style="{ paddingTop: entry.coverPadding }" /><view class="feed-skeleton-copy"><view class="feed-skeleton-title" /><view class="feed-skeleton-line" /></view></view></view>
    </view>
    <view v-else class="waterfall community-waterfall">
      <view v-for="(lane, laneIndex) in lanes" :key="laneIndex" class="waterfall-lane">
        <view v-for="entry in lane" :key="entry.post.id" class="feed-card">
          <button role="button" class="feed-cover" :style="{ paddingTop: entry.coverPadding }" :aria-label="`查看${entry.post.title}`" @click="open(entry.post)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
            <view class="feed-cover-media"><LazyImage :src="foodCover(entry.post.image, entry.post.kind)" mode="aspectFill" variant="card" /></view>
            <text class="feed-cover-category">{{ entry.post.kind === 'menu' ? `套餐 · ${entry.post.recipes.length} 道菜` : entry.post.recipes[0]?.category || '其他' }}</text>
          </button>
          <view class="feed-summary">
            <button role="button" class="feed-body" :aria-label="`查看${entry.post.title}详情`" @click="open(entry.post)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
              <view class="feed-heading"><text class="feed-title food-list-title">{{ entry.post.title }}</text></view>
              <view class="feed-meta"><CommunityByline class="feed-byline" :post="entry.post" /><CommunityFamilyCount class="feed-family-count" :count="entry.post.importedFamilyCount" inline /></view>
            </button>
          </view>
        </view>
      </view>
    </view>
    <text v-if="cloudMode && feed.error" role="alert" class="error-message">{{ feed.error }}</text><button v-if="cloudMode && (feed.cursor || feed.error)" role="button" class="secondary-button full" :disabled="feed.loading" @click="$feedback(); feed.error ? feedController.retry() : loadFeed(true)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ feed.loading ? '正在加载…' : feed.error ? '重试' : '加载更多' }}</button>
    <view v-if="(!cloudMode || (feed.ready && !feed.error)) && !filtered.length" class="empty-state community-search-empty" role="status"><text class="subheading">{{ search.trim() ? '没有找到相关菜品或套餐' : '这个分类还没有内容' }}</text><text class="search-empty-hint">换一换试试</text></view>
      </view>
    </scroll-view>
    <FoodDetailSheet v-if="current" :title="current.title" :image="current.image" community :publisher="communityPublisherName(current)" :family-count="current.importedFamilyCount" :kind="current.kind" :category="current.kind === 'dish' ? current.recipes[0].category : '套餐'" :minutes="current.kind === 'dish' ? current.recipes[0].minutes : null" :dish-count="current.kind === 'dish' ? null : current.recipes.length" :scroll-anchor="scrollAnchor" :share-card="friendCard" :can-edit="Boolean(editableEntry)" :can-remove="canDelete" :busy="removingPost" @close="current = null" @edit="editPost" @remove="removePost">
      <template #action><button role="button" class="recipe-detail-button menu-detail-order" :class="{ 'is-complete': imported(current) }" :disabled="imported(current) || removingPost || addingPosts.includes(current.id)" :aria-busy="addingPosts.includes(current.id)" @click="add(current)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="detail-choice-surface"><AppIcon :name="imported(current) ? 'check' : 'plus-inverse'" :size="14" /><text>{{ imported(current) ? '已加入' : addingPosts.includes(current.id) ? '加入中' : '加入菜单' }}</text></view></button></template>
      <view v-if="detailLoading && !detailReady" class="detail-loading" role="status">正在加载食材与做法…</view><button v-if="!detailReady && !detailLoading" class="text-button" @click="open(current)" role="button" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">重新加载详情</button><view v-if="detailReady">
      <RecipeContent v-if="current.kind === 'dish'" :recipe="current.recipes[0]" :cover="false" :show-meta="false" />
      <view v-else class="community-set-content" @touchmove="cancelRecipeScroll"><view class="section-line"><text class="subheading">套餐搭配</text></view><view v-for="(recipe, index) in current.recipes" :id="recipeAnchor(index)" :key="recipe.id" class="community-recipe"><button role="button" class="recipe-expand" :aria-label="`${expanded === recipe.id ? '收起' : '查看'}${recipe.title}食材与做法`" :aria-expanded="expanded === recipe.id" @click="toggleRecipe(recipe.id, index)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><FoodThumbnail :src="recipe.image" /><view class="recipe-list-copy"><text class="stock-name" :class="{ 'food-list-title': expanded !== recipe.id }">{{ recipe.title }}</text><RecipeListMeta :category="recipe.category" :minutes="recipe.minutes" /></view><AppIcon :name="expanded === recipe.id ? 'minus' : 'plus'" class="expand-mark" /></button><RecipeContent v-if="expanded === recipe.id" :recipe="recipe" :cover="false" :show-meta="false" /></view></view>
      <view v-if="COMMUNITY_COMMENTS_ENABLED" class="community-comments">
      <view class="section-line"><text class="subheading">评论</text><text class="muted">{{ commentCursor ? '已加载 ' : '' }}{{ comments.length }} 条</text></view>
      <view v-for="thread in threads" :key="thread.id" class="comment-thread"><CommentItem :entry="thread" :member-id="state.activeMemberId" @reply="reply" @like="runAction(() => toggleCommentLike($event))" /><view v-if="thread.replies.length" class="comment-replies"><CommentItem v-for="response in thread.replies" :key="response.id" :entry="response" :member-id="state.activeMemberId" @reply="reply" @like="runAction(() => toggleCommentLike($event))" /></view></view>
      <button v-if="commentCursor" class="text-button full" :disabled="commentsLoading" @click="loadComments" role="button" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ commentsLoading ? '正在加载…' : '更多评论' }}</button><text v-if="!comments.length" class="muted">还没有评论，来聊聊怎么做吧。</text>
      <view class="comment-composer"><view v-if="replyTarget" class="reply-target"><text>回复 {{ replyTarget.author }}：{{ replyTarget.text }}</text><button role="button" aria-label="取消回复" @click="replyTarget = null" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="close" /></button></view><FormField multiline v-model="comment" :focus="commentFocus" @blur="commentFocus = false" field-class="textarea short" :placeholder="replyTarget ? `回复 ${replyTarget.author}…` : '写下你的做菜心得…'" maxlength="300" aria-label="评论内容" /><view class="comment-actions"><button role="button" class="primary-button" :disabled="sending || !comment.trim()" @click="send" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ sending ? '正在发布…' : replyTarget ? '发布回复' : '发布评论' }}</button></view><text v-if="commentError" class="error-message">{{ commentError }}</text></view>
      </view>
      </view><text v-if="!detailReady && commentError" class="error-message">{{ commentError }}</text>
    </FoodDetailSheet>
  </view>
</template>
