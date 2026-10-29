import { FilesetResolver, FaceDetector, GestureRecognizer }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const C = window.APP_CONFIG;
const $ = (id) => document.getElementById(id);
const stage = $("stage"), cam = $("cam"), bubble = $("bubble"), hint = $("hint");
const ICON = { rock: "✊", scissors: "✌️", paper: "✋" };
const GESTURE_TO_MOVE = { Closed_Fist: "rock", Victory: "scissors", Open_Palm: "paper" };
const BEATS = { rock: "scissors", scissors: "paper", paper: "rock" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

let S;                         // 当前店铺配置（stores/<id>.json）
let storeId, lang;
let faceDetector, gestureRecognizer;
let state = "idle";            // idle | busy
let presentSince = 0, lastSeen = 0, cooldownUntil = 0;
let videoSound = false;         // 点了启动后角色视频才出声（后台可以关掉某段的原声）
let needLeave = false;          // 刚玩过的人还在镜头前：不自动再开，点角色才再玩
let gestureSeen = null;       // 出拳窗口内每帧认出的手势（按顺序）
let tapMove = null;            // 触屏出拳（识别失败时的备用）
const mediaCache = {};        // 角色素材：网址 → 已下载的 blob 网址（下载完之前先直接用原网址）
// 声音：先建好 Web Audio（静音状态），点了「启动」才开始出声
const actx = (window.AudioContext || window.webkitAudioContext) ? new (window.AudioContext || window.webkitAudioContext)() : null;
const musicBus = actx?.createGain(), sfxBus = actx?.createGain();
musicBus?.connect(actx.destination); sfxBus?.connect(actx.destination);
const soundCache = {};        // 网址 → 解码好的声音
let soundOn = false, music = null;   // music：正在放的曲子 { src, node, fade }

// ---------- 语言 ----------
const T = () => S.lines[lang];                      // 店铺台词
const U = () => C.ui[lang];                         // 界面固定文字
const tr = (v) => (typeof v === "string" ? v : v[lang] ?? Object.values(v)[0]); // {zh, en} → 当前语言

function setLang(l) {
  lang = l;
  document.documentElement.lang = l;
  $("storeName").textContent = tr(S.storeName);
  $("youLabel").textContent = U().you;
  $("meLabel").textContent = U().me;
  $("claimText").textContent = U().claim;
  $("fsText").textContent = U().fullscreen;
  $("lockText").textContent = U().lock;
  const sb = $("startBtn"); if (sb && !sb.dataset.busy) sb.textContent = U().start;
  if (state === "idle") idleHint();
  const next = S.languages[(S.languages.indexOf(l) + 1) % S.languages.length];
  $("langBtn").textContent = next === "zh" ? "中文" : "English";
  $("langBtn").hidden = S.languages.length < 2;
}
$("langBtn").onclick = () => setLang(S.languages[(S.languages.indexOf(lang) + 1) % S.languages.length]);

// 全屏：没全屏时左上角显示「全屏」按钮（摄像头授权弹窗、返回键、重新载入都会退出全屏）
// 旧版安卓浏览器 / iPad Safari 只有 webkit 开头的写法；iPhone 和 iPad 上的 Chrome 不能网页全屏，改为提示「添加到主屏幕」
const root = document.documentElement;
const canFull = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;   // 从主屏幕打开，本来就没有网址栏
function goFull() {
  try { (root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: "hide" })?.catch?.(() => {}); } catch {}
}
const fsSync = () => {
  $("fsBtn").hidden = standalone || !(canFull || isIOS) || !!(document.fullscreenElement || document.webkitFullscreenElement);
};
$("fsBtn").onclick = () => (canFull ? goFull() : tip(U().fsTip));
document.addEventListener("fullscreenchange", fsSync); document.addEventListener("webkitfullscreenchange", fsSync); fsSync();

// 待机时在气泡里显示一下说明
function tip(text) {
  bubble.textContent = text; bubble.classList.remove("hidden");
  setTimeout(() => state === "idle" && bubble.classList.add("hidden"), 6000);
}

// 锁定：防止小朋友乱按跳出去。锁定后左上角按钮收起来、点任何地方都会回到全屏、「返回」手势留在本页；按住左上角 3 秒解锁
// （网页没办法挡住回主画面：要完全锁住，iPad 用「引导式访问」，安卓用「屏幕固定」或 Fully Kiosk）
let locked = false;
function setLocked(on) {
  locked = on;
  try { on ? localStorage.setItem("kioskLocked", "1") : localStorage.removeItem("kioskLocked"); } catch {}
  $("corner").hidden = on; $("unlockZone").hidden = !on;
  if (on) { history.pushState({ locked: 1 }, ""); goFull(); }
}
$("lockBtn").onclick = () => { setLocked(true); if (state === "idle") tip(U().lockTip); };
addEventListener("popstate", () => { if (locked) history.pushState({ locked: 1 }, ""); });
document.addEventListener("pointerdown", () => {
  if (locked && canFull && !(document.fullscreenElement || document.webkitFullscreenElement)) goFull();
}, true);
let holdTimer;
$("unlockZone").addEventListener("pointerdown", () => {
  const z = $("unlockZone"); let n = 3;
  z.textContent = "🔓 " + n;
  holdTimer = setInterval(() => { if (--n > 0) z.textContent = "🔓 " + n; else { clearInterval(holdTimer); z.textContent = ""; setLocked(false); } }, 1000);
});
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
  $("unlockZone").addEventListener(ev, () => { clearInterval(holdTimer); $("unlockZone").textContent = ""; });
}
// 不能双指缩放、不能长按弹出菜单（iPad Safari 不理会 user-scalable=no）
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("contextmenu", (e) => e.preventDefault());
try { if (localStorage.getItem("kioskLocked")) setLocked(true); } catch {}

// ---------- 后端（Supabase） ----------
const params = new URLSearchParams(location.search);
const deviceKey = params.get("key") || "";
const preview = params.get("preview") === "1";   // 后台「预览互动屏」打开的：不计入数据，领奖码只是示范
if (preview) stage.append(Object.assign(document.createElement("div"), { id: "previewTag", textContent: "预览 Preview · 不计数据、领奖码无效" }));
const backendOn = !!(C.backend?.url && C.backend?.key);

async function rpc(fn, body) {
  const res = await fetch(`${C.backend.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: C.backend.key, Authorization: `Bearer ${C.backend.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function logEvent(type) {
  if (backendOn && !preview) rpc("kiosk_event", { p_store: storeId, p_key: deviceKey, p_type: type }).catch(console.warn);
}

function showBlocked(msg) {
  document.body.innerHTML = `<div style="height:100vh;display:grid;place-items:center;text-align:center;font-size:4vh;padding:4vw">${msg}</div>`;
}

// ---------- 加载店铺 ----------
async function fetchStore() {
  if (backendOn) {
    const r = await rpc("kiosk_config", { p_store: storeId });
    if (!r) return { missing: true };
    return { cfg: r.config, active: r.active };
  }
  const res = await fetch(`stores/${encodeURIComponent(storeId)}.json`, { cache: "no-cache" });
  return res.ok ? { cfg: await res.json(), active: true } : { missing: true };
}

async function keyValid() {
  try { await rpc("kiosk_check", { p_store: storeId, p_key: deviceKey }); return true; }
  catch (e) { return !/invalid device key/.test(e.message); }  // 断网不算无效
}

async function loadStore() {
  storeId = params.get("store") || C.defaultStore;
  let r;
  try { r = await fetchStore(); } catch (e) { r = { error: e }; }
  if (r.missing || r.error) {
    showBlocked(`找不到店铺 / Store not found: ${storeId}`);
    throw r.error || new Error("store not found");
  }
  if (!r.active) {
    showBlocked("暂停服务<br>Service paused");
    throw new Error("store inactive");
  }
  // 有后端时必须带正确的设备密钥，否则发出的领奖码无法核销
  if (backendOn && !(await keyValid())) {
    showBlocked("设备链接无效，请在后台重新复制链接<br>Invalid device link — copy it again from the admin page");
    throw new Error("invalid device key");
  }
  applyStore(r.cfg);
}

// 定时拉取最新设置；只在待机时套用，避免打断正在玩的顾客
setInterval(async () => {
  if (state !== "idle") return;
  try {
    const r = await fetchStore();
    if (r.missing || !r.active || (backendOn && !(await keyValid()))) return location.reload();
    if (JSON.stringify(r.cfg) !== rawCfg) { applyStore(r.cfg); toIdle(); }
  } catch (e) { console.warn("refresh failed", e); }  // 断网时继续用旧设置
}, C.refreshMs);

let rawCfg = "";
function applyStore(cfg) {
  rawCfg = JSON.stringify(cfg);
  S = structuredClone(cfg);
  S.languages ||= Object.keys(S.lines);
  for (const [k, v] of Object.entries(S.theme || {})) document.documentElement.style.setProperty("--" + k, v);
  applySkin();
  preloadMedia();
  preloadSounds();
  syncMusic();
  playVideo("idle");
  setLang(S.languages[0]);
  document.title = tr(S.storeName);
}
await loadStore();
$("startBtn").onclick = start;

async function start() {
  const sb = $("startBtn");
  sb.dataset.busy = 1; sb.textContent = U().loading;
  try {
    goFull();
    videoSound = true;   // 点了启动之后浏览器才允许有声音播放
    $("charVideo").muted = !!S.character?.mute?.[$("charVideo").dataset.key];
    startSound();
    cam.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    await cam.play();
    const fs = await FilesetResolver.forVisionTasks(C.mediapipe.wasm);
    faceDetector = await FaceDetector.createFromOptions(fs, {
      baseOptions: { modelAssetPath: C.mediapipe.face, delegate: "GPU" }, runningMode: "VIDEO" });
    gestureRecognizer = await GestureRecognizer.createFromOptions(fs, {
      baseOptions: { modelAssetPath: C.mediapipe.gesture, delegate: "GPU" }, runningMode: "VIDEO", numHands: 1 });
  } catch (e) {
    sb.textContent = U().startFail + e.message;
    return;
  }
  sb.remove();
  say(""); // 解锁语音
  toIdle();
  requestAnimationFrame(loop);
}

// ---------- 每帧检测 ----------
let lastT = -1;
function loop() {
  const now = performance.now();
  if (cam.readyState >= 2 && now !== lastT) {
    lastT = now;
    const faces = faceDetector.detectForVideo(cam, now).detections;
    const big = faces.some((f) => f.boundingBox.width / cam.videoWidth >= C.minFaceWidth);
    if (big) { lastSeen = Date.now(); presentSince ||= Date.now(); } else if (Date.now() - lastSeen > 300) presentSince = 0;

    let g = "";
    if (gestureSeen) {
      const r = gestureRecognizer.recognizeForVideo(cam, now);
      const top = r.gestures[0]?.[0];
      if (top && top.score > 0.5 && GESTURE_TO_MOVE[top.categoryName]) {
        const m = GESTURE_TO_MOVE[top.categoryName];
        gestureSeen.push(m);
        $("youHand").textContent = ICON[m];
        g = top.categoryName;
      }
    }
    onTick();
    $("dbgText").textContent = `store=${storeId} lang=${lang}\nstate=${state}\nfaces=${faces.length} present=${!!presentSince}\ngesture=${g}`;
  }
  requestAnimationFrame(loop);
}

function onTick() {
  const t = Date.now();
  const left = t - lastSeen > C.leaveMs;
  if (needLeave && left) { needLeave = false; if (state === "idle") idleHint(); }
  if (state === "idle" && !needLeave && t > cooldownUntil && hint.textContent === U().again) idleHint();
  if (state === "idle" && !needLeave && presentSince && t - presentSince > C.presenceMs && t > cooldownUntil) runSession();
}

// 点角色也能开始（同一个人想再玩，或摄像头没认出人）
const tapToPlay = () => { if (state === "idle" && faceDetector) runSession(); };
$("character").addEventListener("click", tapToPlay);
hint.addEventListener("click", tapToPlay);   // 点下面的「点我再玩一次」也可以

// ---------- 互动流程 ----------
async function runSession() {
  state = "busy"; hint.textContent = ""; syncMusic();
  logEvent("visit");
  setMood("wave"); playVideo("wave");
  await speak(pick(T().welcome), 2200);
  setMood(""); playVideo("idle");
  await speak(T().invite, 1800);

  logEvent("play");
  // 平手重来，直到分出输赢；没认出手就一直重新问，连续 maxMisses 次都没认出才结束（人走了也是这样结束）；连续平手 6 次算输（送安慰奖）
  // 玩的过程中不用「看不到脸」判断离开：举手出拳、看角色动画时脸常常被挡住
  for (let misses = 0, draws = 0; misses < C.maxMisses;) {
    const you = await playRound();
    if (!you) { if (++misses < C.maxMisses) await speak(T().noHand, 1800); continue; }
    misses = 0;
    const bot = pick(Object.keys(ICON));
    await playThrow(bot);
    $("botHand").textContent = ICON[bot];
    if (you === bot && ++draws < 6) { playSfx("draw"); await speak(T().draw, 1800); playVideo("idle"); continue; }
    const won = you !== bot && BEATS[you] === bot;
    const mood = won ? "sad" : "happy";   // 角色的心情：顾客赢 = 角色输了失落，顾客输 = 角色赢了开心（和台词「哈哈，我赢啦」一致）
    setMood(mood); playVideo(mood); playSfx(won ? "win" : "lose");
    await speak(won ? T().win : T().lose, 1800);
    $("game").classList.add("hidden");
    showPrize(await getPrize(won));
    await countdown($("timer"), 8).done;
    $("prize").classList.add("hidden");
    if (S.photo !== false && await askPhoto()) await takePhoto();
    break;
  }
  return bye();
}

async function playRound() {
  $("game").classList.remove("hidden");
  $("youHand").textContent = $("botHand").textContent = "❔";
  tapMove = null;
  gestureSeen = []; // 倒数时就开始识别，提示画面会实时显示
  for (const w of U().countdown) {
    $("countdown").textContent = w; say(w); await sleep(800);
  }
  gestureSeen = []; // 只算最后一拍之后 1 秒的手势
  await sleep(1000);
  const last = gestureSeen.slice(-5).reverse(); gestureSeen = null;   // 看最后几帧：手停下来的样子才算，换手势途中的不算
  $("countdown").textContent = "";
  const count = {};
  for (const m of last) count[m] = (count[m] || 0) + 1;   // 票数一样时，越后面认出的越优先
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  const move = tapMove || (best && best[1] >= 2 ? best[0] : null);
  if (move) $("youHand").textContent = ICON[move];   // 画面显示的就是真正算数的手势
  return move;
}

document.querySelectorAll("#tapPick button").forEach((b) =>
  b.addEventListener("click", () => { tapMove = b.dataset.move; $("youHand").textContent = ICON[tapMove]; }));

async function bye() {
  $("game").classList.add("hidden"); $("prize").classList.add("hidden");
  setMood(""); playVideo("idle");
  await speak(T().bye, 1500);
  // 马上回到待机，显示「点我再玩一次」：同一个人不会自动再开（点了就能马上玩），新顾客 20 秒后才自动开始
  cooldownUntil = Date.now() + C.cooldownMs;
  needLeave = true;
  toIdle();
}

function toIdle() {
  state = "idle"; presentSince = 0; syncMusic();
  setLang(S.languages[0]); // 下一位顾客回到默认语言
  setMood(""); playVideo("idle");
  bubble.classList.add("hidden");
  idleHint();
}

// 刚玩完（人还在，或 20 秒内）显示「点我再玩一次」，否则显示招呼语
function idleHint() { hint.textContent = needLeave || Date.now() < cooldownUntil ? U().again : T().slogan; }

// ---------- 离线奖品（每日库存存在本机，按店铺分开） ----------
function drawPrize() {
  const key = `stock-${storeId}-${new Date().toISOString().slice(0, 10)}`;
  let used = {};
  try { used = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
  const id = (p) => tr(p.name);
  const pool = S.prizes.filter((p) => p.stock == null || (used[id(p)] || 0) < p.stock);
  if (!pool.length) return S.consolation;
  let r = Math.random() * pool.reduce((s, p) => s + p.weight, 0);
  const prize = pool.find((p) => (r -= p.weight) < 0) || pool[pool.length - 1];
  used[id(prize)] = (used[id(prize)] || 0) + 1;
  try { localStorage.setItem(key, JSON.stringify(used)); } catch {}
  return prize;
}

// 有后端：服务器抽奖并生成可核销的领奖码；没后端或断网：本机抽奖，码只作展示
async function getPrize(won) {
  if (backendOn && !preview) {
    try {
      const r = await rpc("kiosk_prize", { p_store: storeId, p_key: deviceKey, p_won: won });
      return { prize: r.prize, code: r.code };
    } catch (e) { console.warn("kiosk_prize failed, using offline draw", e); }
  }
  const d = new Date();
  return { prize: won ? drawPrize() : S.consolation,
           code: `${d.getMonth() + 1}${d.getDate()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}` };
}

function showPrize({ prize: p, code }) {
  $("prizeEmoji").textContent = p.emoji;
  $("prizeName").textContent = tr(p.name);
  $("prizeCode").textContent = code;
  $("prize").classList.remove("hidden");
}

// ---------- 合照 ----------
async function askPhoto() {
  speak(U().photoAsk, 0);
  $("photoYes").textContent = U().photoYes; $("photoNo").textContent = U().photoNo;
  $("photoAsk").classList.remove("hidden");
  const t = countdown($("timer"), 10);
  const yes = await new Promise((resolve) => {
    t.done.then(() => resolve(false));
    $("photoYes").onclick = () => resolve(true);
    $("photoNo").onclick = () => resolve(false);
  });
  t.stop();
  $("photoAsk").classList.add("hidden"); bubble.classList.add("hidden");
  return yes;
}

async function takePhoto() {
  const cv = $("photoCanvas"), view = $("photo"), count = $("photoCount");
  const art = await characterArt();
  cv.width = 960; cv.height = 1280;   // 竖版 3:4
  $("photoShare").classList.add("hidden");
  view.classList.remove("hidden");

  let live = true;   // 倒数时实时预览
  (function draw() { if (live) { composePhoto(cv, art, true); requestAnimationFrame(draw); } })();
  say(U().photoLook); count.textContent = "";
  await sleep(1500);
  for (const n of ["3", "2", "1"]) { count.textContent = n; say(n); await sleep(1000); }
  count.textContent = ""; live = false;
  composePhoto(cv, art, false);   // 存下来的照片不镜像，招牌和衣服上的字才是正的
  view.classList.add("flash"); setTimeout(() => view.classList.remove("flash"), 500); playSfx("photo");

  const msg = $("photoMsg"), qrBox = $("photoQr");
  qrBox.replaceChildren();
  try {
    if (!backendOn) throw new Error("no backend");
    const data = cv.toDataURL("image/jpeg", 0.85).split(",")[1];
    const id = await rpc("kiosk_photo", { p_store: storeId, p_key: deviceKey, p_data: data });
    const qr = qrcode(0, "M"); qr.addData(new URL(`photo.html?id=${id}`, location.href).href); qr.make();
    qrBox.innerHTML = qr.createImgTag(6, 8);
    msg.textContent = U().photoScan;
  } catch (e) { console.warn("photo upload failed", e); msg.textContent = U().photoFail; }
  $("photoDone").textContent = U().done;
  $("photoShare").classList.remove("hidden");
  say(msg.textContent);
  const t = countdown($("photoTimer"), 40);   // 时间到或点「完成」就关闭
  $("photoDone").onclick = t.stop;
  await t.done;
  view.classList.add("hidden");
}

// 照片里的角色：上传的视频/动图取当前画面；内置卡通转成图片。素材不允许跨域导出时就不画角色
async function characterArt() {
  const v = $("charVideo"), img = $("charImg");
  let el, w, h;
  if (!v.hidden && v.videoWidth) [el, w, h] = [v, v.videoWidth, v.videoHeight];
  else if (!img.hidden && img.naturalWidth) [el, w, h] = [img, img.naturalWidth, img.naturalHeight];
  else {
    const live = $("mascot"), svg = live.cloneNode(true);
    const src = live.querySelectorAll("*"), dst = svg.querySelectorAll("*");
    dst.forEach((n, i) => {
      if (/outfit|hair|skin/.test(n.getAttribute("class") || "")) n.setAttribute("fill", getComputedStyle(src[i]).fill);
      n.removeAttribute("class");
    });
    svg.removeAttribute("style"); svg.removeAttribute("id");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg"); svg.setAttribute("width", 400); svg.setAttribute("height", 520);
    el = new Image();
    el.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    try { await el.decode(); } catch { return null; }
    [w, h] = [400, 520];
  }
  try {
    const t = document.createElement("canvas").getContext("2d");
    t.drawImage(el, 0, 0, 1, 1); t.getImageData(0, 0, 1, 1);
  } catch { return null; }
  return { el, w, h };
}

function composePhoto(cv, art, mirror) {
  const g = cv.getContext("2d"), W = cv.width, H = cv.height, band = Math.round(H * 0.11);
  // 摄像头画面居中裁成竖版（横向摄像头会裁掉左右两边）
  const vw = cam.videoWidth, vh = cam.videoHeight, k = Math.min(vw / W, vh / (H - band));
  const sw = W * k, sh = (H - band) * k, sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  g.save(); if (mirror) { g.translate(W, 0); g.scale(-1, 1); }   // 预览镜像，像照镜子
  g.drawImage(cam, sx, sy, sw, sh, 0, 0, W, H - band); g.restore();
  if (art) {
    const ah = H * 0.4, aw = (ah * art.w) / art.h;
    g.drawImage(art.el, W - aw - W * 0.02, H - band - ah, aw, ah);
  }
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue("--primary").trim(); g.fillRect(0, H - band, W, band);
  g.fillStyle = css.getPropertyValue("--accent").trim(); g.textBaseline = "middle";
  g.font = `bold ${Math.round(band * 0.42)}px "PingFang SC", "Noto Sans SC", sans-serif`;
  g.textAlign = "left"; g.fillText(tr(S.storeName), W * 0.04, H - band / 2);
  g.font = `${Math.round(band * 0.3)}px sans-serif`;
  g.textAlign = "right"; g.fillText(new Date().toLocaleDateString(lang === "zh" ? "zh-CN" : "en-MY"), W * 0.96, H - band / 2);
}

// 上方倒数计时「n 秒后自动关闭」：时间到或调用 stop() 就结束（done 完成）
function countdown(el, secs) {
  let left = secs, stop;
  const tick = () => { el.textContent = "⏱ " + U().closeIn.replace("{n}", left); };
  const done = new Promise((resolve) => {
    const timer = setInterval(() => { if (--left <= 0) stop(); else tick(); }, 1000);
    stop = () => { clearInterval(timer); el.textContent = ""; resolve(); };
  });
  tick();
  return { done, stop };
}

// ---------- 声音：后台设的音乐（循环）和音效（播一次）----------
// 全部用 Web Audio 先解码再播：iPad 上 <audio> 调不了音量，而且有声音的角色视频一播就会把它暂停。
// 玩的时候换成游戏音乐（没有就继续背景音乐），音量减半，听得清角色说话
function sound(src) {   // 网址 → 解码好的声音（Promise），同一个只下载一次
  return (soundCache[src] ||= fetch(src).then((r) => r.arrayBuffer())
    .then((b) => new Promise((ok, fail) => actx.decodeAudioData(b, ok, fail)))
    .catch((e) => { console.warn("sound failed", src, e); delete soundCache[src]; return null; }));
}

function preloadSounds() {
  if (!actx) return;
  const want = new Set(Object.values(S.sounds || {}).filter(Boolean));
  for (const src of Object.keys(soundCache)) if (!want.has(src)) delete soundCache[src];
  want.forEach(sound);
}

function startSound() {   // 点「启动」时调用：浏览器要求点过屏幕才可以出声
  if (!actx) return;
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}   // iPhone 静音键打开也照样出声
  actx.resume?.();
  const unlock = actx.createBufferSource();   // iPhone / iPad 要在点击当下播一下才算解锁
  unlock.buffer = actx.createBuffer(1, 1, 22050); unlock.connect(actx.destination); unlock.start(0);
  soundOn = true;
  syncMusic();
}
// 来电、切到别的 App 回来后，Web Audio 可能被暂停；点一下屏幕就恢复
document.addEventListener("pointerdown", () => { if (soundOn && actx.state !== "running") actx.resume?.(); }, true);

function syncMusic() {
  if (!soundOn) return;
  const s = S.sounds || {}, busy = state === "busy", now = actx.currentTime;
  const src = (busy && s.game) || s.bgm || "";
  if ((music?.src || "") !== src) {   // 换曲：旧的淡出，新的淡入
    if (music?.node) { const { node, fade } = music; fade.gain.setTargetAtTime(0, now, 0.15); setTimeout(() => node.stop(), 1000); }
    const cur = music = src ? { src } : null;
    if (cur) sound(src).then((buf) => {
      if (!buf || music !== cur) return;   // 下载期间又换了曲
      cur.node = actx.createBufferSource(); cur.node.buffer = buf; cur.node.loop = true;
      cur.fade = actx.createGain(); cur.fade.gain.value = 0;
      cur.node.connect(cur.fade).connect(musicBus); cur.node.start();
      cur.fade.gain.setTargetAtTime(1, actx.currentTime, 0.3);
    });
  }
  musicBus.gain.setTargetAtTime(((S.musicVolume ?? 30) / 100) * (busy ? 0.5 : 1), now, 0.4);
}

function playSfx(name) {
  const src = S.sounds?.[name];
  if (!soundOn || !src) return;
  sfxBus.gain.value = (S.sfxVolume ?? 80) / 100;
  sound(src).then((buf) => {
    if (!buf) return;
    const n = actx.createBufferSource(); n.buffer = buf; n.connect(sfxBus); n.start();
  });
}

// ---------- 角色表现 ----------
function setMood(m) { stage.classList.remove("wave", "happy", "sad"); if (m) stage.classList.add(m); }

// 角色素材先整段下载到内存，切换动画时不用再等网络（店里网速慢时，出拳动画才不会还没载入就结束）
function preloadMedia() {
  const want = new Set(Object.values(S.character?.media || {}).filter(Boolean));
  for (const [src, url] of Object.entries(mediaCache)) {
    if (!want.has(src)) { if (url.startsWith("blob:")) URL.revokeObjectURL(url); delete mediaCache[src]; }
  }
  for (const src of want) {
    if (mediaCache[src]) continue;
    mediaCache[src] = src;
    fetch(src).then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b && mediaCache[src] === src) mediaCache[src] = URL.createObjectURL(b); }).catch(() => {});
  }
}

// 角色素材：mp4/webm 用 <video>，gif/webp/png 动图用 <img>；都没填就用内置卡通角色
function playVideo(name) {
  const media = S.character?.media || {};
  const key = media[name] ? name : "idle", src = media[key];
  const v = $("charVideo"), img = $("charImg");
  stage.classList.toggle("full", !!src);   // 上传的素材全屏播放，不显示店名招牌
  $("mascot").style.display = src ? "none" : "";
  if (!src) { v.hidden = img.hidden = true; return; }
  const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(src);
  v.hidden = !isVideo; img.hidden = isVideo;
  const el = isVideo ? v : img;
  if (isVideo) { v.dataset.key = key; v.muted = !videoSound || !!S.character?.mute?.[key]; }
  if (el.dataset.src !== src) {
    el.dataset.src = src; el.src = mediaCache[src] || src;
    if (isVideo) v.play().catch(() => {});
  }
}

// 角色出拳动画（店家上传了才播）：整段播完再出结果（最多等 8 秒），播的时候先收起猜拳画面，不挡住角色
async function playThrow(move) {
  const src = S.character?.media?.[move];
  if (!src) return;
  const v = $("charVideo");
  $("game").classList.add("hidden");
  playVideo(move);
  if (/\.(mp4|webm|mov)(\?|$)/i.test(src)) {
    v.loop = false; v.currentTime = 0; v.play().catch(() => {});
    await Promise.race([new Promise((r) => v.addEventListener("ended", r, { once: true })), sleep(8000)]);
    v.loop = true;
  } else await sleep(1800);   // 动图没有结束事件，按时间等
  $("game").classList.remove("hidden");
}

function applySkin() {
  const map = { outfit: "--outfit", outfitDark: "--outfit-dark", hair: "--hair", skin: "--skin" };
  for (const [k, v] of Object.entries(S.character?.skin || {})) if (map[k]) $("mascot").style.setProperty(map[k], v);
}

function say(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = (S.tts || C.tts)[lang]; u.rate = 1.05; u.pitch = 1.2;
  speechSynthesis.speak(u);
}

async function speak(text, ms) {
  bubble.textContent = text; bubble.classList.remove("hidden");
  say(text); await sleep(ms);
}

// 连点店名 5 次显示/隐藏摄像头调试画面
let taps = 0, tapTimer;
$("sign").addEventListener("click", () => {
  taps++; clearTimeout(tapTimer); tapTimer = setTimeout(() => (taps = 0), 1500);
  if (taps >= 5) { $("debug").classList.toggle("hidden"); taps = 0; }
});
