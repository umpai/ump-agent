# UMP: запуск на сервере

Сервер тот же, что у FOMI и FOMIX: `root@177.1.180.199`. UMP работает рядом с ними: порт 8789, процесс в pm2 называется `ump`.

- Сайт: https://umpai.trade (Netlify, папка `docs`)
- Live API: https://live.umpai.trade
- Код: https://github.com/umpai/ump-agent
- X: @ump_ai

## 1. Установка (один раз)

Одна команда: клонирует код, ставит зависимости и создаёт `.env`. Коды падов подставь свои (готовую команду с ними Claude дал в чате). Ключи VMOS, DeepSeek и GMGN берутся из `.env` FOMI, они общие. В чат и в git ключи не попадают.

```
cd ~ && git clone https://github.com/umpai/ump-agent.git && cd ump-agent && npm install && cp .env.example .env && for k in VMOS_AK VMOS_SK DEEPSEEK_API_KEY GMGN_API_KEY; do v=$(grep "^$k=" ~/fomi-agent/.env | cut -d= -f2-); sed -i "s|^$k=.*|$k=$v|" .env; done && sed -i -e "s|^PAD_TRADE=.*|PAD_TRADE=<код #1>|" -e "s|^PAD_SCOPE=.*|PAD_SCOPE=<код #2>|" -e "s|^PAD_SOCIAL=.*|PAD_SOCIAL=<код #3>|" -e "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(openssl rand -hex 16)|" .env && grep -E "^(BANK_MODE|PAD_|START_BANK|PHONE_DRY_RUN)" .env
```

GMGN пока тот же ключ, что у FOMI. Отдельный ключ потом можно вписать так: `nano ~/ump-agent/.env`, строка `GMGN_API_KEY=`.

## 2. Проверка телефонов

```
cd ~/ump-agent && npm run phone:ping -- all
```

Должно быть три строки `ok`. Затем:

```
npm run phone:debug -- 1
```

Команда покажет настоящее имя пакета pump.fun. Если оно не `fun.pump.app`, впиши его в `.env` (`PUMPFUN_PKG=`).

## 3. Карта интерфейса (калибровка)

Открой на телефоне #1 нужный экран (страница токена, экран покупки, комментарии, портфель) и выполни:

```
cd ~/ump-agent && npm run phone:snap -- 1
```

Пришли Claude вывод команды, он заполнит `brain/phone/ui/pumpfun.json`. То же для `-- 2` (gmgn) и `-- 3` (X).

Проверка сценариев без денег:

```
npm run phone:test -- <CA> <TICKER> 10
npm run scope:test -- <CA> <TICKER>
npm run x:check -- https://x.com/<handle> <TICKER>
npm run x:test -- "test post, not sent"
```

## 4. Запуск

```
cd ~/ump-agent && npm run launch -- 300 && pm2 start npm --name ump -- run live && pm2 save
```

Caddy: добавить блок и перезагрузить.

```
printf '\nlive.umpai.trade {\n  reverse_proxy localhost:8789\n}\n' >> /etc/caddy/Caddyfile && systemctl reload caddy
```

DNS (добавляешь ты): в Netlify → Domains → umpai.trade → DNS records → Add new record: тип `A`, имя `live`, значение `177.1.180.199`.

## 5. Реальные сделки

Пока `PHONE_DRY_RUN=1`, UMP проходит весь путь на телефоне, но не нажимает финальное «купить». На сайте висит плашка «setup». После калибровки:

```
cd ~/ump-agent && sed -i "s|^PHONE_DRY_RUN=.*|PHONE_DRY_RUN=0|" .env && pm2 restart ump
```

На кошельке pump.fun должно лежать $300. Банк $300 уже задан командой `launch` в шаге 4.

## Полезные команды

- Логи: `pm2 logs ump --lines 100`
- Обновление: `cd ~/ump-agent && git pull && pm2 restart ump`
- Рубильник: `npm run admin -- status|on|pause|off`
- Аварийный стоп телефонов: `npm run stop` (снять: `npm run unstop`)
- Банк: `npm run status`
- Сверка с pump.fun: `npm run sync`
- Поправить итог сделки: `npm run fix -- TICKER PCT`
- Админка: `https://live.umpai.trade/admin#<ADMIN_TOKEN>`. Токен показывает команда `grep ADMIN_TOKEN ~/ump-agent/.env`.

## Важно

- Не запускать `npm run launch`, пока есть открытые live-позиции: агент их забудет. Команда сама откажется.
- Лимиты под $300: позиция $10–25, резерв $15, дневной убыток $45, полная остановка при equity < $180.
- Автоматизация X через приложение может привести к блокировке аккаунта. Поэтому аккаунт отдельный, с меткой «Automated» в настройках X, и не больше 4 постов в час.
