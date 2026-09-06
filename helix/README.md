# Helix — knowledge galaxy core

The pure core of the knowledge galaxy: turning notes into a graph, and ranking
notes against a question. No Helix imports, no rendering, no network, no keys.

## Why this lives in the Avernal repo

It is staged here because the Helix source is not reachable from the session
that wrote it — there is no `axle2851664-lang/helix` on GitHub, and neither
Avernal repo contains Helix code. Nothing here is Avernal's; it is written to be
moved into Helix's `src/core/galaxy/` unchanged.

`tsconfig.json` mirrors the strictness of Helix's `tsconfig.app.json`
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`
and the rest) so that the move is a copy, not a port.

## What is here

| File | Responsibility |
|---|---|
| `types.ts` | The data model, and `NoteSource` — the adapter seam |
| `text.ts` | Markdown to prose, excerpts, normalisation, wikilink extraction |
| `graph.ts` | Note set to `{nodes, links}`, appending, the integrity assertion |
| `retrieval.ts` | Question to ranked note ids, and the grounding threshold |
| `focus.ts` | Answer sources to what the view should light up |
| `persona.ts` | The butler system prompt, notes context, boot greeting |
| `capture.ts` | "remember that ..." to a real markdown note |

Verify with `npm run verify` (typecheck + 88 tests).

> Installing needs `--legacy-peer-deps` under npm 10.9.7, which crashes on
> vitest 4's peer graph. Helix's own toolchain is unaffected.

### The invariant

A node's `id` is its index in `nodes` and nothing else. `assertGalaxyIntegrity`
checks it, and the checks run in the suite, because lookups by position break
silently and late when it drifts.

### Linking

Two notes are linked when one wikilinks the other, or when one's prose mentions
the other's title. Both sides are compared in normalised form — casefolded, with
punctuation reduced to spaces — so `Hand-Tracking` and `hand tracking` match, and
`Art` does not match inside `cartographer`. Titles shorter than four characters
never create mention links; they match far too much prose to mean anything.

A wikilink beats a mention for the same pair: it is a link the author wrote
rather than one inferred.

### Proving where an answer came from

`planFocus` turns an answer's sources into one of three outcomes: `none` (stay
put), `single` (fly to the top source, light it, its neighbours and the other
sources), or `cluster` (four or more sources — light them all and move nothing).

Unknown and duplicate ids are dropped rather than trusted. Acting on a stale id
would light the wrong note, which is worse than lighting none: it claims a
provenance that does not exist.

`none` is what keeps the camera still during small talk. It comes from
`groundedNotes`, which drops any note scoring below one title hit — so a word
that happens to appear somewhere in the vault cannot masquerade as a source.

### Ranking

A title hit scores 3, a group hit 1, and body hits 1 each capped at three
occurrences, so one repeated word cannot dominate. Notes with no overlap are
excluded rather than padding the result. Ties break towards the lower id, so the
same question always selects the same context.

### Captures

`parseRememberCommand` accepts "remember that X" and bare "remember X", since
transcripts lose small words. `draftCapture` derives a title from the opening
words and a slug from its normalised form — which keeps only letters and digits,
so a dictated title cannot produce a path separator or a traversal. Existing
slugs are passed in so a second capture never overwrites the first.

`appendNote` is safe for a live view because ids are positions: appending leaves
every existing note at its index. Inserting or removing anywhere else renumbers,
and must not be done while a view is open.

## What is deliberately not here

These need the real Helix source, and guessing at their signatures would produce
code that its strict compiler rejects:

- **The `KnowledgeIndex` adapter.** The one piece of glue: real index entries to
  `NoteSource[]`. Everything above is written against that seam.
- **The camera and the glow.** `planFocus` says what to light; flying to it and
  pulsing a newborn node are the view's job, on Helix's existing vault graph.
- **Writing the capture file.** `draftCapture` produces the path and the bytes;
  the write, and the notes directory it writes into, need the real vault.
- **The 3D view.** Helix already has a force-directed vault graph with hubs and
  shortest path. This should extend it, not add a second graph engine.
- **Voice.** `VoiceManager` already does listen/speak/interrupt. The British
  voice preference and the listening/thinking status line are additions to it.
- **Answering.** An orchestrator tool, so the response passes through the persona
  module that owns every user-facing sentence, and through `ConversationStore`
  for follow-ups.
- **The API key.** Behind the Tauri boundary or in the OS credential store —
  never a plaintext file beside a portable app, which would contradict the
  `Logger` that redacts secrets and the `MemoryManager` that refuses credentials.
