// Три телефона UMP и «одна рука», которая ими управляет.
//   #1 TRADE  — приложение pump.fun: покупка, продажа, тезис в комментариях
//   #2 SCOPE  — gmgn.ai в Chrome: график и холдеры (визуальный ресёрч)
//   #3 SOCIAL — приложение X: проверка аккаунта проекта и пост о позиции
//
// Каждое действие сначала уходит событием на сайт (курсор успевает доехать), и только через
// CURSOR_LEAD_MS идёт настоящая команда в VMOS. Так зритель видит движение и клик синхронно.
import fs from "node:fs";
import path from "node:path";
import * as vm from "./vmos-api.js";
import { CFG } from "../config.js";
import { emit } from "../bus.js";
import { getControl } from "../control.js";

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stopFile = () => path.join(CFG.paths.data, "STOP");
export const stopped = () => fs.existsSync(stopFile());

// Слова, после которых телефон жмёт «назад» и сценарий останавливается.
// Сценарии никогда не ведут к выводу, переводу или экспорту ключей — это страховка от случайного экрана.
const DANGER = ["seed phrase", "recovery phrase", "secret recovery", "private key", "secret key", "export wallet",
  "export private", "recipient address", "enter recipient", "withdraw to", "send to address"];

export function guard() {
  if (stopped()) throw new Error("STOP file present — phone actions halted");
  if (getControl().mode === "off") throw new Error("agent is off (admin)");
}

const low = (s) => String(s || "").toLowerCase();
function match(n, sel) {
  const t = low(n.text), d = low(n.desc);
  if (sel.textAny?.some((x) => t === low(x))) return true;
  if (sel.textContainsAny?.some((x) => x && t.includes(low(x)))) return true;
  if (sel.descAny?.some((x) => d === low(x))) return true;
  if (sel.descContainsAny?.some((x) => x && d.includes(low(x)))) return true;
  return false;
}

export class Phone {
  constructor(n) {
    this.n = n;
    this.role = CFG.phone.roles[n];
    this.pad = CFG.phone.pads[n];
    this.nodes = [];
    this.extraDanger = [];
  }
  get on() { return CFG.phone.on && !!this.pad; }
  size() { return vm.size(this.pad); }
  step(text) { emit("step", { phone: this.n, text: String(text).slice(0, 80) }); }

  async tap(x, y, label = "") {
    guard();
    const { w, h } = await this.size();
    emit("tap", { phone: this.n, x: Math.round(x), y: Math.round(y), w, h, label });
    await wait(CFG.phone.leadMs);
    await vm.tap(this.pad, x, y);
    await wait(CFG.phone.stepDelayMs);
  }
  async swipe(x1, y1, x2, y2, ms = 450, label = "") {
    guard();
    const { w, h } = await this.size();
    emit("swipe", { phone: this.n, x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), w, h, label });
    await wait(CFG.phone.leadMs);
    await vm.swipe(this.pad, x1, y1, x2, y2, ms);
    await wait(500);
  }
  // прокрутка по долям экрана: down = листаем ленту вниз
  async scroll(dir = "down", amount = 0.4) {
    const { w, h } = await this.size();
    const a = h * 0.75, b = h * (0.75 - amount);
    return dir === "down" ? this.swipe(w * 0.5, a, w * 0.5, b) : this.swipe(w * 0.5, b, w * 0.5, a);
  }
  async type(text, label = "") {
    guard();
    emit("type", { phone: this.n, text: String(text).slice(0, 280), label });
    await wait(CFG.phone.leadMs);
    await vm.type(this.pad, text);
    await wait(600);
  }
  async clearField(chars = 24) {
    guard();
    await vm.sh(this.pad, `input keyevent 123; ${Array(chars).fill("input keyevent 67").join("; ")}`, true);   // в конец поля и стереть
  }
  back() { return vm.back(this.pad); }
  async openApp(pkg) { guard(); await vm.openApp(this.pad, pkg); }
  async openUrl(url, pkg) { guard(); await vm.openUrl(this.pad, url, pkg); }
  async shareText(text, pkg) { guard(); await vm.shareText(this.pad, text, pkg); }
  sh(cmd, out = false) { return vm.sh(this.pad, cmd, out); }
  screenshot() { return vm.screenshot(this.pad); }
  connect() { return vm.connect(this.pad); }

  // Что сейчас на экране (текст интерфейса). Опасный экран — назад и стоп.
  async screen() {
    const { nodes } = await vm.dumpUi(this.pad).catch(() => ({ nodes: [] }));
    this.nodes = nodes;
    const all = nodes.map((n) => `${n.text} ${n.desc}`.toLowerCase()).join(" | ");
    const danger = [...DANGER, ...this.extraDanger].find((w) => all.includes(w));
    if (danger) await this.bail(`unsafe screen detected: "${danger}"`);
    return { nodes, all, readable: nodes.some((n) => n.text) };
  }
  async bail(why) {
    this.step(`${why}, backing out`);
    await vm.back(this.pad).catch(() => {});
    throw new Error(`${why} — aborted`);
  }

  // Найти элемент по селектору из карты интерфейса. pick: first | last | lowest | highest
  async find(sel, fresh = true) {
    if (!sel) return null;
    const nodes = fresh ? (await this.screen()).nodes : this.nodes;
    let hits = nodes.filter((n) => match(n, sel) && n.w > 0 && n.h > 0);
    if (!hits.length) return null;
    if (sel.pick === "last") return hits[hits.length - 1];
    if (sel.pick === "lowest") return hits.sort((a, b) => b.y - a.y)[0];
    if (sel.pick === "highest") return hits.sort((a, b) => a.y - b.y)[0];
    return hits[0];
  }
  async point(sel, fresh = true) {
    const hit = await this.find(sel, fresh);
    if (hit) return { x: hit.x, y: hit.y, how: "ui" };
    if (Array.isArray(sel?.xy)) { const { w, h } = await this.size(); return { x: sel.xy[0] * w, y: sel.xy[1] * h, how: "xy" }; }
    return null;
  }
  // нажать элемент; false — если его нет на экране и запасных координат тоже нет
  async tapSel(sel, label, fresh = true) {
    const p = await this.point(sel, fresh);
    if (!p) return false;
    await this.tap(p.x, p.y, label);
    return true;
  }
}

export const phones = { 1: new Phone(1), 2: new Phone(2), 3: new Phone(3) };

// ── одна рука: в каждый момент активен только один телефон ──
// приоритеты: 0 выходы · 1 цикл входа · 2 сверка · 9 простой (листание лент)
class Hand {
  constructor() { this.queue = []; this.busy = false; this.focus = 0; this.task = ""; }
  acquire(prio) {
    return new Promise((resolve) => {
      this.queue.push({ prio, resolve });
      this.queue.sort((a, b) => a.prio - b.prio);
      this.next();
    });
  }
  next() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    this.queue.shift().resolve();
  }
  release() { this.busy = false; this.next(); }
  waiting() { return this.queue.length > 0; }
  setFocus(n, task = "") {
    this.task = task;
    if (task) phones[n]?.step(task);
    emit("focus", { phone: n, task });
    this.focus = n;
  }
  // выполнить fn на телефоне n; ошибки пробрасываются
  async run(n, task, fn, prio = 1) {
    await this.acquire(prio);
    try { this.setFocus(n, task); return await fn(phones[n]); }
    finally { this.release(); }
  }
}
export const hand = new Hand();
