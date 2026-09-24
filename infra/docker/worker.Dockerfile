# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# PST writer. Built from VENDORED source in services/pst-builder, never pulled
# as a prebuilt binary and never restored from the upstream NuGet package — see
# services/pst-builder/UPSTREAM.md for why (13 commits, one author, one star).
#
# Published as one self-contained linux-x64 file, which measured +42 MB. That is
# trivial next to the LibreOffice already in the runtime image.
#
# Only MimeKit comes from NuGet. It is a decade-old mainstream MIME library, not
# the thing we were worried about disappearing.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS pstb
WORKDIR /src
COPY services/pst-builder ./services/pst-builder
RUN dotnet publish services/pst-builder/cli/pstb.csproj \
      -c Release -r linux-x64 --self-contained true \
      -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true \
      -o /out \
 && test -x /out/pstb

FROM node:22-bookworm-slim AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY apps/worker ./apps/worker
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @aeg-clouddfir/worker... \
 && pnpm --filter @aeg-clouddfir/worker... build

# Worker runtime: extraction/OCR/conversion tools live ONLY here, never in api.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini wget ca-certificates \
      tesseract-ocr tesseract-ocr-eng \
      libreoffice \
      poppler-utils \
      ghostscript \
      # For the PST writer. Without it the .NET runtime exits BEFORE Main with
      # "Couldn't find a valid ICU package", which looks like the binary is
      # broken rather than a missing package. It is not optional: folder names
      # and attachment filenames in real mail are Japanese, Cyrillic and
      # accented Latin, so InvariantGlobalization is the wrong trade here.
      libicu72 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r ev && useradd -r -g ev -d /app ev
# Provided the same way tesseract, pdftoppm and soffice are: on PATH, run as a
# child process. CDFIR_PSTB_BIN defaults to this path.
COPY --from=pstb --chown=root:root /out/pstb /usr/local/bin/pstb
RUN chmod 0755 /usr/local/bin/pstb
# A PST export is assembled here, NOT in /tmp. /tmp is a small tmpfs, so a
# multi-gigabyte PST there either fills RAM or lands on the container's writable
# layer. That disk filling once crashed PostgreSQL, and it could not restart
# because replaying its log also needed space. Compose mounts a named volume
# over this path; the directory exists so a misconfigured deploy fails on a
# permission error rather than writing to the image layer.
RUN mkdir -p /var/lib/cdfir/export-scratch && chown ev:ev /var/lib/cdfir/export-scratch
# Whole built workspace — see api.Dockerfile for why `pnpm deploy` cannot be
# used (it omits workspace packages, causing ERR_MODULE_NOT_FOUND at startup).
COPY --from=builder --chown=ev:ev /app /app
USER ev
EXPOSE 5100
WORKDIR /app/apps/worker
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
# Sandboxing (orchestration level): read_only rootfs, tmpfs /tmp with size
# limit, no-new-privileges, CPU/memory limits, egress restricted to provider
# API allowlist + internal services.
