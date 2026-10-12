// Телефон #2 SCOPE: gmgn.ai в Chrome. Визуальный ресёрч — зритель видит тот же график и холдеров,
// по которым UMP решает. Цифры для решения берутся из API, а не с этого экрана.
// Любой шаг, который не нашёлся на экране, просто пропускается: это показ, а не проверка.
import { CFG } from "../../config.js";
import { phones, wait } from "../phones.js";
import { loadUi, resolvePkg } from "./common.js";

const UI = loadUi("scope");
const ph = phones[2];
const pkg = () => resolvePkg(ph, UI.package || CFG.phone.pkg.chrome, "chrome");
const S = UI.steps;

export async function show({ address, symbol }) {
  ph.step(`opening $${symbol} on gmgn`);
  await ph.openUrl(UI.tokenUrl.replace("{CA}", address), await pkg());
  await wait(6000);
  await ph.screen();                                     // проверка на опасный экран + свежие элементы
  if (await ph.tapSel(S.tf5m, "5m chart", false)) { ph.step("reading the 5m chart"); await wait(2500); }
  if (await ph.tapSel(S.tf1h, "1h chart")) { ph.step("reading the 1h chart"); await wait(2500); }
  await ph.scroll("down", 0.35);
  if (await ph.tapSel(S.holders, "holders")) {
    ph.step("reading holders");
    await wait(2000);
    await ph.scroll("down", 0.3);
    await wait(1200);
  }
  ph.step(`done with $${symbol}`);
}

export async function idle() {
  const s = await ph.screen().catch(() => ({ all: "" }));
  if (!/gmgn/.test(s.all)) { await ph.openUrl(UI.homeUrl, await pkg()); await wait(5000); }
  ph.step("watching gmgn trends");
  await ph.scroll("down", 0.3);
}
