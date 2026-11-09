<picture>
  <source media="(max-width: 600px)" srcset="docs/images/promotion/readme-cta-top-compact.png" />
  <img src="docs/images/promotion/readme-cta-top.png" alt="食愿：今天吃什么？把想吃的，变成一起吃的。微信小程序搜索「食愿小灶」，或扫描右侧小程序码体验。" width="100%" />
</picture>

<p align="center">
  <strong>打开微信 → 搜索小程序「食愿小灶」</strong><br />
  也可以用微信扫一扫上方小程序码；同一台手机浏览时，可保存<a href="docs/images/promotion/mini-program-code-1280.jpg">小程序码原图</a>，在微信扫一扫中从相册识别。
</p>

<p align="center">
  <a href="docs/版本与发布.md"><img src="docs/images/readme/badges/version.svg" alt="源码版本 2.0.0" height="24" /></a>
  <img src="docs/images/readme/badges/wechat.svg" alt="微信小程序" height="24" />
  <img src="docs/images/readme/badges/vue.svg" alt="Vue 3" height="24" />
  <img src="docs/images/readme/badges/cloudbase.svg" alt="微信云开发 CloudBase" height="24" />
</p>

<p align="center">
  <a href="#体验食愿小灶">小程序体验</a> ·
  <a href="#看看食愿">界面预览</a> ·
  <a href="#一家人的日常">功能介绍</a> ·
  <a href="#开始开发">开始开发</a> ·
  <a href="docs/开发接手指南.md">开发文档</a>
</p>

> **2.0.0 已提交微信审核**（2026-11-09，用户确认），尚未确认审核通过或正式发布。下方展示 2.0 界面；微信搜索入口的正式版本仍以平台为准。查看 [2.0 更新说明](docs/releases/2.0.0.md) 与 [发布台账](docs/发布版本台账.md)。

## 关于食愿

> 「今天吃啥？」
> 「都行，你定。」
> 到了晚上，又是同样的问题。

两个人也好，一家人也好，每天吃什么，是一个小问题，却要每天重新做决定。想吃的人一时没有主意，做饭的人除了下厨，还要想菜单、记住大家的口味、确认材料够不够。

**食愿是一款兼顾个人与家庭的饮食规划、菜谱和餐食记录小程序。一个人认真吃饭，一家人一起安排。**

把喜欢的菜收进自家菜单，家人挑选想吃的菜，在「小灶」汇成同一餐，再按菜准备食材。负责点菜的人有具体的选择，负责做饭的人能看到这一餐的安排；菜谱、用量和餐食记录也有了共同的去处。

没有灵感时，就去「美食」看看别人家的拿手菜。喜欢的做法可以加入自家菜单，按家人的口味修改；自己做得好的菜也可以分享出去。一家人的菜单，就这样随着每一次发现、尝试和调整，慢慢丰富起来。

> 把想吃的，变成一起吃的。让好好吃饭这件事，少一些纠结，多一些参与。

## 看看食愿

以下八张图于 **2026-11-09** 从 2.0.0 送审源码对应的微信预览采集，涵盖菜单、安排、备菜、美食、发现、记录、日记和我的。页面内容来自微信开发者工具中连接真实云数据的截图，与 **iPhone 17 标准版边框合成**为下方效果图。左右滑动浏览完整页面，点击图片查看大图。

<table>
  <thead><tr>
    <th width="280" align="center" nowrap>菜单 · 收好想吃的</th>
    <th width="280" align="center" nowrap>安排 · 计划每一餐</th>
    <th width="280" align="center" nowrap>备菜 · 看清用量</th>
    <th width="280" align="center" nowrap>美食 · 寻找灵感</th>
    <th width="280" align="center" nowrap>发现 · 分享日常</th>
    <th width="280" align="center" nowrap>记录 · 留下这一餐</th>
    <th width="280" align="center" nowrap>日记 · 回看日常</th>
    <th width="280" align="center" nowrap>我的 · 自己与家人</th>
  </tr></thead>
  <tbody>
    <tr>
      <td width="280" align="center" nowrap><a href="docs/images/readme/v2/menu-phone.png"><img src="docs/images/readme/v2/menu-phone.png" alt="食愿 2.0 真实微信页面与 iPhone 边框合成：菜单 · 收好想吃的，按分类浏览美食与自建菜，留下喜欢的味道" width="280" /></a></td>
      <td width="280" align="center" nowrap><a href="docs/images/readme/v2/arrange-phone.png"><img src="docs/images/readme/v2/arrange-phone.png" alt="食愿 2.0 真实微信页面与 iPhone 边框合成：安排 · 计划每一餐，选择日期和餐次，把几道菜安排到同一餐" width="280" /></a></td>
      <td width="280" align="center" nowrap><a href="docs/images/readme/v2/preparation-phone.png"><img src="docs/images/readme/v2/preparation-phone.png" alt="食愿 2.0 真实微信页面与 iPhone 边框合成：备菜 · 看清用量，按餐查看每道菜的食材与用量，准备更从容" width="280" /></a></td>
      <td width="280" align="center" nowrap><a href="docs/images/readme/v2/food-phone.png"><img src="docs/images/readme/v2/food-phone.png" alt="食愿 2.0 真实微信页面与 iPhone 边框合成：美食 · 寻找灵感，浏览公开菜谱，把喜欢的做法加入自己的菜单" width="280" /></a></td>
      <td width="280" align="center" nowrap><a href="docs/images/readme/v2/discovery-phone.png"><img src="docs/images/readme/v2/discovery-phone.png" alt="食愿 2.0 真实微信页面与 iPhone 边框合成：发现 · 分享日常，看看大家正在吃什么，为喜欢的餐食点赞" width="280" /></a></td>
      <td width="280" align="center" nowrap><a href="docs/images/readme/v2/record-phone.png"><img src="docs/images/readme/v2/record-phone.png" alt="食愿 2.0 真实微信页面与 iPhone 边框合成：记录 · 留下这一餐，选择安排或上传实拍，自由选择餐食可见范围" width="280" /></a></td>
      <td width="280" align="center" nowrap><a href="docs/images/readme/v2/diary-phone.png"><img src="docs/images/readme/v2/diary-phone.png" alt="食愿 2.0 真实微信页面与 iPhone 边框合成：日记 · 回看日常，按日期回看餐食，家庭共同记录也能个人回顾" width="280" /></a></td>
      <td width="280" align="center" nowrap><a href="docs/images/readme/v2/profile-phone.png"><img src="docs/images/readme/v2/profile-phone.png" alt="食愿 2.0 真实微信页面与 iPhone 边框合成：我的 · 自己与家人，管理个人资料与家庭，从这里进入饮食日记" width="280" /></a></td>
    </tr>
    <tr>
      <td align="center" nowrap>按分类浏览美食与自建菜，留下喜欢的味道</td>
      <td align="center" nowrap>选择日期和餐次，把几道菜安排到同一餐</td>
      <td align="center" nowrap>按餐查看每道菜的食材与用量，准备更从容</td>
      <td align="center" nowrap>浏览公开菜谱，把喜欢的做法加入自己的菜单</td>
      <td align="center" nowrap>看看大家正在吃什么，为喜欢的餐食点赞</td>
      <td align="center" nowrap>选择安排或上传实拍，自由选择餐食可见范围</td>
      <td align="center" nowrap>按日期回看餐食，家庭共同记录也能个人回顾</td>
      <td align="center" nowrap>管理个人资料与家庭，从这里进入饮食日记</td>
    </tr>
  </tbody>
</table>

## 一家人的日常

### 从想吃，到记下这一餐

**收进菜单 → 安排日期和餐次 → 按菜备料 → 拍照记录 → 回看饮食日记**

- **自己用，也能一起用。** 普通首次进入默认个人模式；通过家庭邀请加入后开启家庭模式。个人菜单与安排独立，家庭模式下共享同一个小灶。
- **先把菜记下来。** 创建菜品填写封面、名称和类别即可；时长不填按 20 分钟保存。食材与做法默认收起，可以以后补充；发布到美食前必须补全，分享给微信好友不要求先公开发布。
- **美食与自建，来源清楚。** 从美食加入菜单而未修改的菜沿用原菜品身份；实际编辑后生成新的自建菜。仅打开编辑或原样保存不会产生副本。自建菜主动发布后，其他人才能在美食中看到。
- **一餐共同记录，个人也能回看。** 家庭餐食关联记录时的成员，家庭日记共同可见，对应成员在个人模式也能回看；个人餐食归个人空间。新加入的家人不会自动获得所有历史餐食的个人归档。
- **可见范围由你选择。** 记录可公开到发现，也可仅留在饮食日记。未手动记录的有效安排跨天后自动归档，默认公开；已有记录保留原选择，删除过的记录不会自动补回。
- **删除按所在空间处理。** 家庭日记删除一餐，会同步移除关联个人日记中的该餐；个人日记移除来自家庭的餐食，仅影响自己，保留家庭和其他成员的记录。具体操作仍受账号权限限制。

### 四个入口，各有一件日常事

| 入口 | 能做什么 |
| --- | --- |
| **小灶** | 在菜单中浏览、自建菜品或组合套餐；安排日期与餐次、加菜、查看备菜清单、记录这一餐。套餐选入安排后按其中的菜品处理。 |
| **美食** | 浏览公开菜谱与完整做法，将喜欢的菜加入菜单；补全自建菜的食材和步骤后公开分享。 |
| **发现** | 浏览公开餐食、点赞、上传实拍。美食菜图片打开菜谱详情，自建菜和实拍图打开大图，历史无图菜以文字展示。 |
| **我的** | 修改头像昵称、切换个人与家庭模式、管理家庭、进入饮食日记和使用说明。 |

餐食记录的可见范围与菜谱是否发布到美食是两件事：公开一餐不等于公开其中自建菜的完整菜谱。退出或清理家庭后的日记保留规则见 [2.0 更新说明](docs/releases/2.0.0.md)。

## 接下来，还想做好这些事

食愿先把选菜、安排餐食、按菜备料和饮食记录这条日常流程做好，再逐步扩展一餐饭前后的服务。**以下为后续规划，尚未成为当前版本的功能。**

| 方向 | 想解决的问题 | 后续设想 |
| --- | --- | --- |
| **AI 选餐与推荐** | 每天还是会有不想翻菜单、也不知道吃什么的时候。 | 下一阶段结合家庭偏好与用餐需求，提供可以继续挑选、调整的菜品和餐食建议。 |
| **AI 餐食搭配分析** | 单道菜会做了，一整餐怎样搭配更合适，却不容易判断。 | 围绕食材组成和搭配提供分析与建议，让日常餐食更丰富；不作为医疗或健康结果承诺。 |
| **按菜采购，按量准备** | 菜想好了，买菜时却容易凭感觉多买，或者买回了用不上的材料。 | AI 能力稳定后，再在现有备菜清单基础上接入一个官方采购渠道，衔接所需用量和可购买食材。 |

这些方向会随着实际使用反馈继续调整。希望未来的食愿，既能帮人决定吃什么，也能让准备一餐饭更有把握。

## 项目构成

食愿采用 **Vue 3 + uni-app** 构建微信小程序，通过 **微信云开发 / CloudBase** 提供家庭协作、数据存储和图片服务。

| 部分 | 说明 |
| --- | --- |
| 小程序界面 | Vue 3 组件、uni-app 微信端、统一视觉与交互约定 |
| 业务规则 | 独立领域模块，管理家庭、菜谱、餐单、备菜、采购与分享 |
| 云端服务 | Node.js 云函数、微信可信身份、家庭权限校验、云数据库与云存储 |
| 图片体验 | 本机压缩、列表与详情图、缓存、按需加载和私有媒体处理 |
| 工程保障 | 锁定依赖、自动化测试、微信原生产物检查、版本与发布校验 |

## 开始开发

仓库已公开，可以下载源码并安装依赖：

```sh
git clone https://github.com/pydaxing/shiyuan.git
cd shiyuan
npm ci
cp .env.example .env.production
```

独立开发请使用**自己的微信小程序 AppID 与 CloudBase 云环境**，在 `.env.production` 填写配置，并同步调整 `cloudbaserc.json` 的云环境与函数名称，再运行：

```sh
npm run build:release
```

按 [云端部署](docs/正式云端部署.md) 在自己的云环境准备数据库规则、索引及云函数后，使用微信开发者工具打开 **`dist/release`**，登录有开发权限的微信账号进行真实云数据预览。已验证的工具环境、配置来源、常用命令和上传工具要求，见 **[开发接手指南](docs/开发接手指南.md)**。

仓库保存源码与项目资源。数据库、云存储、账号登录和本机私有配置各自维护；换电脑时需要恢复配置与工具登录。新的 Codex 可从 [AGENTS.md](AGENTS.md) 开始理解项目。

项目自有软件代码与配套技术文档采用 **[MIT License](LICENSE)**，欢迎学习、修改、商用和再分发，使用时请保留版权与许可声明。品牌、小程序码、图片与宣传素材、菜谱及用户内容不包含在本次代码授权中；第三方依赖保留原许可。具体范围见 **[许可说明](LICENSING.md)**。

## 文档导航

| 文档 | 适合什么时候阅读 |
| --- | --- |
| [2.0 更新说明](docs/releases/2.0.0.md) | 查看本轮变化、发布状态与已知验收边界 |
| [开发接手指南](docs/开发接手指南.md) | 换电脑、换会话，或第一次加入开发 |
| [交互约定](UX-CONTRACT.md) | 修改餐食流程、数据行为与页面交互 |
| [设计规范](DESIGN.md) | 调整布局、颜色、组件与视觉细节 |
| [云端部署](docs/正式云端部署.md) | 核对云环境、数据库规则与云函数部署 |
| [版本与发布](docs/版本与发布.md) | 更新版本号、校验构建与准备微信上传 |
| [发布版本台账](docs/发布版本台账.md) | 查询微信版本对应的 Git 标签、源码提交和已核验发布阶段 |
| [首页素材维护](docs/项目首页维护.md) | 更新封面、截图与顶部徽章 |
| [宣传素材](docs/images/promotion/README.md) | 下载小程序码、分享封面和宣传海报 |
| [推广与增长](docs/推广与增长.md) | 查看推广计划、渠道建议与介绍文案 |
| [开发协作](CONTRIBUTING.md) | 反馈问题、提出改进、提交代码 |

## 反馈与协作

欢迎通过 [Issues](https://github.com/pydaxing/shiyuan/issues/new/choose) 记录问题与想法。描述遇到问题的页面、操作步骤、期望结果和实际表现，会让修复更快；截图请先遮挡个人资料和家庭邀请码。

准备修改代码时，从 [开发协作](CONTRIBUTING.md) 开始。希望每一次改进，都让一家人更轻松地决定吃什么、一起把饭做好。

## 体验食愿小灶

今晚吃什么，可以从一家人都想吃的一道菜开始。打开微信，搜索小程序 **「食愿小灶」**，或者扫一扫下面的小程序码。

<picture>
  <source media="(max-width: 600px)" srcset="docs/images/promotion/readme-cta-bottom-compact.png" />
  <img src="docs/images/promotion/readme-cta-bottom.png" alt="今晚吃什么，一起决定。微信搜索「食愿小灶」，或扫描小程序码，收藏想吃的、一起点菜、安排下厨。" width="100%" />
</picture>

<p align="center">
  <a href="docs/images/promotion/mini-program-code-1280.jpg">查看小程序码</a> ·
  <a href="docs/images/promotion/poster.png">保存宣传海报</a> ·
  <a href="https://github.com/pydaxing/shiyuan/issues/new/choose">反馈使用感受</a><br />
  如果食愿对你有帮助，欢迎 Star 关注后续进展，也欢迎把它分享给每天一起商量吃什么的人。
</p>

<p align="center"><strong>食愿 · 好好吃饭，一起生活。</strong></p>


手机号登录接入的入口规则、兼容边界和真实验收进度见 [手机号登录接入](docs/手机号登录接入-2026-11-09.md)。本轮不接入位置；后端部署与前端上传状态分别记录，真实手机号授权尚待本人完成。
