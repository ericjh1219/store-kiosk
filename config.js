// ===== 全局默认设置（所有餐厅共用）=====
// 每家餐厅自己的店名、语言、台词、奖品放在 stores/<店铺ID>.json
// 设备打开 https://.../store-kiosk/?store=<店铺ID> 就会加载那家店
window.APP_CONFIG = {
  defaultStore: "demo",

  // Supabase 后端（见 README「后台」）。url 留空 = 不用后端，直接读 stores/*.json（无核销、无统计）
  // key 填 Publishable key（anon key），它本来就是公开的，可以放在网页里
  backend: { url: "https://rvvwlbidsompjjrtywcd.supabase.co", key: "sb_publishable_PQ2gwEFWyTsBFrcZPljSqg_jNZUTVAy" },
  // 互动屏多久重新拉一次店铺设置（后台改了设置会自动生效）
  refreshMs: 5 * 60 * 1000,

  // 进入画面多久算“有人来了”（毫秒），人离开多久回到待机
  presenceMs: 800,
  leaveMs: 4000,
  // 同一轮玩完后的冷却时间，避免同一个人反复刷奖品
  cooldownMs: 20000,
  // 没认出手会一直重新问；连续这么多次都没认出才结束（人走了也是这样结束，约 5 秒一次）
  maxMisses: 5,
  // 人脸框至少占画面宽度的比例（越大 = 要越靠近才触发）
  minFaceWidth: 0.12,
  // 招揽：远处有人走过（人形框至少占画面高度这个比例，太远的路人不算），
  // 位置在 1 秒内移动超过画面这个比例才算「走过」（坐着吃饭的客人不会一直触发）
  attractMinHeight: 0.15,
  attractMove: 0.06,

  // 语音朗读用的语言代码（店铺 JSON 里可用 "tts" 覆盖）
  tts: { zh: "zh-CN", en: "en-GB" },

  // 界面固定文字
  ui: {
    zh: { start: "点击启动互动屏", fullscreen: "全屏", lock: "锁定", lockTip: "已锁定 🔒 要解锁：按住左上角 3 秒", fsTip: "iPad / iPhone：用 Safari 打开，点「分享 → 添加到主屏幕」，从主屏幕打开就是全屏", loading: "加载中…", startFail: "启动失败（需 HTTPS + 摄像头权限）：",
          you: "你", me: "我", countdown: ["石头", "剪刀", "布！"], claim: "请截图或出示此画面给店员领取", again: "点我再玩一次",
          photoAsk: "要不要和我拍张合照？", photoYes: "📸 拍合照", photoNo: "不用了", photoLook: "看镜头！",
          photoScan: "用手机扫码保存照片（24 小时后自动删除）", photoFail: "照片没上传成功，可以直接用手机拍屏幕哦", done: "完成", closeIn: "{n} 秒后自动关闭",
          attract: "嘿～进来坐坐吧！和我猜拳赢小礼品！", photoScanJoin: "扫码加入我们的 WhatsApp 社群，领取照片（24 小时内有效）" },
    en: { start: "Tap to start", fullscreen: "Full screen", lock: "Lock", lockTip: "Locked 🔒 To unlock, hold the top-left corner for 3 seconds", fsTip: "iPad / iPhone: open in Safari, tap Share → Add to Home Screen, then open it from the Home Screen", loading: "Loading…", startFail: "Failed to start (needs HTTPS + camera): ",
          you: "You", me: "Me", countdown: ["Rock", "Paper", "Scissors!"], claim: "Show this screen to our staff to claim", again: "Press me",
          photoAsk: "Want a photo with me?", photoYes: "📸 Take a photo", photoNo: "No thanks", photoLook: "Look at the camera!",
          photoScan: "Scan to save your photo (deleted after 24 hours)", photoFail: "Upload failed — just snap the screen with your phone!", done: "Done", closeIn: "Closing in {n}s",
          attract: "Hey there! Come on in and win a gift!", photoScanJoin: "Scan to join our WhatsApp community and get your photo (valid 24 hours)" },
  },

  // MediaPipe 模型地址（可改成本地路径，见 README）
  mediapipe: {
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    face: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
    gesture: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
    person: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
  },
};
