// Телефон #1 TRADE: приложение pump.fun.
//   buy:    открыть токен → Buy → сумма → проверка экрана → подтверждение → проверка покупки → тезис в комментариях
//   sell:   открыть токен → Sell → 100% / 50% → проверка → подтверждение → стоимость позиции упала
//   portfolio: баланс и открытые позиции для сверки (правда о деньгах)
//
// Предохранители (как у FOMI):
//   • PHONE_DRY_RUN=1 или BANK_MODE=paper — весь путь, но БЕЗ финального подтверждения
//   • перед подтверждением проверяем тикер и сумму на экране (текст интерфейса, иначе «глаза», 3 попытки)
//   • опасный экран (seed phrase, private key, export, адрес получателя) — назад и стоп
//   • сумма покупки не выше MAX_POSITION_USD; продаём только позиции, которые открыл мозг
//   • файл brain/data/STOP или режим admin=off — никаких действий
import { CFG } from "../../config.js";
import { phones, wait } from "../phones.js";
import { loadUi, resolvePkg, verify, readNumber } from "./common.js";
import { readPortfolio, readPositionValue, look } from "../vision.js";
import { solUsd, toUsd } from "../../sources/solprice.js";

const UI = loadUi("pumpfun");
const ph = phones[1];
ph.extraDanger = (UI.dangerWords || []).map((w) => w.toLowerCase());
ph.app = "pump.fun app";
const pkg = () => resolvePkg(ph, UI.package || CFG.phone.pkg.pump, "pump");
const S = UI.steps;
const LAUNCH_WAIT = UI.launchWaitMs || 6000;

// открыть лист сделки: большая кнопка ⇄ TICKER внизу страницы токена
async function openTradeSheet() {
  if (!(await ph.tapSel(S.tradeButton, "trade"))) throw new Error("trade button not mapped — calibrate ui/pumpfun.json");
  await wait(2200);
}

// сумма на встроенной клавиатуре приложения: стереть, потом набрать по цифре
async function keypadEnter(str) {
  const K = UI.keypad;
  const { w, h } = await ph.size();
  const tapKey = (k, label) => ph.tap(K[k][0] * w, K[k][1] * h, label);
  for (let i = 0; i < 6; i++) await tapKey("del", i ? "" : "clear");
  for (const ch of str) { if (!K[ch]) throw new Error(`no key "${ch}" on the keypad`); await tapKey(ch, ch); }
}

export async function openToken(address, symbol) {
  ph.step(`opening $${symbol} on pump.fun`);
  try {
    await ph.openUrl(UI.deepLink.replace("{CA}", address), await pkg());
    await wait(4500);
    if ((await verify(ph, { ticker: symbol, kind: "token page", app: "pump.fun app" })).ok) return;
  } catch (e) { if (/unsafe|STOP|admin/.test(e.message)) throw e; }
  ph.step("searching by contract");
  await ph.openApp(await pkg());
  await wait(LAUNCH_WAIT);
  if (!(await ph.tapSel(S.search, "search"))) throw new Error("search button not mapped — calibrate ui/pumpfun.json");
  await ph.tapSel(S.searchInput, "search field");
  await ph.type(address, "contract");
  await wait(3000);
  if (!(await ph.tapSel(S.firstResult, `$${symbol}`))) {
    const hit = await ph.find({ textAny: [symbol, `$${symbol}`] });
    if (!hit) throw new Error(`$${symbol} not found in search`);
    await ph.tap(hit.x, hit.y, `$${symbol}`);
  }
  await wait(3500);
  const v = await verify(ph, { ticker: symbol, kind: "token page", app: "pump.fun app" });
  if (!v.ok) throw new Error(`token page for $${symbol} did not open (${v.how}${v.saw ? ": saw " + JSON.stringify(v.saw) : ""})`);
}

// сумма в единицах приложения: доллары или SOL по текущей цене
async function amountFor(usd) {
  if (String(UI.amountUnit).toUpperCase() !== "SOL") return { str: String(Math.floor(usd * 100) / 100).replace(/\.0+$/, ""), unit: "$" };
  const px = await solUsd();
  if (!Number.isFinite(px)) throw new Error("no SOL price — can't size the order");
  return { str: (usd / px).toFixed(3).replace(/\.?0+$/, ""), unit: "SOL" };
}

export async function buy({ address, symbol, usd, thesis }) {
  if (usd > CFG.bank.maxPos + 0.01) throw new Error(`$${usd} above MAX_POSITION_USD — refused`);
  if (usd < CFG.bank.minOrder) throw new Error(`$${usd} below the app minimum — refused`);
  await openToken(address, symbol);
  await openTradeSheet();
  if (S.buyTab?.xy) await ph.tapSel(S.buyTab, "buy");        // переключатель Buy/Sell, если появится в листе
  // свободный баланс с экрана покупки: не тратим резерв, даже если мозг считает иначе
  const pre = await ph.screen();
  const solBal = readNumber(pre.all, /balance[:\s]*([\d,]+(?:\.\d+)?)\s*sol/i);
  const usdAvail = Number.isFinite(solBal) ? await toUsd(solBal, "SOL") : readNumber(pre.all, /\$\s*([\d,]+(?:\.\d+)?)\s*available/i);
  // в paper кошелёк может быть пустым — там баланс не проверяем
  if (CFG.bankMode === "live" && Number.isFinite(usdAvail) && usdAvail - usd < CFG.bank.reserve) {
    await ph.back();
    return { filled: false, noCash: true, available: +usdAvail.toFixed(2) };
  }
  const amt = await amountFor(usd);
  if (UI.keypad) await keypadEnter(amt.str);
  else {
    if (!(await ph.tapSel(S.amountInput, "amount", false))) throw new Error("amount field not found — calibrate ui/pumpfun.json");
    await ph.clearField();
    await ph.type(amt.str, `typing ${amt.unit === "$" ? "$" + amt.str : amt.str + " SOL"}`);
  }
  await wait(800);
  const v1 = await verify(ph, { ticker: symbol, amount: amt.str, kind: "BUY order sheet (amount entered, Submit button visible; NOT a sell sheet)", app: "pump.fun app" });
  if (v1.ok && v1.saw && v1.saw.screen === "sell") v1.ok = false;
  if (!v1.ok) { await ph.back(); throw new Error(`buy screen check failed for $${symbol} / ${amt.str} (${v1.how}${v1.saw ? ": saw " + JSON.stringify(v1.saw) : ""}) — aborted`); }
  if (CFG.phone.dryRun) {
    ph.step(`${CFG.bankMode === "paper" ? "paper" : "dry run"}: confirm skipped for $${symbol}`);
    await ph.back(); await wait(600); await ph.back();
    if (thesis) await postThesis(symbol, thesis, { dry: true }).catch(() => {});
    return { filled: false, dry: true };
  }
  if (!(await ph.tapSel(S.confirmBuy, `buy ${amt.unit === "$" ? "$" + amt.str : amt.str + " SOL"}`))) throw new Error("submit button not mapped — calibrate ui/pumpfun.json");
  await wait(2000);
  await ph.tapSel(S.confirmSheet, "confirm").catch(() => false);      // у некоторых версий есть второй шаг
  await wait(6000);
  let confirmed = false;
  for (let attempt = 0; attempt < 2 && !confirmed; attempt++) {
    if (attempt) await wait(6000);
    const after = await ph.screen().catch(() => ({ all: "" }));
    confirmed = UI.boughtWords.some((w) => after.all.includes(w.toLowerCase()));
    if (!confirmed) {
      const jpg = await ph.screenshot().catch(() => null);
      const v = jpg && await look(jpg, `A buy of ${symbol} was just submitted. ok=true only if the screen shows a success message or my holding of ${symbol}.`, "pump.fun app");
      confirmed = !!v?.ok;
    }
  }
  if (!confirmed) { ph.step(`can't confirm the $${symbol} buy, checking at the next sync`); return { filled: false, unconfirmed: true }; }
  ph.step(`bought $${symbol}`);
  const th = thesis ? await postThesis(symbol, thesis) : { ok: false, error: "no thesis" };
  return { filled: true, thesisPosted: th.ok, thesisError: th.error };
}

// Тезис в комментариях к токену. dry — набрать, но не отправлять (paper)
export async function postThesis(symbol, text, { dry = false } = {}) {
  try {
    await wait(1500);
    if (!(await ph.tapSel(S.commentsTab, "comments"))) await ph.scroll("down", 0.5);
    await wait(1500);
    if (!(await ph.tapSel(S.commentInput, "comment field"))) throw new Error("comment field not found");
    await wait(600);
    await ph.type(text.slice(0, 280), "thesis");
    await wait(1200);
    if (dry) { ph.step("paper: thesis typed, not posted"); await ph.back(); await ph.back(); return { ok: false, dry: true }; }
    await ph.tapSel(S.commentPost, "post thesis");
    await wait(3500);
    const done = await ph.screen();
    let ok = done.all.includes(text.slice(0, 24).toLowerCase());
    if (!ok) {
      const jpg = await ph.screenshot().catch(() => null);
      const v = jpg && await look(jpg, `Expected: the comments of ${symbol} with my new comment visible. ok=true only if it is visible.`, "pump.fun app");
      ok = !!v?.ok;
    }
    if (!ok) throw new Error("comment not visible after posting");
    ph.step(`thesis posted on $${symbol}`);
    return { ok: true };
  } catch (e) {
    ph.step(`thesis: ${e.message}`);
    await ph.back().catch(() => {});
    return { ok: false, error: e.message };
  }
}

async function positionUsd(symbol) {
  const jpg = await ph.screenshot().catch(() => null);
  const r = jpg ? await readPositionValue(jpg, symbol) : null;
  return r ? toUsd(r.value, r.unit) : null;
}

export async function sell({ address, symbol, pct }) {
  await openToken(address, symbol);
  const before = await positionUsd(symbol);
  await openTradeSheet();
  if (!(await ph.tapSel(S.sellTab, "sell"))) { await ph.back(); throw new Error("sell switch not found on the trade sheet — calibrate ui/pumpfun.json"); }
  await wait(1500);
  await ph.tapSel(pct >= 0.99 ? S.sell100 : S.sell50, pct >= 0.99 ? "100%" : "50%");
  const s1 = await ph.screen();
  if (/minimum|too small/.test(s1.all)) { await ph.back(); return { filled: false, stuck: true }; }
  await wait(800);
  const v1 = await verify(ph, { ticker: symbol, kind: "SELL order sheet (selling my holding; NOT a buy sheet)", app: "pump.fun app" });
  if (v1.ok && v1.saw && v1.saw.screen === "buy") v1.ok = false;
  if (!v1.ok) { await ph.back(); throw new Error(`sell screen check failed for $${symbol} (${v1.how}) — aborted`); }
  if (CFG.phone.dryRun) {
    ph.step(`${CFG.bankMode === "paper" ? "paper" : "dry run"}: would sell ${pct >= 0.99 ? "all" : "half"} of $${symbol}`);
    await ph.back(); await wait(600); await ph.back();
    return { filled: false, dry: true };
  }
  if (!(await ph.tapSel(S.confirmSell, `sell ${pct >= 0.99 ? "all" : "half"}`))) throw new Error("submit button not mapped — calibrate ui/pumpfun.json");
  await wait(2000);
  await ph.tapSel(S.confirmSheet, "confirm").catch(() => false);
  await wait(7000);
  await ph.back().catch(() => {}); await wait(1500);
  await openToken(address, symbol).catch(() => {});
  const after = await positionUsd(symbol);
  const sold = before == null || after == null ? null : after < before * (1 - pct * 0.6);
  if (sold === false) { ph.step(`sell of $${symbol} did not go through`); return { filled: false, unconfirmed: true }; }
  ph.step(`sold ${pct >= 0.99 ? "all" : "half"} of $${symbol}${sold === null ? " (unverified)" : ""}`);
  return { filled: true, verified: sold === true };
}

// Сверка: экран портфеля → баланс и ВСЕ позиции (с прокруткой). Суммы переводим в доллары.
export async function portfolio() {
  ph.step("checking my pump.fun balance");
  await ph.openApp(await pkg());
  await wait(LAUNCH_WAIT);
  if (!(await ph.tapSel(S.navPortfolio, "portfolio"))) throw new Error("portfolio tab not found — calibrate ui/pumpfun.json");
  await wait(4000);
  const seen = new Map();
  let cash = NaN, total = NaN, count = null;
  for (let page = 0; page < 4; page++) {
    const jpg = await ph.screenshot().catch(() => null);
    const v = jpg ? await readPortfolio(jpg) : null;
    if (v?.ok) {
      if (!Number.isFinite(cash) && v.cash != null && Number.isFinite(Number(v.cash))) cash = await toUsd(v.cash, v.cashUnit);
      if (!Number.isFinite(total) && v.total != null && Number.isFinite(Number(v.total))) total = await toUsd(v.total, v.totalUnit);
      count ??= Number(v.count) || null;
      for (const p of v.positions || []) {
        const key = String(p.ticker || p.name || "").toUpperCase();
        if (key && !seen.has(key)) seen.set(key, { name: String(p.name || ""), ticker: String(p.ticker || "").replace(/^\$/, "").toUpperCase(),
          value: (await toUsd(p.value, p.valueUnit)) || 0, pnlPct: Number(p.pnlPct) || 0 });
      }
    }
    if (count != null && seen.size >= count) break;
    await ph.scroll("down", 0.4);
    await wait(1500);
  }
  await ph.tapSel(S.navHome, "home").catch(() => {});
  const positions = [...seen.values()];
  // экран показывает только общую стоимость: свободные = всего − позиции (только если список прочитан целиком)
  if (!Number.isFinite(cash) && Number.isFinite(total) && (positions.length === 0 ? count === 0 || count == null : count != null && positions.length >= count))
    cash = total - positions.reduce((a, p) => a + (p.value || 0), 0);
  if (!Number.isFinite(cash) || cash < 0) return null;
  return { cash, count, positions, closed: [], complete: count != null && positions.length >= count };
}

// простой: открыть ленту pump.fun и пролистать
export async function idle() {
  const s = await ph.screen().catch(() => ({ all: "" }));
  if (!s.all) { await ph.openApp(await pkg()); await wait(LAUNCH_WAIT); }
  ph.step("browsing the pump.fun board");
  await ph.scroll("down", 0.35);
}
