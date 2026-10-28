<script setup>
import { computed, ref } from 'vue';
import { state, activeMember, familyFeatures, preferencePending, cloudMode, setFridgeEnabled, runAction, notify } from '../store.js';
import FamilyInviteCard from './FamilyInviteCard.vue';
import ProfileEditor from './ProfileEditor.vue';
import LazyImage from './LazyImage.vue';
import FamilyCoverImage from './FamilyCoverImage.vue';
import AppIcon from './AppIcon.vue';
import PageHeader from './PageHeader.vue';
import Sheet from './Sheet.vue';
import CookingDiary from './CookingDiary.vue';
import { coverFrameStyle } from '../domain/image-crop.js';
import { familyAppearance, familyPublicId } from '../domain/family.js';
import { localDate } from '../domain/kitchen.js';
defineProps({ today: { type: String, default: localDate } });
defineEmits(['customize']);
const familyDisplay = computed(() => familyAppearance(state.value.family));
const visibleFamilyId = computed(() => familyPublicId(state.value.family));
const about = ref(false);
const editingProfile = ref(false);
function editProfile() {
  if (!cloudMode) { notify('请在微信小程序中编辑头像与昵称'); return; }
  editingProfile.value = true;
}
</script>

<template>
  <view class="family-view"><PageHeader :title="familyDisplay.name" />
    <view class="family-banner">
      <button role="button" class="family-banner-main family-management-entry" aria-label="家庭设置" @click.stop="$emit('customize')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
        <view class="family-banner-thumbnail"><view class="family-banner-frame" :style="coverFrameStyle('family')"><FamilyCoverImage class="family-cover" :src="state.family.cover" variant="card" /></view></view>
        <view class="family-banner-copy"><text class="subheading family-banner-name">{{ familyDisplay.name }}</text><text v-if="visibleFamilyId" class="family-banner-caption family-id">ID: {{ visibleFamilyId }}</text></view>
      </button>
      <button role="button" class="family-banner-edit" aria-label="编辑家庭名称与封面" @click.stop="$emit('customize')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="action-icon-circle"><AppIcon name="edit" :size="18" /></view></button>
    </view>
    <CookingDiary :orders="state.orders" :today="today" />
    <view class="feature-panel family-members-panel">
      <view class="section-line family-members-heading"><text class="subheading">家庭成员</text><text class="muted">{{ state.family.members.length }} 人</text></view>
      <view class="member-grid family-member-grid">
        <view v-for="member in state.family.members" :key="member.id" class="member-card" :class="{ 'is-self': activeMember.id === member.id }">
          <view class="member-portrait"><view class="member-photo"><LazyImage class="member-avatar-image" :src="member.avatar" variant="avatar" avatar round /></view><view v-if="state.family.headMemberId === member.id" class="head-crown" aria-label="一家之主"><AppIcon name="crown" active /></view></view>
          <text class="member-name">{{ member.name || '家人' }}</text><text class="member-status">{{ activeMember.id === member.id ? '我' : '家人' }}</text><text v-if="state.family.headMemberId === member.id" class="member-status member-head-label">一家之主</text>
          <button v-if="activeMember.id === member.id" class="member-profile-button" aria-label="编辑我的头像与昵称" @click.stop="$feedback(); editProfile()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="member-profile-mark"><AppIcon name="edit" active /></view></button>
        </view>
        <FamilyInviteCard />
      </view>
    </view>
    <view class="feature-panel family-preferences">
      <view class="feature-row" :aria-busy="preferencePending"><view class="feature-icon"><AppIcon name="inventory" /></view><view class="feature-copy"><text class="stock-name">冰箱</text></view><button role="switch" class="feature-switch" :class="{ on: familyFeatures.fridge }" :aria-checked="familyFeatures.fridge" aria-label="冰箱" @click="$feedback(); runAction(() => setFridgeEnabled(!familyFeatures.fridge))" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view /></button></view>
      <button role="button" class="family-info-row family-help-entry" @click="$feedback(); about = true" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="menu" /><text>使用说明</text><AppIcon name="chevron" /></button>
    </view>
    <Sheet v-if="about" title="使用说明" :preferred-height="600" @close="about = false">
      <view class="help-section"><text class="subheading">家庭与个人资料</text><text class="hint">在「我家」点击自己的成员卡片修改头像和昵称。顶部家庭卡片和右侧编辑按钮都打开「名称与封面」；需要切换、新建或管理家庭时，在设置内选择「切换与管理」。</text></view>
      <view class="help-section"><text class="subheading">点菜与开饭</text><text class="hint">在「菜单」选好菜再选餐次，重复菜品只做一道。「厨房」按日期和餐次展示已安排的餐食，开饭前可以加菜、查看本餐备菜。无需标记已备也能直接开饭，开饭后记入开火日记。</text></view>
      <view class="help-section"><text class="subheading">本餐备菜</text><text class="hint">点击菜品查看做法，展开「按需调整」即可修改用量、添加或删除材料，调整会自动保存，仅影响本餐。「恢复默认」可取回本餐原材料。点击「备齐」或「加购」即可标记，再点「已备齐」或「已加购」可取消。备齐会移除本菜待买包，取消备齐不会自动加购；需要购买时先取消备齐，再加购并从底部进入采购。</text></view>
      <view class="help-section"><text class="subheading">采购与冰箱</text><text class="hint">采购只显示主动加购的菜品食材包，用量以本餐调整为准，可选择本次要买的餐或菜；购买功能接入中。备菜中标记「备齐」会移除该菜待买包，开饭、取消或删除餐单会移除本餐待买包。冰箱独立记录库存，不自动扣减；关闭冰箱不会清除记录，底部「食材」变为「采购」，备菜和采购始终可用。</text></view>
      <view class="help-section"><text class="subheading">分享与隐私</text><text class="hint">{{ cloudMode ? '家庭记录仅家人可访问。通过微信发给好友的菜品或套餐，对方无需加入家庭即可查看；主动发布到美食的内容会公开。邀请卡片需由对方确认后才会加入家庭。' : '当前为本地预览，分享与评论只保存在当前设备。' }}删除分享不影响已加入的菜单。营养说明由作者填写，不作为医疗建议。</text></view>
    </Sheet>
    <ProfileEditor v-if="editingProfile" @close="editingProfile = false" />
  </view>
</template>

<style scoped>
.family-banner-caption.family-id { white-space: nowrap; }
.section-line.family-members-heading { justify-content: flex-start; gap: 8px; }
</style>
