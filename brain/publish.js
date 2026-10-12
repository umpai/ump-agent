// Состояние для сайта (GET /state и событие state в /events). Формат описан в docs/index.html.
// Только реальные цифры: банк, позиции, сделки, решения и мысли берутся из памяти мозга.
import { CFG } from "./config.js";
import { equity, priceOf, levels, exitsOf } from "./bank.js";
import { stats, loadEvents, loadDecisions } from "./memory.js";
import { emit } from "./bus.js";
import { getPlaybook } from "./playbook.js";
import { getFocus, getSteps } from "./live/screens.js";
import { load, save } from "./store.js";

export let lastState = null;

// История equity для графика PnL: снимок не чаще раза в минуту; последние 48 часов — поминутно,
// старше — по одной точке на 15 минут. Только с момента запуска банка (launch).
function recordEquity(eq, since) {
  const h = load("equity", []).filter((p) => p.t >= since);
  const now = Date.now(), last = h[h.length - 1];
  if (last && now - last.t < 60e3) { last.e = eq; }
  else h.push({ t: now, e: eq });
  const cut = now - 48 * 3600e3, out = [];
  let bucket = -1;
  for (const p of h) {
    if (p.t >= cut) { out.push(p); continue; }
    const b = Math.floor(p.t / (15 * 60e3));
    if (b !== bucket) { out.push(p); bucket = b; } else out[out.length - 1] = p;
  }
  save("equity", out.slice(-12000));
  return out;
}
const r2 = (x) => +(+x || 0).toFixed(2);
const r1 = (x) => +(+x || 0).toFixed(1);

// событие журнала → мысль в ленте «ump says» (или null, если это шум)
export function toThought(e) {
  if (!e || !e.type) return null;
  const sym = e.symbol ? `$${e.symbol}` : "";
  const t = e.t || Date.now();
  switch (e.type) {
    case "thought": return { text: e.text, kind: e.kind || "think", t };
    case "buy": return { text: e.text || `bought ${sym} for $${e.size}`, kind: "buy", t };
    case "dry-run": return { text: e.text || `dry run on ${sym}`, kind: "think", t };
    case "exit": return { text: e.text || `${e.paper || CFG.bankMode === "paper" ? "paper " : ""}sold ${e.pct >= 0.99 ? "all" : Math.round(e.pct * 100) + "%"} of ${sym} (${e.reason}), ${e.pnlPct >= 0 ? "+" : ""}${(e.pnlPct * 100).toFixed(1)}%`, kind: "sell", t };
    case "error": case "stuck": return { text: e.text, kind: "warn", t };
    case "learn": case "review": case "sync": case "thesis": return e.text ? { text: e.text, kind: "think", t } : null;
    default: return null;
  }
}

export function publish(bank, brain, journal, prices, control = { mode: "on" }) {
  const eq = equity(bank, prices);
  const since = bank.launchedAt || 0;
  const positions = bank.positions.map((p) => {
    const px = priceOf(prices.get(p.address)) || p.lastPrice || p.entryPrice;
    const E = exitsOf(p), L = levels(p);
    return {
      ticker: p.symbol, ca: p.address, size: r2(p.size), remaining: +p.remaining.toFixed(2),
      value: r2(p.tokens * p.remaining * px), pnlPct: r1((px / p.entryPrice - 1) * 100), openedAt: p.openedAt,
      plan: { stop: Math.round((L.sl / p.entryPrice - 1) * 100), tp1: Math.round(E.tp1 * 100), tp2: Math.round(E.tp2 * 100), tp1Done: !!p.tp1Done },
      thesis: p.thesis || "", note: p.plan?.note || "", paper: !!p.paper || bank.mode === "paper",
    };
  });
  const trades = journal.filter((t) => (t.closedAt || 0) > since).slice(-60).map((t) => ({
    ticker: t.symbol, size: r2(t.size), pnlPct: r1((t.pnlPct || 0) * 100), pnlUsd: r2(t.pnl), reason: String(t.reason || "").slice(0, 60),
    closedAt: t.closedAt, verified: t.truth === "app", paper: !!t.paper,
  }));
  const events = loadEvents();
  const lastScan = [...events].reverse().find((e) => e.type === "scan");
  const st = stats(journal.filter((t) => (t.closedAt || 0) > since));
  const pb = getPlaybook();
  const curve = recordEquity(r2(eq), since);
  const state = {
    updatedAt: Date.now(),
    name: CFG.name,
    mode: CFG.bankMode,                                   // paper | live
    control: control.mode,                                // on | pause | off
    dryRun: CFG.phone.dryRun,
    bank: { start: r2(bank.start), equity: r2(eq), cash: r2(bank.cash), dayPnl: r2(bank.day.pnl), realized: r2(bank.realized),
      halted: !!bank.halted, lastSync: bank.lastSync || 0 },
    positions,
    external: bank.external || [],
    trades,
    decisions: loadDecisions().slice(-12),
    thoughts: events.map(toThought).filter(Boolean).slice(-8),
    rules: { posMin: CFG.bank.minPos, posMax: CFG.bank.maxPos, reserve: CFG.bank.reserve, dayLossLimit: CFG.bank.dailyLossLimit,
      haltBelow: CFG.bank.haltEquity, maxTweetsPerHour: CFG.x.maxPerHour },
    playbook: (pb.rules || []).map((r, i) => `${i + 1}. ${r}`).join("\n") + (pb.changes ? `\n\nv${pb.version}: ${pb.changes}` : ""),
    stats: { trades: st.trades, winrate: st.winrate, profitFactor: st.profitFactor },
    brain: { generation: brain.generation, threshold: brain.threshold, weights: brain.weights },
    phones: getSteps(),
    focus: getFocus(),
    lastScanAt: lastScan?.t || null,
    equity: curve.map((p) => [p.t, p.e]),               // [время, equity] — только в /state, не в SSE
    links: { x: CFG.links.x, github: CFG.links.github, pump: CFG.links.pump, contract: CFG.links.contract, site: CFG.links.site },
  };
  lastState = state;
  const { equity: _curve, ...light } = state;
  emit("state", { state: light });
  return state;
}
