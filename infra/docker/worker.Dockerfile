# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY apps/worker ./apps/worker
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @aeg-clouddfir/worker... \
 && pnpm --filter @aeg-clouddfir/worker... build \
 \
 # --legacy keeps the pre-pnpm-10 deploy behaviour; the alternative
 # (inject-workspace-packages=true) would change how local dev links
 # workspace packages.
 && pnpm --filter @aeg-clouddfir/worker deploy --legacy --prod /out

# Worker runtime: extraction/OCR/conversion tools live ONLY here, never in api.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini wget ca-certificates \
      tesseract-ocr tesseract-ocr-eng \
      libreoffice --no-install-recommends \
      poppler-utils \
      ghostscript \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r ev && useradd -r -g ev -d /app ev
WORKDIR /app
COPY --from=builder /out .
USER ev
EXPOSE 5100
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
# Sandboxing (orchestration level): read_only rootfs, tmpfs /tmp with size
# limit, no-new-privileges, CPU/memory limits, egress restricted to provider
# API allowlist + internal services.
