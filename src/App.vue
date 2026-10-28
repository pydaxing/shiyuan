<script>
import { cloudMode, cloudStatus, connectCloud } from './store.js';
import { sheetOpen } from './composables/sheetStack.js';
import { flushCloudCache, recoverVisibleImages } from './services/cloud.js';
import { familyInvitation } from './services/family-invitation.js';
import { dismissFocusedKeyboard } from './services/keyboard.js';
let syncTimer;
function refresh() { if (cloudMode && !cloudStatus.value.busy && !sheetOpen.value) connectCloud({ background: true }).catch(() => {}); }
export default {
  onLaunch() { familyInvitation.resume().catch(() => {}); refresh(); if (cloudMode) uni.onNetworkStatusChange?.(status => { if (status.isConnected) { recoverVisibleImages(); familyInvitation.ensure().catch(() => {}); } }); },
  onShow() { familyInvitation.resume().catch(() => {}); recoverVisibleImages(); if (cloudStatus.value.phase === 'ready') refresh(); clearInterval(syncTimer); if (cloudMode) syncTimer = setInterval(() => { if (cloudStatus.value.phase === 'ready') refresh(); }, 20000); },
  onHide() { dismissFocusedKeyboard(); familyInvitation.pause(); clearInterval(syncTimer); flushCloudCache(); },
};
</script>

<style>
@import './styles.css';
</style>
