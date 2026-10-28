<script setup>
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import AppIcon from './AppIcon.vue';
import { computed, ref } from 'vue';
import { state, removeStock, changeStockImage, runAction, notify } from '../store.js';
import { expiryLabel, isExpired, localDate, formatAmount } from '../domain/kitchen.js';
import { ingredientImage } from '../domain/presentation.js';
import { coverFrameStyle } from '../domain/image-crop.js';
import { isPendingRecord, presentMutation } from '../services/mutation-feedback.js';
import StockEditor from './StockEditor.vue';
import Sheet from './Sheet.vue';
import ImagePicker from './ImagePicker.vue';
import LazyImage from './LazyImage.vue';
import PageHeader from './PageHeader.vue';
const props = defineProps({ embedded: Boolean, today: { type: String, default: localDate } });
const location = ref('全部');
const editing = ref(false);
const initialStock = ref({});
const photoBatch = ref(null);
const photo = ref('');
const busy = ref(false);
const locations = [{ name: '冷藏', image: 'greens', tone: 'fresh' }, { name: '冷冻', image: 'meat', tone: 'frozen' }, { name: '常温', image: 'jar', tone: 'pantry' }, { name: '全部', image: 'eggs', tone: 'all' }];
const filtered = computed(() => state.value.inventory.filter((batch) => location.value === '全部' || batch.location === location.value));
const expiring = computed(() => state.value.inventory.filter((batch) => batch.expiresOn && !isExpired(batch, props.today) && (new Date(`${batch.expiresOn}T12:00:00`) - new Date(`${props.today}T12:00:00`)) / 86400000 <= 3).length);
const expired = computed(() => state.value.inventory.filter((batch) => isExpired(batch, props.today)).length);
const countAt = (place) => state.value.inventory.filter((batch) => place === '全部' || batch.location === place).length;
function locationTone(place) { return locations.find((zone) => zone.name === place)?.tone || 'all'; }
function addAt(place) { initialStock.value = { location: place === '全部' ? '冷藏' : place }; editing.value = true; }
function remove(batch) { if (isPendingRecord(batch.id)) { notify('食材正在同步，请稍等'); return; } uni.showModal({ confirmColor: NATIVE_UI_COLORS.danger, cancelColor: NATIVE_UI_COLORS.muted, title: `删除${batch.name}？`, content: '这会移除冰箱中的整个食材批次，不影响餐单和备菜状态。', confirmText: '删除', success: (result) => { if (result.confirm) runAction(() => removeStock(batch.id)); } }); }
function editPhoto(batch) { if (isPendingRecord(batch.id)) { notify('食材正在同步，请稍等'); return; } photoBatch.value = batch; photo.value = batch.image || ''; }
function savePhoto() { runAction(async () => { await presentMutation(changeStockImage(photoBatch.value.id, photo.value), () => { photoBatch.value = null; }); }); }
</script>

<template>
  <view class="inventory-view">
    <PageHeader v-if="!embedded" title="冰箱" />
    <view class="fridge-zones">
      <view v-for="zone in locations" :key="zone.name" class="zone-card" :class="[zone.tone, { selected: location === zone.name }]">
        <button role="button" class="zone-filter" :aria-label="`查看${zone.name}食材`" :aria-pressed="location === zone.name" @click="location = zone.name" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
          <text class="zone-name">{{ zone.name }}</text>
          <text class="zone-count">{{ countAt(zone.name) }} 份食材</text>
          <image class="zone-illustration" :src="$image(`/static/ingredient-${zone.image}.png`)" mode="aspectFit" aria-hidden="true" />
          <AppIcon v-if="location === zone.name" class="zone-selected" name="check" :size="14" />
          <view class="zone-meter"><view :style="{ width: `${state.inventory.length ? countAt(zone.name) / state.inventory.length * 100 : 0}%` }" /></view>
        </button>
        <button role="button" class="zone-add" :aria-label="zone.name === '全部' ? '添加食材' : `添加${zone.name}食材`" @click="addAt(zone.name)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="plus" :size="18" /></button>
      </view>
    </view>
    <view v-if="expiring || expired" class="freshness-notice" role="status">
      <AppIcon class="freshness-notice-icon" name="alert-danger" :size="16" />
      <view class="freshness-notice-text"><text v-if="expiring">{{ expiring }} 份即将到期</text><text v-if="expired" class="danger">{{ expired }} 份已过期</text></view>
    </view>
    <view class="section-line"><text class="subheading">{{ location === '全部' ? '全部食材' : `${location}食材` }} <text class="muted-inline">{{ filtered.length }}</text></text></view>
    <view v-if="!filtered.length" class="inventory-empty" aria-label="冰箱空空如也">
      <view class="supplies-empty-art"><AppIcon name="inventory" :size="50" /></view>
      <button role="button" class="secondary-button" @click="addAt(location)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="plus" active :size="18" /><text>放入冰箱</text></button>
    </view>
    <view class="stock-grid">
      <view v-for="batch in filtered" :key="batch.id" class="stock-card" :class="[locationTone(batch.location), { expired: isExpired(batch, today) }]">
        <button role="button" class="stock-photo" :style="coverFrameStyle('recipe')" :aria-label="`修改${batch.name}图片`" @click="editPhoto(batch)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
          <LazyImage class="stock-photo-image" :src="batch.image || ingredientImage(batch.name)" :mode="batch.image ? 'aspectFill' : 'aspectFit'" style="position: absolute; inset: 0; background: var(--white);" />
        </button>
        <button role="button" class="card-remove" :aria-label="`删除${batch.name}`" @click.stop="remove(batch)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="trash-danger" :size="18" /></button>
        <view class="stock-body">
          <view class="stock-heading"><text class="stock-name">{{ batch.name }}</text><text class="stock-quantity">{{ formatAmount(batch.quantity, batch.unit) }}</text></view>
          <view class="stock-description"><text class="stock-location">{{ batch.location }}</text><text class="expiry" :class="{ danger: isExpired(batch, today) }">{{ expiryLabel(batch, today) }}</text></view>
        </view>
      </view>
    </view>
    <StockEditor v-if="editing" :initial="initialStock" @close="editing = false" @saved="editing = false" />
    <Sheet v-if="photoBatch" :title="`${photoBatch.name}的图片`" @close="photoBatch = null"><ImagePicker v-model="photo" label="拍照或更换食材图片" :fallback="ingredientImage(photoBatch.name)" @busy="busy = $event" /><template #footer><button role="button" class="primary-button full" :disabled="busy" @click="savePhoto" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">保存图片</button></template></Sheet>
  </view>
</template>
