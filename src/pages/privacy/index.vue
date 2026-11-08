<template>
  <view class="privacy-page">
    <text class="privacy-heading">你的资料与每一餐</text>
    <text class="privacy-intro">使用食愿小灶前，请了解资料的保存方式，以及个人、家庭和公开内容的区别。</text>
    <view class="privacy-section"><text class="privacy-section-title">01　资料与云端保存</text><text>昵称、头像、菜单和餐食记录会保存在微信云端，用于识别账号、同步内容和展示餐食。账号使用唯一用户标识区分；昵称可以相同。首次进入会提供默认昵称和头像，你可以修改。选择头像或照片时，才需要使用对应的微信图片功能。</text></view>
    <view class="privacy-section"><text class="privacy-section-title">02　个人与家庭空间</text><text>普通入口首次进入使用个人空间。通过有效家人邀请并确认加入后，进入家庭空间，家人可以共同查看家庭菜单与餐食。家庭餐食也会汇总到相关成员的个人饮食日记。昵称、头像属于同一账号，修改后会同步到加入的家庭。</text></view>
    <view class="privacy-section"><text class="privacy-section-title">03　谁可以看到餐食</text><text>“发现 · 公开”的餐食会展示在发现页，其他用户可以查看。“仅饮食日记”的餐食不展示在发现页：家庭餐食仍对家人可见，个人餐食仅自己可见。</text><text>请特别留意：过去日期的安排如未主动记录，系统会自动生成餐食记录，并按当前规则默认公开到发现页。你可以在饮食日记中修改可见范围。</text></view>
    <view class="privacy-section"><text class="privacy-section-title">04　分享与管理</text><text>分享给微信好友或发布到美食，会让相应接收者看到分享内容。请确认照片和文字中没有不希望分享的资料。</text><text>你可以在饮食日记管理自己的记录。从家庭空间删除家庭餐食，会同时删除成员日记中的关联记录；从个人日记移除家庭餐食，仅影响自己的日记，不删除家人及家庭空间的记录。</text></view>
    <view class="privacy-section"><text class="privacy-section-title">05　你的选择</text><text>同意前可以返回查看并修改资料；不勾选同意，不会提交此页的进入或加入操作。你可以在“我的”修改昵称、头像和使用模式。微信相关权限可在微信的小程序设置中管理。</text></view>
  </view>
</template>
<style scoped>
.privacy-page { max-width: 560px; margin: auto; padding: 28px 24px calc(36px + env(safe-area-inset-bottom)); color: var(--ink); }
.privacy-heading { display: block; font-family: var(--font-display); font-size: var(--type-display); line-height: 1.45; }
.privacy-intro { display: block; margin-top: 12px; color: var(--muted); font-size: var(--type-control); line-height: 1.8; }
.privacy-section { margin-top: 28px; font-size: var(--type-body); line-height: 1.9; }
.privacy-section > text { display: block; margin-top: 10px; }
.privacy-section .privacy-section-title { font-size: var(--type-section); font-weight: 600; margin-bottom: 12px; }
</style>
