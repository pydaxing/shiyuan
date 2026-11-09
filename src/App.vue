<script>
import { cloudMode, cloudStatus, connectCloud } from './store.js';
import { sheetOpen } from './composables/sheetStack.js';
import { flushCloudCache, recoverVisibleImages, setAccountVisitVisible, refreshAccountVisit } from './services/cloud.js';
import { familyInvitation } from './services/family-invitation.js';
import { dismissFocusedKeyboard } from './services/keyboard.js';
import { isMomentsPreview } from './services/moments.js';
let syncTimer;
function refresh() { void refreshAccountVisit(); if (cloudMode && !cloudStatus.value.busy && !sheetOpen.value) connectCloud({ background: true }).catch(() => {}); }
export default {
  onLaunch(options) { if (isMomentsPreview(options)) return; familyInvitation.resume().catch(() => {}); refresh(); if (cloudMode) uni.onNetworkStatusChange?.(status => { if (status.isConnected) { recoverVisibleImages(); familyInvitation.ensure().catch(() => {}); } }); },
  onShow(options) { if (isMomentsPreview(options)) return; void setAccountVisitVisible(true); familyInvitation.resume().catch(() => {}); recoverVisibleImages(); if (cloudStatus.value.phase === 'ready') refresh(); clearInterval(syncTimer); if (cloudMode) syncTimer = setInterval(() => { if (cloudStatus.value.phase === 'ready') refresh(); }, 20000); },
  onHide() { if (isMomentsPreview()) return; void setAccountVisitVisible(false); dismissFocusedKeyboard(); familyInvitation.pause(); clearInterval(syncTimer); flushCloudCache(); },
};
</script>

<style>
@import './styles.css';
</style>
