FROM oven/bun:1 AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src/ src/
COPY tsconfig.json ./
RUN bun build src/index.ts --target=bun --outfile=dist/knoldr.js \
    --external playwright --external playwright-core \
    --external @huggingface/transformers --external pdf-parse

FROM oven/bun:1

# Playwright Chromium system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2t64 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN bunx playwright install chromium

COPY --from=build /app/dist/knoldr.js dist/

ENV KNOLDR_PORT=3000
ENV KNOLDR_HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["bun", "dist/knoldr.js"]
