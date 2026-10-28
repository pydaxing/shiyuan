<script setup>
import AppIcon from './AppIcon.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import { computed } from 'vue';
import { foodMinutesLabel, mealVoterRows } from '../domain/presentation.js';
const props = defineProps({ rows: Array, members: { type: Array, default: () => [] }, removable: Boolean, editable: Boolean, busy: Boolean });
defineEmits(['open', 'remove']);
const displayedRows = computed(() => mealVoterRows(props.rows || [], props.members).map(item => ({ ...item, minutesLabel: foodMinutesLabel(item.recipe.minutes) })));
</script>

<template>
  <view class="meal-dish-list">
    <view v-for="item in displayedRows" :key="item.recipe.id" class="meal-dish-row" :class="item.groups.length ? `set-tone-${item.groups[0].tone}` : 'standalone-dish'">
      <button role="button" class="meal-dish-open" :aria-label="`查看${removable ? '已选' : '订单中'}${item.recipe.title}做法`" @click="$emit('open', item.recipe)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
        <FoodThumbnail class="meal-dish-photo" :src="item.recipe.image" />
        <view class="meal-dish-copy">
          <text class="stock-name food-list-title">{{ item.recipe.title }}</text>
          <view v-if="item.groups.length" class="dish-set-tags"><text v-for="group in item.groups" :key="group.id" class="food-list-title" :class="`set-tone-${group.tone}`">{{ group.title }}</text></view>
          <view v-if="!removable" class="meal-dish-meta">
            <text class="meal-dish-category home-menu-item-category">{{ item.recipe.category || '其他' }}</text>
            <view v-if="item.minutesLabel" class="meal-dish-duration"><AppIcon name="clock" :size="12" /><text>{{ item.minutesLabel }}</text></view>
            <text class="dish-voters">{{ item.voters.length || 1 }} 人想吃</text>
          </view>
        </view>
      </button>
      <button v-if="removable" role="button" class="cart-remove" :aria-label="`取消选择${item.recipe.title}`" @click="$emit('remove', item.recipe.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="close" /></button>
      <button v-else-if="editable" role="button" class="meal-dish-remove" :aria-label="`从本餐移除${item.recipe.title}`" :disabled="busy" @click.stop="$emit('remove', item.recipe.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="meal-dish-remove-mark"><AppIcon name="minus" :size="16" /></view></button>
    </view>
  </view>
</template>
