// GMGN через официальный gmgn-cli (https://github.com/GMGNAI/gmgn-skills).
// Для чтения нужен только GMGN_API_KEY (ключ с правом Reading). Торговля через GMGN не используется.
// Даёт то, чего нет на DexScreener: smart money / KOL, rug ratio, топ-10 холдеров, wash trading, бандлеры, статус дева.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CFG, ROOT } from "../config.js";

const local = path.join(ROOT, "node_modules", ".bin", "gmgn-cli");
const bin = fs.existsSync(local) ? [local, []] : ["npx", ["--yes", "gmgn-cli"]];

export const enabled = () => !!process.env.GMGN_API_KEY && !CFG.mock;

// GMGN считает лимит «ведром»: на бесплатном ключе ~5 единиц в секунду, тренды стоят 3, trenches 2.
// Поэтому запросы идут строго по одному, с паузой, а короткий бан cli переждёт сам (до 20 с).
let lastCall = 0;
async function cli(args) {
  const gap = 1500 - (Date.now() - lastCall);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  lastCall = Date.now();
  const env = { GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS: "20000", ...process.env };
  return new Promise((res, rej) =>
    execFile(bin[0], [...bin[1], ...args, "--raw"], { timeout: 45000, maxBuffer: 32 << 20, env }, (err, out, errOut) => {
      lastCall = Date.now();
      if (err) return rej(new Error(`gmgn-cli ${args.slice(0, 2).join(" ")}: ${(errOut || err.message).trim().slice(0, 200)}`));
      if (!String(out).trim()) return rej(new Error("gmgn-cli: empty reply (soft rate limit)"));
      try { res(JSON.parse(out)); } catch { rej(new Error("gmgn-cli: bad json")); }
    }));
}

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

const pick = (t, ...keys) => { for (const k of keys) if (t[k] !== undefined && t[k] !== null && t[k] !== "") return t[k]; return undefined; };

// Приводим и тренды, и «trenches» к одному виду
function norm(t, origin) {
  return {
    address: t.address,
    symbol: (t.symbol || "?").toUpperCase(),
    origin,
    gmgn: {
      priceUsd: num(t.price), mcap: num(pick(t, "market_cap", "usd_market_cap")), liqUsd: num(t.liquidity),
      // «volume» в трендах — объём за интервал списка (1m/5m/1h), поэтому как часовой берём его только из 1h
      vol1h: num(t.volume_1h) ?? (origin === "trending 1h" ? num(t.volume) : null),
      chg1h: num(pick(t, "price_change_percent1h", "price_change_percent")), chg5m: num(t.price_change_percent5m),
      buys: num(pick(t, "buys", "buys_24h")), sells: num(pick(t, "sells", "sells_24h")), holders: num(t.holder_count),
      smart: num(t.smart_degen_count) || 0, kol: num(t.renowned_count) || 0,
      rug: num(t.rug_ratio), top10: num(t.top_10_holder_rate), wash: t.is_wash_trading === true || t.is_wash_trading === 1,
      bundler: num(pick(t, "bundler_rate", "bundler_trader_amount_rate")), snipers: num(t.sniper_count),
      devHolds: t.creator_token_status === "creator_hold",
      mintRenounced: num(t.renounced_mint) === 1 || t.renounced_mint === true,
      freezeRenounced: num(t.renounced_freeze_account) === 1 || t.renounced_freeze_account === true,
      platform: t.launchpad_platform || "", created: num(pick(t, "creation_timestamp", "created_timestamp")),
      twitter: pick(t, "twitter_username", "twitter") || "", website: t.website || "", telegram: t.telegram || "",
      xFollowers: num(t.x_user_follower),
      socialReuse: num(t.twitter_create_token_count) || 0, socialDeletes: num(t.twitter_del_post_token_count) || 0,
      websiteDup: num(t.website_dup) || 0, twitterDup: num(t.twitter_dup) || 0, cto: num(t.cto_flag) === 1 || t.cto_flag === true,
      botRate: num(t.bot_degen_rate), entrapment: num(t.entrapment_ratio), live: t.is_token_live === true,
      name: t.name || "",
    },
  };
}

const PUMP_ARGS = () => (CFG.filters.pumpFunOnly ? ["--platform", "Pump.fun", "--platform", "pump_mayhem", "--platform", "pump_agent", "--platform", "pump_mayhem_agent"] : []);

// Фильтры прямо в запросе: GMGN отдаёт до 100 токенов, и все 100 мест уходят на то,
// что она вообще может купить (pump.fun, капа от MIN_MCAP_USD, возраст до MAX_AGE_H), а не на мелочь до $100k.
let serverFilters = true;   // старый gmgn-cli не знает этих флагов — тогда работаем без них
async function trendingList(interval) {
  const base = ["market", "trending", "--chain", "sol", "--interval", interval, "--order-by", "volume",
    "--limit", "100", "--filter", "not_wash_trading", ...PUMP_ARGS()];
  const extra = ["--min-marketcap", String(CFG.filters.minMcapUsd),
    ...(CFG.filters.maxAgeH > 0 ? ["--max-created", `${Math.round(CFG.filters.maxAgeH * 60)}m`] : [])];
  let j;
  try { j = await cli(serverFilters ? [...base, ...extra] : base); }
  catch (e) {
    if (!serverFilters || /429|rate/i.test(e.message)) throw e;
    serverFilters = false;                     // не понял флаги — повторяем без них
    j = await cli(base);
  }
  return (j?.rank || j?.data?.rank || (Array.isArray(j) ? j : [])).map((t) => norm(t, `trending ${interval}`));
}

// Только что мигрировавшие с бондинг-кривой токены (последние 12 часов).
// Без фильтра лаунчпада GMGN отдаёт миграции всех платформ (bonk, bags…) — половина списка уходила
// в «not a pump.fun token». Просим сразу pump.fun; если GMGN не понял фильтр — работаем без него.
let trenchPump = true;
async function migrated() {
  const args = ["market", "trenches", "--chain", "sol", "--type", "completed", "--limit", "80",
    "--min-marketcap", String(CFG.filters.minMcapUsd), "--max-rug-ratio", String(CFG.filters.maxRug),
    "--max-created", "720m", "--sort-by", "volume_1h"];
  const pumpArgs = CFG.filters.pumpFunOnly ? ["--launchpad-platform", "Pump.fun", "pump_mayhem", "pump_agent", "pump_mayhem_agent"] : [];
  const read = (j) => j?.completed || j?.data?.completed || [];
  let list = [];
  if (trenchPump && pumpArgs.length) {
    try { list = read(await cli([...args, ...pumpArgs])); } catch (e) { if (/429|rate/i.test(e.message)) throw e; trenchPump = false; }
    if (!list.length) trenchPump = false;      // фильтр не сработал — дальше без него
  }
  if (!list.length) list = read(await cli(args));
  return list.map((t) => norm(t, "just migrated"));
}

export let lastCounts = {};
// У GMGN лимит запросов. Каждый поток обновляем по своему расписанию и держим в кэше,
// а на 429 отступаем на 15 минут — сканер продолжает работать на кэше.
// 1m — что качают прямо сейчас (как вкладка 1m на gmgn), 5m и 1h — тренды, плюс свежие миграции.
// Каждый поток со своим расписанием; итого ~2 запроса в минуту — далеко от лимита GMGN.
// Только живые тренды GMGN, как вкладка Trending: 1m, 5m, 1h — каждый обновляется раз в минуту.
// (список «just migrated» из trenches убран: GMGN игнорировал там фильтры и отдавал мусор с других лаунчпадов)
const SOURCES = [
  { name: "trending 1m", fn: () => trendingList("1m"), everyMin: 1 },
  { name: "trending 5m", fn: () => trendingList("5m"), everyMin: 1 },
  { name: "trending 1h", fn: () => trendingList("1h"), everyMin: 1 },
];
const cache = new Map();   // name → { at, list, backoffUntil, error }

export async function trending() {
  const out = new Map();
  lastCounts = {};
  for (const src of SOURCES) {
    const c = cache.get(src.name) || { at: 0, list: [], backoffUntil: 0 };
    const due = Date.now() - c.at > src.everyMin * 60e3 - 5000 && Date.now() > c.backoffUntil;
    if (due) {
      try { c.list = await src.fn(); c.at = Date.now(); c.error = null; }
      catch (e) {
        c.error = String(e.message || e).slice(0, 80);
        if (/429|RATE_LIMIT/i.test(c.error)) c.backoffUntil = Date.now() + 6 * 60e3;   // бан у GMGN до 5 минут
      }
      cache.set(src.name, c);
    }
    lastCounts[src.name] = c.error && !c.list.length ? `error: ${c.error}` : c.list.length;
    for (const t of c.list) {
      if (!t.address) continue;
      const prev = out.get(t.address);
      if (!prev) out.set(t.address, t);
      else if (prev.gmgn.vol1h == null && t.gmgn.vol1h != null) prev.gmgn.vol1h = t.gmgn.vol1h;   // часовой объём из другого списка
    }
  }
  if (!out.size) throw new Error(JSON.stringify(lastCounts));
  return [...out.values()];
}
