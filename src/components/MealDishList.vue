<script setup>
import { isUnchangedCommunityRecipe } from '../domain/recipe-identity.js';
import AppIcon from './AppIcon.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import { computed } from 'vue';
import { foodMinutesLabel, mealVoterRows } from '../domain/presentation.js';
const props = defineProps({ rows: Array, posts: { type: Array, default: () => [] }, members: { type: Array, default: () => [] }, removable: Boolean, editable: Boolean, busy: Boolean });
defineEmits(['open', 'remove']);
const displayedRows = computed(() => mealVoterRows(props.rows || [], props.members).map(item => ({ ...item, originLabel: isUnchangedCommunityRecipe(item.recipe, props.posts) ? '美食' : '自建', minutesLabel: foodMinutesLabel(item.recipe.minutes) })));
</script>

<template>
  <view class="meal-dish-list">
    <view v-for="item in displayedRows" :key="item.recipe.id" class="meal-dish-row standalone-dish">
      <button role="button" class="meal-dish-open" :aria-label="`查看${removable ? '已选' : '订单中'}${item.recipe.title}做法`" @click="$emit('open', item.recipe)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
        <FoodThumbnail class="meal-dish-photo" :src="item.recipe.image" />
        <view class="meal-dish-copy">
          <text class="stock-name food-list-title">{{ item.recipe.title }}</text>
          <view class="meal-dish-meta">
            <text class="meal-dish-category home-menu-item-category">{{ item.recipe.category || '其他' }}</text>
            <text class="meal-dish-origin source-badge" :class="item.originLabel === '美食' ? 'source-badge-community' : 'source-badge-custom'">{{ item.originLabel }}</text>
            <view v-if="item.minutesLabel" class="meal-dish-duration"><AppIcon name="clock" :size="12" /><text>{{ item.minutesLabel }}</text></view>

          </view>
        </view>
      </button>
      <button v-if="removable" role="button" class="cart-remove" :aria-label="`取消选择${item.recipe.title}`" @click="$emit('remove', item.recipe.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="close" /></button>
      <button v-else-if="editable" role="button" class="meal-dish-remove" :aria-label="`从本餐移除${item.recipe.title}`" :disabled="busy" @click.stop="$emit('remove', item.recipe.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="meal-dish-remove-mark"><AppIcon name="minus" :size="14" /></view></button>
    </view>
  </view>
</template>
