<script setup>
import { computed, nextTick, ref } from 'vue';
import { profileNameError } from '../domain/family.js';
import { accountProfile, manageFamily } from '../services/cloud.js';
import { activeMember } from '../store.js';
import Sheet from './Sheet.vue';
import ProfileFields from './ProfileFields.vue';
const emit = defineEmits(['close']);
const name = ref(accountProfile.value.name || activeMember.value?.name || '');
const avatar = ref(accountProfile.value.avatar || activeMember.value?.avatar || '');
const busy = ref(false);
const uploading = ref(false);
const error = ref('');
const profile = ref(null);
const submitted = ref(false);
const nameError = computed(() => submitted.value ? profileNameError(name.value) : '');
async function save() {
  if (busy.value || uploading.value) return;
  submitted.value = true;
  if (nameError.value) { await nextTick(); profile.value?.reveal(); return; }
  busy.value = true; error.value = '';
  try { await manageFamily('updateProfile', { name: name.value, avatar: avatar.value }); emit('close'); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
</script>

<template><Sheet title="我的头像与昵称" @close="!busy && $emit('close')"><ProfileFields ref="profile" v-model:name="name" v-model:avatar="avatar" :name-error="nameError" :disabled="busy" @busy="uploading = $event" /><template #footer><text v-if="error" class="error-message" role="alert">{{ error }}</text><button class="primary-button full" :disabled="busy || uploading" @click="save">{{ busy ? '正在保存…' : '保存个人资料' }}</button></template></Sheet></template>
