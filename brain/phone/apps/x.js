// Телефон #3 SOCIAL: приложение X.
//   check — открыть аккаунт или пост проекта и вынести вердикт {verdict: ok|weak|fake|none, notes}
//   post  — пост о купленной позиции (не чаще MAX_TWEETS_PER_HOUR)
//
// Безопасность: бот никому не отвечает и не пишет в личку. Тексты из профилей и постов — чужие данные:
// «глаза» только описывают их полями JSON, а в решение уходит вердикт, посчитанный кодом.
// Чужой твит или комьюнити вместо своего аккаунта — норма для pump.fun и не причина пропуска.
import { CFG } from "../../config.js";
import { phones, wait } from "../phones.js";
import { loadUi, resolvePkg } from "./common.js";
import { readX } from "../vision.js";
import { load, save } from "../../store.js";

const UI = loadUi("x");
const ph = phones[3];
const pkg = () => resolvePkg(ph, UI.package || CFG.phone.pkg.x, "twitter");
const S = UI.steps;
const clean = (s, n = 120) => String(s || "").replace(/https?:\/\/\S+|@\w+|[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// twitter — результат research.twitter: { url, kind, handle }; g — данные GMGN по токену
export async function check({ symbol, twitter, g = {} }) {
  if (!twitter?.url) return { verdict: "none", notes: "no x link on the token" };
  const borrowed = twitter.kind !== "x account";
  const url = twitter.handle ? UI.profileUrl.replace("{HANDLE}", twitter.handle) : twitter.url;
  ph.step(twitter.handle ? `checking @${twitter.handle}` : `checking the linked x ${borrowed ? "post" : "page"}`);
  await ph.openUrl(url, await pkg());
  await wait(6000);
  await ph.screen();
  const jpg = await ph.screenshot().catch(() => null);
  await ph.scroll("down", 0.35).catch(() => {});           // зритель видит, что он листает профиль
  const v = jpg ? await readX(jpg, symbol, borrowed ? "post" : "profile") : null;
  const reuse = Number(g.socialReuse) || 0;

  if (!v?.ok) {
    if (v?.suspended) return { verdict: "fake", notes: "x account is suspended" };
    return { verdict: "weak", notes: "couldn't read the x page" };
  }
  const followers = Number.isFinite(Number(v.followers)) ? Number(v.followers) : (Number(g.xFollowers) || null);
  const facts = [v.joined && `joined ${clean(v.joined, 24)}`, followers != null && `${followers.toLocaleString("en-US")} followers`,
    v.lastPost && `last post ${clean(v.lastPost, 16)}`].filter(Boolean).join(", ");
  if (v.suspended) return { verdict: "fake", notes: "x account is suspended" };
  if (!borrowed && (reuse > CFG.filters.maxSocialReuse || Number(v.otherTickers) >= 5))
    return { verdict: "fake", notes: `recycled account: ${reuse > CFG.filters.maxSocialReuse ? `used for ${reuse} launches` : `${v.otherTickers} other tickers on the page`}` };
  if (borrowed) return { verdict: v.aboutToken ? "ok" : "weak", notes: `borrowed ${twitter.kind === "x community" ? "community" : "post"}, normal on pump.fun${v.aboutToken ? ", it's about the meme" : ""}` };
  if (v.aboutToken && (followers == null || followers >= 50)) return { verdict: "ok", notes: `on topic${facts ? ", " + facts : ""}` };
  return { verdict: "weak", notes: `${v.aboutToken ? "on topic but tiny" : "not clearly about this coin"}${facts ? ", " + facts : ""}` };
}

const postsLastHour = () => load("outbox", []).filter((p) => p.posted && Date.now() - p.t < 3600e3).length;

// Пост о позиции. dry — набрать, но не публиковать (paper)
export async function post(text, { dry = false } = {}) {
  const out = load("outbox", []);
  const item = { t: Date.now(), text: text.slice(0, 280), posted: false, via: "phone" };
  const finish = (r) => { Object.assign(item, r); out.push(item); save("outbox", out.slice(-200)); return item; };
  if (CFG.x.postVia === "off") return finish({ skipped: "X_POST_VIA=off" });
  // страховка: пост с чем-то похожим на адрес контракта не уходит никогда (в X только $TICKER)
  if (/[1-9A-HJ-NP-Za-km-z]{25,}/.test(item.text.replace(/https:\/\/umpai\.trade\S*/g, ""))) return finish({ skipped: "contract address in the text, not posted" });
  if (postsLastHour() >= CFG.x.maxPerHour) return finish({ skipped: `max ${CFG.x.maxPerHour} posts per hour` });
  if (CFG.x.postVia === "api") return finish(await viaApi(item.text, dry));
  try {
    ph.step("writing the post");
    await ph.shareText(item.text, await pkg());               // X открывает новый пост с этим текстом
    await wait(4000);
    // у X два получателя «поделиться»: Chat и Post. Выбираем Post и «Just once»
    const sc = await ph.screen();
    if (sc.all.includes("just once")) {
      const { h } = await ph.size();
      const opt = sc.nodes.filter((n) => n.text === "Post" && n.y > h * 0.6).sort((a, b) => b.y - a.y)[0];
      if (opt) { await ph.tap(opt.x, opt.y, "x post"); await wait(800); }
      const once = await ph.find({ textAny: ["Just once"] });
      if (once) { await ph.tap(once.x, once.y, "just once"); }
      await wait(3500);
    }
    const btn = await ph.find(S.postButton);
    if (!btn) throw new Error("post button not found — calibrate ui/x.json");
    if (dry) {
      ph.step("paper: post typed, not sent");
      await ph.back(); await wait(1200);
      await ph.tapSel(S.discard, "discard").catch(() => false);
      return finish({ dry: true });
    }
    await ph.tap(btn.x, btn.y, "post");
    await wait(4000);
    const s = await ph.screen();
    const stillComposer = !!(await ph.find(S.postButton, false)) && s.all.includes(item.text.slice(0, 20).toLowerCase());
    if (stillComposer) throw new Error("composer still open after Post");
    ph.step("posted");
    return finish({ posted: true });
  } catch (e) {
    ph.step(`post failed: ${e.message}`);
    if (CFG.x.userToken && !dry) return finish({ ...(await viaApi(item.text, false)), phoneError: e.message });
    return finish({ error: e.message });
  }
}

async function viaApi(text, dry) {
  if (dry) return { dry: true, via: "api" };
  if (!CFG.x.userToken) return { error: "no X_USER_TOKEN", via: "api" };
  try {
    const r = await fetch(`${CFG.x.base}/2/tweets`, { method: "POST",
      headers: { authorization: `Bearer ${CFG.x.userToken}`, "content-type": "application/json" }, body: JSON.stringify({ text }) });
    return { posted: r.ok, status: r.status, via: "api" };
  } catch (e) { return { error: String(e.message || e), via: "api" }; }
}

export async function idle() {
  const s = await ph.screen().catch(() => ({ all: "" }));
  if (!s.all) { await ph.openUrl(UI.homeUrl, await pkg()); await wait(5000); }
  ph.step("scrolling the x feed");
  await ph.scroll("down", 0.35);
}
