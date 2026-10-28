# 食愿小灶宣传图片

这些图片用于项目 README 和对外介绍。微信小程序的搜索名称是 **食愿小灶**。

| 文件 | 尺寸 | 使用位置 |
| --- | --- | --- |
| `readme-cta-top.png` | 1600 × 640 | README 顶部，桌面宽度 |
| `readme-cta-top-compact.png` | 900 × 1080 | README 顶部，手机宽度 |
| `readme-cta-bottom.png` | 1600 × 560 | README 底部，桌面宽度 |
| `readme-cta-bottom-compact.png` | 900 × 1060 | README 底部，手机宽度 |
| `social-preview.jpg` | 1280 × 640 | GitHub 社交分享预览 |
| `poster.png` | 1080 × 1440 | 竖版介绍海报 |
| `mini-program-code-1280.jpg` | 1280 × 1280 | 原始小程序码，适合单独展示或再次排版 |

README 使用 `<picture>` 在 600px 以下切换到紧凑版，避免把二维码和文字随横图一起缩得过小。海报和分享预览使用本仓库现有的微信真实页面截图与手机边框，内容没有重新绘制。

在项目根目录运行：

```sh
node scripts/build-readme-promo.mjs
```

脚本只生成本目录的六张宣传图，输入为本目录的原始小程序码、`assets/brand/shiyuan-icon-v2-1024.png` 和 `docs/images/readme/` 的真实页面图片；不会构建或部署小程序。

原始码来自项目所有者提供的 1280px JPEG，保持原文件内容。排版只对整张方形图片等比缩放，不重新绘制、着色、遮挡或裁切二维码。原文件 SHA-256：

```text
01cec1a783f740e46dd511893a02fb8f627f765eb7a085b5cf2f035228814d3f
```

如小程序码或真实界面发生变化，先替换对应输入素材，再重新生成图片。项目未声明的版权许可不因这些宣传图而改变。
