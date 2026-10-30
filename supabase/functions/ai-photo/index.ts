// AI 合照：互动屏拍完照后调用。先检查设备密钥、是否开通、每日上限（ai_photo_begin），
// 然后在背景请 Gemini 把模版里的示范人物换成顾客，生成好存回照片（ai_photo_finish）。
// 互动屏和顾客手机自己轮询 photo_ai，好了就换成 AI 版。
// 要先在 Supabase → Edge Functions → Secrets 加 GEMINI_API_KEY；这个函数要关掉「Verify JWT」（互动屏用设备密钥验证）
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DB_URL = Deno.env.get("SUPABASE_URL") ?? "";
// 旧版是 service_role key；只开新版 API key 的项目给的是 SUPABASE_SECRET_KEYS（{ 名字: sb_secret_… }）
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || (() => {
  try { return Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"))[0] as string ?? ""; } catch { return ""; }
})();
// 内置模版放在网站的 frames/；店家上传的在 Supabase Storage 的 assets。只接受这两个地方的图片
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://ericjh1219.github.io/store-kiosk/";
const DEFAULT_TEMPLATE = "frames/ai-premo-studio.webp";
const MODELS: Record<string, string> = { standard: "gemini-3.1-flash-image", pro: "gemini-3-pro-image" };
const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

const KEEP =
  "Keep everything else in image 1 exactly as it is: the mascot character and its pose, every sign and its lettering, " +
  "the frame, decorations, lights and background. If there are small photos in the scene (for example polaroids), " +
  "change the person in them to the same customer. No extra text, no watermark.";
const STYLES: Record<string, string> = {
  real:
    "Image 1 is a souvenir photo template. Image 2 is a real customer (if several people are in image 2, use all of them). " +
    "Edit image 1: replace the demo person standing next to the mascot with the customer from image 2. " +
    "Keep the customer's real face, face shape, skin tone, glasses and hairstyle so friends instantly recognise them; " +
    "do not turn them into a different, more generic face. Give them a natural happy smile and the same friendly pose " +
    "as the demo person, close to the mascot, in neat smart-casual clothes. " +
    "Photorealistic, warm soft studio lighting, flattering but true to life. " + KEEP,
  cartoon:
    "Image 1 is a souvenir photo template. Image 2 is a real customer (if several people are in image 2, use all of them). " +
    "Edit image 1: replace the demo person standing next to the mascot with a cute 3D animated (Pixar-like) version of " +
    "the customer from image 2, still clearly recognisable: same face shape, glasses, hairstyle and skin tone. " +
    "Give them a big happy smile and the same friendly pose as the demo person, close to the mascot, in neat smart-casual clothes. " +
    "Render the whole scene in the same soft 3D animated style so the customer and the mascot match. " + KEEP,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(fn: string, body: unknown) {
  const res = await fetch(`${DB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// 读图片的宽高（PNG / WebP / JPEG 文件头），输出就用最接近模版的比例
function size(b: Uint8Array): [number, number] | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (i: number) => String.fromCharCode(...b.subarray(i, i + 4));
  if (tag(0) === "\x89PNG") return [v.getUint32(16), v.getUint32(20)];
  if (tag(0) === "RIFF" && tag(8) === "WEBP") {
    if (tag(12) === "VP8X") return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
    if (tag(12) === "VP8L") { const n = v.getUint32(21, true); return [1 + (n & 0x3fff), 1 + ((n >> 14) & 0x3fff)]; }
    if (tag(12) === "VP8 ") return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [v.getUint16(i + 7), v.getUint16(i + 5)];
      i += 2 + v.getUint16(i + 2);
    }
  }
  return null;
}

function mimeOf(b: Uint8Array) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return "";
}

const templates = new Map<string, { mime: string; data: string; ratio: string }>();   // 同一个模版只下载一次
async function template(src: string | null) {
  const url = new URL(src || DEFAULT_TEMPLATE, SITE_URL).href;
  if (!url.startsWith(SITE_URL) && !url.startsWith(`${DB_URL}/storage/v1/object/public/assets/`)) {
    throw new Error("template not allowed: " + url);
  }
  if (templates.has(url)) return templates.get(url)!;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`template ${res.status}: ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = mimeOf(bytes), wh = size(bytes);
  if (!mime) throw new Error("template is not an image: " + url);
  const diff = (r: string) => { const [a, b] = r.split(":").map(Number); return Math.abs(Math.log(a / b) - Math.log(wh![0] / wh![1])); };
  const t = { mime, data: base64(bytes), ratio: wh ? RATIOS.reduce((best, r) => (diff(r) < diff(best) ? r : best)) : "9:16" };
  templates.set(url, t);
  return t;
}

async function generate(model: string, style: string, tpl: { mime: string; data: string; ratio: string }, photo: string) {
  const body = {
    contents: [{ parts: [
      { text: STYLES[style] ?? STYLES.real },
      { inline_data: { mime_type: tpl.mime, data: tpl.data } },
      { inline_data: { mime_type: "image/jpeg", data: photo } },
    ] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: tpl.ratio } },
  };
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(100_000),
    });
    if (res.ok) {
      const r = await res.json();
      for (const p of r.candidates?.[0]?.content?.parts ?? []) {
        const d = p.inlineData ?? p.inline_data;
        if (d?.data) return { data: d.data as string, mime: (d.mimeType ?? d.mime_type) as string };
      }
      throw new Error("no image: " + JSON.stringify(r).slice(0, 500));
    }
    const err = `gemini ${res.status}: ${(await res.text()).slice(0, 500)}`;
    if (attempt >= 2 || (res.status !== 429 && res.status < 500)) throw new Error(err);   // 忙线或服务器错误才再试一次
    console.warn(err);
    await sleep(3000);
  }
}

async function run(job: { model: string; style: string; template: string | null }, photo: string, image: string) {
  let out: { data: string; mime: string } | null = null;
  try {
    const t = Date.now();
    out = await generate(MODELS[job.model] ?? MODELS.standard, job.style, await template(job.template), image);
    if (!["image/png", "image/jpeg", "image/webp"].includes(out.mime) || out.data.length >= 6_000_000) {
      throw new Error(`bad output ${out.mime} ${out.data.length}`);
    }
    console.log(`ai photo ${photo} done in ${Date.now() - t}ms (${job.model}, ${job.style})`);
  } catch (e) {
    out = null;
    console.error("ai photo failed", photo, e);
  }
  try {
    await rpc("ai_photo_finish", { p_photo: photo, p_data: out?.data ?? null, p_mime: out?.mime ?? null });
  } catch (e) {
    console.error("ai photo save failed", photo, e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { store, key, photo, image } = b ?? {};
  if (typeof store !== "string" || typeof key !== "string" || typeof photo !== "string" ||
      typeof image !== "string" || !image.startsWith("/9j/") || image.length > 2_000_000) {
    return json({ error: "bad request" }, 400);
  }
  if (!GEMINI_KEY || !SERVICE_KEY) return json({ ok: false, reason: "not configured" }, 503);
  let job;
  try {
    job = await rpc("ai_photo_begin", { p_store: store, p_key: key, p_photo: photo });
  } catch (e) {
    const denied = /invalid device key/.test(String(e));
    if (!denied) console.error("ai_photo_begin failed", e);
    return json({ ok: false, reason: denied ? "key" : "error" }, denied ? 403 : 500);
  }
  if (!job?.ok) return json(job ?? { ok: false });
  // 先回应互动屏，生成在背景继续（Supabase 的 EdgeRuntime.waitUntil）
  const task = run(job, photo, image);
  const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (rt) rt.waitUntil(task); else await task;
  return json({ ok: true });
});
