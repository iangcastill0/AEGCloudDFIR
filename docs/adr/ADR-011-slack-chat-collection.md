# ADR-011: Slack, and a `chat` collection source

Status: proposed · Date: 2026-09-01

## Context

Slack is the third-largest evidence source most clients have, after mail and
files, and it is the one where the conversation actually happens. The product
today has three sources — `email`, `drive`, `audit` — and a Slack channel is
none of them.

Two Slack facts shape everything below. Both are already covered by tests in
`packages/connectors/src/slack/`:

- **Slack reports failure with HTTP 200** and `{"ok": false, "error": "..."}`.
  `ensureOk` is built on status codes, so an unguarded Slack call records zero
  messages as a complete success. Every response goes through
  `readSlackEnvelope` first.
- **`conversations.history` returns thread parents only.** Replies are behind
  `conversations.replies`, and nothing signals their absence except
  `reply_count`. In an active workspace most content is in threads, so missing
  this collects a fraction and calls it complete.

## Decision

### 1. A new source: `chat`

`CollectionSource` gains `chat`, alongside `email`, `drive`, `audit`.

The alternative — calling Slack messages `email` — was rejected. It ships
faster and reuses the mail pipeline, but the UI, the manifest and the
production load file would then all state that a Slack message is an email.
This product's value is that its statements can be relied on; a false field in
a manifest is not a shortcut, it is a defect. Modelling messages as `drive`
files was also rejected: it loses author, timestamp and thread as first-class
searchable fields, which are precisely what a reviewer filters on.

`chat` is written generically so Microsoft Teams and Google Chat reuse it.

### 2. Evidence kinds

`EvidenceKind` gains:

- `chat_message` — one message. The preserved native is the message JSON
  exactly as Slack returned it.
- `chat_conversation` — one channel/DM, holding the collection-time metadata
  (name, purpose, membership, archived state). Membership at collection time is
  evidence and Slack does not keep history of it.

Attachments stay `attachment`, parented to their message, so the existing
family, OCR and production paths work unchanged.

### 3. Threads are a family, not a field

A reply is an `attachment`-style child of its parent message via the existing
`EvidenceRelationship` family kinds. Family grouping in Review, production
family-split validation and `includeFamilies` in exports then work with no
change — a thread produced without its replies would already be flagged.

### 4. Scope

`scope.chat`:

- `conversationIds` — explicit channels, or null for everything reachable
- `includePublic` / `includePrivate` / `includeDms` / `includeGroupDms`
- `includeArchived`
- date range reuses the existing collection-wide range

DMs are opt-in and default off. Reaching a custodian's DMs is a materially
larger intrusion than reading a public channel, and it should be a decision
someone made rather than a default they inherited.

### 5. Two access tiers, named honestly

- **Regular workspace, user token.** Reaches what that user can see: public
  channels, plus private channels and DMs they are in. Cannot reach a channel
  they are not a member of. This is a real limit and belongs in the
  completeness narrative, not in a footnote.
- **Enterprise Grid, org app.** `discovery.*` reaches every conversation
  including DMs, and `audit.logs` provides the provider-side forensic record
  (the Slack analogue of Dropbox's team event log). Requires org-level
  installation an admin must approve.

Tier 1 is built first. Tier 2 is a later ADR: without a Grid tenant to test
against it would ship unproven, and this project has been burned by exactly
that twice this week.

### 6. Audit source

Slack's `audit.logs` becomes `AuditSystem.slack_audit_logs`, following
`dropbox_team_log`. Grid only.

## Consequences

Two enum migrations (`CollectionSource`, `EvidenceKind`), applied by hand on
both databases as the others were. Search mapping gains `chat.*` fields
(author, conversation, thread, editedAt) behind a `MAPPING_VERSION` bump, so a
reindex is required.

Every place that switches on source or kind must handle `chat`. That is a
feature of the change, not a cost: making the enums exhaustive is what made the
Dropbox work surface all six call sites through the type checker rather than at
runtime.

Edited and deleted messages need explicit representation. Slack keeps no copy
of prior text, so an edited message is recorded as a revision with its edit
time, and a `tombstone` is recorded as a deletion rather than as empty text. A
reviewer who is not told cannot know.

The regular-workspace tier will produce collections that are visibly partial by
design. That must read as a stated limit of the access granted, never as a
collection failure — the same distinction the IMAP coverage exception draws for
a mail server that withholds most of a mailbox.
