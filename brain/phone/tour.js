// Обход телефонов для калибровки карты интерфейса.
// Открывает нужные экраны и снимает с каждого: картинку и все надписи с координатами (доли экрана).
// Ничего не подтверждает и не покупает: нажимает только вкладки и кнопки, которые открывают экраны
// (Buy открывает форму покупки, финальное подтверждение никогда не нажимается).
// Запуск: `npm run phone:tour -- 1|2|3 [CA]` на сервере или кнопкой в админке.
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../config.js";
import { phones, hand, wait } from "./phones.js";
import { resolvePkg } from "./apps/common.js";
import { load } from "../store.js";

const low = (s) => String(s || "").toLowerCase();
const find = (nodes, re) => nodes.find((n) => re.test(n.text) || re.test(n.desc));

async function snap(ph, name, out) {
  const { w, h } = await ph.size();
  const jpg = await ph.screenshot().catch(() => null);
  const { nodes } = await ph.screen();
  const els = nodes.filter((n) => n.text || n.desc).map((n) => ({ t: n.text, d: n.desc, x: +(n.x / w).toFixed(3), y: +(n.y / h).toFixed(3) }));
  const dir = path.join(CFG.paths.data, "phone", String(ph.n), "tour");
  fs.mkdirSync(dir, { recursive: true });
  if (jpg) fs.writeFileSync(path.join(dir, `${name}.jpg`), jpg);
  fs.writeFileSync(path.join(dir, `${name}.txt`), els.map((e) => `${e.x},${e.y}  text="${e.t}" desc="${e.d}"`).join("\n"));
  out.push({ phone: ph.n, name, w, h, elements: els, jpg: jpg ? jpg.toString("base64") : "" });
  return nodes;
}

// монета для обхода: из аргумента, иначе последняя, которую мозг разбирал
function pickCoin(ca) {
  if (ca) return { address: ca, ticker: "" };
  const d = load("decisions", []).slice().reverse().find((x) => x.address);
  return d ? { address: d.address, ticker: d.ticker } : null;
}

async function tourTrade(out, ca) {
  const ph = phones[1];
  const coin = pickCoin(ca);
  const pkg = await resolvePkg(ph, CFG.phone.pkg.pump, "pump");
  out.push({ phone: 1, name: "package", note: pkg });
  await ph.openApp(pkg); await wait(5000);
  let nodes = await snap(ph, "1-home", out);
  if (coin) {
    await ph.openUrl(`https://pump.fun/coin/${coin.address}`, pkg); await wait(6000);
    nodes = await snap(ph, "2-token", out);
  }
  const buy = find(nodes, /^\s*buy\s*$/i);
  if (buy) {
    await ph.tap(buy.x, buy.y, "buy (opens the form only)"); await wait(2500);
    await snap(ph, "3-buy-form", out);
    await ph.back(); await wait(1500);
    nodes = (await ph.screen()).nodes;
  }
  const com = find(nodes, /comment|thread|repl|chat/i);
  if (com) { await ph.tap(com.x, com.y, "comments"); await wait(2500); await snap(ph, "4-comments", out); await ph.back(); await wait(1500); }
  await ph.openApp(pkg); await wait(3000);
  nodes = (await ph.screen()).nodes;
  const pf = find(nodes, /portfolio|profile|wallet|holdings|account/i);
  if (pf) { await ph.tap(pf.x, pf.y, "portfolio"); await wait(3500); await snap(ph, "5-portfolio", out); }
}

async function tourScope(out, ca) {
  const ph = phones[2];
  const coin = pickCoin(ca);
  const pkg = await resolvePkg(ph, CFG.phone.pkg.chrome, "chrome");
  await ph.openUrl(coin ? `https://gmgn.ai/sol/token/${coin.address}` : "https://gmgn.ai/?chain=sol", pkg); await wait(8000);
  await snap(ph, "1-gmgn", out);
}

async function tourSocial(out) {
  const ph = phones[3];
  const pkg = await resolvePkg(ph, CFG.phone.pkg.x, "twitter");
  out.push({ phone: 3, name: "package", note: pkg });
  await ph.openUrl(`https://x.com/${CFG.x.handle || "ump_ai"}`, pkg); await wait(7000);
  await snap(ph, "1-profile", out);
  // окно нового поста с готовым текстом — НЕ публикуется, сразу назад
  await ph.shareText("calibration, not posted", pkg); await wait(5000);
  await snap(ph, "2-composer", out);
  await ph.back(); await wait(1500);
  const n = (await ph.screen()).nodes;
  const discard = find(n, /^(discard|delete)$/i);
  if (discard) await ph.tap(discard.x, discard.y, "discard");
}

export async function tour(which = [1, 2, 3], ca = "") {
  const out = [];
  for (const n of which) {
    if (!phones[n].on) { out.push({ phone: n, name: "error", note: "no pad code" }); continue; }
    try {
      await hand.run(n, "calibration tour", async () => {
        if (n === 1) await tourTrade(out, ca);
        if (n === 2) await tourScope(out, ca);
        if (n === 3) await tourSocial(out);
      }, 0);
    } catch (e) { out.push({ phone: n, name: "error", note: e.message }); }
  }
  return out;
}

// текстовая сводка для терминала
export const summary = (out) => out.map((s) => s.elements
  ? `── phone #${s.phone} · ${s.name} (${s.w}x${s.h})\n` + s.elements.map((e) => `  ${e.x},${e.y}  ${e.t ? `"${e.t}"` : ""}${e.d ? ` desc="${e.d}"` : ""}`).join("\n")
  : `── phone #${s.phone} · ${s.name}: ${s.note}`).join("\n");
