<script setup>
import AccountEntry from '../../components/AccountEntry.vue';
import { accountEntryStatus } from '../../services/account-entry.js';
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
const loading = ref(false);
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
  <AccountEntry v-if="cloudMode && accountEntryStatus.phase !== 'ready'" />
  <view v-else class="app-shell" @click="dismissFocusedKeyboard" @touchmove="cancelRecipeScroll"><view class="entry-page shared-page">
    <text v-if="loading && !post" class="hint">正在打开做法…</text><view v-if="error"><text class="error-message">{{ error }}</text><button class="secondary-button full" @click="read">重新加载</button></view>
    <view v-if="post"><text class="entry-eyebrow">{{ post.kind === 'menu' ? '分享的套餐' : '分享的菜品' }}</text><text class="entry-title">{{ post.title }}</text>
      <RecipeContent v-if="post.kind === 'dish'" :recipe="post.recipes[0]" />
      <view v-else><RecipeCover :image="post.image" kind="set" :title="post.title" category="套餐" :dish-count="post.recipes.length" /><view v-for="(recipe, index) in post.recipes" :id="recipeAnchor(index)" :key="recipe.id" class="shared-recipe-card"><button class="recipe-expand" :aria-label="`${expanded === recipe.id ? '收起' : '查看'}${recipe.title}食材与做法`" :aria-expanded="expanded === recipe.id" @click="$feedback(); toggleRecipe(recipe.id, index)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><FoodThumbnail :src="recipe.image" /><view class="recipe-list-copy"><text class="stock-name" :class="{ 'food-list-title': expanded !== recipe.id }">{{ recipe.title }}</text><RecipeListMeta :category="recipe.category" :minutes="recipe.minutes" /></view><AppIcon :name="expanded === recipe.id ? 'minus' : 'plus'" class="expand-mark" /></button><RecipeContent v-if="expanded === recipe.id" :recipe="recipe" :cover="false" :show-meta="false" /></view></view>
      <view v-if="onboarding && cloudStatus.phase !== 'ready'" class="entry-card"><CloudConnection /></view><view class="shared-cta"><text class="subheading">把喜欢的味道，留给自家餐桌</text><view class="friend-detail-actions"><view class="friend-action-cell"><FriendForwardButton :card="card" /></view><view class="friend-action-cell"><button class="recipe-detail-button" :class="{ 'is-complete': added }" :disabled="busy || added" :aria-busy="busy" @click="$feedback(); importDish()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon :name="added ? 'check' : 'plus'" :size="19" :active="!added" /><text>{{ added ? '已加入' : busy ? '正在加入…' : cloudStatus.phase === 'ready' ? '加入我家菜单' : '进入我的小灶' }}</text></button></view></view></view>
    </view><button class="text-button entry-home" @click="home">打开食愿小灶</button>
  </view></view>
</template>
