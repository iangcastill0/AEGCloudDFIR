# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages ./packages

# Next.js INLINES NEXT_PUBLIC_* into the client bundle at BUILD time, so these
# must be present here — setting them only at runtime leaves the browser
# calling the defaults (localhost), which breaks any real hostname. Rebuild the
# image whenever these change; see docs/guides/domain-setup.md.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_AUTHENTIK_URL=http://localhost:9443
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_AUTHENTIK_URL=${NEXT_PUBLIC_AUTHENTIK_URL}

RUN pnpm install --frozen-lockfile --filter @aeg-clouddfir/web... \
 && pnpm --filter @aeg-clouddfir/web... build

FROM node:22-alpine
RUN apk add --no-cache wget tini && addgroup -S ev && adduser -S ev -G ev
WORKDIR /app
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
USER ev
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
