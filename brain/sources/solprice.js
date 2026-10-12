// Цена SOL в долларах: pump.fun показывает баланс и суммы в SOL, а банк UMP считается в USD.
// Берём самую ликвидную пару wSOL/стейбл на DexScreener, кэш 60 секунд.
const WSOL = "So11111111111111111111111111111111111111112";
let cache = { at: 0, usd: 0 };

export async function solUsd() {
  if (cache.usd && Date.now() - cache.at < 60e3) return cache.usd;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WSOL}`, { headers: { accept: "application/json" } });
    const j = await r.json();
    const pairs = (j.pairs || []).filter((p) => p.chainId === "solana" && p.baseToken?.address === WSOL && /^(USDC|USDT)$/i.test(p.quoteToken?.symbol || ""));
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const usd = Number(pairs[0]?.priceUsd);
    if (usd > 0) cache = { at: Date.now(), usd };
  } catch { /* остаётся прошлая цена */ }
  return cache.usd || NaN;
}

// сумма с экрана в долларах: "0.25 SOL" / "$40" / число + единица
export async function toUsd(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v)) return NaN;
  if (/sol/i.test(unit || "")) { const p = await solUsd(); return Number.isFinite(p) ? v * p : NaN; }
  return v;
}
