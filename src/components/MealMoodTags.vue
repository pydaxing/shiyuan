<script setup>
import { MEAL_MOODS, mealMoodDisplayLabel } from '../domain/meal-social.js';
defineProps({ tags: { type: Array, default: () => MEAL_MOODS }, selected: { type: Array, default: () => [] }, editable: Boolean, disabled: Boolean, selectionSummary: Boolean, feed: Boolean });
defineEmits(['toggle']);
</script>
<template>
  <view class="meal-mood-tags" :class="{ 'is-picker': editable || selectionSummary, 'in-feed': feed }">
    <template v-for="tag in tags" :key="tag.id">
      <button v-if="editable" class="meal-mood-pill" :class="['mood-' + (tag.tone || 'sky'), { selected: selected.includes(tag.id), unavailable: disabled || (!selected.includes(tag.id) && selected.length >= 3) }]" :aria-label="mealMoodDisplayLabel(tag)" :aria-pressed="selected.includes(tag.id)" :disabled="disabled || (!selected.includes(tag.id) && selected.length >= 3)" @click="$emit('toggle', tag.id)" hover-class="touch-feedback"><text class="meal-mood-emoji" aria-hidden="true">{{ tag.emoji }}</text><text>{{ mealMoodDisplayLabel(tag) }}</text><text class="meal-mood-check" aria-hidden="true">✓</text></button>
      <view v-else class="meal-mood-pill" :class="['mood-' + (tag.tone || 'sky'), { selected: selected.includes(tag.id) }]" :aria-label="mealMoodDisplayLabel(tag)"><text class="meal-mood-emoji" aria-hidden="true">{{ tag.emoji }}</text><text class="meal-mood-label">{{ mealMoodDisplayLabel(tag) }}</text><text v-if="selected.includes(tag.id) && !selectionSummary" class="meal-mood-check" aria-hidden="true">✓</text></view>
    </template>
  </view>
</template>
<style scoped>
.meal-mood-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 4px; }
.meal-mood-pill { position: relative; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; gap: 2px; max-width: 100%; min-height: 24px; padding: 2px 3px; margin: 0; border: 0; border-radius: 999px; font-size: var(--type-caption); line-height: 1.5; text-align: center; }
.in-feed .meal-mood-pill { gap: 3px; min-height: 26px; padding: 3px 6px; }
.meal-mood-label { white-space: nowrap; }
.is-picker { justify-content: center; gap: 10px 6px; }
.is-picker .meal-mood-pill { flex: 0 1 auto; gap: 4px; min-height: 30px; padding: 5px 9px; border: 1px solid transparent; }
.meal-mood-pill.selected { border-color: currentColor; box-shadow: inset 0 0 0 1px currentColor; }
.meal-mood-pill.unavailable { opacity: .55; }
.meal-mood-emoji { flex: 0 0 1em; width: 1em; font-size: var(--type-meta); line-height: 1.5; text-align: center; }
.meal-mood-check { position: absolute; right: -2px; top: -4px; width: 14px; height: 14px; border-radius: 50%; background: var(--white); text-align: center; line-height: 14px; font-size: var(--type-caption); visibility: hidden; font-weight: 600; }
.selected .meal-mood-check { visibility: visible; }
.mood-peach { color: var(--mood-peach-ink); background: var(--mood-peach-surface); }
.mood-mint { color: var(--mood-mint-ink); background: var(--mood-mint-surface); }
.mood-sky { color: var(--mood-sky-ink); background: var(--mood-sky-surface); }
.mood-rose { color: var(--mood-rose-ink); background: var(--mood-rose-surface); }
.mood-lavender { color: var(--mood-lavender-ink); background: var(--mood-lavender-surface); }
</style>
