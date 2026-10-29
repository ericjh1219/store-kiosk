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

let faceDetector, gestureRecognizer;
let state = "idle";            // idle | busy | cooldown
let presentSince = 0, lastSeen = 0, cooldownUntil = 0;
let gestureVotes = null;       // 出拳窗口内收集手势
let tapMove = null;            // 触屏出拳（识别失败时的备用）

$("storeName").textContent = C.storeName;
$("startBtn").onclick = start;

async function start() {
  $("startBtn").textContent = "加载中…";
  try {
    document.documentElement.requestFullscreen?.().catch(() => {});
    cam.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 640, height: 480 }, audio: false });
    await cam.play();
    const fs = await FilesetResolver.forVisionTasks(C.mediapipe.wasm);
    faceDetector = await FaceDetector.createFromOptions(fs, {
      baseOptions: { modelAssetPath: C.mediapipe.face, delegate: "GPU" }, runningMode: "VIDEO" });
    gestureRecognizer = await GestureRecognizer.createFromOptions(fs, {
      baseOptions: { modelAssetPath: C.mediapipe.gesture, delegate: "GPU" }, runningMode: "VIDEO", numHands: 1 });
  } catch (e) {
    $("startBtn").textContent = "启动失败：" + e.message + "（需 HTTPS + 摄像头权限）";
    return;
  }
  $("startBtn").remove();
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
    $("dbgText").textContent = `state=${state}\nfaces=${faces.length} present=${!!presentSince}\ngesture=${g}`;
  }
  requestAnimationFrame(loop);
}

function onTick() {
  const t = Date.now();
  if (state === "idle" && presentSince && t - presentSince > C.presenceMs && t > cooldownUntil) runSession();
  if (state === "cooldown" && t - lastSeen > C.leaveMs) toIdle();
}

// ---------- 互动流程 ----------
async function runSession() {
  state = "busy";
  setMood("wave"); playVideo("wave");
  await speak(pick(C.lines.welcome), 2200);
  setMood("");
  await speak(C.lines.invite, 1800);

  for (let round = 0; round < 3; round++) {
    if (Date.now() - lastSeen > C.leaveMs) return bye();
    const you = await playRound();
    if (!you) { await speak(C.lines.noHand, 1800); continue; }
    const bot = pick(Object.keys(ICON));
    $("botHand").textContent = ICON[bot];
    if (you === bot) { await speak(C.lines.draw, 1800); continue; }
    const won = BEATS[you] === bot;
    setMood(won ? "happy" : "sad"); playVideo(won ? "happy" : "sad");
    await speak(won ? C.lines.win : C.lines.lose, 1800);
    $("game").classList.add("hidden");
    showPrize(won ? drawPrize() : C.consolation);
    await sleep(8000);
    break;
  }
  return bye();
}

async function playRound() {
  $("game").classList.remove("hidden");
  $("youHand").textContent = $("botHand").textContent = "❔";
  tapMove = null;
  gestureVotes = {}; // 倒数时就开始识别，提示画面会实时显示
  for (const w of ["石头", "剪刀", "布！"]) {
    $("countdown").textContent = w; say(w); await sleep(800);
  }
  gestureVotes = {}; // 只统计“布！”之后 0.8 秒的手势
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
  await speak(C.lines.bye, 1500);
  bubble.classList.add("hidden");
  cooldownUntil = Date.now() + C.cooldownMs;
  state = "cooldown";
  hint.textContent = "";
}

function toIdle() {
  state = "idle"; presentSince = 0;
  setMood(""); playVideo("idle");
  bubble.classList.add("hidden");
  hint.textContent = C.slogan;
}

// ---------- 奖品（每日库存存在本机） ----------
function drawPrize() {
  const key = "stock-" + new Date().toISOString().slice(0, 10);
  let used = {};
  try { used = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
  const pool = C.prizes.filter((p) => p.stock == null || (used[p.name] || 0) < p.stock);
  if (!pool.length) return C.consolation;
  let r = Math.random() * pool.reduce((s, p) => s + p.weight, 0);
  const prize = pool.find((p) => (r -= p.weight) < 0) || pool[pool.length - 1];
  used[prize.name] = (used[prize.name] || 0) + 1;
  try { localStorage.setItem(key, JSON.stringify(used)); } catch {}
  return prize;
}

function showPrize(p) {
  $("prizeEmoji").textContent = p.emoji;
  $("prizeName").textContent = p.name;
  const d = new Date();
  $("prizeCode").textContent = `${d.getMonth() + 1}${d.getDate()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  $("prize").classList.remove("hidden");
}

// ---------- 角色表现 ----------
function setMood(m) { stage.classList.remove("wave", "happy", "sad"); if (m) stage.classList.add(m); }

function playVideo(name) {
  const src = C.videos[name] || C.videos.idle;
  const v = $("charVideo");
  if (!src) return;
  $("mascot").style.display = "none"; v.hidden = false;
  if (!v.src.endsWith(src)) { v.src = src; v.play().catch(() => {}); }
}

function say(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-CN"; u.rate = 1.05; u.pitch = 1.2;
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
