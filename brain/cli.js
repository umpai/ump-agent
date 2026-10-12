// Управление с сервера:
//   npm run admin -- status | on | pause | off   — рубильник (pause: без новых входов, выходы работают; off: стоит всё)
//   npm run status                               — банк и позиции
//   npm run sync                                 — сверка с приложением pump.fun прямо сейчас (live)
//   npm run launch -- <usd>                      — старт банка с нуля (отказывается, если есть открытые live-позиции)
//   npm run fix -- TICKER PCT                    — поправить итог сделки под факт из приложения
//   npm run threshold -- 70                      — порог скора для входа
//   npm run playbook [-- rewrite]                — показать / переписать плейбук
//   npm run llm:test                             — проверка модели (текст и картинка с телефона #1)
//   npm run stop / unstop                        — аварийный запрет любых действий на всех телефонах
//   npm run phone:ping -- 1|2|3|all              — подключение и кадр с телефона
//   npm run phone:snap -- 1|2|3                  — кадр + все элементы экрана (для карты интерфейса)
//   npm run phone:tour -- [1|2|3|all] [CA]        — обход экранов для калибровки (ничего не покупает)
//   npm run phone:debug -- 1|2|3                 — размер экрана, установленные пакеты, тексты на экране
//   npm run phone:test -- <CA> <TICKER> [usd]    — весь путь покупки на #1 БЕЗ финального подтверждения
//   npm run scope:test -- <CA> <TICKER>          — #2 открывает токен на gmgn
//   npm run x:check -- <x link> <TICKER>         — #3 проверяет X-аккаунт или пост
//   npm run x:test -- "текст"                    — #3 набирает пост и НЕ публикует
import fs from "node:fs";
import { CFG } from "./config.js";
import { loadBank, saveBank } from "./bank.js";
import { loadJournal, saveJournal, pushEvent } from "./memory.js";
import { loadBrain } from "./learn.js";
import { publish } from "./publish.js";
import { getControl, setControl } from "./control.js";

const [cmd, a, b, c] = process.argv.slice(2);
const done = () => process.exit(0);
const fail = (m) => { console.error(m); process.exit(1); };
const phoneArg = (x) => { const n = Number(x); if (![1, 2, 3].includes(n)) fail("which phone? 1 (trade), 2 (scope) or 3 (social)"); return n; };

if (cmd === "admin") {
  if (a && a !== "status") { const ctl = setControl(a, "cli"); console.log(`agent is now: ${ctl.mode}`); }
  const ctl = getControl();
  const bank = loadBank();
  console.log({ mode: ctl.mode, since: ctl.at ? new Date(ctl.at).toISOString() : "-", bankMode: CFG.bankMode, dryRun: CFG.phone.dryRun, executor: CFG.executor,
    cash: bank.cash, open: bank.positions.map((p) => `$${p.symbol} $${p.size}`), halted: bank.halted, phonesStopped: fs.existsSync(`${CFG.paths.data}/STOP`) });
  done();
}

if (cmd === "stop") { fs.mkdirSync(CFG.paths.data, { recursive: true }); fs.writeFileSync(`${CFG.paths.data}/STOP`, String(Date.now())); console.log("STOP set — all phone actions halted"); done(); }
if (cmd === "unstop") { fs.rmSync(`${CFG.paths.data}/STOP`, { force: true }); console.log("STOP removed"); done(); }

if (cmd === "phone-tour") {
  const { tour, summary } = await import("./phone/tour.js");
  const which = a && a !== "all" ? [Number(a)] : [1, 2, 3];
  const out = await tour(which, b || "");
  console.log(summary(out));
  console.log(`\nscreens saved to ${CFG.paths.data}/phone/<N>/tour/`);
  done();
}

if (cmd?.startsWith("phone-") || ["scope-test", "x-check", "x-test"].includes(cmd)) {
  const { phones, wait } = await import("./phone/phones.js");
  const save = (n, name, buf) => { const dir = `${CFG.paths.data}/phone/${n}`; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/${name}`, buf); return `${dir}/${name}`; };
  try {
    if (cmd === "phone-ping") {
      const list = a === "all" || !a ? [1, 2, 3] : [phoneArg(a)];
      for (const n of list) {
        const ph = phones[n];
        if (!ph.on) { console.log(`#${n} ${ph.role}: no pad code in .env`); continue; }
        try { const sz = await ph.connect(); const img = await ph.screenshot(); console.log(`#${n} ${ph.role}: ok, screen ${sz.w}x${sz.h}, frame saved to ${save(n, "ping.jpg", img)}`); }
        catch (e) { console.log(`#${n} ${ph.role}: ERROR ${e.message}`); }
      }
    } else if (cmd === "phone-snap") {
      const n = phoneArg(a), ph = phones[n];
      await ph.connect();
      const shot = save(n, "screen.jpg", await ph.screenshot());
      const { nodes } = await ph.screen();
      const { w, h } = await ph.size();
      const list = nodes.filter((x) => x.text || x.desc).map((x) => `${(x.x / w).toFixed(3)},${(x.y / h).toFixed(3)}  text="${x.text}" desc="${x.desc}"`);
      const el = save(n, "elements.txt", list.join("\n"));
      console.log(list.join("\n"));
      console.log(`\nscreen ${w}x${h}\nsaved ${shot}\nsaved ${el}`);
    } else if (cmd === "phone-debug") {
      const n = phoneArg(a), ph = phones[n];
      console.log("wm size →", (await ph.sh("wm size", true)).trim());
      console.log("apps →", (await ph.sh("pm list packages | grep -iE 'pump|twitter|chrome'", true)).trim() || "(none of pump / twitter / chrome)");
      const { nodes } = await ph.screen();
      console.log("texts on screen →", nodes.filter((x) => x.text).slice(0, 25).map((x) => x.text).join(" | ") || "(no readable text)");
    } else if (cmd === "phone-test") {
      if (!a || !b) fail("usage: npm run phone:test -- <CA> <TICKER> [usd]");
      CFG.phone.dryRun = true;
      const app = await import("./phone/apps/pumpfun.js");
      console.log(await app.buy({ address: a, symbol: String(b).toUpperCase().replace(/^\$/, ""), usd: Number(c || CFG.bank.minPos), thesis: "" }));
    } else if (cmd === "scope-test") {
      if (!a || !b) fail("usage: npm run scope:test -- <CA> <TICKER>");
      const scope = await import("./phone/apps/scope.js");
      await scope.show({ address: a, symbol: String(b).toUpperCase().replace(/^\$/, "") }); console.log("done");
    } else if (cmd === "x-check") {
      if (!a) fail("usage: npm run x:check -- <x link> <TICKER>");
      const { research } = await import("./research.js");
      const x = await import("./phone/apps/x.js");
      const r = await research({ gmgn: { twitter: a }, links: {} });
      console.log("link:", r.twitter);
      console.log(await x.check({ symbol: String(b || "TOKEN").toUpperCase(), twitter: r.twitter, g: {} }));
    } else if (cmd === "x-test") {
      if (!a) fail('usage: npm run x:test -- "post text"');
      const x = await import("./phone/apps/x.js");
      console.log(await x.post(a, { dry: true }));
    }
  } catch (e) { fail(`error: ${e.message}`); }
  await wait(300);
  done();
}

const bank = loadBank();
const journal = loadJournal();

if (cmd === "status") {
  console.log({ bankMode: CFG.bankMode, cash: bank.cash, start: bank.start, positions: bank.positions.map((p) => [p.symbol, p.size, p.remaining]), halted: bank.halted, control: getControl().mode });
} else if (cmd === "launch") {
  // официальный старт: банк с нуля, прошлые сделки в архив, мозг (веса, уроки, плейбук) остаётся.
  // С открытыми live-позициями отказывается: иначе агент забудет их (так у FOMI потерялась позиция).
  const live = bank.positions.filter((p) => !p.paper && bank.mode !== "paper");
  if (live.length) fail(`refused: ${live.length} open live position(s): ${live.map((p) => "$" + p.symbol).join(", ")}. close them first (npm run admin -- pause and wait).`);
  const amount = Number(a) || CFG.bank.start;
  const dir = `${CFG.paths.data}/archive-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["bank", "journal", "events", "decisions", "outbox", "seen", "equity"]) {
    const src = `${CFG.paths.data}/${f}.json`;
    if (fs.existsSync(src)) fs.renameSync(src, `${dir}/${f}.json`);
  }
  const nb = loadBank(); nb.start = amount; nb.cash = amount; nb.mode = CFG.bankMode; nb.launchedAt = Date.now(); saveBank(nb);
  console.log(`launched ${CFG.bankMode} bank with $${amount}. old trades archived to ${dir}. brain, lessons and playbook kept. agent mode: ${getControl().mode}`);
  publish(nb, loadBrain(), [], new Map(), getControl());
  done();
} else if (cmd === "sync") {
  const { syncWithApp } = await import("./index.js");
  const pf = await syncWithApp(bank, journal, true);
  console.log(pf ? { cash: bank.cash, positions: pf.positions, mine: bank.positions.map((p) => p.symbol), notMine: bank.external } : "sync skipped or failed (paper mode, or see events)");
} else if (cmd === "fix") {
  const sym = String(a || "").replace(/^\$/, "").toUpperCase(), pctv = Number(b);
  const t = journal.slice().reverse().find((x) => String(x.symbol).toUpperCase() === sym);
  if (!t || !Number.isFinite(pctv)) fail("usage: npm run fix -- TICKER PNL_PERCENT   (e.g. npm run fix -- GLORP -23)");
  const newPnl = +(t.size * pctv / 100).toFixed(2), delta = newPnl - (t.pnl || 0);
  if (new Date(t.closedAt).toISOString().slice(0, 10) === bank.day.date) bank.day.pnl += delta;
  bank.realized = (bank.realized || 0) + delta;
  console.log(`$${sym}: ${(t.pnlPct * 100).toFixed(1)}% → ${pctv}% ($${(t.pnl || 0).toFixed(2)} → $${newPnl})`);
  t.pnl = newPnl; t.pnlPct = +(pctv / 100).toFixed(4); t.truth = "app";
  pushEvent({ type: "sync", text: `corrected $${sym} with the real number from the app: ${pctv}%` });
} else if (cmd === "playbook") {
  const { maybeRewrite, getPlaybook } = await import("./playbook.js");
  const p = a === "rewrite" ? await maybeRewrite(journal, true) : getPlaybook();
  console.log(p || "rewrite failed (llm?)"); done();
} else if (cmd === "llm-test") {
  const { askJson } = await import("./llmcall.js");
  console.log("model:", CFG.llm.provider, CFG.llm.model, CFG.llm.key ? "key ok" : "NO KEY");
  const t = await askJson('Reply ONLY with JSON {"ok":true,"says":"short greeting"}', "say hi", { maxTokens: 1500 });
  console.log("text →", t, t ? "" : (await import("./llmcall.js")).lastLlmError);
  try {
    const { phones } = await import("./phone/phones.js");
    const jpg = await phones[1].screenshot();
    const v = await askJson('Reply ONLY with JSON {"ok":true,"what":"one line: what app screen is this"}', "describe the screen", { image: jpg, maxTokens: 1500 });
    console.log("vision →", v, v ? "" : (await import("./llmcall.js")).lastLlmError);
  } catch (e) { console.log("vision skipped:", e.message); }
  done();
} else if (cmd === "threshold") {
  // npm run threshold -- 70 — порог скора для входа прямо сейчас (дальше он подстраивается сам от этого значения)
  const v = Number(a);
  if (!Number.isFinite(v) || v < 40 || v > 95) fail("usage: npm run threshold -- 70   (40..95)");
  const { load: ld, save: sv } = await import("./store.js");
  const br = loadBrain(); const was = br.threshold; br.threshold = Math.round(v); sv("brain", br);
  console.log(`threshold ${was} → ${br.threshold}`);
  pushEvent({ type: "thought", kind: "think", text: `my entry threshold is now ${br.threshold}. pickier.` });
} else if (cmd === "resume") {
  bank.halted = false; bank.pausedUntil = 0; console.log("resumed");
} else {
  console.log("commands: admin [status|on|pause|off] | status | sync | launch [usd] | fix TICKER PCT | playbook [rewrite] | llm-test | resume | stop | unstop | phone-ping [1|2|3|all] | phone-snap N | phone-debug N | phone-test CA TICKER [usd] | scope-test CA TICKER | x-check LINK TICKER | x-test TEXT");
  done();
}
saveBank(bank); saveJournal(journal);
publish(bank, loadBrain(), journal, new Map(), getControl());
done();
