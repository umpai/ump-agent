// Сигналы — то, что «приходит ей в голову». Каждый от 0 до 1.
// Итоговый скор = взвешенная сумма. Веса учатся на её собственных сделках (см. learn.js).
import { CFG } from "./config.js";

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lin = (x, x0, x1) => clamp((x - x0) / (x1 - x0));

export const SIGNALS = ["momentum", "volume", "buyers", "liquidity", "freshness", "social", "smart", "safety"];
// Ликвидность в скоре не участвует: пул pump.fun создаёт сам протокол при миграции, ликва 15–35% от капы — норма,
// а не риск. Сигнал считается только для истории и сайта, вес у него 0.
export const IGNORED = new Set(["liquidity"]);

// pump.fun: по данным GMGN (launchpad) или по адресу — у токенов pump.fun он заканчивается на «pump»
const PUMP = new Set(["pump.fun", "pump_mayhem", "pump_agent", "pump_mayhem_agent"]);
export const isPumpFun = (t) => PUMP.has(String(t.gmgn?.platform || "").toLowerCase()) || /pump$/.test(t.address || "");

// ссылка на чужой твит или комьюнити, а не на свой аккаунт
export const borrowedX = (tw) => /\/status\/|\/i\/communities\//.test(String(tw || ""));

export function passesFilters(t) {
  const f = CFG.filters;
  const g = t.gmgn;
  const mcap = t.mcap || t.fdv || 0;
  if (!t.priceUsd) return "no price";
  if (f.pumpFunOnly && !isPumpFun(t)) return "not a pump.fun token";
  if (mcap < f.minMcapUsd) return `mcap below $${(f.minMcapUsd / 1000).toFixed(0)}k`;
  if (f.maxAgeH > 0 && t.ageMin > f.maxAgeH * 60) return "too old";
  if (f.minAgeMin > 0 && t.ageMin < f.minAgeMin) return "too new";
  if (t.vol.h1 != null && t.vol.h1 < f.minVol1hUsd) return "dead volume";   // null — объём за час неизвестен, не режем
  if (t.chg.m5 < -12) return "dumping right now";
  if (g) {
    if (g.wash) return "wash trading";
    if (g.rug != null && g.rug > f.maxRug) return "rug risk";
    if (g.top10 != null && g.top10 > f.maxTop10) return "top 10 holders too heavy";
    if (g.bundler != null && g.bundler > f.maxBundler) return "bundled supply";
    if (!g.mintRenounced || !g.freezeRenounced) return "mint or freeze not renounced";
    // чужой твит или X-комьюнити под токеном — норма для pump.fun (мем часто начинается с чужого поста),
    // поэтому «переиспользование» считаем только для собственного аккаунта токена
    if (g.socialReuse > f.maxSocialReuse && !borrowedX(g.twitter)) return "recycled socials";
  }
  return null;
}

const XBONUS = { ok: 0.15, weak: 0, none: 0, fake: -0.35 };

const VOL_STEPS = [[5000, 0], [10000, 0.25], [20000, 0.5], [80000, 0.75], [300000, 1]];
export function volScore(v) {
  if (v <= VOL_STEPS[0][0]) return 0;
  for (let i = 1; i < VOL_STEPS.length; i++) {
    const [x0, y0] = VOL_STEPS[i - 1], [x1, y1] = VOL_STEPS[i];
    if (v <= x1) return y0 + (y1 - y0) * (Math.log(v / x0) / Math.log(x1 / x0));
  }
  return 1;
}

export function computeSignals(t, ctx = {}) {
  const b5 = t.txns.m5.b, s5 = t.txns.m5.s, b1 = t.txns.h1.b, s1 = t.txns.h1.s;
  const buyRatio = (b5 + b1 * 0.3) / Math.max(1, b5 + s5 + (b1 + s1) * 0.3);
  const mentions = ctx.x?.count ?? null;
  const fomoCount = null;

  const momentum = clamp(lin(t.chg.h1, -10, 80) * 0.7 + lin(t.chg.m5, -5, 15) * 0.3);
  // оборот за час (по лог-шкале между точками): $10k слабо 0.25 · $20k средне 0.5 · $80k хорошо 0.75 · $300k+ отлично 1
  const volume = volScore(t.vol.h1 || 0);
  const buyers = lin(buyRatio, 0.42, 0.7);
  const liquidity = lin(Math.log10(Math.max(1, t.liqUsd)), 4.1, 5.4);
  const freshness = t.ageMin < 360 ? 1 : clamp(1 - (t.ageMin - 360) / (7 * 1440 - 360));   // до 6 часов — 1, к неделе — 0 (старые не запрещены, просто без бонуса)
  const g0 = t.gmgn || {};
  // на pump.fun у большинства раннеров нет сайта, а в X — чужой пост или старый аккаунт. это не минус.
  // минус — только свой аккаунт, который уже запускал кучу токенов, и сайт-копия.
  const social = clamp(
    0.3 + (t.socials.twitter || g0.twitter ? 0.1 : 0) + (t.socials.telegram || g0.telegram ? 0.05 : 0) + (t.socials.website || g0.website ? 0.05 : 0) -
    (g0.socialReuse > 2 && !borrowedX(g0.twitter) ? 0.25 : 0) - (g0.websiteDup > 3 ? 0.15 : 0) +
    (t.boosted ? 0.1 : 0) + (mentions != null ? lin(mentions, 2, 30) * 0.2 : 0.1) + (fomoCount != null ? lin(fomoCount, 1, 10) * 0.1 : 0.05) +
    // проверка X на телефоне #3: свой живой аккаунт про этот токен — плюс, фейк или переработанный — сильный минус
    (XBONUS[ctx.xcheck?.verdict] ?? 0)
  );
  let risk = clamp(lin(t.chg.h1, 150, 500) * 0.55 + lin(0.5 - buyRatio, 0, 0.2) * 0.45);
  const g = t.gmgn;
  if (g) {   // данные GMGN: концентрация холдеров, rug, бандлеры, дев ещё держит, mint/freeze
    const gRisk = clamp((g.rug ?? 0.15) * 1.6 * 0.3 + lin(g.top10 ?? 0.3, 0.2, 0.6) * 0.3 + lin(g.bundler ?? 0, 0.1, 0.4) * 0.15 +
      (g.devHolds ? 0.1 : 0) + (g.mintRenounced && g.freezeRenounced ? 0 : 0.15));
    risk = clamp(risk * 0.5 + gRisk * 0.5);
  }
  const safety = 1 - risk;
  const smart = g ? lin(g.smart + g.kol * 0.5, 0, 6) : 0.35;   // smart money и KOL в токене

  return { momentum, volume, buyers, liquidity, freshness, social, smart, safety };
}

export function score(sig, weights) {
  let s = 0, w = 0;
  for (const k of SIGNALS) { if (IGNORED.has(k)) continue; s += (weights[k] ?? 1) * sig[k]; w += weights[k] ?? 1; }
  return Math.round((100 * s) / w);
}
