# Vendored PST writer

## What this is

`vendor/PST-Builder/` is a copy of somebody else's code. We keep the copy in our
own repo instead of downloading it when we build.

|               |                                                 |
| ------------- | ----------------------------------------------- |
| Upstream      | https://github.com/ml6719/PST-Builder           |
| Commit        | `a0d3f9c488f789c1f585f3c0d0083c9cd4bcd718`      |
| Tag / version | `1.3.0`                                         |
| Commit date   | 2026-07-03                                      |
| Licence       | MIT — full text in `vendor/PST-Builder/LICENSE` |

## Why we copied it instead of downloading it

The project has **13 commits, one author, and one star**. Ours is the only
production use we know of. If the author deletes the repo or unlists the NuGet
package, we still have to be able to ship a PST export tomorrow, so the source
lives here.

Copying also let us fix a bug in it (below) without waiting for anyone.

## What we copied, and what we did not

Copied:

- `src/PstBuilder/` — the writer itself
- `src/PstBuilder.Eml/` — turns an `.eml` file into a message the writer accepts
- `LICENSE`, `Directory.Build.props`

Not copied: `src/PstBuilder.Pim/` (calendar and contacts — we export mail),
`src/PstBuilder.All/` (a convenience package), the upstream tests, docs and
samples.

**One NuGet package is still downloaded at build time: `MimeKit` 4.17.0.**
`PstBuilder.Eml` needs it to parse MIME. That is a deliberate exception:
MimeKit is a decade-old, widely used library, not a two-week-old one-star
project. If it ever needs vendoring too, that is a separate job.

## Our one change to their code

`patches/0001-always-emit-attachment-table-subnode.patch` is already applied to
the copy in `vendor/`. Run `git apply -R` on it from
`vendor/PST-Builder/` to get back to exactly the upstream commit above.

**What it fixes.** Upstream writes the "attachment table" part of a message
only when the message actually has an attachment. libpff — the reader that
Outlook-free tools and our own validation use — then refuses to count
attachments on every message that has none, with
`libpff_message_determine_attachments: unable to retrieve local descriptor
identifier: 1649`.

That matters because **most real mail has no attachment.** On a 12-message
fixture set, 9 of the 12 threw that error. With the patch: 0 errors, all 12
messages read, every attachment still byte-identical.

**The cost.** One upstream test,
`StoreWriterTests.Milestone_OneFolderOneMessage_ProducesValidContainer`, asserts
that a no-attachment message has exactly one subnode entry. With the patch it
has two. That test is asserting the shape that causes the bug, so it is the
test that is wrong — but be aware of it before sending this upstream.

`pstbuilder-patch.test.ts` fails if this patch ever goes missing from the
vendored file, because re-copying upstream would silently undo it.

## How it gets built

`infra/docker/worker.Dockerfile` publishes `cli/` as one self-contained
`linux-x64` file called `pstb` and copies it into the worker image. Nothing
builds on a server, and nothing pulls a prebuilt binary from a stranger.

The binary needs `libicu72` in the runtime image. Without it .NET exits before
`Main` runs with `Couldn't find a valid ICU package`.

## Proof it runs on Linux

Checked on 2026-09-24 in `debian:bookworm-slim` (`linux/amd64`, the Linode's
architecture) with only `libicu72` added:

```
{"candidate":"PST-Builder","ok":true,"messagesRequested":12,"messagesAdded":12,
 "failures":[],"outputBytes":271360,"peakWorkingSetMiB":259}
```

`pffexport` then exported all 12 messages from that file, exit 0, zero errors.
