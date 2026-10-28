<script setup>
import { NATIVE_UI_COLORS } from '../../domain/ui-theme.js';
import AppIcon from '../../components/AppIcon.vue';
import { ref, computed } from 'vue';
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
const card = computed(() => post.value ? dishShareCard({ ...post.value, token: token.value, imageUrl: resolveImage(post.value.image) }) : null);
onShareAppMessage(event => shareMessage(event, card.value));
async function read() {
  loading.value = true; error.value = '';
  try {
    if (!cloudMode) throw new Error('请在微信小程序中打开分享卡片');
    await connectCloud();
    const result = await invokeCloud(token.value ? 'readShare' : 'readPost', token.value ? { token: token.value } : { postId: postId.value, paginateComments: true });
    setShareMediaToken(token.value);
    post.value = result.post;
    resetRecipes();
  } catch (failure) { error.value = failure.message; }
  finally { loading.value = false; }
}
onLoad(query => { token.value = query.token || ''; postId.value = query.postId || ''; read(); });
onUnload(() => { cancelRecipeScroll(); setShareMediaToken(); });
async function importDish() {
  if (busy.value || added.value) return;
  if (cloudStatus.value.phase !== 'ready') { onboarding.value = true; return; }
  uni.showModal({ confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted, title: '加入我家菜单？', content: `将「${post.value.title}」${post.value.kind === 'menu' ? '及其中全部菜品' : ''}加入当前家庭，加入后可以编辑。`, success: async result => {
    if (!result.confirm || busy.value) return;
    busy.value = true;
    try {
      if (token.value) await manageFamily('importShare', { token: token.value });
      else await addCollection(post.value);
      added.value = true;
    } catch (failure) { notify(failure.message); }
    finally { busy.value = false; }
  } });
}
function home() { uni.reLaunch({ url: '/pages/index/index' }); }
</script>

<template>
  <view class="app-shell" @click="dismissFocusedKeyboard" @touchmove="cancelRecipeScroll"><view class="entry-page shared-page">
    <text v-if="loading && !post" class="hint">正在打开做法…</text><view v-if="error"><text class="error-message">{{ error }}</text><button class="secondary-button full" @click="read">重新加载</button></view>
    <view v-if="post"><text class="entry-eyebrow">{{ post.kind === 'menu' ? '分享的套餐' : '分享的菜品' }}</text><text class="entry-title">{{ post.title }}</text>
      <RecipeContent v-if="post.kind === 'dish'" :recipe="post.recipes[0]" />
      <view v-else><RecipeCover :image="post.image" kind="set" :title="post.title" category="套餐" :dish-count="post.recipes.length" /><view v-for="(recipe, index) in post.recipes" :id="recipeAnchor(index)" :key="recipe.id" class="shared-recipe-card"><button class="recipe-expand" :aria-label="`${expanded === recipe.id ? '收起' : '查看'}${recipe.title}食材与做法`" :aria-expanded="expanded === recipe.id" @click="$feedback(); toggleRecipe(recipe.id, index)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><FoodThumbnail :src="recipe.image" /><view class="recipe-list-copy"><text class="stock-name" :class="{ 'food-list-title': expanded !== recipe.id }">{{ recipe.title }}</text><RecipeListMeta :category="recipe.category" :minutes="recipe.minutes" /></view><AppIcon :name="expanded === recipe.id ? 'minus' : 'plus'" class="expand-mark" /></button><RecipeContent v-if="expanded === recipe.id" :recipe="recipe" :cover="false" :show-meta="false" /></view></view>
      <view v-if="onboarding && cloudStatus.phase !== 'ready'" class="entry-card"><CloudConnection /></view><view class="shared-cta"><text class="subheading">把喜欢的味道，留给自家餐桌</text><view class="friend-detail-actions"><view class="friend-action-cell"><FriendForwardButton :card="card" /></view><view class="friend-action-cell"><button class="recipe-detail-button" :class="{ 'is-complete': added }" :disabled="busy || added" :aria-busy="busy" @click="$feedback(); importDish()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon :name="added ? 'check' : 'plus'" :size="19" :active="!added" /><text>{{ added ? '已加入' : busy ? '正在加入…' : cloudStatus.phase === 'ready' ? '加入我家菜单' : '创建我的家庭' }}</text></button></view></view></view>
    </view><button class="text-button entry-home" @click="home">打开食愿小灶</button>
  </view></view>
</template>
