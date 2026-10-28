<script setup>
defineProps({ name: String, active: Boolean, size: Number });
</script>

<template>
  <image class="app-icon" :src="$image(`/static/icon-${name}${active ? '-active' : ''}.png`)" :style="size ? { width: `${size}px`, height: `${size}px` } : {}" mode="aspectFit" aria-hidden="true" />
</template>
