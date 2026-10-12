// Торговля через приложение pump.fun на телефоне #1 (через «одну руку»).
// BANK_MODE=paper: телефон проходит весь путь без финального подтверждения, а сделка учитывается
// виртуально по реальной цене — так paper-банк честно показывает, что было бы.
// BANK_MODE=live: учёт по цене DexScreener в момент сделки, правда о деньгах — сверка с приложением.
import { CFG } from "../config.js";
import { hand } from "../phone/phones.js";
import * as app from "../phone/apps/pumpfun.js";
import * as paper from "./paper.js";

const paperMode = () => CFG.bankMode === "paper";

export async function buy(bank, t, size, meta) {
  const r = await hand.run(1, `buying $${t.symbol}`, () => app.buy({ address: t.address, symbol: t.symbol, usd: size, thesis: meta.thesis }), 1);
  if (r.dry) {
    if (!paperMode()) return { filled: false, dry: true };
    const res = await paper.buy(bank, t, size, { ...meta, name: t.gmgn?.name || t.name || "", via: "phone", paper: true, thesisPosted: false, thesisTries: 9 });
    return { ...res, paper: true };
  }
  if (r.noCash) return { filled: false, noCash: true, available: r.available };
  if (!r.filled) return { filled: false, unconfirmed: r.unconfirmed };
  const res = await paper.buy(bank, t, size, { ...meta, name: t.gmgn?.name || t.name || "", via: "phone", thesisPosted: !!r.thesisPosted, thesisTries: 1 });
  return { ...res, thesisError: r.thesisPosted ? null : r.thesisError };
}

// Тезис не встал сразу — пробуем ещё раз отдельным заходом на страницу токена (только live)
export async function retryThesis(pos) {
  if (pos.paper) return { ok: true };
  if (!app.commentsOn) return { ok: false, skipped: true };
  return hand.run(1, `thesis for $${pos.symbol}`, async () => { await app.openToken(pos.address, pos.symbol); return app.postThesis(pos.symbol, pos.thesis); }, 1);
}

export async function sell(bank, pos, pct, t, reason) {
  const r = await hand.run(1, `selling $${pos.symbol} (${reason})`, () => app.sell({ address: pos.address, symbol: pos.symbol, pct }), 0);
  if (r.dry && (paperMode() || pos.paper)) return { ...(await paper.sell(bank, pos, pct, t)), paper: true };
  if (!r.filled) return { filled: false, dry: r.dry, stuck: r.stuck, unconfirmed: r.unconfirmed };
  return paper.sell(bank, pos, pct, t);
}

// Сверка с приложением — только в live: в paper деньги виртуальные
export const portfolio = () => (paperMode() ? Promise.resolve(null) : hand.run(1, "checking my balance", () => app.portfolio(), 2));
