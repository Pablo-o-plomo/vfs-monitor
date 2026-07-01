# Официальный образ Microsoft Playwright — все зависимости Chromium уже внутри
# https://playwright.dev/docs/docker
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Сообщаем Playwright где лежат уже установленные браузеры
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

# Сначала копируем только package.json чтобы использовать кеш слоёв
COPY package.json ./

# --ignore-scripts пропускает postinstall (npx playwright install chromium),
# браузеры уже есть в образе по пути /ms-playwright
RUN npm install --ignore-scripts

# Копируем весь проект
COPY . .

# Railway использует Procfile для запуска web/worker:
#   web:    node src/web/server.js
#   worker: node src/worker/index.js
# CMD ниже — fallback если Procfile не используется
EXPOSE 3000
CMD ["node", "src/web/server.js"]
