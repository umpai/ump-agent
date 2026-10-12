// Облачные телефоны VMOS через OpenAPI (https://api.vmoscloud.com, подпись SHA-256).
// Мульти-телефонная версия драйвера FOMI: каждая функция получает padCode.
//
//   экран      → getLongGenerateUrl (ссылка на живое превью, обновляем по истечении)
//   нажатия    → asyncCmd: `input tap x y` / `input swipe` / `input keyevent`
//   результат  → padTaskDetail (taskStatus 3 = готово)
//   текст      → inputText (печатает в поле, где сейчас фокус)
//   приложение → startApp / `am start -d <ссылка> <пакет>`
//   интерфейс  → uiautomator dump (text / content-desc / bounds)
//
// Ключи только в .env на сервере (VMOS_AK / VMOS_SK / PAD_*). На сайт они не попадают никогда.
import crypto from "node:crypto";
import { CFG } from "../config.js";

const BASE = "https://api.vmoscloud.com";
const P = "/vcpcloud/api/padApi";
const UNSIGNED_BODY = new Set([`${P}/asyncCmd`, `${P}/syncCmd`, `${P}/uploadFile`, `${P}/uploadFileV3`]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function sign(sk, ts, path, bodyOrQuery) {
  return crypto.createHash("sha256").update(sk + ts + path + bodyOrQuery, "utf8").digest("hex");
}

export async function call(path, body) {
  if (!CFG.phone.vmosAk || !CFG.phone.vmosSk) throw new Error("set VMOS_AK and VMOS_SK in .env");
  const raw = body ? JSON.stringify(body) : "";
  const send = async (signBody) => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: { "X-Access-Key": CFG.phone.vmosAk, "X-Timestamp": ts, "Content-Type": "application/json",
        "X-Sign": sign(CFG.phone.vmosSk, ts, path, signBody ? raw : "") },
      body: raw,
      signal: AbortSignal.timeout(25000),
    });
    return r.json().catch(() => ({ code: r.status, msg: "bad json" }));
  };
  // в документации VMOS расходится, подписывается ли тело у командных методов — пробуем оба варианта (как в FOMI)
  let j = await send(!UNSIGNED_BODY.has(path));
  if (j.code === 2019) j = await send(UNSIGNED_BODY.has(path));
  if (j.code !== 200) throw new Error(`vmos ${path.replace(P, "")}: ${j.code} ${j.msg || ""}`);
  return Array.isArray(j.data) ? j.data[0] : j.data;
}

const need = (pad) => { if (!pad) throw new Error("pad code is empty — set PAD_TRADE / PAD_SCOPE / PAD_SOCIAL in .env"); return pad; };

// ADB-команда внутри облачного телефона. wantOutput — дождаться и вернуть вывод.
export async function sh(pad, cmd, wantOutput = false) {
  const d = await call(`${P}/asyncCmd`, { padCodes: [need(pad)], scriptContent: cmd });
  const taskId = d?.taskId;
  if (!taskId) return "";
  const deadline = Date.now() + (wantOutput ? 20000 : 8000);
  while (Date.now() < deadline) {
    await wait(600);
    const t = await call(`${P}/padTaskDetail`, { taskIds: [taskId] }).catch(() => null);
    if (t?.taskStatus === 3) return t.taskResult || "";
    if (t?.taskStatus < 0) throw new Error(`cmd failed: ${t.errorMsg || t.taskStatus}`);
  }
  return "";
}

const sizes = new Map();
export async function size(pad) {
  if (sizes.has(pad)) return sizes.get(pad);
  let s = { w: CFG.phone.width, h: CFG.phone.height };
  try {
    const out = await sh(pad, "wm size", true);
    const m = out.match(/(\d+)x(\d+)(?!.*\d+x\d+)/s);     // Override size, если есть, иначе Physical
    if (m) s = { w: +m[1], h: +m[2] };
  } catch { /* запасной вариант из .env */ }
  sizes.set(pad, s);
  return s;
}
export const resetSize = (pad) => sizes.delete(pad);

const previews = new Map();   // pad → { url, exp }
async function previewUrl(pad) {
  const p = previews.get(pad);
  if (p?.url && Date.now() < p.exp - 60e3) return p.url;
  const d = await call(`${P}/getLongGenerateUrl`, { padCodes: [need(pad)], format: "jpg", quality: 70, width: "540" });
  if (!d?.url) throw new Error(`no preview url: ${d?.reason || "unknown"}`);
  previews.set(pad, { url: d.url, exp: d.expireAt || Date.now() + 10 * 60e3 });
  return d.url;
}

export async function connect(pad) { await previewUrl(pad); return size(pad); }
export async function screenshot(pad) {
  const url = await previewUrl(pad);
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), { signal: AbortSignal.timeout(15000) });
  if (!r.ok) { previews.delete(pad); throw new Error("preview " + r.status); }
  return Buffer.from(await r.arrayBuffer());
}
export const frameType = "image/jpeg";

export const tap = (pad, x, y) => sh(pad, `input tap ${Math.round(x)} ${Math.round(y)}`);
export const swipe = (pad, x1, y1, x2, y2, ms = 300) => sh(pad, `input swipe ${[x1, y1, x2, y2].map(Math.round).join(" ")} ${ms}`);
export const key = (pad, code) => sh(pad, `input keyevent ${code}`);
export const back = (pad) => key(pad, 4);
export const type = (pad, text) => call(`${P}/inputText`, { padCodes: [need(pad)], text });
export const openApp = (pad, pkg) => call(`${P}/startApp`, { padCodes: [need(pad)], pkgName: pkg });
const q = (s) => String(s).replace(/'/g, "");
export const openUrl = (pad, url, pkg) => sh(pad, `am start -a android.intent.action.VIEW -d '${q(url)}' ${pkg ? q(pkg) : ""}`);
// поделиться текстом в приложение (так X открывает окно нового поста с уже вставленным текстом)
export const shareText = (pad, text, pkg) => sh(pad, `am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT '${q(text)}' ${q(pkg)}`);

export async function dumpUi(pad) {
  // компактный дамп: только text / content-desc / bounds каждого элемента — полный XML слишком большой для ответа API
  const out = await sh(pad, `uiautomator dump /sdcard/ump_ui.xml >/dev/null 2>&1; tr '>' '\\n' < /sdcard/ump_ui.xml | grep -oE 'text="[^"]*"|content-desc="[^"]*"|bounds="[^"]*"'`, true);
  const nodes = [];
  let cur = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^(text|content-desc|bounds)="(.*)"$/);
    if (!m) continue;
    if (m[1] === "text") cur.text = m[2];
    else if (m[1] === "content-desc") cur.desc = m[2];
    else {
      const b = m[2].match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (b) { const [x1, y1, x2, y2] = b.slice(1).map(Number); nodes.push({ text: cur.text || "", desc: cur.desc || "", x: (x1 + x2) / 2, y: (y1 + y2) / 2, w: x2 - x1, h: y2 - y1, clickable: true }); }
      cur = {};
    }
  }
  return { xml: out, nodes };
}
