import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const C = window.APP_CONFIG;
const $ = (id) => document.getElementById(id);
if (!C.backend?.url) {
  document.body.innerHTML = "<main class='card narrow'><h2>后台未设置</h2><p>请先在 config.js 填写 backend.url 和 backend.key（见 README）。</p></main>";
  throw new Error("backend not configured");
}
const sb = createClient(C.backend.url, C.backend.key);

// 小工具：建元素（全部用 textContent，避免把商家输入当成 HTML）
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
function toast(msg, ms = 2500) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
const fmtTime = (s) => (s ? new Date(s).toLocaleString() : "");
const tr = (v) => (v && typeof v === "object" ? v.zh && v.en ? `${v.zh} / ${v.en}` : v.zh || v.en || "" : v || "");
const show = (id, on) => ($(id).hidden = !on);

let me = { email: "", isAdmin: false, roles: {} }; // roles: storeId -> owner|staff
let stores = [];
let cur = null; // 当前店铺行

// ---------- 登录 ----------
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginMsg").textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  if (error) $("loginMsg").textContent = "登录失败 Login failed: " + error.message;
});
$("signupBtn").onclick = async () => {
  if (!$("loginForm").reportValidity()) return;
  const { data, error } = await sb.auth.signUp({ email: $("email").value.trim(), password: $("password").value,
    options: { emailRedirectTo: location.href.split("#")[0] } });
  if (error) return ($("loginMsg").textContent = error.message);
  if (!data.session) $("loginMsg").textContent = "请到邮箱点确认链接后再登录。Check your email to confirm, then sign in.";
};
$("forgotBtn").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) return ($("loginMsg").textContent = "请先填写邮箱 Enter your email first");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0] });
  $("loginMsg").textContent = error ? error.message : "重设密码邮件已发送 Reset email sent";
};
$("logoutBtn").onclick = () => sb.auth.signOut();

sb.auth.onAuthStateChange(async (event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    const pw = prompt("输入新密码（至少 8 位）New password (min 8 chars)");
    if (pw) {
      const { error } = await sb.auth.updateUser({ password: pw });
      toast(error ? error.message : "密码已更新 Password updated");
    }
  }
  // 回调里不要直接 await 其他 supabase 请求（官方建议），放到下一轮
  setTimeout(() => (session ? boot(session) : showLogin()), 0);
});

function showLogin() {
  booted = ""; activeTab = "";   // 下一个登录的人从「核销」开始，不会停在上一个人的设置页
  show("loginView", true); show("appView", false); show("noAccessView", false);
  show("logoutBtn", false); show("storeSel", false); $("who").textContent = "";
}

let booted = "";
async function boot(session) {
  if (booted === session.user.id) return;
  booted = session.user.id;
  me.email = session.user.email.toLowerCase();
  $("who").textContent = me.email;
  show("loginView", false); show("logoutBtn", true);

  const { data: staffRows } = await sb.from("staff").select("store_id, role").eq("email", me.email);
  me.isAdmin = (staffRows || []).some((r) => r.store_id === null);
  me.roles = Object.fromEntries((staffRows || []).filter((r) => r.store_id).map((r) => [r.store_id, r.role]));
  await loadStores();
  if (!stores.length && !me.isAdmin) { show("noAccessView", true); return; }
  show("appView", true);
  buildTabs();
}

// 设备密钥不在这里读（员工没有权限看），店主要用时才用 store_device_key 取
const STORE_COLS = "id, config, active, rental_until, ai_photo, ai_photo_daily, ai_photo_model";
async function loadStores(selectId) {
  let { data, error } = await sb.from("stores").select(STORE_COLS).order("id");
  if (error) ({ data, error } = await sb.from("stores").select("*").order("id"));   // 数据库还没更新到新版时的退路
  if (error) return toast(error.message);
  stores = data;
  const sel = $("storeSel");
  sel.replaceChildren(...stores.map((s) => h("option", { value: s.id }, `${tr(s.config.storeName) || s.id} (${s.id})`)));
  show("storeSel", stores.length > 0);
  const want = selectId || cur?.id || localStorage.getItem("admin-store");
  sel.value = stores.some((s) => s.id === want) ? want : stores[0]?.id || "";
  selectStore(sel.value);
}
$("storeSel").onchange = (e) => selectStore(e.target.value);

const isOwner = () => me.isAdmin || me.roles[cur?.id] === "owner";

function selectStore(id) {
  cur = stores.find((s) => s.id === id) || null;
  try { localStorage.setItem("admin-store", id); } catch {}
  document.body.classList.toggle("hide-staff", !isOwner());
  if (activeTab) buildTabs();   // 每家店的权限可能不同（这家是店主、那家只是员工），分页要跟着换
}

// 设备密钥：只有店主和平台管理员拿得到，第一次要用时向服务器要
async function ensureKey(store) {
  if (!store.device_key) {
    const { data, error } = await sb.rpc("store_device_key", { p_store: store.id });
    if (error) toast(error.message); else store.device_key = data;
  }
  return store.device_key;
}

// ---------- 分页 ----------
const TABS = [
  ["redeem", "核销 Redeem"], ["stats", "数据 Stats"], ["settings", "设置 Settings", "owner"],
  ["device", "设备 Device", "owner"], ["staff", "员工 Staff"], ["platform", "平台 Platform", "admin"],
];
let activeTab = "";
function buildTabs() {
  const visible = TABS.filter(([, , need]) => !need || (need === "owner" ? isOwner() : me.isAdmin));
  $("tabs").replaceChildren(...visible.map(([key, label]) => h("button", { "data-key": key, onclick: () => openTab(key) }, label)));
  openTab(visible.some(([key]) => key === activeTab) ? activeTab : "redeem");
}

function openTab(key) {
  if (!cur && key !== "platform") key = me.isAdmin ? "platform" : key;
  activeTab = key;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.key === key));
  document.querySelectorAll("section[data-tab]").forEach((s) => s.classList.toggle("on", s.dataset.tab === key));
  ({ redeem: loadRecent, stats: loadStats, settings: renderSettings, device: renderDevice,
     staff: loadStaff, platform: renderPlatform })[key]?.();
}

// ---------- 核销 ----------
$("redeemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("codeInput").value.trim().toUpperCase();
  const { data, error } = await sb.rpc("redeem_code", { p_code: code });
  const box = $("redeemResult");
  if (error) return box.replaceChildren(h("div", { class: "result bad" }, error.message));
  const p = data.prize || {};
  const prizeLine = p.name ? h("div", {}, h("div", { class: "emoji" }, p.emoji || "🎁"), tr(p.name)) : null;
  const views = {
    ok: ["ok", "✅ 核销成功，请发放奖品 Valid — hand over the prize"],
    already: ["warn", `⚠️ 已经核销过 Already redeemed ${fmtTime(data.redeemed_at)}（${data.redeemed_by || ""}）`],
    expired: ["bad", "⌛ 已过期 Expired"],
    not_found: ["bad", "❌ 无效的码 Code not found"],
  };
  const [cls, msg] = views[data.status] || ["bad", data.status];
  box.replaceChildren(h("div", { class: "result " + cls }, prizeLine, h("div", {}, msg), h("small", {}, code)));
  if (data.status === "ok") $("codeInput").value = "";
  loadRecent();
});

async function loadRecent() {
  if (!cur) return;
  const id = cur.id;
  const { data } = await sb.from("redemptions").select("*").eq("store_id", id)
    .order("created_at", { ascending: false }).limit(30);
  if (cur?.id !== id) return;   // 等待期间换了店，不要把上一家的资料显示在这家下面
  $("recentCodes").replaceChildren(h("table", {},
    h("tr", {}, h("th", {}, "码 Code"), h("th", {}, "奖品 Prize"), h("th", {}, "发出 Issued"), h("th", {}, "状态 Status")),
    (data || []).map((r) => h("tr", {}, h("td", {}, r.code), h("td", {}, `${r.prize.emoji || ""} ${tr(r.prize.name)}`),
      h("td", {}, fmtTime(r.created_at)),
      h("td", {}, r.redeemed_at ? h("span", { class: "tag ok" }, "已领 Claimed") : h("span", { class: "tag warn" }, "未领 Open"))))));
}

// ---------- 数据 ----------
$("statsDays").onchange = () => loadStats();
async function loadStats() {
  if (!cur) return;
  const id = cur.id;
  const { data, error } = await sb.rpc("store_stats", { p_store: id, p_days: +$("statsDays").value });
  if (cur?.id !== id) return;
  if (error) return toast(error.message);
  const sum = (k) => data.reduce((s, r) => s + Number(r[k]), 0);
  const visits = sum("visits"), plays = sum("plays"), codes = sum("codes"), redeemed = sum("redeemed");
  const showAi = cur.ai_photo || sum("ai") > 0;   // 开通过 AI 合照才显示这一栏（旧版数据库没有 ai 栏）
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
  $("statsTotals").replaceChildren(
    ...[["到访 Visitors", visits], ["参与猜拳 Played", plays, pct(plays, visits)], ["发出领奖码 Codes", codes],
        ["已核销 Redeemed", redeemed, pct(redeemed, codes)], showAi && ["✨ AI 合照 AI photos", sum("ai") || 0]].filter(Boolean)
      .map(([label, n, sub]) => h("div", { class: "tile" }, h("small", {}, label), h("b", {}, n), sub ? h("small", {}, sub) : null)));
  const cols = [["day", "日期 Date"], ["visits", "到访"], ["plays", "猜拳"], ["wins", "赢"], ["loses", "输"], ["codes", "领奖码"], ["redeemed", "核销"],
    showAi && ["ai", "AI 合照"]].filter(Boolean);
  $("statsTable").replaceChildren(h("table", {},
    h("tr", {}, cols.map(([k, l]) => h("th", { class: k === "day" ? "" : "num" }, l))),
    data.map((r) => h("tr", {}, cols.map(([k]) => h("td", { class: k === "day" ? "" : "num" }, r[k] ?? 0))))));
}

// ---------- 设置 ----------
const LINE_FIELDS = [
  ["slogan", "待机招揽语 Idle slogan"], ["welcome", "欢迎语（每行一句，随机）Welcome lines, one per line", "multi"],
  ["invite", "邀请猜拳 Invite"], ["win", "顾客赢 Customer wins"], ["lose", "顾客输 Customer loses"],
  ["draw", "平手 Draw"], ["noHand", "没看到手 No hand seen"], ["bye", "再见 Goodbye"],
  ["attract", "有人经过时的招呼（留空 = 只播动画不说话）Passer-by call-out (optional)", "", "optional"],
];
const LANG_NAMES = { zh: "中文", en: "English" };
// 声音：音乐循环播放，音效播一次
const SOUNDS = [["bgm", "背景音乐"], ["game", "游戏音乐"], ["win", "赢了"], ["lose", "输了"], ["draw", "平手"], ["photo", "拍照"]];
// 声音模版：tools/make_sounds.py 合成的原创声音，放在网站的 sounds/ 里
const SOUND_TEMPLATES = {
  bgm: [["bgm-sunny", "轻快午后"], ["bgm-teahouse", "中国风茶楼"], ["bgm-lofi", "轻松 Lo-fi"]],
  game: [["game-bouncy", "欢乐挑战"], ["game-8bit", "8-bit 游戏机"]],
  win: [["win-fanfare", "胜利号角"], ["win-coins", "金币叮叮"], ["win-gong", "锣鼓 咚咚锵"]],
  lose: [["lose-wahwah", "哇哇哇"], ["lose-slide", "可爱滑落"]],
  draw: [["draw-dingdong", "叮咚"], ["draw-boop", "啵啵"]],
  photo: [["photo-shutter", "咔嚓快门"], ["photo-flash", "闪光"]],
};
const SOUND_SETS = [
  ["轻快 Bright", { bgm: "bgm-sunny", game: "game-bouncy", win: "win-fanfare", lose: "lose-wahwah", draw: "draw-dingdong", photo: "photo-shutter" }],
  ["中国风 Chinese", { bgm: "bgm-teahouse", game: "game-bouncy", win: "win-gong", lose: "lose-slide", draw: "draw-boop", photo: "photo-shutter" }],
  ["游戏机 8-bit", { bgm: "bgm-lofi", game: "game-8bit", win: "win-coins", lose: "lose-slide", draw: "draw-boop", photo: "photo-flash" }],
];
const tplUrl = (id) => `sounds/${id}.mp3`;
// 拍照背景框模版：放在网站的 frames/ 里，中间镜头位置是透明的
const FRAME_TEMPLATES = [["frames/premo-studio.webp", "PREMO Studio 花艺摄影棚"]];
// AI 合照模版：一张示范合照（角色 + 一个示范人物），AI 会把示范人物换成顾客
const AI_TEMPLATES = [["frames/ai-premo-studio.webp", "PREMO Studio 熊熊自拍"]];
const AI_STYLES = [["real", "写实：像本人，稍微美化 Realistic"], ["cartoon", "卡通：3D 动画风 Cartoon"]];
const WHATSAPP_LINK = /^https:\/\/(chat\.whatsapp\.com|wa\.me|(www\.)?whatsapp\.com)\//;
const MIME = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm", png: "image/png", webp: "image/webp" };

// 上传到 assets/<店铺ID>/，文件名带时间戳（所以可以让浏览器长期缓存）
async function uploadAsset(f, name) {
  if (f.size > 20 * 1024 * 1024) return toast("文件太大（最大 20MB）File too large (max 20MB)");
  const ext = (f.name.split(".").pop() || "bin").toLowerCase();
  const path = `${cur.id}/${name}-${Date.now()}.${ext}`;
  toast("上传中… Uploading…", 60000);
  const body = f.type ? f : new File([f], f.name, { type: MIME[ext] || "" });   // 有些 m4a 浏览器认不出类型，按扩展名补上
  const { error } = await sb.storage.from("assets").upload(path, body, { upsert: false, cacheControl: "31536000" });
  if (error) return toast("上传失败 " + error.message);
  toast("已上传，记得保存 Uploaded — remember to Save");
  return sb.storage.from("assets").getPublicUrl(path).data.publicUrl;
}

// 后台试听：再点一次同一个就停
let previewAudio;
function preview(src) {
  const same = previewAudio && !previewAudio.paused && previewAudio.src === new URL(src, location.href).href;
  previewAudio?.pause();
  if (same || !src) return;
  previewAudio = new Audio(src);
  previewAudio.play().catch(() => toast("播放失败 Can't play"));
}

const MEDIA_STATES = [["idle", "待机 Idle"], ["wave", "挥手 Wave"], ["attract", "招揽（有人经过，没有就用挥手）"], ["happy", "开心（角色赢）"], ["sad", "失落（角色输）"],
  ["rock", "出石头 ✊"], ["scissors", "出剪刀 ✌️"], ["paper", "出布 ✋"]];

function renderSettings() {
  if (!cur) return;
  const store = cur, c = structuredClone(cur.config);
  const previewLink = h("a", { class: "btn ghost", target: "_blank", title: "先保存，再打开互动屏看效果（不计入数据）" }, "预览互动屏 Preview");
  c.lines ||= {}; c.prizes ||= []; c.character ||= {}; c.theme ||= {};
  const form = $("settingsForm");
  const val = (path, fallback = "") => path.reduce((o, k) => (o == null ? undefined : o[k]), c) ?? fallback;
  const inp = (name, value, extra = {}) => h("input", { name, value: value ?? "", ...extra });

  const langSel = h("select", { name: "languages" },
    [["zh,en", "中文 + English（默认中文）"], ["en,zh", "English + 中文（default English）"], ["en", "English only"], ["zh", "只有中文"]]
      .map(([v, l]) => h("option", { value: v, selected: (c.languages || ["zh", "en"]).join(",") === v }, l)));

  const lineSets = ["zh", "en"].map((lang) => h("fieldset", { "data-lang": lang },
    h("legend", {}, `台词 Lines — ${LANG_NAMES[lang]}`),
    LINE_FIELDS.map(([k, label, multi]) => h("label", {}, label,
      multi ? h("textarea", { name: `lines.${lang}.${k}` }, (val(["lines", lang, k], []) || []).join("\n"))
            : inp(`lines.${lang}.${k}`, val(["lines", lang, k], C.ui[lang][k] ?? ""))))));   // 新增的台词先填上默认句子
  const syncLangs = () => {
    const on = langSel.value.split(",");
    lineSets.forEach((fs) => (fs.style.display = on.includes(fs.dataset.lang) ? "" : "none"));
  };
  langSel.onchange = syncLangs;

  const prizeBody = h("tbody");
  const addPrizeRow = (p = {}) => prizeBody.append(h("tr", { class: "prize-row", "data-id": p.id || "p" + Date.now().toString(36) },
    h("td", {}, inp("emoji", p.emoji || "🎁", { style: "width:60px" })),
    h("td", {}, inp("nameZh", p.name?.zh)), h("td", {}, inp("nameEn", p.name?.en)),
    h("td", {}, inp("weight", p.weight ?? 1, { type: "number", min: 0, step: 1, style: "width:80px" })),
    h("td", {}, inp("stock", p.stock ?? "", { type: "number", min: 0, step: 1, placeholder: "不限 ∞", style: "width:90px" })),
    h("td", {}, h("button", { type: "button", class: "danger small", onclick: (e) => e.target.closest("tr").remove() }, "删除"))));
  c.prizes.forEach(addPrizeRow);

  const colorInp = (name, value) => h("label", {}, name.split(".").pop(), inp(name, value, { type: "color" }));

  // 一行素材：网址 + 上传按钮（声音多一个「选模版」和试听）
  const assetRow = (name, label, value, accept, placeholder, templates, extra) => {
    const url = inp(name, value, { type: "text", placeholder });
    const audio = accept.startsWith("audio");   // 声音才有试听
    const pick = templates && h("select", { class: "tpl", onchange: () => { if (pick.value) { url.value = pick.value; if (audio) preview(pick.value); } } },
      h("option", { value: "" }, "选模版…"), templates.map(([u, l]) => h("option", { value: u, selected: u === value }, l)));
    const set = (v) => { url.value = v; if (pick) pick.value = templates.some(([u]) => u === v) ? v : ""; };
    url.addEventListener("input", () => set(url.value.trim()));
    const file = h("input", { type: "file", accept, hidden: true, onchange: async () => {
      const f = file.files[0]; if (!f) return;
      const u = await uploadAsset(f, name.split(".").pop());
      if (u) set(u);
    } });
    const row = h("div", { class: "media-row" }, h("span", {}, label), url, h("span", { class: "row-btns" }, pick,
      audio ? h("button", { type: "button", class: "ghost small", onclick: () => preview(url.value.trim()) }, "▶ 试听") : null,
      extra, h("button", { type: "button", class: "ghost small", onclick: () => file.click() }, "上传 Upload"), file));
    row.set = set;
    return row;
  };
  const mediaRows = MEDIA_STATES.map(([state, label]) => assetRow(`media.${state}`, label, val(["character", "media", state]),
    "video/mp4,video/webm,image/gif,image/webp,image/png", "（空 = 内置卡通 / built-in）", null,
    h("label", { class: "inline mute", title: "这段动画播放时不出声 Mute this clip" },
      h("input", { type: "checkbox", name: `mute.${state}`, checked: !!val(["character", "mute", state], false) }), "🔇 关原声")));
  const soundRows = SOUNDS.map(([k, label]) => assetRow(`sounds.${k}`, label, val(["sounds", k]),
    "audio/*,.mp3,.m4a,.aac,.wav,.ogg", "（空 = 不播 / none）", SOUND_TEMPLATES[k].map(([id, l]) => [tplUrl(id), l])));
  const frameRow = assetRow("photoFrame", "拍照背景框", val(["photoFrame"]), "image/png,image/webp", "（空 = 普通拍照画面）", FRAME_TEMPLATES);
  // AI 合照：平台开通了才可以选风格和模版
  const aiPart = cur.ai_photo ? [
    h("h3", {}, "✨ AI 合照 AI photo"),
    h("p", { class: "hint" }, `拍完照后 AI 会把模版里的示范人物换成顾客（约 10–20 秒），互动屏和顾客扫码的页面都会自动换成 AI 版；生成失败就给普通合照。今天最多 ${cur.ai_photo_daily} 张。模版是一张竖版示范合照：角色 + 一个示范人物，最好 9:16。`),
    h("label", {}, "风格 Style", h("select", { name: "aiStyle" },
      AI_STYLES.map(([v, l]) => h("option", { value: v, selected: (c.aiStyle || "real") === v }, l)))),
    assetRow("aiTemplate", "AI 合照模版", val(["aiTemplate"]), "image/png,image/webp,image/jpeg", "（空 = PREMO Studio 熊熊自拍）", AI_TEMPLATES),
  ] : h("p", { class: "hint" }, "✨ AI 合照：未开通（加购配套，请联系我们）");
  const applySet = (set) => {
    SOUNDS.forEach(([k], i) => soundRows[i].set(tplUrl(set[k])));
    toast("已套用，记得保存 Applied — remember to Save");
  };
  const volume = (name, label, value) => {
    const out = h("b", {}, value + "%");
    return h("label", {}, label, " ", out,
      inp(name, value, { type: "range", min: 0, max: 100, step: 5, oninput: (e) => (out.textContent = e.target.value + "%") }));
  };

  form.replaceChildren(
    h("fieldset", {}, h("legend", {}, "基本 Basics"), h("div", { class: "grid2" },
      h("label", {}, "店名 中文", inp("storeName.zh", val(["storeName", "zh"]))),
      h("label", {}, "Store name English", inp("storeName.en", val(["storeName", "en"]))),
      h("label", {}, "语言 Languages", langSel),
      h("label", {}, "领奖码有效天数 Code valid days", inp("codeValidDays", c.codeValidDays ?? 7, { type: "number", min: 1, max: 365 })),
      h("label", { class: "inline" }, h("input", { type: "checkbox", name: "photo", checked: c.photo !== false }),
        "玩完后可以和角色合照（扫码下载，24 小时后删除）Photo with character"),
      h("label", { class: "inline" }, h("input", { type: "checkbox", name: "attract", checked: c.attract !== false }),
        "有人从前面走过时，播「招揽」动画招呼进店 Call out to passers-by"),
      h("label", {}, "招揽间隔（秒）同一段时间最多招呼一次 Min. seconds between call-outs",
        inp("attractGap", c.attractGap ?? 30, { type: "number", min: 10, max: 600 })),
      h("p", { class: "hint" }, cur.ai_photo
        ? `✨ AI 合照：已开通（每日最多 ${cur.ai_photo_daily} 张，在下面「合照」选风格）`
        : "✨ AI 合照：未开通（加购配套，请联系我们）"))),
    ...lineSets,
    h("fieldset", {}, h("legend", {}, "奖品 Prizes（赢了按权重抽；每日库存留空 = 不限）"),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, ["图标", "名称 中文", "Name English", "权重 Weight", "每日库存 Daily stock", ""].map((t) => h("th", {}, t)))),
        prizeBody)),
      h("button", { type: "button", class: "ghost small", onclick: () => addPrizeRow() }, "+ 添加奖品 Add prize"),
      h("h3", {}, "安慰奖（顾客输了）Consolation prize"),
      h("div", { class: "grid4" },
        h("label", {}, "图标", inp("consolation.emoji", val(["consolation", "emoji"], "🎟️"))),
        h("label", {}, "名称 中文", inp("consolation.zh", val(["consolation", "name", "zh"]))),
        h("label", {}, "Name English", inp("consolation.en", val(["consolation", "name", "en"]))))),
    h("fieldset", {}, h("legend", {}, "颜色 Colors"), h("div", { class: "grid4" },
      colorInp("theme.primary", c.theme.primary || "#4a160f"), colorInp("theme.accent", c.theme.accent || "#f5d68a"),
      colorInp("theme.bg", c.theme.bg || "#6b2d1e"))),
    h("fieldset", {}, h("legend", {}, "角色动画 Character"),
      h("p", { class: "hint" }, "上传竖屏 mp4/webm 视频或 gif/webp 动图（最大 20MB），建议 1080×1920。上传后角色会全屏播放，不显示店名招牌。视频本身的声音会播放，勾「关原声」就不出声。只上传「待机」也可以。「出石头 / 剪刀 / 布」是角色出拳的动画（建议 1–3 秒，整段播一次再出结果），没上传就只显示图标。没有上传就用内置卡通角色，可改下面的颜色。"),
      mediaRows,
      h("h3", {}, "内置卡通颜色 Built-in character colors"),
      h("div", { class: "grid4" }, ["outfit", "outfitDark", "hair", "skin"].map((k) =>
        colorInp(`skin.${k}`, val(["character", "skin", k], { outfit: "#e74c3c", outfitDark: "#c0392b", hair: "#2c2c2c", skin: "#ffe0bd" }[k]))))),
    h("fieldset", {}, h("legend", {}, "合照 Photo"),
      h("p", { class: "hint" }, "「拍照背景框」是拍照时整个屏幕的画面：上传一张竖版 PNG / WebP（建议 1080×1920），中间放镜头画面的地方要挖空（透明），镜头画面会自动放进挖空的地方，照片也会连背景框一起保存。留空就是普通拍照画面。"),
      frameRow,
      h("label", {}, "WhatsApp 社群链接（填了的话，顾客扫码后要先加入社群才看得到照片）WhatsApp community link",
        inp("whatsapp", val(["whatsapp"]), { type: "url", placeholder: "https://chat.whatsapp.com/…" })),
      aiPart),
    h("fieldset", {}, h("legend", {}, "声音 Sounds"),
      h("div", { class: "row" }, "一键套用整套 Apply a set：",
        SOUND_SETS.map(([label, set]) => h("button", { type: "button", class: "ghost small", onclick: () => applySet(set) }, label))),
      h("p", { class: "hint" }, "每一项可以「选模版」（▶ 试听），也可以上传自己的 mp3 / m4a 等音频（最大 20MB），留空就不播。「背景音乐」待机时循环播放；「游戏音乐」猜拳时循环播放，没上传就继续放背景音乐。玩的时候音乐会自动调小一半，听得清角色说话。「赢了 / 输了 / 平手 / 拍照」是音效，到那一刻播一次。点了「启动」之后才会出声。"),
      soundRows,
      h("div", { class: "grid2" }, volume("musicVolume", "音乐音量 Music", c.musicVolume ?? 30),
        volume("sfxVolume", "音效音量 Sound effects", c.sfxVolume ?? 80))),
    h("div", { class: "row" }, h("button", { type: "submit" }, "保存 Save"),
      previewLink),
  );
  ensureKey(store).then(() => (previewLink.href = kioskUrl(store, true)));
  syncLangs();
  form.onsubmit = (e) => { e.preventDefault(); saveSettings(c, form, prizeBody); };
}

async function saveSettings(base, form, prizeBody) {
  const f = (n) => form.elements[n]?.value.trim() ?? "";
  const c = structuredClone(base);
  c.languages = f("languages").split(",");
  c.storeName = Object.fromEntries(["zh", "en"].map((l) => [l, f(`storeName.${l}`)]).filter(([, v]) => v));
  c.codeValidDays = Math.max(1, parseInt(f("codeValidDays")) || 7);
  c.photo = form.elements.photo.checked;
  c.photoFrame = f("photoFrame");
  c.whatsapp = f("whatsapp");
  if (c.whatsapp && !WHATSAPP_LINK.test(c.whatsapp)) return toast("WhatsApp 链接要以 https://chat.whatsapp.com/ 开头 Invalid WhatsApp link", 4000);
  if (form.elements.aiStyle) { c.aiStyle = f("aiStyle"); c.aiTemplate = f("aiTemplate"); }   // 没开通时不显示，保留原本的设置
  c.attract = form.elements.attract.checked;
  c.attractGap = Math.min(600, Math.max(10, parseInt(f("attractGap")) || 30));
  c.lines = {};
  for (const lang of c.languages) {
    c.lines[lang] = {};
    for (const [k, label, multi, optional] of LINE_FIELDS) {
      const v = f(`lines.${lang}.${k}`);
      c.lines[lang][k] = multi ? v.split("\n").map((s) => s.trim()).filter(Boolean) : v;
      if (!v && !optional) return toast(`请填写 Please fill: ${LANG_NAMES[lang]} — ${label}`);
    }
    if (!c.storeName[lang]) return toast(`请填写店名 Store name (${LANG_NAMES[lang]})`);
  }
  c.prizes = [...prizeBody.querySelectorAll("tr")].map((tr) => {
    const q = (n) => tr.querySelector(`[name=${n}]`).value.trim();
    const name = Object.fromEntries([["zh", q("nameZh")], ["en", q("nameEn")]].filter(([, v]) => v));
    return { id: tr.dataset.id, name, weight: Math.max(0, Number(q("weight")) || 0),
             stock: q("stock") === "" ? null : Math.max(0, parseInt(q("stock"))), emoji: q("emoji") };
  }).filter((p) => Object.keys(p.name).length);
  c.consolation = { name: Object.fromEntries([["zh", f("consolation.zh")], ["en", f("consolation.en")]].filter(([, v]) => v)),
                    emoji: f("consolation.emoji") || "🎟️" };
  c.theme = { primary: f("theme.primary"), accent: f("theme.accent"), bg: f("theme.bg") };
  c.character = {
    skin: Object.fromEntries(["outfit", "outfitDark", "hair", "skin"].map((k) => [k, f(`skin.${k}`)])),
    media: Object.fromEntries(MEDIA_STATES.map(([s]) => [s, f(`media.${s}`)])),
    mute: Object.fromEntries(MEDIA_STATES.map(([s]) => [s, form.elements[`mute.${s}`].checked])),
  };
  c.sounds = Object.fromEntries(SOUNDS.map(([k]) => [k, f(`sounds.${k}`)]));
  c.musicVolume = Number(f("musicVolume"));
  c.sfxVolume = Number(f("sfxVolume"));
  const store = cur;   // 保存期间换了店，也只更新原来那家
  const { data, error } = await sb.from("stores").update({ config: c, updated_at: new Date().toISOString() })
    .eq("id", store.id).select("id");
  if (error) return toast("保存失败 Save failed: " + error.message);
  if (!data?.length) return toast("保存失败：没有修改这家店的权限 Save failed: no permission for this store", 4000);
  store.config = c;
  toast("已保存，互动屏 5 分钟内自动更新 Saved — kiosks update within 5 min", 4000);
}

// ---------- 设备 ----------
// 设备链接（带密钥）；preview = 后台「预览互动屏」用的，不计入数据、领奖码只是示范
function kioskUrl(store, preview = false) {
  const base = new URL("index.html", location.href);
  base.searchParams.set("store", store.id);
  base.searchParams.set("key", store.device_key || "");
  if (preview) base.searchParams.set("preview", "1");
  return base.toString();
}
async function renderDevice() {
  if (!cur) return;
  const store = cur;
  if (!(await ensureKey(store)) || cur !== store) return;
  const url = kioskUrl(store);
  $("deviceUrl").value = url;
  $("openKiosk").href = url;
  const qr = window.qrcode(0, "M"); qr.addData(url); qr.make();
  $("qr").innerHTML = qr.createImgTag(5, 8);
}
$("copyUrlBtn").onclick = async () => {
  try { await navigator.clipboard.writeText($("deviceUrl").value); toast("已复制 Copied"); }
  catch { $("deviceUrl").select(); }
};
$("rotateBtn").onclick = async () => {
  if (!confirm("更换后，旧链接的设备需要重新设置。确定？\nOld device links will stop working. Continue?")) return;
  const store = cur;
  const { data, error } = await sb.rpc("rotate_device_key", { p_store: store.id });
  if (error) return toast(error.message);
  store.device_key = data; renderDevice(); toast("已更换密钥 New key created");
};

// ---------- 员工 ----------
async function loadStaff() {
  if (!cur) return;
  const id = cur.id;
  const { data } = await sb.from("staff").select("*").eq("store_id", id).order("created_at");
  if (cur?.id !== id) return;
  $("staffList").replaceChildren(h("table", {},
    h("tr", {}, h("th", {}, "邮箱 Email"), h("th", {}, "角色 Role"), h("th", {})),
    (data || []).map((r) => h("tr", {}, h("td", {}, r.email), h("td", {}, r.role === "owner" ? "店主 Owner" : "员工 Staff"),
      h("td", {}, isOwner() && r.email !== me.email
        ? h("button", { class: "danger small", onclick: () => removeStaff(r) }, "移除 Remove") : null)))));
}
async function removeStaff(r) {
  if (!confirm(`移除 Remove ${r.email}?`)) return;
  const { error } = await sb.from("staff").delete().eq("id", r.id);
  if (error) toast(error.message); else loadStaff();
}
$("staffForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await sb.from("staff").insert({ email: $("staffEmail").value.trim().toLowerCase(), store_id: cur.id, role: $("staffRole").value });
  if (error) return toast(error.code === "23505" ? "已经在列表里 Already added" : error.message);
  $("staffEmail").value = ""; loadStaff();
});

// ---------- 平台管理 ----------
function renderPlatform() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });   // 和互动屏一样按马来西亚日期算到期
  $("allStores").replaceChildren(h("table", {},
    h("tr", {}, ["ID", "店名 Name", "状态 Status", "到期 Until", "AI 合照", ""].map((t) => h("th", {}, t))),
    stores.map((s) => {
      const expired = s.rental_until && s.rental_until < today;
      const status = !s.active ? ["bad", "停用 Off"] : expired ? ["bad", "已到期 Expired"] : ["ok", "运行中 On"];
      return h("tr", {}, h("td", {}, s.id), h("td", {}, tr(s.config.storeName)),
        h("td", {}, h("span", { class: "tag " + status[0] }, status[1])), h("td", {}, s.rental_until || "—"),
        h("td", {}, s.ai_photo ? h("span", { class: "tag ok" }, `✨ ${s.ai_photo_daily}/天${s.ai_photo_model === "pro" ? " · Pro" : ""}`) : "—"),
        h("td", {}, h("button", { class: "ghost small", onclick: () => { $("storeSel").value = s.id; selectStore(s.id); } }, "选择 Select")));
    })));
  if (cur) {
    $("rentActive").checked = cur.active; $("rentUntil").value = cur.rental_until || "";
    $("aiOn").checked = !!cur.ai_photo; $("aiDaily").value = cur.ai_photo_daily ?? 100;
    $("aiModel").value = cur.ai_photo_model || "standard";
  }
}
$("addonForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!cur) return;
  const { error } = await sb.rpc("admin_set_ai_photo", { p_id: cur.id, p_on: $("aiOn").checked, p_daily: parseInt($("aiDaily").value) || 0,
    p_model: $("aiModel").value });
  if (error) return toast(error.message);
  toast("已保存 Saved"); await loadStores(cur.id);
});
$("rentalForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!cur) return;
  const { error } = await sb.rpc("admin_set_rental", { p_id: cur.id, p_active: $("rentActive").checked, p_rental_until: $("rentUntil").value || null });
  if (error) return toast(error.message);
  toast("已保存 Saved"); await loadStores(cur.id);
});
$("newStoreForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("newId").value.trim().toLowerCase();
  const langs = $("newLangs").value.split(",");
  const name = { zh: $("newNameZh").value.trim() || $("newNameEn").value.trim(), en: $("newNameEn").value.trim() };
  const { error } = await sb.rpc("admin_create_store", { p_id: id, p_config: newStoreTemplate(name, langs), p_owner_email: $("newOwner").value });
  if (error) return toast(error.code === "23505" ? "这个店铺ID已存在 ID already exists" : error.message);
  e.target.reset(); toast("已创建 Created");
  await loadStores(id); openTab("settings");
});

function newStoreTemplate(name, languages) {
  const lines = {
    zh: { slogan: "走近一点，和我猜个拳吧！", welcome: [`欢迎光临${name.zh}！`, "你好呀，欢迎欢迎！"], invite: "举起手，跟我猜拳赢小礼品！",
          win: "哇，你赢了！", lose: "哈哈，我赢啦！送你一个安慰奖～", draw: "平手！再来一次！", noHand: "没看到你的手哦，再来一次～", bye: "欢迎下次再来！", attract: C.ui.zh.attract },
    en: { slogan: "Come closer and play Rock Paper Scissors with me!", welcome: [`Welcome to ${name.en}!`, "Hello there, come on in!"],
          invite: "Raise your hand, beat me and win a gift!", win: "Wow, you win!", lose: "Haha, I win! Here's a little something anyway.",
          draw: "It's a draw! One more time!", noHand: "I can't see your hand, let's try again!", bye: "See you next time!", attract: C.ui.en.attract },
  };
  return {
    storeName: Object.fromEntries(languages.map((l) => [l, name[l]])), languages,
    lines: Object.fromEntries(languages.map((l) => [l, lines[l]])),
    prizes: [{ id: "p1", name: { zh: "免费饮料一杯", en: "Free Drink" }, weight: 1, stock: 10, emoji: "🥤" },
             { id: "p2", name: { zh: "小礼品", en: "Small Gift" }, weight: 5, stock: null, emoji: "🎁" }],
    consolation: { name: { zh: "9折优惠券", en: "10% Off Coupon" }, emoji: "🎟️" },
    codeValidDays: 7, timezone: "Asia/Kuala_Lumpur",
    theme: { primary: "#4a160f", accent: "#f5d68a", bg: "#6b2d1e" },
    character: { skin: {}, media: { idle: "", wave: "", happy: "", sad: "" } },
  };
}

// 首次进入：没有登录就显示登录页
const { data: { session } } = await sb.auth.getSession();
if (!session) showLogin();
