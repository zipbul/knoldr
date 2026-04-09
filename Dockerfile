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

# Playwright Chromium system deps + Node.js (for codex CLI)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2t64 libxfixes3 fonts-liberation \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Install LLM CLIs
RUN npm install -g @openai/codex \
    && bun install -g @google/gemini-cli

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN bunx playwright install chromium

COPY --from=build /app/dist/knoldr.js dist/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV KNOLDR_PORT=5100
ENV KNOLDR_HOST=0.0.0.0
EXPOSE 5100

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD bun -e "fetch('http://localhost:5100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "dist/knoldr.js"]
