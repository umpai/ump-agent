// Его плейбук — свод правил, который он пишет себе сам (механика из FOMI). Переписывается раз в сутки по итогам сделок.
// Жёсткие лимиты (размер, стопы, лимиты в час) он изменить не может — они в коде.
import { load, save } from "./store.js";
import { rewritePlaybook } from "./llm.js";
import { loadBrain } from "./learn.js";
import { emit } from "./bus.js";

const SEED = {
  version: 1, at: 0, changes: "first version — written before my first trade",
  rules: [
    "only pump.fun tokens above $100k mcap. under that i'm just someone's exit liquidity",
    "fresh migrations are where i look first: under 2h old, buyers ahead of sellers",
    "i want 20+ smart wallets in and top 10 holders under 30%",
    "no website and a borrowed tweet are normal on pump.fun. i judge the meme, the chart and the holders, not the link",
    "never chase a one-candle pump. if the last hour is +300%, i wait",
    "size up only when narrative, holders and chart all agree",
    "take something off the table early. the second half can ride",
    "if smart money leaves before me, i leave too — no waiting for the stop",
    "an x account that already shilled dozens of tickers is a pass. a borrowed tweet is fine",
  ],
  history: [],
};

// одноразовая поправка уже записанного плейбука: правило «только свой сайт и свой X» было ошибкой
const SOCIAL_RULE = /own (website|site|x)|borrowed tweet|no website|own account|community link/i;
function fixSocialRule(p) {
  if (p.socialFix || !p.rules?.some((r) => SOCIAL_RULE.test(r))) return p;
  const rules = p.rules.filter((r) => !SOCIAL_RULE.test(r));
  rules.splice(Math.min(3, rules.length), 0, SEED.rules[3]);
  const next = { ...p, version: (p.version || 1) + 1, at: p.at, rules, socialFix: true,
    changes: "rethought socials: on pump.fun a missing website or a borrowed tweet is normal, not a reason to pass",
    history: [...(p.history || []), { version: p.version, at: p.at, changes: p.changes }].slice(-20) };
  save("playbook", next);
  return next;
}

export function getPlaybook() {
  const p = load("playbook", null);
  if (p) return fixSocialRule(p);
  save("playbook", { ...SEED, at: Date.now() });
  return load("playbook", SEED);
}

// раз в сутки, если с прошлой версии были закрытые сделки (или по команде force)
export async function maybeRewrite(journal, force = false) {
  const p = getPlaybook();
  const newTrades = journal.filter((t) => (t.closedAt || 0) > (p.at || 0)).length;
  if (!force && (Date.now() - (p.at || 0) < 24 * 3600e3 || newTrades < 1)) return null;
  const out = await rewritePlaybook(p, journal, loadBrain().lessons || []);
  if (!out) return null;
  const next = { version: (p.version || 1) + 1, at: Date.now(), rules: out.rules, changes: out.changes, socialFix: true,
    history: [...(p.history || []), { version: p.version, at: p.at, changes: p.changes }].slice(-20) };
  save("playbook", next);
  emit("log", { type: "learn", text: `rewrote my playbook (v${next.version}): ${out.changes}` });
  return next;
}
