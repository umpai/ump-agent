// Что сейчас делает каждый телефон: активный телефон, последняя подпись шага и размер экрана.
// Собирается из событий шины, чтобы /state после перезагрузки сайта сразу показывал правду.
import { bus } from "../bus.js";
import { CFG } from "../config.js";

const phones = { 1: { step: "idle" }, 2: { step: "idle" }, 3: { step: "idle" } };
let focus = 1;

bus.on("event", (e) => {
  const n = Number(e.phone);
  if (!phones[n]) return;
  if (e.type === "focus") { focus = n; if (e.task) phones[n].step = e.task; }
  if (e.type === "step") phones[n].step = e.text;
  if ((e.type === "tap" || e.type === "swipe") && e.w && e.h) { phones[n].w = e.w; phones[n].h = e.h; }
});

export const getFocus = () => focus;
export function getSteps() {
  const out = {};
  for (const n of [1, 2, 3]) out[n] = { ...phones[n], role: CFG.phone.roles[n], online: !!CFG.phone.pads[n] && CFG.phone.on };
  return out;
}
export function setSize(n, w, h) { if (phones[n] && w && h) { phones[n].w = w; phones[n].h = h; } }
