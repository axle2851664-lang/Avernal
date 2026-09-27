# The Helix brain

Five modules, each usable on its own. Nothing here knows about HTTP, and
nothing here speaks — the server wires it to routes, the UI renders the state.

| module | what it decides |
| --- | --- |
| `secrets.ts` | what must never be written down |
| `rules.ts` | what may be remembered, and on whose say-so |
| `store.ts` | where memory lives; the only thing that writes it |
| `context.ts` | what already known bears on what was just said |
| `planner.ts` | how a request breaks into steps — it runs none of them |
| `capabilities.ts` | everything Helix can do, and which needs asking first |
| `state.ts` | one structured answer to "what is Helix holding right now" |

## The two rules that shape everything else

**Helix does not quietly keep what it sees.** Anything meant to outlive the
session has to have been asked for. Observations may only accumulate in
short-term memory, which is scoped to a session and dropped when it ends. The
check is in `rules.ts` and applies on every write, including edits.

**Credentials never land.** `secrets.ts` runs before anything is stored, on
both the text and the reason. There is no secure store here, so there is no
storing of secrets here — and the refusal never repeats the value back, since
quoting a password into an error only moves it somewhere else.

## Memory categories

| category | lifetime | who may write it |
| --- | --- | --- |
| `short-term` | one session | Helix, from observation |
| `long-term` | until deleted | the user, on request |
| `project` | until deleted | the user, on request |
| `task` | until deleted | the user, on request |
| `preference` | until deleted | the user, on request |

Every memory carries a `reason` and a `source`. That pair is what makes
"why do you know that?" answerable, so neither is optional.

## HTTP

| route | does |
| --- | --- |
| `GET /brain/state` | the whole structured state |
| `GET /brain/memory?category=&project=&q=` | view and search |
| `POST /brain/memory` | remember, subject to the rules |
| `PATCH /brain/memory/:id` | edit, re-checked against the rules |
| `DELETE /brain/memory/:id` | forget one |
| `POST /brain/memory/clear` | clear a category, or everything with `all: true` |
| `POST /brain/context` | what is relevant to an utterance, and why |
| `POST /brain/plan` | steps for a request — plans only, runs nothing |

A refusal is a `422` with `refused: true` and a sentence to show the user.

Clearing everything needs `all: true` explicitly. Forgetting the lot should
not be what happens when a parameter goes missing.

## Where it is stored

`helix-memory.json` under the data root, beside the vault, so it travels with
everything else Helix accumulates and can be read, backed up or deleted
without Helix cooperating. Writes go to a temporary file and are renamed, so a
crash mid-write leaves the previous file intact.

## What this is not

The planner is rule-based. It decomposes the request shapes it recognises into
steps built from real capabilities, and when it does not recognise one it says
so and returns no steps. It does not understand arbitrary language, and it
never executes: steps that would reach outside this machine come back marked
`awaiting-confirmation` for something else to decide.

## Adding to it

- A new capability is a row in `capabilities.ts`. A test checks its route
  against the server, so a capability with nothing behind it fails the build.
- A new planned request shape is a row in `planner.ts`.
- A new memory category means a new lifetime rule; add it to
  `MEMORY_CATEGORIES` and decide in `rules.ts` who may write it.
