# AEG-CloudDFIR architecture

See `docs/adr/` for the decision records behind each choice.

## System context

```mermaid
flowchart LR
    subgraph Client
      B[Browser - Next.js web]
    end
    subgraph AEG-CloudDFIR
      API[api - NestJS/Fastify\nOIDC BFF + REST]
      W[worker - BullMQ processors\ncollection/processing/export/production]
      PG[(PostgreSQL 16\ntruth + RLS + audit chain + outbox)]
      OS[(OpenSearch 2.x\nrebuildable index)]
      R[(Redis 7\nBullMQ queues)]
      S3[(Wasabi/S3\noriginals + derivatives + manifests)]
    end
    IDP[Authentik OIDC]
    MS[Microsoft Graph]
    GG[Gmail / Drive APIs]
    CLAM[ClamAV]
    TIKA[Apache Tika]

    B -->|cookies + CSRF| API
    B -.->|login redirect| IDP
    API -->|code+PKCE| IDP
    API --> PG
    API --> OS
    API -->|presigned GET| S3
    API -->|outbox rows| PG
    W -->|FOR UPDATE SKIP LOCKED| PG
    W --> R
    W --> S3
    W --> OS
    W --> MS
    W --> GG
    W --> CLAM
    W --> TIKA
```

## Evidence acquisition flow (per item)

```mermaid
sequenceDiagram
    participant W as worker
    participant P as provider API
    participant S3 as object store
    participant PG as PostgreSQL

    W->>PG: CollectionItem state? (early return if preserved)
    W->>P: fetch native (RFC822 $value / raw / alt=media)
    P-->>W: byte stream
    W->>S3: stage (stream + SHA-256 while uploading)
    W->>S3: verify size, promote to originals/sha256/{h} (dedup-aware)
    W->>PG: TX: EvidenceBlob + EvidenceItem + metadata\n+ CollectionItem=preserved + audit(evidence.acquired)\n+ outbox(process.parse|extract, process.scan)
    Note over W,PG: checkpoint advances only after the page's items are durable
```

## Tenant isolation layers

```mermaid
flowchart TD
    Q[user query] --> AST[typed AST parse + validate]
    AST --> C[compile]
    C --> WRAP[wrapWithAuthorization\ntenant term + case ACL + privilege filter]
    WRAP --> OS[(OpenSearch)]
    subgraph SQL path
      REQ[request] --> GUARDS[session/tenant/role guards]
      GUARDS --> TXN[withTenantContext:\nSET LOCAL app.tenant_id]
      TXN --> RLS[(RLS policies\nfail closed)]
    end
```

## Job reliability

```mermaid
flowchart LR
    TX[state change + OutboxEvent\nsingle transaction] --> D[dispatcher\nSKIP LOCKED claim]
    D -->|jobId = dedup key| Q[(BullMQ)]
    Q --> PR[idempotent processor\nearly-return on done state]
    PR -->|retry w/ jitter| Q
    PR -->|exhausted| DLQ[(dead-letter)]
```

Production pipeline, search compilation details, and the data model live in
the package sources; the canonical model is `packages/database/prisma/schema.prisma`.
