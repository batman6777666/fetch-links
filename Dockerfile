# Dockerfile for fetch-links backend — Render deployment
FROM node:18-bullseye-slim

# Install OS-level libraries that Playwright's bundled Chromium needs
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libglib2.0-0 \
    fonts-liberation \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only the backend package files
COPY backend/package*.json ./

RUN npm install --omit=dev

# Download Playwright's own Chromium binary into the image
RUN npx playwright install chromium

# Copy only the backend source (server.js etc.) — frontend is excluded
COPY backend/ .

ENV NODE_OPTIONS="--max-old-space-size=512"

EXPOSE 10000

CMD ["node", "server.js"]

