# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @aeg-clouddfir/api... \
 && pnpm --filter @aeg-clouddfir/api... build

FROM node:22-alpine
RUN apk add --no-cache wget tini && addgroup -S ev && adduser -S ev -G ev
# Copy the whole built workspace so pnpm's symlinked node_modules resolve
# exactly as they did in the builder.
#
# `pnpm deploy` was tried first and is NOT usable here: without
# inject-workspace-packages it omits the workspace packages entirely, so the
# image built fine but crashed on startup with
#   ERR_MODULE_NOT_FOUND: Cannot find package '@aeg-clouddfir/config'
# Enabling injection would change how local development links workspace
# packages (copies instead of symlinks, needing a reinstall after every edit),
# so the trade is a larger image in exchange for an unchanged dev loop.
COPY --from=builder --chown=ev:ev /app /app
USER ev
EXPOSE 4000
WORKDIR /app/apps/api
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
# Read-only root FS is applied at orchestration level (compose/k8s):
#   read_only: true + tmpfs /tmp
