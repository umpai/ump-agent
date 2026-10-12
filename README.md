# UMP

Live at [umpai.trade](https://umpai.trade). On X: [@ump_ai](https://x.com/ump_ai).

An autonomous AI memecoin trader on pump.fun. He works three real cloud phones, live:

| Phone | Role | What's open |
|---|---|---|
| #1 trade | buys, sells, leaves his thesis in the coin's comments | the pump.fun app |
| #2 scope | shows the chart and holders he is reading | gmgn.ai in Chrome |
| #3 social | checks the project's X account, posts each position | the X app |

One cursor moves between the phones on the website, so you always see which phone he is using.

## How one trade happens

1. **Scan.** Every 60 seconds: GMGN trending (1m, 5m, 1h, pump.fun only, no wash trading), checked against DexScreener.
2. **Hard filters.** Rug ratio, active mint or freeze, heavy top 10, bundled supply, dead volume, recycled socials.
3. **Scope.** Phone #2 opens the coin on gmgn.ai. This is for you to watch; numbers for decisions come from the APIs.
4. **X check.** Phone #3 opens the project's X account and returns `ok`, `weak`, `fake` or `none`. A borrowed tweet or no website is normal on pump.fun and never a reason to skip.
5. **Decide.** Signals are scored against an adaptive threshold. The model (DeepSeek) defaults to entering; skipping a coin above the threshold needs a named veto: `falling_knife`, `blow_off`, `smart_exit`, `sellers`, `fake_socials`.
6. **Trade.** Phone #1 buys in the pump.fun app. The screen is checked before confirming. The thesis goes into the coin's comments.
7. **Post.** Phone #3 posts the position on X (max 4 posts an hour).
8. **Exits run by themselves** every 20 seconds: stop, take-profit 1 and 2, trailing, profit lock (peak +30% moves the stop to +5%), moon (+100% sells half), time stop.
9. **Learning.** Every closed trade writes a lesson and moves the signal weights. Once a day he rewrites his playbook.

The pump.fun app is the source of truth for money: balance and positions are reconciled every 15 minutes.

## Safety

- The code has no withdraw, send or key-export actions. A screen showing a seed phrase, private key, wallet export or recipient address makes the phone go back and the scenario stop.
- `BANK_MODE=paper`: the phones walk the whole path but skip the final confirm. The bank is virtual.
- `npm run stop` blocks every action on every phone until `npm run unstop`.
- Text from token pages, X profiles and websites is treated as untrusted data, never as instructions.
- Keys live only in `.env` on the server.

## Run

```
cp .env.example .env    # fill in keys and pad codes
npm install
npm run phone:ping -- all
npm run live            # brain + phones + live API on LIVE_PORT
```

Live API: `GET /state`, `GET /events` (SSE), `GET /phone/{1,2,3}.jpg`, admin at `/admin#<ADMIN_TOKEN>`.

The website is one file, `docs/index.html`, served by Netlify. It connects to `https://live.<site domain>` and shows a labelled demo when the live server is unreachable.

Experimental. Not financial advice. There is no official UMP token.

Built on the open-source brain of FOMI. MIT license.
