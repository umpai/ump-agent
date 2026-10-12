// Live-сервер UMP: крутит мозг, снимает экраны трёх телефонов и отдаёт всё сайту в реальном времени.
//   npm run live
// Эндпоинты (CORS открыт для LIVE_ALLOW_ORIGIN):
//   GET /state           — текущее состояние (банк, позиции, сделки, решения, мысли, телефоны)
//   GET /events          — поток событий (SSE): focus, tap, swipe, type, step, thought, decision, scan, trade, exit, sync, state
//   GET /phone/{1,2,3}.jpg — последний кадр каждого телефона
//   GET /admin#ТОКЕН     — рубильник on / pause / off и аварийный стоп телефонов
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, ROOT } from "../config.js";
import { bus } from "../bus.js";
import { runForever } from "../index.js";
import { lastState, publish, toThought } from "../publish.js";
import { loadBank } from "../bank.js";
import { loadJournal } from "../memory.js";
import { loadBrain } from "../learn.js";
import { getControl, setControl, MODES } from "../control.js";
import { phones, hand, stopped } from "../phone/phones.js";
import { idleLoop } from "../conductor.js";
import "./screens.js";
import { tour } from "../phone/tour.js";

let lastTour = null, touring = false;

// ── админка: /admin#ТОКЕН. Без ADMIN_TOKEN (≥16 символов) в .env админка выключена. ──
const adminOn = CFG.admin.token && CFG.admin.token.length >= 16;
const okToken = (t) => {
  if (!adminOn || typeof t !== "string") return false;
  const a = crypto.createHash("sha256").update(t).digest(), b = crypto.createHash("sha256").update(CFG.admin.token).digest();
  return crypto.timingSafeEqual(a, b);
};
const fails = new Map();
const ADMIN_PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>ump admin</title>
<style>body{background:#000;color:#EAF4FF;font:15px ui-monospace,Menlo,monospace;padding:24px;max-width:560px;margin:auto}
button{font:inherit;padding:14px 18px;margin:6px 6px 6px 0;border:0;cursor:pointer;color:#000}
.on{background:#47E35F}.pause{background:#FFC83D}.off{background:#FF4D5E}.stop{background:#FF8A1F}.unstop{background:#9AF5B8}
#s{margin:18px 0;padding:12px;border:2px solid #222B36;white-space:pre-wrap}p{color:#8B97A6}</style>
<h2>ump · admin</h2><div id=s>loading…</div>
<button class=on onclick="set('on')">on</button><button class=pause onclick="set('pause')">pause</button><button class=off onclick="set('off')">off</button>
<p>on — trades normally<br>pause — researches and protects open positions, no new entries<br>off — everything stops, phones untouched</p>
<button class=stop onclick="stop(true)">stop phones</button><button class=unstop onclick="stop(false)">unstop phones</button>
<button class=unstop onclick="tourGo()">calibration tour</button> <span id=tr></span>
<p>calibration tour — opens the app screens on all three phones and records their buttons. buys nothing, posts nothing.</p>
<p>stop phones — no action on any phone until you unstop. bank mode (paper / live) is set in .env on the server and needs a restart.</p>
<script>const t=location.hash.slice(1);const h={"x-admin-token":t,"content-type":"application/json"};
async function load(){const r=await fetch("/admin/state",{headers:h});document.getElementById("s").textContent=r.ok?JSON.stringify(await r.json(),null,2):"wrong token";}
async function set(m){await fetch("/admin/mode",{method:"POST",headers:h,body:JSON.stringify({mode:m})});load();}
async function tourGo(){const r=await fetch("/admin/tour",{method:"POST",headers:h,body:"{}"});document.getElementById("tr").textContent=r.status==202?"running… about 2 minutes":await r.text();}
async function stop(v){await fetch("/admin/stop",{method:"POST",headers:h,body:JSON.stringify({stop:v})});load();}
load();setInterval(load,5000);</script>`;

// ── кадры трёх телефонов: активный чаще, остальные реже ──
const frames = { 1: null, 2: null, 3: null };
const online = { 1: false, 2: false, 3: false };
async function frameLoop(n) {
  const ph = phones[n];
  if (!ph.on) { console.log(`phone #${n} (${ph.role}): no pad code, skipped`); return; }
  for (;;) {
    try {
      if (!online[n]) { await ph.connect(); online[n] = true; console.log(`phone #${n} (${ph.role}) connected`); }
      frames[n] = await ph.screenshot();
    } catch (e) { if (online[n]) console.log(`phone #${n} frame error:`, e.message); online[n] = false; }
    const fps = hand.focus === n ? CFG.phone.fpsActive : CFG.phone.fpsIdle;
    await new Promise((r) => setTimeout(r, online[n] ? 1000 / Math.max(0.2, fps) : 15000));
  }
}

// ── SSE: события шины → события сайта ──
const clients = new Set();
const send = (type, data) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); };
const PASS = new Set(["focus", "tap", "swipe", "type", "step", "decision"]);
bus.on("event", (e) => {
  if (PASS.has(e.type)) return send(e.type, e);
  if (e.type === "state") return send("state", e.state || e);
  if (e.type === "control") { try { publish(loadBank(), loadBrain(), loadJournal(), new Map(), getControl()); } catch { /* ниже нечего делать */ } return; }
  if (e.type === "scan") send("scan", { t: e.t, count: e.count });
  if (e.type === "buy" || e.type === "dry-run") send("trade", { side: "buy", ticker: e.symbol, size: e.size, paper: !!e.paper, dry: e.type === "dry-run" });
  if (e.type === "exit") send("exit", { ticker: e.symbol, reason: e.reason, pct: e.pct, pnlPct: e.pnlPct });
  if (e.type === "sync") send("sync", { t: e.t });
  const th = toThought(e);
  if (th) send("thought", th);
});

const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 1000) req.destroy(); }); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { res({}); } }); });
const cors = { "access-control-allow-origin": CFG.live.allowOrigin, "cache-control": "no-store" };

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/admin") { res.writeHead(adminOn ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(adminOn ? ADMIN_PAGE : "admin disabled: set ADMIN_TOKEN (16+ chars) in .env"); }
  if (url.startsWith("/admin/")) {
    const ip = req.socket.remoteAddress || "?";
    if ((fails.get(ip) || 0) > 20) { res.writeHead(429); return res.end("too many attempts"); }
    if (!okToken(req.headers["x-admin-token"])) { fails.set(ip, (fails.get(ip) || 0) + 1); res.writeHead(401); return res.end("unauthorized"); }
    if (url === "/admin/mode" && req.method === "POST") {
      const { mode } = await readBody(req);
      if (!MODES.includes(mode)) { res.writeHead(400); return res.end("bad mode"); }
      setControl(mode, "web"); res.writeHead(200); return res.end("ok");
    }
    // калибровка: обход экранов телефонов (ничего не покупает и не постит), результат — надписи и картинки
    if (url === "/admin/tour" && req.method === "POST") {
      const { phones: which, ca } = await readBody(req);
      if (touring) { res.writeHead(409); return res.end("tour already running"); }
      touring = true;
      const list = (Array.isArray(which) ? which : [1, 2, 3]).map(Number).filter((n) => [1, 2, 3].includes(n));
      tour(list, String(ca || "").replace(/[^1-9A-HJ-NP-Za-km-z]/g, "").slice(0, 60))
        .then((r) => { lastTour = { at: Date.now(), screens: r }; }).catch((e) => { lastTour = { at: Date.now(), error: e.message }; })
        .finally(() => { touring = false; });
      res.writeHead(202); return res.end("started");
    }
    if (url === "/admin/tour") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ running: touring, ...(lastTour || {}) }));
    }
    if (url === "/admin/stop" && req.method === "POST") {
      const { stop } = await readBody(req);
      const f = path.join(CFG.paths.data, "STOP");
      if (stop) fs.writeFileSync(f, String(Date.now())); else fs.rmSync(f, { force: true });
      res.writeHead(200); return res.end("ok");
    }
    const st = lastState || {};
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ mode: getControl().mode, bankMode: CFG.bankMode, dryRun: CFG.phone.dryRun, executor: CFG.executor,
      phonesStopped: stopped(), phones: Object.fromEntries([1, 2, 3].map((n) => [n, `${CFG.phone.roles[n]}: ${online[n] ? "online" : phones[n].on ? "offline" : "no pad"}`])),
      bank: st.bank, open: (st.positions || []).map((p) => `$${p.ticker} $${p.size} ${p.pnlPct}%`) }, null, 2));
  }
  if (url === "/state") { res.writeHead(200, { ...cors, "content-type": "application/json" }); return res.end(JSON.stringify(lastState || {})); }
  const fm = url.match(/^\/phone\/([123])\.jpg$/) || (url === "/phone.jpg" ? [0, "1"] : null);
  if (fm) {
    const f = frames[fm[1]];
    if (!f) { res.writeHead(503, cors); return res.end("phone offline"); }
    res.writeHead(200, { ...cors, "content-type": "image/jpeg" }); return res.end(f);
  }
  if (url === "/events") {
    res.writeHead(200, { ...cors, "content-type": "text/event-stream", connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ phones: online })}\n\n`);
    clients.add(res); req.on("close", () => clients.delete(res));
    return;
  }
  // всё остальное — сам сайт из docs/, чтобы локально открыть http://localhost:8789/?live=http://localhost:8789
  const docs = path.join(ROOT, "docs");
  const file = path.normalize(path.join(docs, url === "/" ? "index.html" : decodeURIComponent(url)));
  if (file.startsWith(docs) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };
    res.writeHead(200, { ...cors, "content-type": types[path.extname(file)] || "application/octet-stream" });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, cors); res.end("not found");
}).listen(CFG.live.port, () => console.log(`ump live on :${CFG.live.port} · bank=${CFG.bankMode} · dryRun=${CFG.phone.dryRun} · executor=${CFG.executor}`));

setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20000);
for (const n of [1, 2, 3]) frameLoop(n);
// сразу отдаём сайту сохранённое состояние — первый цикл мозга идёт минутами (урок FOMI)
try { publish(loadBank(), loadBrain(), loadJournal(), new Map(), getControl()); } catch (e) { console.log("startup publish failed:", e.message); }
idleLoop();
await runForever();
