<script setup>
import { NATIVE_UI_COLORS } from '../../domain/ui-theme.js';
import AppIcon from '../../components/AppIcon.vue';
import { ref, computed, watch } from 'vue';
import { onLoad, onUnload, onShareAppMessage } from '@dcloudio/uni-app';
import { invokeCloud, manageFamily, setShareMediaToken, resolveImage } from '../../services/cloud.js';
import { cloudMode, cloudStatus, connectCloud, addCollection, notify } from '../../store.js';
import { dishShareCard, shareMessage } from '../../services/native-share.js';
import RecipeContent from '../../components/RecipeContent.vue';
import RecipeCover from '../../components/RecipeCover.vue';
import RecipeListMeta from '../../components/RecipeListMeta.vue';
import FriendForwardButton from '../../components/FriendForwardButton.vue';
import FoodThumbnail from '../../components/FoodThumbnail.vue';
import CloudConnection from '../../components/CloudConnection.vue';
import { dismissFocusedKeyboard } from '../../services/keyboard.js';
import { useRecipeAccordion } from '../../composables/useRecipeAccordion.js';
const token = ref('');
const postId = ref('');
const post = ref(null);
const loading = ref(true);
const error = ref('');
const { expanded, recipeAnchor, toggleRecipe, resetRecipes, cancelRecipeScroll } = useRecipeAccordion({ scrollTo: anchor => uni.pageScrollTo({ selector: `#${anchor}`, duration: 0 }) });
const busy = ref(false);
const added = ref(false);
const onboarding = ref(false);
let active = true;
let loaded = false;
let readRevision = 0;
let importRevision = 0;
const currentScope = () => `${cloudStatus.value.userId || ''}:${cloudStatus.value.familyId || ''}`;
const currentTarget = () => `${token.value}:${postId.value}`;
const card = computed(() => post.value ? dishShareCard({ ...post.value, token: token.value, imageUrl: resolveImage(post.value.image) }) : null);
onShareAppMessage(event => shareMessage(event, card.value));
async function read() {
  if (!active) return;
  const revision = ++readRevision;
  const target = currentTarget();
  const shareToken = token.value;
  const requestedPostId = postId.value;
  let scope = currentScope();
  const current = () => active && revision === readRevision && target === currentTarget() && scope === currentScope();
  loading.value = true; error.value = ''; post.value = null;
  setShareMediaToken();
  resetRecipes();
  try {
    if (!cloudMode) throw new Error('请在微信小程序中打开分享卡片');
    await connectCloud();
    if (!active || revision !== readRevision || target !== currentTarget()) return;
    scope = currentScope();
    const result = await invokeCloud(shareToken ? 'readShare' : 'readPost', shareToken ? { token: shareToken } : { postId: requestedPostId, paginateComments: true });
    if (!current()) return;
    setShareMediaToken(shareToken);
    post.value = result.post;
  } catch (failure) { if (current()) { error.value = failure.message; added.value = false; setShareMediaToken(); } }
  finally { if (current()) loading.value = false; }
}
const stopScopeWatch = watch(currentScope, () => {
  const revision = ++readRevision;
  importRevision++;
  post.value = null; added.value = false; busy.value = false; onboarding.value = false;
  error.value = ''; loading.value = false;
  setShareMediaToken();
  resetRecipes();
  // Bootstrap can establish the identity during a read. Re-read after the
  // identity update completes, without re-entering the synchronous watcher.
  Promise.resolve().then(() => { if (active && loaded && revision === readRevision) void read(); });
}, { flush: 'sync' });
onLoad(query => { loaded = true; token.value = query.token || ''; postId.value = query.postId || ''; added.value = false; read(); });
onUnload(() => { active = false; loaded = false; readRevision++; importRevision++; stopScopeWatch(); cancelRecipeScroll(); setShareMediaToken(); });
async function importDish() {
  if (!active || loading.value || !post.value || busy.value || added.value) return;
  if (cloudStatus.value.phase !== 'ready') { onboarding.value = true; return; }
  const revision = ++importRevision;
  const scope = currentScope();
  const target = currentTarget();
  const readAtConfirmation = readRevision;
  const sharedPost = post.value;
  const shareToken = token.value;
  const familyId = cloudStatus.value.familyId;
  const current = () => active && revision === importRevision && readAtConfirmation === readRevision && scope === currentScope() && target === currentTarget();
  uni.showModal({ confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted, title: '加入我家菜单？', content: `将「${sharedPost.title}」${sharedPost.kind === 'menu' ? '及其中全部菜品' : ''}加入当前家庭，加入后可以编辑。`, success: async result => {
    if (!result.confirm || !current() || busy.value || added.value) return;
    busy.value = true;
    try {
      if (shareToken) await manageFamily('importShare', { token: shareToken, familyId });
      else await addCollection(sharedPost);
      if (current()) added.value = true;
    } catch (failure) { if (current()) notify(failure.message); }
    finally { if (active && revision === importRevision && scope === currentScope()) busy.value = false; }
  } });
}
function home() { uni.reLaunch({ url: '/pages/index/index' }); }
</script>

<template>
  <view v-if="loading && !post" class="shared-loading-cover" role="status" aria-label="正在打开做法">
    <image class="entry-backdrop" :src="$image('/static/entry-window.jpg')" mode="aspectFill" aria-hidden="true" />
    <view class="entry-shade" aria-hidden="true" />
    <view class="entry-brand">
      <image class="entry-logo" :src="$image('/static/entry-window-logo.png')" mode="aspectFit" aria-hidden="true" />
      <image class="entry-brand-name" :src="$image('/static/entry-window-wordmark.png')" mode="aspectFit" aria-label="食愿小灶" />
    </view>
    <text class="entry-message">正在打开做法...</text>
  </view>
  <view v-else class="app-shell shared-fullscreen" @click="dismissFocusedKeyboard" @touchmove="cancelRecipeScroll">
    <view v-if="error" class="shared-error"><text class="error-message">{{ error }}</text><button class="secondary-button full" @click="read">重新加载</button></view>
    <view v-if="post">
      <RecipeCover :image="post.image || post.recipes?.[0]?.image" :kind="post.kind === 'menu' ? 'set' : 'dish'" :title="post.title" :category="post.kind === 'menu' ? '套餐' : post.recipes?.[0]?.category" :minutes="post.kind === 'dish' ? post.recipes?.[0]?.minutes : null" :dish-count="post.kind === 'menu' ? post.recipes.length : null" immersive />
      <view class="food-detail-body">
        <view class="food-detail-heading"><text class="food-detail-title" role="heading" aria-level="1">{{ post.title }}</text></view>
        <RecipeContent v-if="post.kind === 'dish'" :recipe="post.recipes[0]" :cover="false" :show-meta="false" />
        <view v-else>
          <view v-for="(recipe, index) in post.recipes" :id="recipeAnchor(index)" :key="recipe.id" class="shared-recipe-card">
            <button class="recipe-expand" :aria-label="`${expanded === recipe.id ? '收起' : '查看'}${recipe.title}食材与做法`" :aria-expanded="expanded === recipe.id" @click="toggleRecipe(recipe.id, index)" hover-class="none"><FoodThumbnail :src="recipe.image" /><view class="recipe-list-copy"><text class="stock-name" :class="{ 'food-list-title': expanded !== recipe.id }">{{ recipe.title }}</text><RecipeListMeta :category="recipe.category" :minutes="recipe.minutes" /></view><AppIcon :name="expanded === recipe.id ? 'minus' : 'plus'" class="expand-mark" /></button>
            <RecipeContent v-if="expanded === recipe.id" :recipe="recipe" :cover="false" :show-meta="false" />
          </view>
        </view>
      </view>
    </view>
    <view class="shared-entry-action"><button class="primary-button full" @click="home" hover-class="none">进入食愿小灶</button></view>
  </view>
</template>

<style scoped>
.shared-fullscreen { min-height: 100vh; background: var(--white); }
.shared-error { padding: 0 var(--page-gutter); }
.shared-entry-action { padding: 24px var(--page-gutter) calc(28px + env(safe-area-inset-bottom)); }

 .shared-loading-cover { position: fixed; inset: 0; z-index: 20; overflow: hidden; background: #d1d2b9; }
.entry-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; }
.entry-shade { position: absolute; inset: 0; background: linear-gradient(180deg, transparent 76%, rgba(247,243,230,.78) 100%); }
.entry-brand { position: absolute; top: 47%; left: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 18px; }
.entry-logo { display: block; width: 62px; height: 66px; }
.entry-brand-name { display: block; width: 154px; height: 42px; }
.entry-message { position: absolute; bottom: calc(36px + env(safe-area-inset-bottom)); left: 24px; right: 24px; color: #435b46; font-size: var(--type-control); letter-spacing: 2px; line-height: 1.6; text-align: center; }

</style>
