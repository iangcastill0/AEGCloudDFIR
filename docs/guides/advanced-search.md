# The advanced query language

Review offers two query languages, chosen with the **Query language** selector.
Both are parsed into the same internal query, so the choice affects only how you
write a search — never what it is allowed to reach. Tenant isolation, case
restrictions and cost limits are applied after parsing, identically for both.

|                    | Simple                       | Advanced                              |
| ------------------ | ---------------------------- | ------------------------------------- |
| A word in the body | `insurance`                  | `body CONTAINS insurance`             |
| Exact phrase       | `subject:"quarterly report"` | `subject CONTAINS "quarterly report"` |
| An address         | `from:alice@example.com`     | `from.address IS alice@example.com`   |
| Exclude            | `NOT draft`                  | `body DOES NOT CONTAIN draft`         |
| Date bound         | `date>2026-01-01`            | `date > 2026-01-01`                   |
| Several tags       | `tags:a OR tags:b`           | `tags IS ANY OF (a, b)`               |

## Operators

- **Text** parameters (`body`, `subject`, `name`, `text`, `attachment`, `ocr`):
  `CONTAINS`, `DOES NOT CONTAIN`
- **Keyword and address** parameters (`tags`, `custodian`, `from.address`, …):
  `IS`, `IS NOT`
- **Dates and sizes** (`date`, `sent-date`, `size`, …): `=`, `>`, `<`, `>=`, `<=`
- **Anything**: `EXISTS`, `DOES NOT EXIST`

Using the wrong family is an error that names the right one, rather than a query
that quietly matches nothing.

### Several values at once

Instead of writing three conditions joined by `OR`:

```
tags IS ANY OF (Documentation, "From Zips", Important)
body CONTAINS ANY OF ("email data", "open file")
tags IS ALL OF (Hot, Reviewed)
tags IS NONE OF (Confidential, Privileged)
tags IS NOT ALL OF (Hot, Reviewed)
body CONTAINS NONE OF (draft, wip)
body DOES NOT CONTAIN ANY OF (draft, wip)
```

`ANY OF` becomes OR, `ALL OF` becomes AND, and `NONE OF` negates the OR. A list
of one value is just that value — no pointless group.

### Grouping

`AND`, `OR`, `NOT` and parentheses. `OR` binds more loosely than `AND`, so
`a AND b OR c` means `(a AND b) OR c`.

Unlike the simple language, **an operator between conditions is required**.
`tags IS a tags IS b` is an error, because guessing AND would silently change the
search someone may certify.

### Proximity (slop)

`body CONTAINS "wire transfer"~3` finds the words up to three positions out of
place. `~0` means exactly as written.

## Parameters

The document this language is modelled on lists parameters that this application
has no equivalent for — imported Bates numbers, review sets, processing state,
privilege categories, page counts. Those names are **refused**, with a suggestion,
rather than accepted and ignored: a search that silently drops a condition is
worse than one that will not run.

Names from that document map onto this app's fields:

| Written                                                   | Searches                   |
| --------------------------------------------------------- | -------------------------- |
| `content`                                                 | all indexed text           |
| `type`                                                    | file extension             |
| `name.ext`                                                | file extension             |
| `name.dirs`, `directory`                                  | folder path                |
| `ingestion-date`                                          | when the item was acquired |
| `sent-date`, `received-date`                              | email sent/received dates  |
| `to.address`, `from.address`, `cc.address`, `bcc.address` | those headers              |
| `participant.address`                                     | any of from/to/cc/bcc      |
| `sender.address`                                          | on-behalf-of sender        |
| `system-tags`                                             | source labels              |

This app's own field names work directly too — `kind`, `bates`, `threadid`,
`privileged`, `produced`, `hash`, and the rest. The full list is in the query
help beside the search box.

## Errors

Errors carry the position of the problem, so the message can point at the
character that broke:

```
unknown parameter "review-set". Supported parameters include body, subject, …
"tags" does not support CONTAINS; use IS (or IS NOT)
expected an operator after "body" — use CONTAINS (or DOES NOT CONTAIN), or EXISTS
```

## Saved searches

A saved search records which language it was written in, so loading one re-parses
it the way it was written. Rows saved before this feature are treated as simple,
which is what they are.
