# VFS Global Monitor — Telegram-бот для мониторинга слотов

Бот проверяет наличие свободных слотов записи в визовый центр VFS Global и присылает уведомление в Telegram, когда слот появляется. **Бронирование выполняется вручную** — бот только уведомляет.

---

## Быстрый старт (локально)

```bash
# 1. Клонируем / копируем проект
cd vfs-monitor

# 2. Устанавливаем зависимости
npm install

# 3. Устанавливаем браузер Playwright
npx playwright install chromium

# 4. Создаём .env
cp .env.example .env
nano .env   # заполняем все переменные

# 5. Тестовый запуск
npm start
```

---

## Деплой на TimeWeb (Ubuntu сервер)

### 1. Подключаемся к серверу

```bash
ssh root@<IP_СЕРВЕРА>
```

### 2. Устанавливаем Node.js 20 (если ещё нет)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v  # должно быть v20+
```

### 3. Устанавливаем системные зависимости для Chromium

```bash
npx playwright install-deps chromium
# или вручную:
apt-get install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
  libgbm1 libasound2 libxcomposite1 libxdamage1 libxrandr2 libxss1 \
  libxtst6 fonts-liberation libappindicator3-1 xdg-utils
```

### 4. Копируем проект на сервер

```bash
# С локальной машины:
scp -r vfs-monitor root@<IP>:/root/
```

или через git:

```bash
git clone <repo_url> /root/vfs-monitor
```

### 5. Устанавливаем зависимости и браузер на сервере

```bash
cd /root/vfs-monitor
npm install
npx playwright install chromium
```

### 6. Создаём .env

```bash
cp .env.example .env
nano .env
```

Минимальный `.env`:

```
VFS_EMAIL=test@example.com
VFS_PASSWORD=yourpassword
VFS_CENTER=Краснодар
VFS_CATEGORY=Краткосрочные
VFS_SUBCATEGORY=Туризм
DATE_FROM=2026-07-01
DATE_TO=2026-08-31
TELEGRAM_BOT_TOKEN=1234567890:AAxxxxxxxx
TELEGRAM_CHAT_ID=-100xxxxxxxxxx
CHECK_INTERVAL_MIN=7
CHECK_INTERVAL_JITTER=3
```

### 7. Устанавливаем PM2

```bash
npm install -g pm2
```

### 8. Запускаем через PM2

```bash
cd /root/vfs-monitor
pm2 start ecosystem.config.js
pm2 save           # автозапуск при перезагрузке сервера
pm2 startup        # следуем инструкции в выводе
```

### Управление

```bash
pm2 status         # статус процессов
pm2 logs vfs-monitor   # логи в реальном времени
pm2 restart vfs-monitor
pm2 stop vfs-monitor
```

---

## Как получить Telegram Bot Token и Chat ID

1. Напишите [@BotFather](https://t.me/BotFather) → `/newbot` → получаете токен
2. Создайте канал или группу, добавьте бота как администратора
3. Отправьте любое сообщение в канал, затем откройте:  
   `https://api.telegram.org/bot<TOKEN>/getUpdates`  
   Найдите поле `chat.id` — это и есть `TELEGRAM_CHAT_ID` (для каналов будет отрицательным)

---

## Архитектура

```
src/
├── index.js      — главный цикл, дедупликация, обработка ошибок
├── monitor.js    — логин + перехват API слотов + DOM-парсинг как fallback
├── browser.js    — Playwright stealth, управление сессией
├── telegram.js   — отправка уведомлений
├── config.js     — конфигурация из .env
└── logger.js     — Winston логгер
```

### Стратегия обхода защиты

- **playwright-extra + stealth plugin** — скрывает признаки автоматизации
- **Реалистичные задержки** — случайные паузы между действиями
- **Сохранение сессии** — cookies сохраняются в `session.json`, повторный логин реже
- **Умеренный интервал** — 7±3 минуты между проверками (не агрессивно)
- **Тестовый аккаунт** — используйте аккаунт без реальных данных на стадии тестирования

### Перехват API

Бот перехватывает XHR-ответы содержащие `/slot`, `/appointment`, `/schedule` и парсит JSON. Если API изменился — автоматически падает к парсингу DOM-календаря.

---

## Что делать при получении уведомления

1. Открыть ссылку из уведомления
2. Войти в **свой основной аккаунт VFS**
3. Выбрать визовый центр, категорию, заявителя
4. Выбрать найденный слот и подтвердить бронирование вручную

---

## Важно

- Бот **не вводит паспортные данные** и **не бронирует автоматически**
- Используйте разумный интервал (не менее 5 минут) — агрессивный polling может привести к блокировке IP
- При длительной блокировке — смените IP сервера или добавьте proxy
