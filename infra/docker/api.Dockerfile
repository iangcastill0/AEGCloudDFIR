# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @aeg-clouddfir/api... \
 && pnpm --filter @aeg-clouddfir/api... build \
 \
 # --legacy keeps the pre-pnpm-10 deploy behaviour; the alternative
 # (inject-workspace-packages=true) would change how local dev links
 # workspace packages.
 && pnpm --filter @aeg-clouddfir/api deploy --legacy --prod /out

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
