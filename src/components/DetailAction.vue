<script setup>
import AppIcon from './AppIcon.vue';
import { tapFeedback } from '../services/feedback.js';
defineProps({ icon: String, label: String, busy: Boolean });
const emit = defineEmits(['click']);
function activate() { tapFeedback(); emit('click'); }
</script>

<template>
  <button role="button" class="detail-icon-action" :aria-label="label" :aria-busy="busy" :disabled="busy" @click.stop="activate" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="action-icon-circle" :class="{ 'action-pending': busy }"><AppIcon :name="icon" active /></view><text class="action-icon-label">{{ label }}</text></button>
</template>
