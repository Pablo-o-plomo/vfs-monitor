# Adria Travel Monitor

SaaS-инструмент для мониторинга свободных слотов записи в визовые центры VFS Global.

**Что делает:**
- Отслеживает появление слотов по параметрам (страна, центр, категория, даты)
- Хранит клиентов и их заявки в PostgreSQL
- Присылает Telegram-уведомление когда слот появляется
- Не бронирует автоматически — финальная запись делается вручную

---

## Архитектура

```
┌─────────────┐    ┌──────────────────┐    ┌──────────────┐
│  Web Admin  │    │    PostgreSQL     │    │   Worker     │
│  (Express)  │◄──►│  5 таблиц        │◄──►│  VFS checks  │
│  :3000      │    │                  │    │  Telegram    │
└─────────────┘    └──────────────────┘    └──────────────┘
```

**Таблицы:** `clients` → `visa_requests` → `monitoring_jobs` + `slot_events` + `notifications`

**Процессы:**
- `web` — Express admin panel, управление клиентами и заявками
- `worker` — фоновый процесс, читает активные заявки и проверяет VFS каждые ~7 мин

---

## Запуск локально

### 1. Зависимости

```bash
cd vfs-monitor
npm install
npx playwright install chromium
```

### 2. Настройка

```bash
cp .env.example .env
# Заполнить: DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
#            ADMIN_PASSWORD, VFS_EMAIL, VFS_PASSWORD
```

### 3. База данных (локально)

```bash
# Создать БД в PostgreSQL:
createdb adria_monitor

# В .env:
DATABASE_URL=postgresql://localhost/adria_monitor
```

### 4. Запуск

```bash
# Оба процесса вместе (dev режим):
npm run dev

# Или раздельно:
npm run dev:web     # только web-панель
npm run dev:worker  # только worker

# Применить миграции отдельно:
npm run migrate
```

Открыть: http://localhost:3000

---

## Деплой на Railway

### Подготовка

1. Создать проект на [railway.app](https://railway.app)
2. Добавить PostgreSQL плагин → Railway автоматически добавит `DATABASE_URL`
3. Подключить GitHub репозиторий

### Два сервиса в одном проекте

Railway поддерживает несколько сервисов из одного репо:

**Сервис 1: Web**
- Start command: `npm start`
- Переменные: все 6 из `.env.example`

**Сервис 2: Worker**
- Start command: `npm run worker`
- Переменные: те же 6 (можно скопировать)
- Public URL: не нужен

### Переменные окружения (Railway → Variables)

```
DATABASE_URL          — выдаётся автоматически Postgres плагином
TELEGRAM_BOT_TOKEN    — токен бота от @BotFather
TELEGRAM_CHAT_ID      — ID канала (с минусом) или чата
ADMIN_PASSWORD        — пароль для входа в панель
VFS_EMAIL             — email тестового аккаунта VFS
VFS_PASSWORD          — пароль тестового аккаунта VFS
```

### Один раз после деплоя

Миграции применяются автоматически при старте `web` и `worker` процессов.

---

## Структура файлов

```
src/
├── config.js              # 6 ENV-переменных
├── logger.js              # Winston
├── browser.js             # Playwright stealth + сессии
├── db/
│   └── index.js           # pg Pool + migrate()
├── services/
│   ├── vfs.js             # Логика проверки VFS (принимает params из БД)
│   └── notifier.js        # Telegram с инфо о клиенте
├── web/
│   ├── server.js          # Express
│   ├── middleware/auth.js
│   ├── routes/
│   │   ├── dashboard.js
│   │   ├── clients.js
│   │   └── requests.js
│   └── views/             # EJS шаблоны
└── worker/
    └── index.js           # Цикл мониторинга

migrations/
└── 001_init.sql           # Схема БД (5 таблиц)

nixpacks.toml              # Railway build (Chromium deps)
Procfile                   # web + worker процессы
```

---

## Как получить Telegram Bot Token и Chat ID

1. [@BotFather](https://t.me/BotFather) → `/newbot` → токен
2. Создать канал, добавить бота как администратора
3. `https://api.telegram.org/bot<TOKEN>/getUpdates` → найти `chat.id`

---

## Важно

- Бот **не вводит паспортные данные** и **не бронирует автоматически**
- Используйте тестовый аккаунт VFS для мониторинга
- Интервал по умолчанию 7±3 мин — не агрессивно, VFS не банит при таком режиме
- При 5 ошибках подряд заявка переходит в статус `error` и приходит Telegram-уведомление
