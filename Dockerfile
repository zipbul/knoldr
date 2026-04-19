FROM oven/bun:1

# Node.js required by codex CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# LLM CLIs (query decomposition, link filtering)
RUN npm install -g @openai/codex \
    && bun install -g @google/gemini-cli

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ src/
COPY tsconfig.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV KNOLDR_PORT=5100
ENV KNOLDR_HOST=0.0.0.0
EXPOSE 5100

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD bun -e "fetch('http://localhost:5100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
# Run TS directly via Bun. Bundling broke jsdom's runtime data files
# and zod/v4 init order; Bun's native TS execution avoids both.
CMD ["bun", "src/index.ts"]
