FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

# Install Bun + minimal tooling. libstdc++ is required for
# onnxruntime-node native bindings.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | bash \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ src/
COPY tsconfig.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV KNOLDR_PORT=5100
ENV KNOLDR_HOST=0.0.0.0
# Prefer CUDA inference when the runtime exposes a GPU; the code
# falls back to CPU automatically if the GPU load throws.
ENV KNOLDR_INFERENCE_DEVICE=cuda
EXPOSE 5100

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD bun -e "fetch('http://localhost:5100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "src/index.ts"]
