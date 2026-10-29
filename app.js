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
let state = "idle";            // idle | busy | cooldown
let presentSince = 0, lastSeen = 0, cooldownUntil = 0;
let needLeave = false;          // 刚玩过的人还在镜头前：不自动再开，点角色才再玩
let gestureVotes = null;       // 出拳窗口内收集手势
let tapMove = null;            // 触屏出拳（识别失败时的备用）

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
  const sb = $("startBtn"); if (sb && !sb.dataset.busy) sb.textContent = U().start;
  if (state === "idle") idleHint();
  const next = S.languages[(S.languages.indexOf(l) + 1) % S.languages.length];
  $("langBtn").textContent = next === "zh" ? "中文" : "English";
  $("langBtn").hidden = S.languages.length < 2;
}
$("langBtn").onclick = () => setLang(S.languages[(S.languages.indexOf(lang) + 1) % S.languages.length]);

// ---------- 后端（Supabase） ----------
const params = new URLSearchParams(location.search);
const deviceKey = params.get("key") || "";
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
  if (backendOn) rpc("kiosk_event", { p_store: storeId, p_key: deviceKey, p_type: type }).catch(console.warn);
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
    document.documentElement.requestFullscreen?.().catch(() => {});
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
    if (gestureVotes) {
      const r = gestureRecognizer.recognizeForVideo(cam, now);
      const top = r.gestures[0]?.[0];
      if (top && top.score > 0.5 && GESTURE_TO_MOVE[top.categoryName]) {
        const m = GESTURE_TO_MOVE[top.categoryName];
        gestureVotes[m] = (gestureVotes[m] || 0) + 1;
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
  if (state === "idle" && !needLeave && presentSince && t - presentSince > C.presenceMs && t > cooldownUntil) runSession();
  if (state === "cooldown" && (left || t > cooldownUntil)) toIdle();
}

// 点角色也能开始（同一个人想再玩，或摄像头没认出人）
$("character").addEventListener("click", () => { if (state === "idle" && faceDetector) runSession(true); });

// ---------- 互动流程 ----------
async function runSession(byTap = false) {
  state = "busy"; hint.textContent = "";
  logEvent("visit");
  setMood("wave"); playVideo("wave");
  await speak(pick(T().welcome), 2200);
  setMood("");
  await speak(T().invite, 1800);

  logEvent("play");
  // 平手重来，直到分出输赢；没认出手 2 次就结束；连续平手 6 次算输（送安慰奖）
  for (let misses = 0, draws = 0; misses < 2;) {
    if (!byTap && Date.now() - lastSeen > C.leaveMs * 2) return bye(); // 出拳时手可能挡住脸，放宽一点
    const you = await playRound();
    if (!you) { misses++; await speak(T().noHand, 1800); continue; }
    const bot = pick(Object.keys(ICON));
    $("botHand").textContent = ICON[bot];
    if (you === bot && ++draws < 6) { await speak(T().draw, 1800); continue; }
    const won = you !== bot && BEATS[you] === bot;
    setMood(won ? "happy" : "sad"); playVideo(won ? "happy" : "sad");
    await speak(won ? T().win : T().lose, 1800);
    $("game").classList.add("hidden");
    showPrize(await getPrize(won));
    await sleep(8000);
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
  gestureVotes = {}; // 倒数时就开始识别，提示画面会实时显示
  for (const w of U().countdown) {
    $("countdown").textContent = w; say(w); await sleep(800);
  }
  gestureVotes = {}; // 只统计最后一拍之后 0.8 秒的手势
  await sleep(800);
  const votes = gestureVotes; gestureVotes = null;
  $("countdown").textContent = "";
  if (tapMove) return tapMove;
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : null;
}

document.querySelectorAll("#tapPick button").forEach((b) =>
  b.addEventListener("click", () => { tapMove = b.dataset.move; $("youHand").textContent = ICON[tapMove]; }));

async function bye() {
  $("game").classList.add("hidden"); $("prize").classList.add("hidden");
  setMood(""); playVideo("idle");
  await speak(T().bye, 1500);
  bubble.classList.add("hidden");
  cooldownUntil = Date.now() + C.cooldownMs;
  state = "cooldown"; needLeave = true;
  hint.textContent = "";
}

function toIdle() {
  state = "idle"; presentSince = 0;
  setLang(S.languages[0]); // 下一位顾客回到默认语言
  setMood(""); playVideo("idle");
  bubble.classList.add("hidden");
  idleHint();
}

function idleHint() { hint.textContent = needLeave ? U().again : T().slogan; }

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
  if (backendOn) {
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
  const yes = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10000);
    $("photoYes").onclick = () => { clearTimeout(timer); resolve(true); };
    $("photoNo").onclick = () => { clearTimeout(timer); resolve(false); };
  });
  $("photoAsk").classList.add("hidden"); bubble.classList.add("hidden");
  return yes;
}

async function takePhoto() {
  const cv = $("photoCanvas"), view = $("photo"), count = $("photoCount");
  const art = await characterArt();
  const scale = 1280 / Math.max(cam.videoWidth, cam.videoHeight);
  cv.width = Math.round(cam.videoWidth * scale); cv.height = Math.round(cam.videoHeight * scale);
  $("photoShare").classList.add("hidden");
  view.classList.remove("hidden");

  let live = true;   // 倒数时实时预览
  (function draw() { if (live) { composePhoto(cv, art, true); requestAnimationFrame(draw); } })();
  say(U().photoLook); count.textContent = "";
  await sleep(1500);
  for (const n of ["3", "2", "1"]) { count.textContent = n; say(n); await sleep(1000); }
  count.textContent = ""; live = false;
  composePhoto(cv, art, false);   // 存下来的照片不镜像，招牌和衣服上的字才是正的
  view.classList.add("flash"); setTimeout(() => view.classList.remove("flash"), 500);

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
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 40000);
    $("photoDone").onclick = () => { clearTimeout(timer); resolve(); };
  });
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
  g.save(); if (mirror) { g.translate(W, 0); g.scale(-1, 1); }   // 预览镜像，像照镜子
  g.drawImage(cam, 0, 0, W, H); g.restore();
  if (art) {
    const ah = H * 0.5, aw = (ah * art.w) / art.h;
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

// ---------- 角色表现 ----------
function setMood(m) { stage.classList.remove("wave", "happy", "sad"); if (m) stage.classList.add(m); }

// 角色素材：mp4/webm 用 <video>，gif/webp/png 动图用 <img>；都没填就用内置卡通角色
function playVideo(name) {
  const media = S.character?.media || {};
  const src = media[name] || media.idle;
  const v = $("charVideo"), img = $("charImg");
  if (!src) return;
  const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(src);
  $("mascot").style.display = "none";
  v.hidden = !isVideo; img.hidden = isVideo;
  if (isVideo) { if (!v.src.endsWith(src)) { v.src = src; v.play().catch(() => {}); } }
  else if (!img.src.endsWith(src)) img.src = src;
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
