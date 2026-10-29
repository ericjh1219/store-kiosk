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
  booted = "";
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

async function loadStores(selectId) {
  const { data, error } = await sb.from("stores").select("*").order("id");
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
  if (activeTab) openTab(activeTab);
}

// ---------- 分页 ----------
const TABS = [
  ["redeem", "核销 Redeem"], ["stats", "数据 Stats"], ["settings", "设置 Settings", "owner"],
  ["device", "设备 Device", "owner"], ["staff", "员工 Staff"], ["platform", "平台 Platform", "admin"],
];
let activeTab = "";
function buildTabs() {
  const visible = TABS.filter(([, , need]) => !need || (need === "owner" ? isOwnerAnywhere() : me.isAdmin));
  $("tabs").replaceChildren(...visible.map(([key, label]) => h("button", { "data-key": key, onclick: () => openTab(key) }, label)));
  openTab(activeTab || "redeem");
}
const isOwnerAnywhere = () => me.isAdmin || Object.values(me.roles).includes("owner");

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
  const { data } = await sb.from("redemptions").select("*").eq("store_id", cur.id)
    .order("created_at", { ascending: false }).limit(30);
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
  const { data, error } = await sb.rpc("store_stats", { p_store: cur.id, p_days: +$("statsDays").value });
  if (error) return toast(error.message);
  const sum = (k) => data.reduce((s, r) => s + Number(r[k]), 0);
  const visits = sum("visits"), plays = sum("plays"), codes = sum("codes"), redeemed = sum("redeemed");
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
  $("statsTotals").replaceChildren(
    ...[["到访 Visitors", visits], ["参与猜拳 Played", plays, pct(plays, visits)], ["发出领奖码 Codes", codes],
        ["已核销 Redeemed", redeemed, pct(redeemed, codes)]]
      .map(([label, n, sub]) => h("div", { class: "tile" }, h("small", {}, label), h("b", {}, n), sub ? h("small", {}, sub) : null)));
  const cols = [["day", "日期 Date"], ["visits", "到访"], ["plays", "猜拳"], ["wins", "赢"], ["loses", "输"], ["codes", "领奖码"], ["redeemed", "核销"]];
  $("statsTable").replaceChildren(h("table", {},
    h("tr", {}, cols.map(([k, l]) => h("th", { class: k === "day" ? "" : "num" }, l))),
    data.map((r) => h("tr", {}, cols.map(([k]) => h("td", { class: k === "day" ? "" : "num" }, r[k]))))));
}

// ---------- 设置 ----------
const LINE_FIELDS = [
  ["slogan", "待机招揽语 Idle slogan"], ["welcome", "欢迎语（每行一句，随机）Welcome lines, one per line", "multi"],
  ["invite", "邀请猜拳 Invite"], ["win", "顾客赢 Customer wins"], ["lose", "顾客输 Customer loses"],
  ["draw", "平手 Draw"], ["noHand", "没看到手 No hand seen"], ["bye", "再见 Goodbye"],
];
const LANG_NAMES = { zh: "中文", en: "English" };
const MEDIA_STATES = [["idle", "待机 Idle"], ["wave", "挥手 Wave"], ["happy", "开心 Happy"], ["sad", "失落 Sad"],
  ["rock", "出石头 ✊"], ["scissors", "出剪刀 ✌️"], ["paper", "出布 ✋"]];

function renderSettings() {
  if (!cur) return;
  const c = structuredClone(cur.config);
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
            : inp(`lines.${lang}.${k}`, val(["lines", lang, k]))))));
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

  const mediaRows = MEDIA_STATES.map(([state, label]) => {
    const url = inp(`media.${state}`, val(["character", "media", state]), { type: "text", placeholder: "（空 = 内置卡通 / built-in）" });
    const file = h("input", { type: "file", accept: "video/mp4,video/webm,image/gif,image/webp,image/png", hidden: true,
      onchange: async () => {
        const f = file.files[0]; if (!f) return;
        if (f.size > 20 * 1024 * 1024) return toast("文件太大（最大 20MB）File too large (max 20MB)");
        const ext = (f.name.split(".").pop() || "bin").toLowerCase();
        const path = `${cur.id}/${state}-${Date.now()}.${ext}`;
        toast("上传中… Uploading…", 60000);
        const { error } = await sb.storage.from("assets").upload(path, f, { contentType: f.type, upsert: false });
        if (error) return toast("上传失败 " + error.message);
        url.value = sb.storage.from("assets").getPublicUrl(path).data.publicUrl;
        toast("已上传，记得保存 Uploaded — remember to Save");
      } });
    return h("div", { class: "media-row" }, h("span", {}, label), url,
      h("span", {}, h("button", { type: "button", class: "ghost small", onclick: () => file.click() }, "上传 Upload"), file));
  });

  form.replaceChildren(
    h("fieldset", {}, h("legend", {}, "基本 Basics"), h("div", { class: "grid2" },
      h("label", {}, "店名 中文", inp("storeName.zh", val(["storeName", "zh"]))),
      h("label", {}, "Store name English", inp("storeName.en", val(["storeName", "en"]))),
      h("label", {}, "语言 Languages", langSel),
      h("label", {}, "领奖码有效天数 Code valid days", inp("codeValidDays", c.codeValidDays ?? 7, { type: "number", min: 1, max: 365 })),
      h("label", { class: "inline" }, h("input", { type: "checkbox", name: "photo", checked: c.photo !== false }),
        "玩完后可以和角色合照（扫码下载，24 小时后删除）Photo with character"))),
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
      h("p", { class: "hint" }, "上传竖屏 mp4/webm 视频或 gif/webp 动图（最大 20MB），建议 1080×1920。上传后角色会全屏播放，不显示店名招牌。只上传「待机」也可以。「出石头 / 剪刀 / 布」是角色出拳的短动画（1–2 秒，播一次），没上传就只显示图标。没有上传就用内置卡通角色，可改下面的颜色。"),
      mediaRows,
      h("h3", {}, "内置卡通颜色 Built-in character colors"),
      h("div", { class: "grid4" }, ["outfit", "outfitDark", "hair", "skin"].map((k) =>
        colorInp(`skin.${k}`, val(["character", "skin", k], { outfit: "#e74c3c", outfitDark: "#c0392b", hair: "#2c2c2c", skin: "#ffe0bd" }[k]))))),
    h("div", { class: "row" }, h("button", { type: "submit" }, "保存 Save"),
      h("a", { class: "btn ghost", target: "_blank", href: kioskUrl(false) }, "预览互动屏 Preview")),
  );
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
  c.lines = {};
  for (const lang of c.languages) {
    c.lines[lang] = {};
    for (const [k, label, multi] of LINE_FIELDS) {
      const v = f(`lines.${lang}.${k}`);
      c.lines[lang][k] = multi ? v.split("\n").map((s) => s.trim()).filter(Boolean) : v;
      if (!v) return toast(`请填写 Please fill: ${LANG_NAMES[lang]} — ${label}`);
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
  };
  const { error } = await sb.from("stores").update({ config: c, updated_at: new Date().toISOString() }).eq("id", cur.id);
  if (error) return toast("保存失败 Save failed: " + error.message);
  cur.config = c;
  toast("已保存，互动屏 5 分钟内自动更新 Saved — kiosks update within 5 min", 4000);
}

// ---------- 设备 ----------
function kioskUrl(withKey = true) {
  const base = new URL("index.html", location.href);
  base.searchParams.set("store", cur.id);
  if (withKey) base.searchParams.set("key", cur.device_key);
  return base.toString();
}
function renderDevice() {
  if (!cur) return;
  const url = kioskUrl();
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
  const { data, error } = await sb.rpc("rotate_device_key", { p_store: cur.id });
  if (error) return toast(error.message);
  cur.device_key = data; renderDevice(); toast("已更换密钥 New key created");
};

// ---------- 员工 ----------
async function loadStaff() {
  if (!cur) return;
  const { data } = await sb.from("staff").select("*").eq("store_id", cur.id).order("created_at");
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
  const today = new Date().toISOString().slice(0, 10);
  $("allStores").replaceChildren(h("table", {},
    h("tr", {}, ["ID", "店名 Name", "状态 Status", "到期 Until", ""].map((t) => h("th", {}, t))),
    stores.map((s) => {
      const expired = s.rental_until && s.rental_until < today;
      const status = !s.active ? ["bad", "停用 Off"] : expired ? ["bad", "已到期 Expired"] : ["ok", "运行中 On"];
      return h("tr", {}, h("td", {}, s.id), h("td", {}, tr(s.config.storeName)),
        h("td", {}, h("span", { class: "tag " + status[0] }, status[1])), h("td", {}, s.rental_until || "—"),
        h("td", {}, h("button", { class: "ghost small", onclick: () => { $("storeSel").value = s.id; selectStore(s.id); } }, "选择 Select")));
    })));
  if (cur) { $("rentActive").checked = cur.active; $("rentUntil").value = cur.rental_until || ""; }
}
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
          win: "哇，你赢了！", lose: "哈哈，我赢啦！送你一个安慰奖～", draw: "平手！再来一次！", noHand: "没看到你的手哦，再来一次～", bye: "欢迎下次再来！" },
    en: { slogan: "Come closer and play Rock Paper Scissors with me!", welcome: [`Welcome to ${name.en}!`, "Hello there, come on in!"],
          invite: "Raise your hand, beat me and win a gift!", win: "Wow, you win!", lose: "Haha, I win! Here's a little something anyway.",
          draw: "It's a draw! One more time!", noHand: "I can't see your hand, let's try again!", bye: "See you next time!" },
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
