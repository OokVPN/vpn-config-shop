# VPN Config Shop

Telegram-магазин VPN-конфигураций на Node.js.

## Стек

- Telegram Bot API
- Vercel Functions
- Turso / libSQL
- YooKassa (платежи — следующий этап)

## Статус

Начальный каркас. Каталог читает товары из базы данных.
Создание платежей, полноценная админ-панель и выдача конфигов
пока не реализованы.

## Переменные окружения

Настрой в Vercel → Settings → Environment Variables:

- `BOT_TOKEN`
- `ADMIN_IDS`
- `WEBHOOK_SECRET`
- `YOOKASSA_SHOP_ID`
- `YOOKASSA_SECRET_KEY`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `APP_URL`

Не добавляй реальные значения в Git.

## База данных

Примени `database/schema.sql` к своей базе Turso через
поддерживаемый интерфейс управления базой данных.

## Telegram webhook

После деплоя задай webhook для адреса:

`https://YOUR-APP.vercel.app/api/webhook`

При установке webhook передай `WEBHOOK_SECRET` как
`secret_token`. Сам секрет не публикуй.

## Безопасность

Не храни реальные конфиги и секреты в репозитории.
Перед запуском продаж обязательно реализовать и проверить
подтверждение платежей, идемпотентность и атомарную выдачу.
