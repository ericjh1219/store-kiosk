# 门店互动屏（Android 闺蜜机 Web App，多商家版）

顾客走近 → 摄像头检测到人脸 → 角色挥手语音欢迎 → 举手猜拳（手势识别）→ 赢了抽奖品 / 输了送安慰券 → 人离开后回到待机。

一套系统可以租给多家餐厅：每家店一个设置文件、一个专属网址，店名、语言、台词、奖品、颜色、角色动画都可以不一样。

线上网址：https://ericjh1219.github.io/store-kiosk/?store=<店铺ID>

## 文件
- `stores/<店铺ID>.json` —— **每家餐厅的设置**（店名、语言、台词、奖品、颜色、角色）
- `assets/` —— 角色视频 / 动图
- `config.js` —— 所有店共用的设置（触发距离、冷却时间、界面文字、模型地址）
- `app.js` —— 流程逻辑（MediaPipe 人脸检测 + 手势识别，全部在设备本地运行，不上传画面）

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
  素材可以用数字人或 AI 视频工具生成，建议单个文件小于 10MB。

## 放到闺蜜机上
1. 设备安装 **Fully Kiosk Browser**，起始网址设为该店的专属网址。
2. 设置开机自动启动、全屏锁定、允许摄像头、允许自动播放声音、屏幕常亮。
3. 屏幕竖放，前置摄像头朝向门口人流。
4. 连点店名 5 次可以显示摄像头调试画面。

## 本机测试
```
python3 -m http.server 8765
```
打开 http://localhost:8765/?store=demo

## 注意
- 奖品库存记录在每台设备的浏览器里，按店铺分开，每天自动重置。如果要防止重复领奖、在后台看数据、远程改设置，需要加一个后端和商家管理后台。
- 摄像头只做本地检测、不存储画面。建议在店门口贴「本设备使用摄像头互动」的告示（PDPA）。
