// Общие помощники для сценариев приложений: карта интерфейса, поиск пакета, проверка экрана.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { look } from "../vision.js";
import { wait } from "../phones.js";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
export const loadUi = (name) => JSON.parse(fs.readFileSync(path.join(UI_DIR, `${name}.json`), "utf8"));

// Имя пакета: из карты интерфейса, из .env, а если приложение под таким именем не стоит — ищем по ключевому слову
const pkgCache = new Map();
export async function resolvePkg(phone, preferred, keyword) {
  const k = `${phone.n}:${keyword}`;
  if (pkgCache.has(k)) return pkgCache.get(k);
  let pkg = preferred;
  try {
    const out = await phone.sh(`pm list packages | grep -i ${keyword}`, true);
    const list = out.split("\n").map((l) => l.replace(/^package:/, "").trim()).filter(Boolean);
    if (list.length && !list.includes(preferred)) pkg = list[0];
  } catch { /* остаётся preferred */ }
  pkgCache.set(k, pkg);
  return pkg;
}

// Проверка экрана: сначала по тексту интерфейса, если не хватило — по картинке, до 3 попыток (как у FOMI)
export async function verify(phone, { ticker, amount, kind, app }) {
  const s = await phone.screen();
  const has = (x) => s.all.includes(String(x).toLowerCase());
  if (s.readable && has(ticker) && (!amount || has(amount))) return { ok: true, how: "ui" };
  let v = null;
  for (let i = 0; i < 3 && !v; i++) {
    if (i) await wait(1500);
    const jpg = await phone.screenshot().catch(() => null);
    if (jpg) v = await look(jpg, `Expected: ${kind} for ticker ${ticker}${amount ? `, amount ${amount}` : ""}. Is that what the screen shows?`, app);
  }
  if (!v) return { ok: false, how: "vision unavailable" };
  if (v.danger) await phone.bail("unsafe screen detected by vision");
  const tick = String(v.ticker || "").replace(/^\$/, "").toLowerCase() === String(ticker).toLowerCase();
  const amt = !amount || String(v.amount || "").replace(/[$,\s]|usdc|usd|sol/gi, "").replace(/\.0+$/, "") === String(amount).replace(/[$,\s]|usdc|usd|sol/gi, "").replace(/\.0+$/, "");
  return { ok: !!v.ok && tick && amt, how: "vision", saw: v };
}

// число из текста вроде "Balance: 1.234 SOL" / "$12.50 available"; не прочиталось — NaN, а не 0 (урок FOMI)
export function readNumber(all, re) {
  const m = all.match(re);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
}
