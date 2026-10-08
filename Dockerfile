FROM node:22-slim

# Chromium + fonts (emoji/CJK so Snapchat renders properly in the live screen)
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY snapbot.js ./
COPY server ./server

CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
