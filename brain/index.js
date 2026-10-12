// UMP brain — главный цикл (механика FOMI, исполнение на трёх телефонах).
//   node brain/index.js          — крутится бесконечно (тик раз в TICK_SECONDS)
//   node brain/index.js --once   — один тик
//
// Один токен проходит так:
//   скан (GMGN + DexScreener) → жёсткие фильтры → скор
//   → #2 SCOPE показывает токен на gmgn → #3 SOCIAL проверяет X проекта
//   → решение модели (DeepSeek) → #1 TRADE покупает и пишет тезис → #3 SOCIAL постит о позиции
// Выходы (стоп, тейки, трейлинг, profit lock, time stop) проверяются каждые 20 секунд и перебивают всё остальное.
import { CFG } from "./config.js";
import * as dex from "./sources/dexscreener.js";
import * as mock from "./sources/mock.js";
import { research } from "./research.js";
import { SIGNALS, passesFilters, computeSignals, score } from "./signals.js";
import { loadBrain, learnFromTrade, addLesson } from "./learn.js";
import { decide, reviewPosition, reflect } from "./llm.js";
import { lastCounts } from "./sources/gmgn.js";
import { maybeRewrite } from "./playbook.js";
import { loadBank, saveBank, equity, gate, sizeFor, exitCheck, recordClose, priceOf, valueOf } from "./bank.js";
import { loadJournal, saveJournal, stats, pushEvent, pushDecision, loadDecisions, think } from "./memory.js";
import { getControl } from "./control.js";
import { load, save } from "./store.js";
import { publish } from "./publish.js";
import { lookAt, postAbout } from "./conductor.js";

const market = CFG.mock ? mock : dex;
const exec = await import(`./executor/${CFG.executor}.js`);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "│", ...a);
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "m" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : Math.round(n || 0) + "");
const ageTxt = (m) => (m >= 99999 ? "" : m < 60 ? Math.round(m) + "m" : m < 1440 ? (m / 60).toFixed(0) + "h" : (m / 1440).toFixed(0) + "d");
const pct = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(0) + "%";
const sgn = (x) => (x >= 0 ? "+" : "") + Math.round(x || 0);

async function manageOpen(bank, journal, prices) {
  // тезисы, которые не встали при покупке: до 3 попыток, по одной за тик
  if (exec.retryThesis) for (const pos of bank.positions) {
    if (pos.thesis && !pos.thesisPosted && (pos.thesisTries || 0) < 3) {
      pos.thesisTries = (pos.thesisTries || 0) + 1;
      const r = await exec.retryThesis(pos).catch((e) => ({ ok: false, error: e.message }));
      pos.thesisPosted = !!r.ok;
      pushEvent(r.ok ? { type: "thesis", symbol: pos.symbol, text: `thesis posted on $${pos.symbol}` }
        : { type: "error", text: `thesis for $${pos.symbol} failed (try ${pos.thesisTries}/3): ${r.error}` });
      break;
    }
  }
  for (const pos of [...bank.positions]) {
    const t = prices.get(pos.address);
    if (!t) continue;
    const price = priceOf(t);
    pos.lastPrice = price;
    pos.lastMcap = t.mcap || t.fdv || pos.lastMcap;
    // после неподтверждённой продажи не продаём повторно, пока сверка не покажет, прошла она или нет
    if (pos.pendingSell && Date.now() - pos.pendingSell.at < 5 * 60e3) continue;
    const ex = exitCheck(pos, price);
    if (!ex) continue;
    if (ex.stuck) {
      if (!pos.stuckNoted) { pushEvent({ type: "stuck", symbol: pos.symbol, text: `$${pos.symbol} is worth under $${CFG.bank.minOrder}, the app won't sell it. holding` }); pos.stuckNoted = true; }
      continue;
    }
    let res;
    try { res = await exec.sell(bank, pos, ex.pct, t, ex.reason); }
    catch (e) { bank.needSync = true; pushEvent({ type: "error", text: `sell $${pos.symbol} failed: ${e.message}` }); log("sell failed", e.message); continue; }
    if (!res.filled) {
      if (res.unconfirmed) {
        bank.needSync = true;
        if (ex.pct >= 0.99) pos.pendingSell = { at: Date.now(), price, reason: ex.reason, mcap: pos.lastMcap || 0 };
        pushEvent({ type: "error", text: `sell $${pos.symbol} (${ex.reason}) not confirmed in the app, checking at the next sync` });
      }
      log("sell not filled", pos.symbol, ex.reason, res.dry ? "(dry run)" : ""); continue;
    }
    if (ex.reason === "tp1") pos.tp1Done = true;
    if (ex.reason === "moon") pos.moonDone = true;
    delete pos.pendingSell;
    (pos.partials ||= []).push({ at: Date.now(), pct: ex.pct, pnlPct: +(price / pos.entryPrice - 1).toFixed(4), reason: ex.reason, mcap: pos.lastMcap || 0 });
    pushEvent({ type: "exit", symbol: pos.symbol, reason: ex.reason, pct: ex.pct, pnlPct: price / pos.entryPrice - 1, paper: !!res.paper });
    log("exit", pos.symbol, ex.reason, `${(ex.pct * 100).toFixed(0)}%`);
    if (pos.remaining <= 0.001) closePosition(bank, journal, pos, ex.reason);
  }
}

// Ревью держимых токенов раз в REVIEW_EVERY_MIN: если тезис сломался — выходим, не дожидаясь стопа
async function reviewOpen(bank, journal, prices, scanned) {
  for (const pos of [...bank.positions]) {
    if (Date.now() - pos.openedAt < 15 * 60e3 || Date.now() - (pos.reviewedAt || 0) < CFG.brain.reviewEveryMin * 60e3) continue;
    const t = scanned.find((x) => x.address === pos.address) || prices.get(pos.address);
    if (!t || !t.priceUsd) continue;
    pos.reviewedAt = Date.now();
    const r = await reviewPosition(pos, t);
    if (!r) continue;
    pos.lastReview = r;
    pushEvent({ type: "review", symbol: pos.symbol, text: `$${pos.symbol}: ${r.action === "EXIT" ? "getting out" : "holding"}, ${r.reason}` });
    if (r.action !== "EXIT") continue;
    if (valueOf(pos, priceOf(t)) < CFG.bank.minOrder) { pushEvent({ type: "stuck", text: `$${pos.symbol}: wants out but it's under $${CFG.bank.minOrder}` }); continue; }
    let res;
    try { res = await exec.sell(bank, pos, 1, t, "thesis broken"); } catch (e) { bank.needSync = true; pushEvent({ type: "error", text: `sell $${pos.symbol} failed: ${e.message}` }); continue; }
    if (!res.filled) continue;
    (pos.partials ||= []).push({ at: Date.now(), pct: 1, pnlPct: +(priceOf(t) / pos.entryPrice - 1).toFixed(4), reason: "thesis broken: " + r.reason, mcap: t.mcap || 0 });
    pushEvent({ type: "exit", symbol: pos.symbol, reason: "thesis broken", pct: 1, pnlPct: priceOf(t) / pos.entryPrice - 1, paper: !!res.paper });
    closePosition(bank, journal, pos, `thesis broken: ${r.reason}`);
  }
}

export function closePosition(bank, journal, pos, reason) {
  bank.positions = bank.positions.filter((p) => p.id !== pos.id);
  const pnl = +(pos.realized || 0).toFixed(4);
  const pnlPct = +(pnl / pos.size).toFixed(4);
  const trade = { symbol: pos.symbol, address: pos.address, name: pos.name || "", size: pos.size, pnl, pnlPct, reason,
    openedAt: pos.openedAt, closedAt: Date.now(), score: pos.score, signals: pos.signals, thesis: pos.thesis, paper: !!pos.paper || CFG.bankMode === "paper",
    entryMcap: pos.entryMcap || 0, exitMcap: pos.lastMcap || 0, plan: pos.plan?.note || "", partials: pos.partials || [], exits: pos.plan?.exits || null };
  journal.push(trade);
  recordClose(bank, pnl);
  learnFromTrade(trade, journal);
  reflect(trade).then((r) => { if (r) { addLesson(r); pushEvent({ type: "learn", text: `lesson: ${r}` }); } }).catch(() => {});
  log("closed", pos.symbol, pnlPct, reason);
}

// Станции Decision Rail: trend → chart → x check → safety. Только реальные цифры токена.
function stations(t, sig, xc) {
  const vol = t.vol?.h1, h1 = +t.chg.h1 || 0, m5 = +t.chg.m5 || 0, b = t.txns.h1.b, s = t.txns.h1.s, g = t.gmgn || {};
  const ratio = s ? (b / s).toFixed(1) : b ? "all buys" : "–";
  const knife = h1 < -25 && m5 < 0, blow = h1 > 300 && m5 < 0;
  const XV = { ok: "pass", weak: "warn", none: "warn", fake: "fail" };
  return [
    { id: "trend", verdict: sig.volume >= 0.5 && sig.momentum >= 0.35 ? "pass" : sig.volume >= 0.25 ? "warn" : "fail",
      note: `vol 1h ${vol != null ? "$" + k(vol) : "n/a"}, h1 ${sgn(h1)}%` },
    { id: "chart", verdict: knife || blow ? "fail" : sig.buyers >= 0.5 ? "pass" : "warn",
      note: knife ? "falling knife" : blow ? "blow-off top" : `5m ${sgn(m5)}%, buyers ${ratio}${s ? ":1" : ""}` },
    { id: "x", verdict: XV[xc?.verdict] || "warn", note: xc?.notes || "not checked" },
    { id: "safety", verdict: sig.safety >= 0.6 ? "pass" : sig.safety >= 0.45 ? "warn" : "fail",
      note: [g.top10 != null && `top10 ${(g.top10 * 100).toFixed(0)}%`, g.rug != null && `rug ${(+g.rug).toFixed(2)}`,
        g.mintRenounced && g.freezeRenounced ? "mint & freeze off" : g.mintRenounced === false ? "mint on" : ""].filter(Boolean).join(", ") || "no gmgn data" },
  ];
}

async function hunt(bank, journal, brain, prices, paused) {
  const eq = equity(bank, prices);
  const blocked = paused ? "paused by admin" : gate(bank, eq);
  const scanned = await market.scan();
  pushEvent({ type: "scan", source: CFG.mock ? "mock" : scanned[0]?.source || "dexscreener", count: scanned.length });
  log(`scanned ${scanned.length} tokens`, JSON.stringify(lastCounts));
  for (const [kk, v] of Object.entries(lastCounts)) if (typeof v !== "number") pushEvent({ type: "error", text: `gmgn ${kk} failed: ${v}` });
  await reviewOpen(bank, journal, prices, scanned);

  const held = new Set(bank.positions.map((p) => p.address));
  const seen = load("seen", {});
  const cooldown = CFG.brain.researchCooldownMin * 60e3;
  const lastLook = (t) => { const v = seen[t.address]; return v == null ? null : typeof v === "number" ? { at: v, mc: 0 } : v; };
  const moved = (t) => { const l = lastLook(t), mc = t.mcap || t.fdv || 0;
    return l && l.mc > 0 && mc > 0 && Date.now() - l.at > 4 * 60e3 && Math.abs(mc / l.mc - 1) * 100 >= CFG.brain.relookMovePct; };
  const fresh = (t) => { const l = lastLook(t); return !l || Date.now() - l.at > cooldown || moved(t); };
  const ranked = scanned
    .filter((t) => !held.has(t.address))
    .map((t) => ({ t, why: passesFilters(t) }))
    .map((x) => ({ ...x, pre: x.why ? 0 : score(computeSignals(x.t), brain.weights) }))
    .sort((a, b) => b.pre - a.pre);
  const pool = ranked.filter((x) => !x.why && fresh(x.t));
  const picks = [...pool.filter((x) => !lastLook(x.t)), ...pool.filter((x) => lastLook(x.t))].slice(0, Math.max(1, CFG.brain.picksPerScan));
  const pass = ranked.filter((x) => !x.why).length;
  if (!picks.length) { log("no fresh candidates this scan"); return; }
  think(`scan: ${scanned.length} coins, ${pass} pass the filters. looking at ${picks.map((x) => "$" + x.t.symbol).join(", ")}.`);

  const st = { ...stats(journal.filter((x) => (x.closedAt || 0) > (bank.launchedAt || 0))), since: bank.launchedAt || 0 };
  const lastEntry = Math.max(0, ...(bank.entryTimes || []), bank.launchedAt || 0);
  st.idleH = lastEntry ? (Date.now() - lastEntry) / 3600e3 : null;
  let entered = 0;

  for (const [pi, { t, pre }] of picks.entries()) {
    // разбор на телефонах идёт минутами — между токенами проверяем выходы по открытым позициям
    if (pi > 0 && bank.positions.length) {
      try { await manageOpen(bank, journal, await market.quotes(bank.positions.map((p) => p.address))); } catch (e) { log("exit check in scan:", e.message); }
    }
    const prev = lastLook(t);
    if (prev?.mc > 0) t.origin = `${t.origin || "trending"} · second look: mcap ${pct((t.mcap || t.fdv || 0) / prev.mc - 1)} since my last look ${Math.round((Date.now() - prev.at) / 60000)}m ago`;
    seen[t.address] = { at: Date.now(), mc: t.mcap || t.fdv || 0 };
    save("seen", Object.fromEntries(Object.entries(seen).filter(([, v]) => Date.now() - (typeof v === "number" ? v : v.at) < 24 * 3600e3)));

    const rs = await research(t);
    // телефоны смотрят только на тех, кто вообще может пройти к модели (скор не ниже порога − 15)
    const worthALook = pre >= brain.threshold - 15;
    const xc = worthALook ? await lookAt(t, rs) : { verdict: rs.twitter ? "weak" : "none", notes: "score too low to check" };
    if (worthALook && xc.checked) think(`$${t.symbol} x check: ${xc.verdict}, ${xc.notes}.`, xc.verdict === "fake" ? "warn" : "think");
    const sig = computeSignals(t, { xcheck: xc });
    const sc = score(sig, brain.weights);
    const d = await decide(t, sig, sc, brain, st, rs, xc);
    let action = d.decision, size = null;

    if (action === "ENTER") {
      const why2 = blocked || (entered >= CFG.bank.maxEntriesPerTick ? "max entries this round" : null) || gate(bank, eq);
      const bankMax = why2 ? null : sizeFor(bank, eq, 1, t.address);
      size = bankMax ? Math.min(d.size || sizeFor(bank, eq, d.conviction, t.address) || bankMax, bankMax) : null;
      if (!size) { action = "SKIP"; d.veto = d.veto || "bank"; d.risks = [...(d.risks || []), why2 || "bank says no"]; }
    }
    const e = { ...CFG.exits, ...(d.exits || {}) };
    const mc = t.mcap || t.fdv || 0;
    const plan = action === "ENTER" ? {
      entryMcap: mc, size, exits: d.exits || null, chosen: !!d.exits,
      sl: { pct: e.stopLoss, mcap: mc * (1 + e.stopLoss) },
      tp1: { pct: e.tp1, mcap: mc * (1 + e.tp1), sell: e.tp1Sell },
      tp2: { pct: e.tp2, mcap: mc * (1 + e.tp2) },
      trail: e.trail, timeStopH: e.timeStopH, note: d.plan || "",
    } : null;

    const skipWhy = action === "SKIP" ? (d.risks || []).slice(-1)[0] || d.mind : "";
    pushDecision({
      ticker: t.symbol, address: t.address, mcap: mc ? "$" + k(mc) : "", age: ageTxt(t.ageMin),
      score: sc, threshold: brain.threshold, verdict: action === "ENTER" ? "buy" : "skip", size, veto: action === "SKIP" ? (d.veto || (sc < brain.threshold ? "below_threshold" : "")) : "",
      reason: action === "ENTER" ? d.plan || d.mind || "" : skipWhy || "", mind: d.mind || "", stations: stations(t, sig, xc),
      thesis: action === "ENTER" ? d.thesis : "", plan, by: d.by,
      signals: Object.fromEntries(SIGNALS.map((s) => [s, +sig[s].toFixed(3)])),
    });
    if (d.mind) think(`$${t.symbol}: ${d.mind}`, action === "ENTER" ? "think" : "think");
    log(`$${t.symbol} score ${sc}/${brain.threshold} → ${action}${size ? " $" + size : ""} (${d.by})`);

    if (action !== "ENTER") continue;
    let res;
    const entryGmgn = t.gmgn ? { smart: t.gmgn.smart, holders: t.gmgn.holders, top10: t.gmgn.top10, kol: t.gmgn.kol } : null;
    try { res = await exec.buy(bank, t, size, { signals: sig, score: sc, thesis: d.thesis, plan, entryGmgn, name: t.gmgn?.name || t.name || "" }); }
    catch (err) { pushEvent({ type: "error", text: `buy $${t.symbol} failed: ${err.message}` }); log("buy failed", err.message); continue; }
    bank.lastEntry[t.address] = Date.now();
    if (res.filled || res.order) { bank.entryTimes.push(Date.now()); entered++; }
    if (res.noCash) { bank.needSync = true; pushEvent({ type: "error", text: `skip $${t.symbol}: the app shows only $${res.available} free, keeping the reserve` }); continue; }
    if (res.thesisError) pushEvent({ type: "error", text: `thesis for $${t.symbol} failed: ${res.thesisError}, will retry` });
    if (res.unconfirmed) {
      bank.needSync = true;
      (bank.pendingBuys ||= []).push({ address: t.address, symbol: t.symbol, name: t.gmgn?.name || t.name || "", url: t.url, size,
        price: priceOf(t), mcap: t.mcap || t.fdv || 0, at: Date.now(), checks: 0, meta: { signals: sig, score: sc, thesis: d.thesis, plan } });
      bank.entryTimes.push(Date.now()); entered++;
      pushEvent({ type: "error", text: `buy $${t.symbol} $${size} sent but not confirmed on screen, checking the app` });
      continue;
    }
    if (res.dry) { pushEvent({ type: "dry-run", symbol: t.symbol, size, text: `dry run: walked the whole $${t.symbol} buy, confirm skipped` }); continue; }
    if (!res.filled) continue;
    pushEvent({ type: "buy", symbol: t.symbol, size, paper: !!res.paper || CFG.bankMode === "paper",
      text: `${CFG.bankMode === "paper" ? "paper buy" : "bought"} $${t.symbol} for $${size}. ${d.plan || ""}`.trim() });
    if (CFG.bankMode === "live") bank.needSync = true;
    await postAbout(t.symbol, d.post || d.thesis, size, { dry: CFG.bankMode === "paper" || CFG.phone.dryRun, ca: t.address });
  }
}

// Сверка с приложением pump.fun (только live): раз в SYNC_MINUTES и сразу после любой неподтверждённой сделки.
// Приложение — источник правды по деньгам: кэш берём оттуда, позиции сопоставляем по тикеру/названию.
export async function syncWithApp(bank, journal, force = false) {
  if (CFG.bankMode !== "live" || !exec.portfolio) return null;
  const due = Date.now() - (bank.lastSync || 0) > CFG.brain.syncEveryMin * 60e3;
  if (!force && !due && !bank.needSync) return null;
  let pf;
  try { pf = await exec.portfolio(); } catch (e) { pushEvent({ type: "error", text: `pump.fun sync failed: ${e.message}` }); return null; }
  if (!pf || !Number.isFinite(pf.cash)) { pushEvent({ type: "error", text: "pump.fun sync: couldn't read the balance" }); return null; }
  const before = bank.cash;
  // резкий скачок кэша без наших сделок может быть ошибкой чтения экрана — применяем, только если повторная сверка покажет то же
  const jump = Math.abs(pf.cash - before) > Math.max(3, before * 0.3);
  if (jump && !(bank.pendingCash && Math.abs(bank.pendingCash - pf.cash) < Math.max(0.3, pf.cash * 0.05))) {
    bank.pendingCash = pf.cash; bank.needSync = true;
    pushEvent({ type: "sync", text: `the app shows cash $${pf.cash.toFixed(2)} vs my $${before.toFixed(2)}, re-checking before I trust it` });
    return null;
  }
  bank.pendingCash = null;
  bank.cash = +pf.cash.toFixed(2);
  bank.lastSync = Date.now(); bank.needSync = false;
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const matched = new Set();
  for (const pos of [...bank.positions]) {
    const f = pf.positions.find((q, i) => !matched.has(i) && (norm(q.ticker) === norm(pos.symbol) || (pos.name && norm(q.name) === norm(pos.name))));
    if (f) {
      matched.add(pf.positions.indexOf(f)); pos.appValue = f.value; pos.missing = 0;
      if (pos.pendingSell) { delete pos.pendingSell; pushEvent({ type: "sync", text: `$${pos.symbol} is still in the app, the last sell didn't go through. will try again` }); }
      // калибровка цены входа по приложению — не дальше ±15% от цены покупки (урок FOMI)
      const mcRef = pos.entryMcap > 0 && pos.lastMcap > 0 && pos.lastPrice > 0 ? pos.entryMcap * pos.lastPrice / pos.lastMcap : 0;
      if (pos.buyPrice == null) pos.buyPrice = pos.calibratedAt ? (mcRef || pos.entryPrice) : pos.entryPrice;
      if (f.value > 0 && pos.lastPrice > 0 && pos.remaining > 0) {
        const tokens = f.value / (pos.remaining * pos.lastPrice);
        const cand = pos.size / tokens;
        const ref = pos.buyPrice || cand;
        if (Math.abs(cand / ref - 1) <= 0.15) { pos.tokens = tokens; pos.entryPrice = cand; }
        else { pos.entryPrice = ref; pos.tokens = (pos.size * (1 - CFG.bank.feePct)) / ref; }
        pos.calibratedAt = Date.now();
      }
      continue;
    }
    if (!pf.complete) continue;                              // список прочитан не целиком — ничего не закрываем
    const ps = pos.pendingSell;
    if (ps && Date.now() - ps.at < 6 * 3600e3) {
      const proceeds = pos.tokens * pos.remaining * ps.price * (1 - CFG.bank.feePct);
      pos.realized = (pos.realized || 0) + proceeds - pos.size * pos.remaining;
      (pos.partials ||= []).push({ at: ps.at, pct: pos.remaining, pnlPct: +(ps.price / pos.entryPrice - 1).toFixed(4), reason: ps.reason, mcap: ps.mcap });
      pos.remaining = 0; pos.lastMcap = ps.mcap || pos.lastMcap;
      pushEvent({ type: "exit", symbol: pos.symbol, reason: ps.reason, pct: 1, pnlPct: ps.price / pos.entryPrice - 1, text: `$${pos.symbol}: the ${ps.reason} sell did go through, the app no longer shows it` });
      closePosition(bank, journal, pos, ps.reason);
      continue;
    }
    pos.missing = (pos.missing || 0) + 1;
    if (pos.missing >= 3) {
      const lastValue = pos.appValue ?? valueOf(pos, pos.lastPrice || pos.entryPrice);
      pos.realized = (pos.realized || 0) + lastValue - pos.size * pos.remaining;
      pushEvent({ type: "error", text: `$${pos.symbol} is no longer in the app, closing it in my books` });
      closePosition(bank, journal, pos, "gone from the app");
    }
  }
  for (const pb of [...(bank.pendingBuys || [])]) {
    const i = pf.positions.findIndex((q, kk) => !matched.has(kk) && (norm(q.ticker) === norm(pb.symbol) || (pb.name && norm(q.name) === norm(pb.name))));
    if (i >= 0) {
      matched.add(i);
      const entryPrice = pb.price || 1e-9;
      bank.positions.push({ id: "p" + Date.now().toString(36), address: pb.address, symbol: pb.symbol, name: pb.name, url: pb.url,
        entryPrice, entryMcap: pb.mcap, lastPrice: entryPrice, size: pb.size, tokens: (pb.size * (1 - CFG.bank.feePct)) / entryPrice,
        remaining: 1, peak: entryPrice, tp1Done: false, openedAt: pb.at, via: "phone", thesisPosted: false, thesisTries: 0,
        appValue: pf.positions[i].value, ...pb.meta });
      bank.pendingBuys = bank.pendingBuys.filter((x) => x !== pb);
      bank.lastEntry[pb.address] = pb.at;
      pushEvent({ type: "buy", symbol: pb.symbol, size: pb.size, text: `found $${pb.symbol} in the app, the buy did go through. tracking it now` });
    } else if (++pb.checks >= 2) {
      bank.pendingBuys = bank.pendingBuys.filter((x) => x !== pb);
      pushEvent({ type: "sync", text: `$${pb.symbol} buy didn't go through, nothing in the app` });
    }
  }
  // токен в кошельке, который он сам решил купить за последние сутки (но покупка не записалась) — его позиция
  const recent = loadDecisions().filter((e) => e.verdict === "buy" && e.address && Date.now() - e.t < 24 * 3600e3);
  const orphans = pf.positions.map((q, i) => ({ q, i })).filter(({ i }) => !matched.has(i))
    .map(({ q, i }) => ({ q, i, ep: recent.slice().reverse().find((e) => norm(e.ticker) === norm(q.ticker)) })).filter((x) => x.ep);
  if (orphans.length) {
    const quotes = await market.quotes(orphans.map((x) => x.ep.address)).catch(() => new Map());
    for (const { q, i, ep } of orphans) {
      const px = priceOf(quotes.get(ep.address));
      if (!px) continue;
      matched.add(i);
      const cost = q.value / (1 + (q.pnlPct || 0) / 100);
      const tokens = q.value / px;
      bank.positions.push({ id: "p" + Date.now().toString(36) + i, address: ep.address, symbol: ep.ticker, name: q.name, url: "",
        entryPrice: cost / tokens, entryMcap: (quotes.get(ep.address)?.mcap || 0) / (1 + (q.pnlPct || 0) / 100), lastPrice: px,
        size: +cost.toFixed(2), tokens, remaining: 1, peak: Math.max(px, cost / tokens), tp1Done: false, openedAt: ep.t, via: "phone",
        thesis: ep.thesis, plan: ep.plan, signals: ep.signals, score: ep.score, thesisPosted: true, appValue: q.value, adopted: true });
      bank.lastEntry[ep.address] = ep.t;
      pushEvent({ type: "buy", symbol: ep.ticker, text: `found $${ep.ticker} in my wallet ($${q.value.toFixed(2)}), it's mine. managing it now` });
    }
  }
  bank.external = pf.positions.filter((_, i) => !matched.has(i)).map((q) => ({ name: q.name, ticker: q.ticker, value: q.value, pnlPct: q.pnlPct }));
  pushEvent({ type: "sync", text: `synced with pump.fun: cash $${bank.cash.toFixed(2)} (was $${before.toFixed(2)})` +
    (bank.external.length ? `. not mine: ${bank.external.map((q) => q.ticker || q.name).join(", ")}` : "") });
  log(`app sync: cash $${before} → $${bank.cash}, untracked ${bank.external.length}`);
  return pf;
}

export async function tick() {
  const control = getControl();
  const bank = loadBank();
  const journal = loadJournal();
  const brain = loadBrain();
  let prices = new Map();
  if (control.mode !== "off") {
    try {
      await syncWithApp(bank, journal);
      await maybeRewrite(journal).catch(() => {});
      prices = await market.quotes(bank.positions.map((p) => p.address));
      await manageOpen(bank, journal, prices);
      await hunt(bank, journal, brain, prices, control.mode === "pause");
    } catch (e) {
      log("tick error:", e.message);
      pushEvent({ type: "error", text: e.message });
    }
  }
  saveBank(bank);
  saveJournal(journal);
  const s = publish(bank, loadBrain(), journal, prices, control);
  log(`[${control.mode}/${CFG.bankMode}] equity $${s.bank.equity} · open ${s.positions.length} · gen ${loadBrain().generation}`);
}

// Быстрая проверка стопов и тейков между сканами
export async function exitsTick() {
  const control = getControl();
  if (control.mode === "off") return;
  const bank = loadBank();
  if (!bank.positions.length) return;
  const journal = loadJournal();
  try {
    const prices = await market.quotes(bank.positions.map((p) => p.address));
    await manageOpen(bank, journal, prices);
    saveBank(bank); saveJournal(journal);
    publish(bank, loadBrain(), journal, prices, control);
  } catch (e) { log("exit check error:", e.message); }
}

export async function runForever() {
  const fast = Math.max(10, Number(process.env.EXIT_CHECK_SECONDS) || 20);
  for (;;) {
    await tick();
    const until = Date.now() + CFG.tickSeconds * 1000;
    while (Date.now() + fast * 1000 < until) { await new Promise((r) => setTimeout(r, fast * 1000)); await exitsTick(); }
    await new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())));
  }
}

if (process.argv[1]?.endsWith("index.js")) {
  log(`ump brain online · bank=${CFG.bankMode} · executor=${CFG.executor} · dryRun=${CFG.phone.dryRun} · mock=${CFG.mock} · llm=${CFG.llm.key ? CFG.llm.model : "rules"}`);
  if (process.argv.includes("--once")) await tick();
  else await runForever();
}
