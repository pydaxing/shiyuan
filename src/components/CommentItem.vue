<script setup>
import AppIcon from './AppIcon.vue';
defineProps({ entry: Object, memberId: String });
defineEmits(['reply', 'like']);
</script>

<template>
  <view class="comment-row"><text class="author-dot">{{ entry.author.slice(0, 1) }}</text><view><text class="comment-author">{{ entry.author }}</text><text v-if="entry.parentId" class="reply-recipient">回复 {{ entry.replyToAuthor }}</text><text class="comment-text">{{ entry.text }}</text><view class="comment-tools"><button role="button" :aria-label="`回复${entry.author}的评论：${entry.text}`" @click.stop="$emit('reply', entry)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">回复</button><button role="button" class="comment-like" :class="{ liked: entry.likes?.includes(memberId) }" :aria-pressed="Boolean(entry.likes?.includes(memberId))" :aria-label="`${entry.likes?.includes(memberId) ? '取消点赞' : '点赞'}评论：${entry.text}`" @click="$feedback(); $emit('like', entry.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="thumb" :active="Boolean(entry.likes?.includes(memberId))" /><text>{{ entry.likes?.length || '赞' }}</text></button></view></view></view>
</template>
