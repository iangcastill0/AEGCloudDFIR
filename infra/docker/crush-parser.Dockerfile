# syntax=docker/dockerfile:1
FROM python:3.12-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential pkg-config libmagic-dev libsqlcipher-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY services/crush-parser/pyproject.toml ./pyproject.toml
COPY services/crush-parser/app ./app
RUN pip wheel --no-cache-dir --wheel-dir /wheels .

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget libmagic1 libsqlcipher1 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r crush && useradd -r -g crush -d /app crush

COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --no-deps /wheels/*.whl \
    && rm -rf /wheels

WORKDIR /app
COPY --chown=crush:crush services/crush-parser/app ./app
COPY services/crush-parser/THIRD_PARTY_NOTICES.md /licenses/THIRD_PARTY_NOTICES.md
COPY LICENSE /licenses/Apache-2.0.txt

RUN mkdir /scratch && chown crush:crush /scratch
USER crush
EXPOSE 5200

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5200", "--no-access-log"]
