# tcxp — Typed Context Protocol, v0.2 reference bundle

A decision state, written as one line of text, that parses into an expression tree, carries its own context, and runs. Or halts.

```
!tcxp:/firm.demo/sql/select?cols=as(sum(work_logs.hours),us_hours)&from=work_logs&where=and(eq(work_logs.work_country,'US'),eq(year(work_logs.worked_on),$tax_year))&~context={"intent":[{"role":"user","text":"How many hours did our people work in the US?"}],"observe":[],"reason":[],"decide":[],"trace":[]}
```

`$tax_year` has no value, so it is a **gap**, and an unbound variable halts: nothing runs or writes until it is bound. Add `&$tax_year=2024` (before `~context`) and it runs. Everything about the state that isn't its identity (what was asked, what was observed, how it got here) rides in one `~context`.

## What's new in v0.2

- **Writes.** `sql/insert`, `sql/update`, `sql/delete`. Without `@` an address previews the write; with `@` it performs it on this session's copy of the data and returns the exact inverse (§12 of the spec).
- **One edit and query API.** `edit(uri, ops)` changes any address with JSON Patch–style operations and never returns an invalid one; `query(uri, selector)` finds gaps, variables, references, operators and annotations; `fromJSON` inverts `toJSON`; `registerCSV` loads a CSV as a table (§13).
- **One `~context`.** Every full address ends with `~context={"intent":[],"observe":[],"reason":[],"decide":[],"trace":[]}`: five arrays, always present, always in that order. Entries are rows (the protocol defines no fields) or bare tcxp addresses (references, never fetched). The context never changes identity (§6).
- **Fingerprints.** A pulse's `parent` is the SHA-256 fingerprint of the previous full address, registered in the registry, so following parents returns every step exactly (§8).
- **Names are data.** `constructor`, `__proto__` and friends behave like any other unknown name.
- **Two address formats, spelled exactly.** `tcxp://<registry>/<path>` is resolvable: a registry entry that points to an external location (such as `https://…` or `file:…`), and resolving it fetches and returns the content there. It is the URI scheme being registered with IANA. Only an explicit resolve fetches; parsing, reading, displaying or serializing never does. `!tcxp:/…` is virtual and is never resolved or fetched; `@` is a call marker in front of either. Any other spelling is rejected, with no normalization (§2).

v0.2 is a deliberate break from v0.1: v0.1's separate `~` keys (`~intent`, `~pulse`, `~spikes`, …) are folded into `~context`, spellings outside the two formats (such as `!tcxp://`) are rejected, and a gap's result kind is `halt`. Every v0.1 address converts by a fixed mapping and keeps its identity, SQL and result. See [CHANGELOG.md](CHANGELOG.md).

## Install

```sh
npm install @tcxp/tcxp  # JavaScript
pip install tcxp        # Python: same engine, same results (see python/)
```

The published packages are **0.1.0**, which has none of the v0.2 features above (it takes v0.1 addresses, without `~context`, and reports a gap as kind `gap`). v0.2 ships as 0.2.0 once the Python port matches it; until then, use `tcxp.js` from this branch.

The two registries use different names for the same engine. npm blocks the plain name `tcxp` as too similar to existing packages, so the npm package is scoped as `@tcxp/tcxp`. On PyPI it is `tcxp`.

```js
const tcxp = require('@tcxp/tcxp');
// v0.2 form; with the published 0.1.0, leave out the &~context=… part
const uri = "!tcxp:/school.demo/sql/select?cols=*&from=students&where=eq(cohort,$cohort)&$cohort='2026-fall'"
  + '&~context={"intent":[],"observe":[],"reason":[],"decide":[],"trace":[]}';
const tree = tcxp.parseURI(uri);
console.log(tcxp.serialize(tree).uri);        // canonical form
console.log(tcxp.identity(tree));             // identity (the address without ~context)
console.log(tcxp.toSQL(tree).sql);            // SELECT * FROM students WHERE cohort = $1
const result = tcxp.execute(tree);            // runs on the built-in demo data
console.log(result.kind, result.rows.length); // rows 7
```

Licensed under Apache-2.0 (see `LICENSE`).

## Open it

Open `tcxp-workbench.html` in any browser. It is one self-contained file with no build step and no server, so it also works as a GitHub gist or GitHub Pages page. Hosted on its own, the *Address bar* toggle writes each pulse into the URL as `#!tcxp:/…`, and opening such a link loads it.

Live: [workbench](https://typed-context-protocol.github.io/tcxp-simulator-web/) · [tax intake demo](https://typed-context-protocol.github.io/tcxp-simulator-web/tax-intake.html)

In the workbench:

- **Writes** preview first. *Run this write* applies it once; *Undo* runs its inverse; *Reset data* restores the shipped rows. Opening an `@` write link only previews it.
- **Find** (under the tree) takes `gaps`, `variables`, `references:gpa`, `operators:eq`, `annotations` or `pointer:/where/0`; hovering a result highlights the node.
- **Halts** list every unbound variable, with a box to bind each one.
- **Pulses** show where each state came from; *Undo* after a write goes back to the exact address before it, found by its fingerprint.
- **Resolvable entries** are listed under each registry as address → location. Opening a `tcxp://` address shows its location; only the *Resolve* button fetches and shows the content.

**Tax intake demo.** `tax-intake.html` is a small app built only on `tcxp.js`, which it loads from next to it. A manager's checklist rule ("the user must state the tax year", *If missing: HALT*) requires `$tax_year`. Ask *"What are the US hours worked in my client CSV?"* and the run stops; the chat then asks for the year. The checklist and the asking are the app's own handling (SPEC §14); the protocol's only halt rule is that an unbound variable halts. Reply *2024* and it runs: 59.25 hours. Its sources are in `demo/` (`python3 demo/build_demo.py` writes an inline single-file build and a linked build into `demo/`; the linked build is `tax-intake.html`).

## What's inside

| Path | What it is |
|---|---|
| `tcxp-workbench.html` | The app: explorer, address, tree, Find, result (halt, rows, write preview), annotations, fibers, pulses, chat placeholder, test suite |
| `tcxp.js` | The engine as one file. Works in browsers and Node |
| `SPEC.md` | The v0.2 protocol: the two address formats, the grammar and `~context`, node kinds and the halt rule, pointers, canonical form and fingerprints, writes, edit and query, handlers, guarantees |
| `CHANGELOG.md` | What changed from v0.1 to v0.2 |
| `lean/Tcxp.lean` | Machine-checked proofs (Lean 4.19, core only): lossless round-trip (trees and whole addresses with their five-key context), gaps halt evaluation and writes, identity ignores the context, exact spike comparison, write inverse laws |
| `lean/LEAN.md` | What is proved, and the order of the remaining proofs |
| `src/` | Sources: `engine.js` (protocol), `_school.js`, `data_tail.js`, `data_csv.js` and `data_resolvable.js` (registries, schemas, seed data, CSV, resolvable entries, addresses), `app.js`, `shell.html`, build scripts |
| `tax-intake.html`, `demo/` | Tax intake demo built on `tcxp.js` |
| `fixtures/` | Local files the demo `tcxp://` entries point to, so resolving works offline |
| `test/verify.mjs` | Every collection address and construct probe against PostgreSQL (writes in a fresh database each, with their inverses); writes `snapshot.json` |
| `test/fuzz.mjs` | Random read addresses against the rules and PostgreSQL; `--writes` for random writes and inverses |
| `test/compat.mjs` | v0.1 addresses, converted by the declared mapping, against the frozen `test/v01-baseline.json` and `test/v01-stream.json` |
| `test/api.mjs` | `edit`, `query`, `fromJSON`, `registerCSV`, and JavaScript-special names |
| `test/context.mjs` | The `~context` grammar: every rejection, entries, compact canonical form, identity, pointers, no fetch, the halt rule, fingerprints |
| `test/formats.mjs` | The two address formats spelled exactly (one rejection per aberration), resolvable entries, and resolve as the only fetch |
| `python/` | The Python package `tcxp`: a conformance port of `tcxp.js`, checked against vectors exported from it |
| `.github/workflows/release.yml` | Release on a version tag: gate, Python vectors, TestPyPI, then npm and PyPI after approval |
| `LICENSE` | Apache-2.0 |

## The model in one table

| Node | What it is | In the address |
|---|---|---|
| Operator | Does something to its children | `eq(…)`, clause keys, `@`, `row(…)`, `assign(…)` |
| Value | A literal | `'2026-fall'`, `3.5`, `date'2026-09-01'` |
| Variable | A name waiting to be filled | `$name` |
| Reference | A name for something that exists | `students.gpa`, a handler address |
| Gap | A variable with no value; the address halts | `$name` with no `$name=` |
| Annotation | A spike pointing at nodes, with meaning, structure and environment lit or dark | an `observe` row with `on` |

Address formats (exactly two, spelled exactly; anything else is rejected):

- `tcxp://<registry>/<path>` is resolvable: its registry entry points to an external location, and resolving fetches and returns the content there. Only an explicit resolve fetches.
- `!tcxp:/…` is virtual: never resolved, never fetched. It names a state; for a write, it describes the write.
- `@` in front of either is a call marker: `@!tcxp:/…` calls a handler, or performs a write.
- The query is data keys, then `$variables`, then `~context`, always last. A reference to another address (a call in a binding, a context entry, an inverse) is written bare, without `~context`.
- `~context={"intent":[],"observe":[],"reason":[],"decide":[],"trace":[]}`: the five arrays, never changing identity. The pulse row in `trace` (`{"step","at","debounce_ms","parent"}`) stamps each committed state; `parent` is the fingerprint of the previous full address, and an executed write adds `undo`.

## Results

All results come from `npm run gate` and are reproducible.

**Collection and probes.** 68 cases against PostgreSQL 18.3 (PGlite), 0 failures: 36 collection addresses and 32 construct probes. For reads, the result equals PostgreSQL. For writes, the affected count, the RETURNING rows and every table equal PostgreSQL, and the inverse restores the seed exactly. A write that breaks a foreign key fails with PostgreSQL's SQLSTATE. 12 constructs are declared unrepresentable.

**v0.1, converted.** All 49 v0.1 cases, converted by the declared mapping, round-trip and keep their identity, SQL fiber and result (with the `gap` → `halt` rename in 5 of them); each seeded generator stream is exactly the converted v0.1 stream, with identical identities.

**Generated reads.** 2,000 addresses (seed 7): all pass the filter rules and round-trip; all 1,541 that ran as SQL or math match PostgreSQL.

**Generated writes.** 1,000 writes (seed 11): 622 match PostgreSQL table for table and their inverses restore the seed; 216 that break a constraint fail with the same SQLSTATE as PostgreSQL (23503, 23502, 23514, 23505, 22003); 162 halt on a gap.

**Edit, query and context.** About 1,600 random edits all produce valid, canonical addresses whose pulse parent is the fingerprint of the previous address; every `query` pointer resolves; `fromJSON(toJSON(t))` keeps all 536 test addresses; random contexts on 536 addresses never change identity; 2,256 grammar checks pass.

**Lean.** Every theorem in `lean/Tcxp.lean` checks, with no `sorry`.

## Rebuild and re-verify

The official gate is one command. Every change must pass it before it is committed:

```sh
npm install                     # installs PGlite (PostgreSQL compiled to WebAssembly)
npm run gate
```

`npm run gate` runs, in order, stopping at the first failure:

```sh
npm run build                   # src/*.js -> tcxp.js -> tcxp-workbench.html
node test/verify.mjs            # every collection address and probe against PostgreSQL; writes snapshot.json
npm run build                   # again, so the workbench embeds the snapshot verify just wrote
node test/fuzz.mjs 2000 7       # 2,000 random read addresses, seed 7 (baseline: 1,541 PostgreSQL matches)
node test/fuzz.mjs 1000 11 --writes   # 1,000 random writes and their inverses against PostgreSQL
node test/compat.mjs            # v0.1 addresses and seeded streams, converted by the declared mapping (test/v01-*.json)
node test/api.mjs               # edit / query / fromJSON / registerCSV properties, JS-special names
node test/context.mjs           # the ~context grammar, identity, pointers, no fetch, halt rule, fingerprints
node test/formats.mjs           # exact address formats, resolvable entries, no fetch except resolve
lean lean/Tcxp.lean             # Lean 4.19+, no sorry
```

The build runs twice because the workbench embeds `snapshot.json`, which `verify.mjs` writes: a single build before verify would ship the previous snapshot.

## Hooks

The conversation column is a placeholder. On send it calls `window.tcxpOnChat(text, context)` if defined, and dispatches a `tcxp:chat-submit` event with `{text, context}`. The context holds the current address, the latest pulse and the open gaps.

Element ids: `tcxp-chat-form`, `tcxp-chat-input`, `tcxp-chat-send`, `tcxp-chat-thread`.
