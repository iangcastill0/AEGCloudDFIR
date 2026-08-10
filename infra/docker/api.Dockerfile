# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @evidencevault/api... \
 && pnpm --filter @evidencevault/api... build \
 && pnpm --filter @evidencevault/api deploy --prod /out

FROM node:22-alpine
RUN apk add --no-cache wget tini && addgroup -S ev && adduser -S ev -G ev
WORKDIR /app
COPY --from=builder /out .
USER ev
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
# Read-only root FS is applied at orchestration level (compose/k8s):
#   read_only: true + tmpfs /tmp
