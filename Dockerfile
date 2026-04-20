FROM oven/bun:1

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
