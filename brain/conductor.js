// Оркестратор: одна рука на три телефона.
// Очередь с приоритетами живёт в phones.js (hand). Здесь — сценарии верхнего уровня:
//   lookAt   — перед решением: #2 показывает токен на gmgn, #3 проверяет X проекта
//   postAbout — после покупки: #3 постит о позиции
//   idle     — когда делать нечего, телефоны листают ленты, чтобы экраны не стояли
import { CFG } from "./config.js";
import { hand, stopped, wait } from "./phone/phones.js";
import { getControl } from "./control.js";
import * as scope from "./phone/apps/scope.js";
import * as xapp from "./phone/apps/x.js";
import * as pump from "./phone/apps/pumpfun.js";
import { pushEvent } from "./memory.js";

const phonesOn = () => CFG.phone.on && !CFG.mock;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

// Визуальный ресёрч и проверка X. Падение любого шага не мешает решению: вердикт просто "weak"/"none".
export async function lookAt(t, research) {
  const twitter = research?.twitter || null;
  if (!phonesOn()) return { verdict: twitter ? "weak" : "none", notes: twitter ? "x not checked (phones off)" : "no x link on the token" };
  if (CFG.phone.pads[2]) {
    await withTimeout(hand.run(2, `scoping $${t.symbol}`, () => scope.show({ address: t.address, symbol: t.symbol }), 1), 60e3, "scope")
      .catch((e) => pushEvent({ type: "error", text: `scope $${t.symbol}: ${e.message}` }));
  }
  if (!CFG.phone.pads[3]) return { verdict: twitter ? "weak" : "none", notes: twitter ? "x not checked (no social phone)" : "no x link on the token" };
  try {
    const r = await withTimeout(hand.run(3, twitter?.handle ? `checking @${twitter.handle}` : "checking x", () => xapp.check({ symbol: t.symbol, twitter, g: t.gmgn || {} }), 1), 90e3, "x check");
    return { ...r, checked: !!twitter };
  } catch (e) {
    pushEvent({ type: "error", text: `x check $${t.symbol}: ${e.message}` });
    return { verdict: twitter ? "weak" : "none", notes: "x check failed" };
  }
}

// Текст поста: тикер, одна строка тезиса, ссылка на сайт, пометка «ИИ, не финсовет». Без обещаний.
// Жёсткое правило: в X только $TICKER, адрес контракта (CA) токена — никогда.
// Вырезаем сам CA, любые base58-строки от 25 символов, ссылки и упоминания «ca:».
export const CA_LIKE = /[1-9A-HJ-NP-Za-km-z]{25,}/;
export function postText(symbol, line, size, ca = "") {
  let raw = String(line || "");
  if (ca) raw = raw.split(ca).join(" ");
  const clean = raw.replace(/https?:\/\/\S+|www\.\S+|\b\S+\.(fun|com|io|xyz|app|net|org|trade)\/\S*|@\w+|[1-9A-HJ-NP-Za-km-z]{25,}|\b(ca|contract)\s*[:=]\s*\S*|[^\x20-\x7E]/gi, " ")
    .replace(/\b(100x|1000x|moon(ing)?|gem|lfg|guaranteed)\b/gi, "").replace(/\s+/g, " ").trim();
  const tick = "$" + String(symbol).toUpperCase();
  const body = clean.toLowerCase().includes(tick.toLowerCase()) ? clean : `${tick}: ${clean}`;
  const tail = ` in for $${size}. ai trade, not financial advice.${CFG.links.site ? " " + CFG.links.site : ""}`;
  return (body.slice(0, 280 - tail.length).replace(/[\s.,;]+$/, "") + "." + tail).slice(0, 280);
}

export async function postAbout(symbol, line, size, { dry, ca = "" }) {
  if (!phonesOn() || !CFG.phone.pads[3]) {
    if (CFG.x.postVia !== "api") return null;
  }
  const text = postText(symbol, line, size, ca);
  try {
    const r = CFG.x.postVia === "api" || !CFG.phone.pads[3]
      ? await xapp.post(text, { dry })
      : await withTimeout(hand.run(3, `posting $${symbol}`, () => xapp.post(text, { dry }), 1), 90e3, "x post");
    if (r?.posted) pushEvent({ type: "thought", kind: "think", text: `posted $${symbol} on x` });
    else if (r?.skipped) pushEvent({ type: "thought", kind: "think", text: `no x post for $${symbol}: ${r.skipped}` });
    return r;
  } catch (e) { pushEvent({ type: "error", text: `x post $${symbol}: ${e.message}` }); return null; }
}

// Простой: раз в IDLE_SECONDS одно короткое действие на одном телефоне — только если рука свободна
const IDLE = [{ n: 1, fn: pump.idle }, { n: 2, fn: scope.idle }, { n: 3, fn: xapp.idle }];
export async function idleLoop() {
  if (!phonesOn() || !CFG.phone.idleBrowse) return;
  let i = 0;
  for (;;) {
    await wait(Number(process.env.IDLE_SECONDS || 25) * 1000);
    if (hand.busy || hand.waiting() || stopped() || getControl().mode === "off") continue;
    const it = IDLE[i++ % IDLE.length];
    if (!CFG.phone.pads[it.n]) continue;
    await hand.acquire(9);
    try { hand.setFocus(it.n, ""); await withTimeout(it.fn(), 30e3, "idle"); }
    catch { /* простой не важен */ }
    finally { hand.release(); }
  }
}
