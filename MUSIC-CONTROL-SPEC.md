# dsh-pet 网易云音乐控制条 · 技术 Spec

> 状态：**已实现并在 DSH 桌面插件中运行** ｜ 本文描述当前真实实现，不是设想
> 形态：DSH 插件（`dsh-pet`），桌面端 Electron Helper 原生 DOM；改源码持续生效（profile 用 Junction 软链）

---

## 1. 目标与形态

桌宠脚下一条音乐控制条，**鼠标悬浮宠物时淡入**：两行歌词（当前行大、下一行小，超长横向滚动）+ 四个圆形按钮（♥ 收藏 / ⏮ 上一首 / ⏯ 播放暂停 / ⏭ 下一首）。

- 播放控制与曲目信息来自 **Windows 系统媒体会话（SMTC）**，控制的是**本机网易云客户端**。
- 歌词与收藏来自 **网易云开放平台 OpenAPI**。

---

## 2. 架构（B1 跟随模式）

```
网易云客户端 ──SMTC──► 常驻 PowerShell 子进程 ──stdout JSON──► 宿主 smtc/poller
                                                              │
        OpenAPI：搜索(标题+歌手→songId) ► 歌词 LRC ► 当前行     │
                                                              ▼
                                    GET /music/state（500/800ms 轮询）
                                                              │
                                              Helper 歌词条 DOM（悬浮显隐 / 锁定常驻）
按钮 ──POST /music/control──► 宿主 ──SMTC 指令──► 客户端
♥ ──POST /music/like──► OpenAPI（需用户 token）
```

**为什么进度靠本地时钟**：实测网易云 Windows 客户端**不上报时间轴**（`Position/End` 恒 0），SMTC 只给曲名/歌手/播放态/控制位。因此进度从"检测到换曲"起本地计时；拖进度条会失准，直到下一首（见 §8 已知缺陷）。

---

## 3. 鉴权：为什么"必须登录"

实测结论（用真实 AppID 反复验证）：

| 事项 | 结论 |
|---|---|
| SMTC 播放信息/控制 | **不需要登录**，直接读本机客户端 |
| 匿名 token（`oauth2/login/anonymous`） | 能取到，但对**搜索/歌词/收藏一律 `301 用户未授权`** |
| 用户 token（扫码登录） | **歌词/搜索/收藏的唯一可行凭证** |

所以：**控制不需要登录；歌词需要登录**。机器上已保存过一次用户 token（`~/.dsh/dsh-pet/music-token.json`），所以在 token 有效期内歌词可用；过期后需重新登录。右键「网易云 → 登录网易云」即为此入口（生成授权链接→系统浏览器登录→轮询拿 token 并落盘）。

**应用凭证**（AppID / AppSecret / PrivateKey）是调 OpenAPI 的必需项，属于"填一次"的配置，不是登录。

---

## 4. 接口（均经实测）

- 网关：`https://openncm.music.163.com`（官方文档示例的 `openapi.music.163.com` 直连返回"公共参数校验失败"，不可用）
- device（实测有效，无需申请）：`deviceType=openapi, os=ncmcli, channel=ncmcli, brand=ncmcli, model=Windows_x64_cli, appVer=0.1.7, osVer=10.0.26300, clientIp=127.0.0.1, deviceId=dshpet_<appId后12位>`

| 用途 | 路径 | 说明 |
|---|---|---|
| 匿名登录 | `/openapi/music/basic/oauth2/login/anonymous` | bizContent `{clientId}`；内容接口仍 301，仅用于换扫码 key |
| 取登录二维码 | `/openapi/music/basic/user/oauth2/qrcodekey/get/v2` | `{type:2, expiredKey:"300"}` → qrCodeUrl + uniKey |
| 轮询扫码 | `/openapi/music/basic/oauth2/device/login/qrcode/get` | `{key, clientId}`；status=803 且 `data.accessToken.accessToken` 为 token（嵌套一层） |
| 搜索歌曲 | `/openapi/music/basic/search/song/get/v3` | `{keyword,limit,offset}` → records[]: id/name/artists/duration/liked/originCoverType/visible |
| 歌词 | `/openapi/music/basic/song/lyric/get/v2` | `{songId}` → lyric(逐行 LRC)/noLyric/pureMusic |
| 红心 | `/openapi/music/basic/playlist/song/like/v2` | `{songId,isLike}` |

**签名**：参数剔除 `sign` 与空值 → key ASCII 升序 → `k=v&` 拼接（值用原始未编码）→ RSA-SHA256(PKCS#1 v1.5) → Base64 → 作为最后一个 query 参数；请求 `POST`，参数全在 query，body 空。

> ⚠️ 踩过的坑：`accessToken` 为空时**不要把 key 放进 params**。`URLSearchParams` 会把 `undefined` 序列化成字面量 `accessToken=undefined`，导致服务端签名校验失败（`1402 非法sign参数`）。

---

## 5. 代码落地（宿主为 TS、Helper 为原生 JS）

```
dsh-pet/src/host/music/
  sign.ts        canonical + RSA 签名
  netease.ts     客户端（匿名/扫码登录、搜索、歌词、红心）
  smtc.ts        常驻 PowerShell 读取器 + 一次性控制命令
  lyrics.ts      LRC 解析 / 当前行 / 三行窗口
  match.ts       标题+歌手 → songId 打分反查（防翻唱误配）
  service.ts     编排：配置、token、进度时钟、曲目缓存、状态快照
dsh-pet/src/host/routes/music.ts         GET /music/state、POST /music/control|like|align、GET /music/login/qr|poll
dsh-pet/src/host/routes/index.ts         注册 handleMusicRoutes
dsh-pet/src/host/routes/types.ts         deps.music
dsh-pet/src/host/index.ts                创建 MusicService 并托管启停
dsh-pet/runtime/electron-helper/
  sprite/music.js   歌词条 DOM（增量更新）、悬浮/锁定、按钮、登录轮询
  sprite/menu.js    右键「网易云」子菜单（放最底）
  sprite/init.js    music 状态位
  preload.js        openMusic / openExternal 桥
  main/ipc.js       pet:open-music（orpheus:// → cloudmusic://）、pet:open-external
  index.html        样式（#fafafa 歌词、SVG 按钮、marquee）
openapi.yaml       /music 六个端点 + Music tag
```

---

## 6. 配置项（已在「桌宠配置」设置页提供卡片）

四项均可在 DSH 的「桌宠配置」设置页里的 **「网易云音乐」** 卡片填写（`src/client/settings/music-card.ts`），随「保存」写入用户层 `~/.dsh/dsh-pet/main-config.jsonc`；也可手改该 JSONC。

| 键 | 说明 |
|---|---|
| `musicEnabled` | 总开关；false 不拉起 SMTC |
| `musicAppId` | 开放平台 AppID |
| `musicAppSecret` | 应用 Secret |
| `musicPrivateKey` | RSA 私钥（PKCS#8，无 PEM 头尾） |

读写链路：设置页 `music-card` → `SaveFields`/`buildSaveBody`（`settings/config/http.ts`）→ 宿主 `PUT /config` 白名单（`host/config/save.ts`）→ `readAllConfig().main` → `MusicService.readConfig()`。
内置默认 `assets/config.jsonc` 里这四项留空/关闭，源码零密钥。

---

## 7. UI 规格（已实现）

- 两行歌词：当前行 16px/600 实色，下一行 12.5px/55% 透明；颜色 `#fafafa` + 深色描边（浅壁纸可读）。
- 超长句：`scrollWidth > clientWidth` 时加 `is-scroll`，`--scroll-dist/--scroll-dur` 由 JS 按实际宽度写入，CSS keyframes 循环滚动。
- 四个按钮：内联 SVG（heart/prev/play/pause/next），深色半透明圆底，hover 上浮、active 回弹；播放键略大；♥ 收藏态变红实心。
- 悬浮显隐：`onMouseMove` 判定光标在身体或控制条上 → `showMusic`，离开 280ms 防抖 `hideMusicSoon`。
- 锁定：右键「歌词锁定」→ 常驻显示不再需 hover；**锁定时按钮栏默认隐藏，光标移到歌词条上才显现**（`pointerenter/leave`）。
- **增量渲染**：结构只建一次（`ensureMusicParts`），轮询只更新文本/图标/类，绝不重建 DOM（避免按钮跳动、点击被轮询打断、连点被吞）。
- 点击后延迟 350ms 再拉状态（等 SMTC 反映），而非立即拉回旧值。

---

## 8. 当前在处理 / 未解决

**正在进行**
- 设置页「网易云音乐」密钥卡片：代码已完成（卡片 + 读写链路），**待你重启 DSH 后确认设置页能正常渲染并保存**。

**已解决（本轮）**
- `1402 非法sign参数`：`request()` 里 `accessToken: undefined` 被 `URLSearchParams` 序列化成 `accessToken=undefined`，污染签名。已改为 token 存在才放入参数。
- 上/下一首按钮只剩黑圆：增量渲染改造时漏给 `prev`/`next` 赋 SVG 图标，已在建按钮时统一给图标。

**未解决 / 待办**
1. **进度漂移**：客户端不报时间轴，启动晚于歌曲或拖动进度条后歌词失准，直到下一首。`/music/align` 接口已留，**手动对齐 UI 未做**。
2. **收藏（♥）未实测写入**：`like/v2` 是写账号操作，未擅自点过；收藏状态回显依赖搜索返回的 `liked`。
3. **歌词读取依赖登录 token**：匿名 token 对搜索/歌词一律 301，token 过期（约 1 天）后需重新扫码登录；目前无"token 即将过期"提示。
4. **反查可能误配**：同名/翻唱多，`match.ts` 打分兜底，低分宁可不显示歌词。
5. **设置页文案未做多语言**：音乐卡用固定中文（避免为它改 8 种语言的键集）；若要随宿主语言切换需补 locales。

## 8.1 为什么 PC 上不用 CMAPI（澄清）

官方另一套能力 **CMAPI**（`docId=3fadf631d7fb4c98a4be386bdcb5c6cd`，含 `CMD_GET_COMPLETE_LYRIC` 取歌词、`CMD_START_PROGRESS_LISTEN` 监听进度、`CMAPI_PLAY_CONTROLLER` 播控）是 **Android/iOS 的 AIDL/Binder 接口**，需要 `channel` 参数与商务申请，**Windows 桌面客户端不提供**。因此 PC 只能用 SMTC（控制/元数据，无进度）+ OpenAPI（歌词/收藏）。

---

## 9. 验证要点

- 宿主：`npm run typecheck`、`npm run build`（产物不得含 `@oxc-project/runtime`，见下）。
- Helper：`node --check`、`npm run check:runtime`、prettier。
- 真机：悬浮出两行歌词+四按钮；点击下一首一次切一首；锁定后仅歌词、悬停出按钮；右键登录能打开授权页。

> 构建坑：宿主入口 `tsdown` 的 `target` 必须是 `es2022`。`es2020` 会把 class field 降级成 `_defineProperty`，产物留下 `@oxc-project/runtime` 裸 import，插件装进 profile 后 DSH 加载即 `ERR_MODULE_NOT_FOUND`。

---

## 10. 合并主分支更新的指引（给未来的你 / 给 agent）

> 本仓库是上游 `dsh-pet` 的二次开发分支，新增了「网易云音乐控制条」。上游更新时**不要整份覆盖我们的文件**——下面按「文件性质」给出处理策略。判定"这是不是网易云的"只需认准本节的清单。

### 10.1 一眼识别：哪些是我们的

**A. 纯新增文件（上游不会有 → 合并时直接保留，冲突概率≈0）**

| 文件 | 作用 |
|---|---|
| `dsh-pet/src/host/music/`（sign / netease / smtc / lyrics / match / service / music.test） | 宿主侧音乐能力全部实现 |
| `dsh-pet/src/host/routes/music.ts` | `/music/*` 路由处理器 |
| `dsh-pet/runtime/electron-helper/sprite/music.js` | 桌面歌词条 UI + 逻辑 |
| `dsh-pet/src/client/settings/music-card.ts` | 设置页「网易云音乐」卡 |
| `MUSIC-CONTROL-SPEC.md` | 本文档 |

**B. 改动了既有文件（**合并冲突高发区**，按下方 10.2 的"插入点"逐条重放）**

| 文件 | 我们加了什么 | 合并策略 |
|---|---|---|
| `tsdown.config.mjs` | 宿主入口那份 `target: 'es2022'`（**关键**，见 9 的构建坑） | **必须保住 es2022**；上游若改回 es2020，取其内容但把 `target` 改回 `es2022` |
| `dsh-pet/assets/config.jsonc` | 文件顶部 4 个 `music*` 键 | 上游版本上重新加这 4 键（见 10.2） |
| `dsh-pet/src/host/index.ts` | 引入并创建 `MusicService`、`ctx.effect` 启停、`deps.music` | 重放 3 处（见 10.2） |
| `dsh-pet/src/host/routes/index.ts` | import + HANDLERS 里加 `handleMusicRoutes` | 重放（保持素材兜底在最后） |
| `dsh-pet/src/host/routes/types.ts` | `PetRouteDeps.music` 字段 + import | 重放 |
| `dsh-pet/src/host/config/save.ts` | 4 个 `music*` 字段的校验/白名单/bodyOwned | 重放（见 10.2） |
| `openapi.yaml` | `Music` tag + 6 条 `/dsh-pet-7340/music/*` 路径 | 重放（否则 `check:openapi` 失败） |
| `dsh-pet/src/client/settings.ts` | import/状态/applyConfig/write.fields/渲染 MusicCard | 重放 5 处 |
| `dsh-pet/src/client/settings/config/http.ts` | `SaveFields` 4 字段 + `buildSaveBody` 4 字段 | 重放 |
| `dsh-pet/src/client/settings/config/read.ts` | `MainConfigPatch` 4 字段 + `readMainConfig` 读取 | 重放 |
| `dsh-pet/src/client/settings/config/http.test.ts` | buildSaveBody 测试补 4 键 | 重放（否则单测挂） |
| `dsh-pet/runtime/electron-helper/index.html` | `sprite/music.js` 的 `<script>` + 一大段 `.pet-music*` CSS | 重放（见 10.2） |
| `dsh-pet/runtime/electron-helper/sprite.js` | `MUSIC_BAR_H` 常量 + `margin.b` 预留高度 | 重放（见 10.2） |
| `dsh-pet/runtime/electron-helper/sprite/init.js` | `initPanels` 里 music 状态位 + `buildDom` 里 `musicEl` | 重放（见 10.2） |
| `dsh-pet/runtime/electron-helper/sprite/input.js` | `inputBusy` 加 `musicOn`；`syncInputRegions` 选择器加 `.pet-music.is-open`；`onMouseMove` 里音乐条显隐 | 重放 3 处（见 10.2） |
| `dsh-pet/runtime/electron-helper/sprite/menu.js` | 右键「网易云」子菜单（放 tail 末尾）+ `music-lock/login/open` 三个动作分支 | 重放（见 10.2） |
| `dsh-pet/runtime/electron-helper/preload.js` | `openMusic()` / `openExternal(url)` 桥 | 重放 |
| `dsh-pet/runtime/electron-helper/main/ipc.js` | `pet:open-music` / `pet:open-external` 处理器 | 重放 |
| `.gitignore` | 忽略 `music163-key.md` | 重放（防私钥泄漏） |

### 10.2 插入点锚点（重放用；合并后逐条核对）

- `assets/config.jsonc`：在顶层 `{` 之后加 `musicEnabled/musicAppId/musicAppSecret/musicPrivateKey`（默认 false/空）。
- `host/index.ts`：① import `MusicService`；② `const music = new MusicService({...}); music.start(); ctx.effect(() => () => music.stop(), 'dsh-pet: music service');`（放在 `todos` 之后）；③ `deps` 对象里加 `music`。
- `host/config/save.ts`：在 `chatImageLimit` 校验后加 `musicEnabled`(boolean) 与三个字符串字段（`undefined/null` 透传，非字符串返回 null）；`outConfig` 与 `bodyOwned` 各补这几项。
- `routes/index.ts`：`import { handleMusicRoutes } from './music.ts'`；HANDLERS 数组里放在 `handlePlaybackRoutes` 前后均可，**必须在 `handleAssetsRoutes` 之前**。
- `openapi.yaml`：顶层 `tags` 加 `- name: Music`；`paths:` 下加 6 条 `/dsh-pet-7340/music/*`（state/control/like/align/login/qr/login/poll）。
- `sprite.js`：文件顶加 `const MUSIC_BAR_H = 118;`；`this.margin.b` 改为 `Math.max(m, MUSIC_BAR_H * (this.size / 462))`。
- `sprite/init.js`：`initPanels()` 末尾加 `musicOn/musicHideTimer/musicState/musicTimer/musicBarHover/musicLocked`；`buildDom()` 里 `stage` 前建 `this.musicEl`（`class="pet-music"`）并 append 到 `this.el`。
- `sprite/input.js`：`inputBusy()` 的 return 里加 `|| this.musicOn`；`syncInputRegions()` 的 `querySelectorAll` 选择器末尾加 `, .pet-music.is-open`；`onMouseMove()` 在 `this.setTip(inBody)` 之后加"在身体或条上→`showMusic`，否则`hideMusicSoon`"。
- `sprite/menu.js`：`tail` 数组末尾加 `{ label:'网易云', children:[歌词锁定/login/open] }`；`onMenuAction` 里加 `music-lock` / `music-login` / `music-open` 三个分支。
- `index.html`：`<script src="./sprite/input.js">` 之后插入 `<script src="./sprite/music.js">`；CSS 在 `.pet-bubble.is-on.is-fading` 之后插入 `.pet-music*` 规则块。
- `settings.ts`：`import { makeMusicCard }`；`const MusicCard = makeMusicCard(rt)`；4 个 useState；`applyConfig` 里 4 个 `setMusic*`；`write.fields` 里 4 个键；渲染处 `h(MusicCard, {...})`（放在 MobileCard 之后）。

### 10.3 冲突处理原则

1. **B 类文件若上游也改了同一处**：先接受上游版本，再按 10.2 的锚点把我们的插入重新加回去，**不要保留整块旧文件**。
2. **只删不加的失败**：合并完必须能过 `npm run typecheck && npm run lint && npm run check:openapi && npm test && npm run build`；任何一条红都说明漏重放了某处。
3. **`tsdown.config.mjs` 的 `es2022` 是硬要求**：丢了它，装进 DSH 会 `ERR_MODULE_NOT_FOUND @oxc-project/runtime`（这是构建期降级辅助，不是运行依赖）。
4. **私有文件不要提交**：`music163-key.md`（已 gitignore）、`dsh-pet/package-lock.json`（npm 生成，与上游 pnpm 体系可能冲突，视需要提交或忽略）。

### 10.4 合并后自检清单

- [ ] `grep -r "handleMusicRoutes\|MusicService\|makeMusicCard\|pet-music" dsh-pet/src dsh-pet/runtime` 命中数不低于合并前
- [ ] `lib/index.js` 无 `@oxc-project/runtime`
- [ ] `npm run build` 成功；`lib/client.js` 含「网易云音乐」
- [ ] 装进 DSH 后：悬浮出歌词+四按钮；右键有「网易云」；设置页有音乐卡

---

## 11. 从 git 拉取更新后，如何更新到插件里

profile 里 `dsh-pet` 是 **Junction 软链**（`~/.dsh/profiles/desktop/node_modules/dsh-pet` → 本仓库 `dsh-pet/dsh-pet`），**改源码即改插件，不需要重新导入/重装**。

标准流程（在本仓库根）：

```sh
git pull                     # 或合并主分支
cd dsh-pet/dsh-pet
npm install                  # 依赖可能变；Junction 下插件用自己这份 node_modules
npm run build                # 必须：生成 lib/（宿主 TS、client bundle、shared-core、类型）
# —— 若改了 tsdown.config.mjs，务必确认宿主入口 target 仍是 es2022 ——
```

然后 **重启 DSH 桌面应用**（Helper 是 DSH 启动时 spawn 的独立 Electron 进程，runtime/ 改动只有重启才重载；宿主 lib 也需要重启才重新 import）。

- **只改 `runtime/**`（Helper 原生 JS）**：不必 `npm run build`，重启 DSH 即可。
- **改 `src/**`（宿主 TS / 设置页）**：必须 `npm run build`，再重启。
- **改了 `package.json` 依赖**：`npm install` 后仍需 `npm run build` + 重启；若 DSH 插件管理器管着 profile 依赖，必要时在设置页重装一次。
- **不需要**卸载/重新导入插件（Junction 生效）。
- 验证：见 §9 与 §10.4。

---

## 12. 日常同步上游 + 自己留档（Git 工作流）

**远程布局**（本仓库已按此配置）：
- `origin` → `https://github.com/PC2005-cloud/dsh-pet.git`（**作者上游**，只用来拉更新）
- `mine` → `https://github.com/hggCode/dsh-pet-music163.git`（**自己的留档仓库**，只用来 push）
- 自己的改动都在分支 **`feat/netease-music`**；`main` 始终保持与上游一致（纯镜像），这样拉上游永远快进、无冲突。

**留档 / 备份自己的进度**
```sh
git switch feat/netease-music
git push mine feat/netease-music
```

**每次同步作者更新（标准循环）**
```sh
git switch main
git pull origin main                 # main 只跟上游 → 永远快进，不产生冲突
git switch feat/netease-music
git merge main                        # 在这条分支上吸收上游；冲突按 §10 清单处理
# 处理完冲突后跑门禁（§9），然后：
git push mine feat/netease-music      # 把合并结果留档
cd dsh-pet/dsh-pet && npm install && npm run build   # 见 §11，再重启 DSH
```

**要点**
- 冲突只会在 `git merge main` 这一步出现；`git pull origin main` 因为 `main` 未被改动，永远是快进。
- 合并冲突的判定与重放锚点见 **§10**：先接受上游版本，再按 §10.2 的插入点把「网易云相关」改动加回，别整份覆盖。
- `mine` 仓库**不必**与上游是 Fork 关系（`origin` 直接指作者仓库即可拉更新）；网页 Fork 只影响能否发 PR。
- 私钥 `music163-key.md`、`dsh-pet/package-lock.json` 已 gitignore，不会入库/推送。
- 首次 push 需要 GitHub 凭据（HTTPS + 凭据管理器或 PAT；本机未装 `gh`）。
