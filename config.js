// ===== 门店互动屏配置：改这里就能换店名、台词、奖品 =====
window.APP_CONFIG = {
  storeName: "红颜茶楼",
  slogan: "走近一点，和我猜个拳吧！",

  // 进入画面多久算“有人来了”（毫秒），人离开多久回到待机
  presenceMs: 800,
  leaveMs: 4000,
  // 同一轮玩完后的冷却时间，避免同一个人反复刷奖品
  cooldownMs: 20000,
  // 人脸框至少占画面宽度的比例（越大 = 要越靠近才触发）
  minFaceWidth: 0.12,

  lines: {
    welcome: ["欢迎光临红颜茶楼！", "客官里边请～", "好久不见，今天想喝点什么？"],
    invite: "举起手，跟我猜拳赢小礼品！",
    win: "哇，你赢了！",
    lose: "哈哈，我赢啦！送你一个安慰奖～",
    draw: "平手！再来一次！",
    noHand: "没看到你的手哦，再来一次～",
    bye: "欢迎下次再来！",
  },

  // 奖品池：weight 是抽中权重，stock 是每天库存（null = 不限）
  prizes: [
    { name: "免费柠檬茶一杯", weight: 1, stock: 10, emoji: "🍋" },
    { name: "小吃券 RM5", weight: 3, stock: 30, emoji: "🥟" },
    { name: "店铺贴纸", weight: 6, stock: null, emoji: "🌸" },
  ],
  consolation: { name: "9折优惠券", emoji: "🎟️" },

  // 可选：换成你自己的 AI 角色视频（竖屏 mp4，放在 assets/ 里）。留空则用内置卡通角色。
  videos: {
    idle: "",   // 待机循环
    wave: "",   // 挥手欢迎
    happy: "",  // 顾客赢
    sad: "",    // 顾客输
  },

  // MediaPipe 模型地址。国内网络请把文件下载到 models/ 并改成本地路径（见 README）
  mediapipe: {
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    face: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
    gesture: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
  },
};
