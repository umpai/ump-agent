// Конфиг UMP. Читает .env без зависимостей. Всё, что можно менять без правки кода, — здесь.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#\n]*)/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const num = (k, d) => Number(env(k, d));

// paper — банк виртуальный, телефоны проходят весь путь, но финальное подтверждение пропускается
// live  — реальный банк = баланс в приложении pump.fun
const bankMode = env("BANK_MODE", "paper") === "live" ? "live" : "paper";
const pads = { 1: env("PAD_TRADE", ""), 2: env("PAD_SCOPE", ""), 3: env("PAD_SOCIAL", "") };
const phonesOn = !!(env("VMOS_AK", "") && env("VMOS_SK", "") && pads[1]);

export const CFG = {
  name: "UMP",
  bankMode,
  mock: env("MOCK", "0") === "1",
  // телефоны есть → торгуем через приложение (в paper — без финального подтверждения), нет → чистая бумага без телефонов
  executor: phonesOn && !env("MOCK", "0").startsWith("1") ? "phone" : "paper",
  tickSeconds: num("TICK_SECONDS", 60),

  bank: {
    unit: "usd",
    start: num("START_BANK_USD", 300),
    reserve: num("RESERVE_USD", 15),               // не торгуется никогда
    minPos: num("MIN_POSITION_USD", 5),
    maxPos: num("MAX_POSITION_USD", 15),
    minOrder: num("PUMP_MIN_ORDER_USD", 1),        // меньше этого приложение не продаст
    maxOpen: num("MAX_OPEN_POSITIONS", 0),          // 0 = без лимита
    maxExposurePct: num("MAX_EXPOSURE_PCT", 0.9),
    basePct: num("BASE_PCT", 0.25),
    dailyLossLimit: num("DAILY_LOSS_LIMIT_USD", 45),
    haltEquity: num("HALT_EQUITY_USD", 180),       // ниже — полный стоп
    lossStreakPause: num("LOSS_STREAK_PAUSE", 0),
    pauseMinutes: 120,
    reentryCooldownH: 24,
    maxEntriesPerHour: num("MAX_ENTRIES_PER_HOUR", 0),
    maxEntriesPerTick: num("MAX_ENTRIES_PER_TICK", 3),
    feePct: num("FEE_PCT", 0.01),                  // комиссия pump.fun ~1%
  },

  exits: {
    stopLoss: -Math.abs(num("STOP_LOSS_PCT", 25)) / 100,
    tp1: num("TP1_PCT", 60) / 100, tp1Sell: num("TP1_SELL_PCT", 50) / 100,
    tp2: num("TP2_PCT", 150) / 100,
    trail: num("TRAIL_PCT", 30) / 100,
    timeStopH: num("TIME_STOP_H", 6), timeBand: [-0.1, 0.15],
    lockAt: num("PROFIT_LOCK_PCT", 30) / 100, lockFloor: num("PROFIT_LOCK_FLOOR", 5) / 100,
    moon: num("MOON_PCT", 100) / 100, moonSell: 0.5,
    ranges: { stopLoss: [-0.30, -0.15], tp1: [0.40, 1.20], tp1Sell: [0.30, 0.60], tp2: [1.00, 3.00], trail: [0.20, 0.40] },
  },

  filters: {
    minMcapUsd: num("MIN_MCAP_USD", 100000),
    pumpFunOnly: env("PUMPFUN_ONLY", "1") !== "0",
    maxAgeH: num("MAX_AGE_H", 0),
    minAgeMin: num("MIN_AGE_MIN", 0),
    minVol1hUsd: num("MIN_VOL_1H_USD", 25000),
    maxRug: num("MAX_RUG", 0.45),
    maxTop10: num("MAX_TOP10", 0.35),
    maxBundler: num("MAX_BUNDLER", 0.35),
    maxSocialReuse: num("MAX_SOCIAL_REUSE", 5),
  },

  brain: {
    startThreshold: num("ENTRY_SCORE", 70),
    researchCooldownMin: num("RESEARCH_COOLDOWN_MIN", 15),
    picksPerScan: num("PICKS_PER_SCAN", 4),
    relookMovePct: num("RELOOK_MOVE_PCT", 35),
    reviewEveryMin: num("REVIEW_EVERY_MIN", 20),
    syncEveryMin: num("SYNC_MINUTES", 15),
  },

  research: { websiteTimeoutMs: 6000, websiteChars: 900 },
  admin: { token: env("ADMIN_TOKEN", "") },

  llm: (() => {
    const ds = env("DEEPSEEK_API_KEY", "");
    const provider = env("LLM_PROVIDER", ds ? "deepseek" : "anthropic");
    let model = env("LLM_MODEL", "");
    if (provider === "deepseek" && (!model || model.startsWith("claude"))) model = "deepseek-flash";
    if (provider === "anthropic" && !model) model = "claude-haiku-4-5-20251001";
    return { provider, model, key: provider === "deepseek" ? ds : env("ANTHROPIC_API_KEY", ""),
      base: env("LLM_BASE_URL", provider === "deepseek" ? "https://api.deepseek.com" : "https://api.anthropic.com") };
  })(),

  x: {
    handle: env("X_HANDLE", "ump_ai"),
    postVia: env("X_POST_VIA", "phone"),            // phone | api | off
    maxPerHour: num("MAX_TWEETS_PER_HOUR", 4),
    userToken: env("X_USER_TOKEN", ""),              // только для X_POST_VIA=api
    base: env("X_API_BASE", "https://api.twitter.com"),
  },

  phone: {
    on: phonesOn,
    pads,
    roles: { 1: "trade", 2: "scope", 3: "social" },
    // paper всегда без финального подтверждения; в live подтверждение только при PHONE_DRY_RUN=0
    dryRun: bankMode === "paper" || env("PHONE_DRY_RUN", "1") !== "0",
    stepDelayMs: num("PHONE_STEP_DELAY_MS", 900),
    leadMs: num("CURSOR_LEAD_MS", 350),               // курсор на сайте появляется раньше реального нажатия
    fpsActive: num("PHONE_FPS_ACTIVE", 2), fpsIdle: num("PHONE_FPS_IDLE", 0.5),
    idleBrowse: env("IDLE_BROWSE", "1") !== "0",
    width: num("PHONE_WIDTH", 720), height: num("PHONE_HEIGHT", 1600),
    vmosAk: env("VMOS_AK", ""), vmosSk: env("VMOS_SK", ""),
    pkg: {
      pump: env("PUMPFUN_PKG", "fun.pump.app"),
      x: env("X_PKG", "com.twitter.android"),
      chrome: env("CHROME_PKG", "com.android.chrome"),
    },
  },
  live: { port: num("LIVE_PORT", 8789), allowOrigin: env("LIVE_ALLOW_ORIGIN", "*") },

  links: {
    site: env("SITE_URL", "https://umpai.trade"),
    x: env("X_HANDLE", "ump_ai") ? `https://x.com/${env("X_HANDLE", "ump_ai").replace(/^@/, "")}` : "",
    github: env("GITHUB_URL", "https://github.com/umpai/ump-agent"),
    pump: env("PUMP_URL", "https://pump.fun"),
    contract: env("CONTRACT_ADDRESS", ""),           // пусто, пока нет официального токена
  },

  paths: {
    data: path.join(ROOT, "brain", "data"),
  },
};
