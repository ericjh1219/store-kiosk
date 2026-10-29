# 门店互动屏（Android 闺蜜机 Web App，多商家版）

顾客走近 → 摄像头检测到人脸 → 角色挥手语音欢迎 → 举手猜拳（手势识别）→ 赢了抽奖品 / 输了送安慰券 → 人离开后回到待机。

一套系统可以租给多家餐厅：每家店一个设置文件、一个专属网址，店名、语言、台词、奖品、颜色、角色动画都可以不一样。

线上网址：https://ericjh1219.github.io/store-kiosk/?store=<店铺ID>

## 文件
- `stores/<店铺ID>.json` —— **每家餐厅的设置**（店名、语言、台词、奖品、颜色、角色）
- `assets/` —— 角色视频 / 动图
- `config.js` —— 所有店共用的设置（触发距离、冷却时间、界面文字、模型地址）
- `app.js` —— 互动屏流程逻辑（MediaPipe 人脸检测 + 手势识别，全部在设备本地运行，不上传画面）
- `admin.html` / `admin.js` —— 商家后台
- `supabase/migrations/` —— 后端数据库结构和权限

## 新增一家餐厅
1. 复制 `stores/demo.json`（中英双语）或 `stores/kopitiam-en.json`（只有英文），改名为 `stores/<店铺ID>.json`，例如 `stores/ahmad-nasi-kandar.json`。
2. 修改里面的内容：
   - `languages`：`["zh", "en"]` 中英双语，默认中文，顾客可以点右上角切换；`["en", "zh"]` 默认英文；`["en"]` 只有英文。
   - `storeName` / `lines` / `prizes`：每种语言写一份。
   - `theme`：招牌和文字颜色。
3. 推送到 GitHub，大约 1 分钟后，在店里的设备上打开 `https://ericjh1219.github.io/store-kiosk/?store=ahmad-nasi-kandar`。

## 更换角色动画
`character` 有两种用法：
- **内置卡通角色换颜色**：改 `character.skin`（outfit 衣服、outfitDark、hair 头发、skin 肤色）。
- **商家自己的角色**：把 4 段竖屏素材放进 `assets/`，填到 `character.media`：
  ```json
  "media": { "idle": "assets/ahmad/idle.mp4", "wave": "assets/ahmad/wave.mp4",
             "happy": "assets/ahmad/happy.mp4", "sad": "assets/ahmad/sad.mp4" }
  ```
  支持 mp4 / webm 视频，或 gif / webp 动图。只填 `idle` 也可以，其他状态会沿用它。
  有素材时角色会**全屏播放**（铺满屏幕，不显示店名招牌），建议做成 1080×1920 竖屏、带背景的视频。
  视频里的声音会一起播放（点了「启动」之后浏览器才允许出声）。
  素材可以用数字人或 AI 视频工具生成，建议单个文件小于 10MB。

## 放到闺蜜机上
1. 设备安装 **Fully Kiosk Browser**，起始网址设为该店的专属网址。
2. 设置开机自动启动、全屏锁定、允许摄像头、允许自动播放声音、屏幕常亮。（直接用 Chrome 的话，点左下角「全屏」隐藏网址栏。）
3. 屏幕竖放，前置摄像头朝向门口人流。
4. 用 iPad 的话：用 **Safari** 打开专属网址 → 点「分享」→「添加到主屏幕」，以后从主屏幕的图标打开，就没有网址栏。再到「设置 → Safari → 相机」选「允许」，就不会每次都问相机权限。可以用「引导式访问」锁定在这个画面。
5. 点左上角「锁定」：收起按钮、点任何地方都回到全屏、「返回」手势和双指缩放没作用，防止小朋友乱按跳出去。**按住左上角 3 秒解锁**。网页挡不住回主画面，要完全锁住请配合 iPad「引导式访问」或安卓「屏幕固定」。
6. 连点店名 5 次可以显示摄像头调试画面（全屏视频时店名隐藏，连点屏幕最上方中间）。

## 本机测试
```
python3 -m http.server 8765
```
打开 http://localhost:8765/?store=demo

## 商家后台（Supabase）
后台网址：https://ericjh1219.github.io/store-kiosk/admin.html

| 角色 | 能做什么 |
|---|---|
| 平台管理员（你） | 新增店铺、设置租赁到期日 / 停用、开通加购配套（AI 合照 + 每日上限）、管理所有店铺 |
| 店主 Owner | 改店铺设置（台词、奖品、颜色、上传角色动画）、拿设备链接、管理员工 |
| 员工 Staff | 核销领奖码、看数据 |

- **领奖码**由服务器生成，需要设备密钥才能发奖，顾客无法伪造；后台可查重复领取和过期（默认 7 天）。
- **每日库存**由服务器计算（马来西亚时间），多台设备共用。
- **数据**：每天到访人数、参与猜拳、赢/输、发出与核销的领奖码。
- **租赁到期**或停用后，互动屏自动显示「暂停服务」；续费后改日期即可恢复。
- 后台改设置后，互动屏 **5 分钟内**自动更新，不用碰设备。
- **声音**：「设置 → 声音」可以分别设背景音乐（待机）、游戏音乐（猜拳时）和赢了 / 输了 / 平手 / 拍照的音效，每一项可以「选模版」或上传自己的音频，也可以「一键套用」整套；音乐和音效音量分开调。玩的时候音乐自动调小一半。模版在 `sounds/`，是 `tools/make_sounds.py` 合成的原创声音。
- **合照**：玩完后角色会问要不要合照，顾客点「拍合照」才会拍。照片加上角色、店名和日期，屏幕显示二维码，顾客扫码保存。照片存在数据库，**24 小时后自动删除**。店主可以在「设置」里关掉。

### 第一次设置（约 15 分钟）
1. 到 supabase.com 注册并新建项目，地区选 **Southeast Asia (Singapore)**。
2. 建表：在终端运行
   ```
   supabase login
   supabase link --project-ref <你的项目ref>
   supabase db push
   ```
   （或者把 `supabase/migrations/` 里的 SQL **按文件名顺序**整个贴到 Supabase 的 SQL Editor 执行。）
3. 在 SQL Editor 把自己设为平台管理员（邮箱用小写）：
   ```sql
   insert into public.staff (email, store_id, role) values ('你的邮箱@gmail.com', null, 'owner');
   ```
4. 在 Supabase → Project Settings → API 复制 **Project URL** 和 **Publishable key（anon）**，填进 `config.js` 的 `backend`，然后推送到 GitHub。
5. 在 Supabase → Authentication → URL Configuration，把 Site URL 设为 `https://ericjh1219.github.io/store-kiosk/admin.html`（注册确认、重设密码的邮件链接会跳回这里）。
6. 打开后台，用第 3 步的邮箱「注册」，然后登录，在「平台」里新增店铺并填店主邮箱。店主用这个邮箱注册后就能管理自己的店。
7. 在「设备」页复制链接（或扫码），设为闺蜜机 Fully Kiosk Browser 的起始网址。

> `config.js` 里的 Publishable key 本来就是公开的，可以放在网页里；**不要**把 secret / service_role key 放进任何网页文件。

### 本机开发测试
需要 Docker：
```
supabase start
python3 -m http.server 8765
```
然后打开 http://localhost:8765/admin.html 。`config.local.js`（不会上传）会让本机页面连到本地后端。测试账号见 `supabase/seed.sql`。

## 注意
- 摄像头只做本地检测、不存储画面。建议在店门口贴「本设备使用摄像头互动」的告示（PDPA）。
- 没有填 `backend` 时，系统会退回读取 `stores/*.json`：这种模式下没有核销、没有统计，库存只记在设备本机。
- 后端暂时连不上时，互动屏继续用本机抽奖；这种情况下发出的码无法在后台核销。
