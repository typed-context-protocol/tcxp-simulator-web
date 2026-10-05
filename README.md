# tcxp — Typed Context Protocol, v0.2 reference bundle

A decision state, written as one line of text, that parses into an expression tree, carries its own context, and runs. Or halts.

```
!tcxp:/firm.demo/sql/select?cols=as(sum(work_logs.hours),us_hours)&from=work_logs&where=and(eq(work_logs.work_country,'US'),eq(year(work_logs.worked_on),$tax_year))&~intent=How many hours did our people work in the US?
```

`$tax_year` has no value, so it is a **gap**, and a gap always halts: nothing runs or writes until every required variable is bound. Add `&$tax_year=2024` (before the `~` keys) and it runs.

## What's new in v0.2

- **Writes.** `sql/insert`, `sql/update`, `sql/delete`. Without `@` an address previews the write; with `@` it performs it on this session's copy of the data and returns the exact inverse (§12 of the spec).
- **One edit and query API.** `edit(uri, ops)` changes any address with JSON Patch–style operations and never returns an invalid one; `query(uri, selector)` finds gaps, variables, references, operators and annotations; `fromJSON` inverts `toJSON`; `registerCSV` loads a CSV as a table (§13).
- **Intent rows.** `~intent` can be a list of rows. A row that `require`s a variable makes the address halt until that variable is bound, even if the query never uses it (§14). HALT is the only implemented state; ASK and ACT are reserved for a future governor (§15).
- **Names are data.** `constructor`, `__proto__` and friends behave like any other unknown name.

Every v0.1 address keeps its canonical string, identity, SQL and result. The one visible change: a gap's result kind is now `halt` instead of `gap`. See [CHANGELOG.md](CHANGELOG.md).

## Install

```sh
npm install @tcxp/tcxp  # JavaScript
pip install tcxp        # Python: same engine, same results (see python/)
```

The two registries use different names for the same engine. npm blocks the plain name `tcxp` as too similar to existing packages, so the npm package is scoped as `@tcxp/tcxp`. On PyPI it is `tcxp`.

```js
const tcxp = require('@tcxp/tcxp');
const uri = "!tcxp:/school.demo/sql/select?cols=*&from=students&where=eq(cohort,$cohort)&$cohort='2026-fall'";
const tree = tcxp.parseURI(uri);
console.log(tcxp.serialize(tree).uri);        // canonical form
console.log(tcxp.identity(tree));             // identity (ignores ~ metadata)
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
- **Halts** list every missing variable and the intent rows that require it, with a box to bind each one.

**Tax intake demo.** `tax-intake.html` is a small app built only on `tcxp.js`, which it loads from next to it. A manager's checklist rule ("the user must state the tax year", *If missing: HALT*) requires `$tax_year`. Ask *"What are the US hours worked in my client CSV?"* and the address halts; the chat then asks for the year. Asking is the app's handler for a halt, not a protocol mode. Reply *2024* and it runs: 59.25 hours. Its sources are in `demo/` (`python3 demo/build_demo.py` writes an inline single-file build and a linked build into `demo/`; the linked build is `tax-intake.html`).

## What's inside

| Path | What it is |
|---|---|
| `tcxp-workbench.html` | The app: explorer, address, tree, Find, result (halt, rows, write preview), annotations, fibers, pulses, chat placeholder, test suite |
| `tcxp.js` | The engine as one file. Works in browsers and Node |
| `SPEC.md` | The v0.2 protocol: address forms, node kinds, gaps and halts, meta, pointers, canonical form, writes, edit and query, intent rows, guarantees |
| `CHANGELOG.md` | What changed from v0.1 to v0.2 |
| `lean/Tcxp.lean` | Machine-checked proofs (Lean 4.19, core only): lossless round-trip, gaps halt evaluation and writes, identity ignores meta, exact spike comparison, write inverse laws |
| `lean/LEAN.md` | What is proved, and the order of the remaining proofs |
| `src/` | Sources: `engine.js` (protocol), `_school.js`, `data_tail.js` and `data_csv.js` (registries, schemas, seed data, CSV, addresses), `app.js`, `shell.html`, build scripts |
| `tax-intake.html`, `demo/` | Tax intake demo built on `tcxp.js` |
| `test/verify.mjs` | Every collection address and construct probe against PostgreSQL (writes in a fresh database each, with their inverses); writes `snapshot.json` |
| `test/fuzz.mjs` | Random read addresses against the rules and PostgreSQL; `--writes` for random writes and inverses |
| `test/compat.mjs` | v0.1 backward compatibility against the frozen `test/v01-baseline.json` and `test/v01-stream.json` |
| `test/api.mjs` | `edit`, `query`, `fromJSON`, `registerCSV`, and JavaScript-special names |
| `test/intent.mjs` | Intent rows: required variables halt, identity is unchanged, ASK and ACT are reserved |

## The model in one table

| Node | What it is | In the address |
|---|---|---|
| Operator | Does something to its children | `eq(…)`, clause keys, `@`, `row(…)`, `assign(…)` |
| Value | A literal | `'2026-fall'`, `3.5`, `date'2026-09-01'` |
| Variable | A name waiting to be filled | `$name` |
| Reference | A name for something that exists | `students.gpa`, a handler address |
| Gap | A variable with no value; the address halts | `$name` with no `$name=`, or required by an intent row |
| Annotation | A spike pointing at nodes, with meaning, structure and environment lit or dark | `~spikes=[…]` |

Address forms:

- `!tcxp:/…` names a state. For a write, it describes the write.
- `@!tcxp:/…` calls a handler, or performs a write.
- `~` keys hold metadata and always come last. They never change identity.
- `~pulse=[{"step","at","debounce_ms","parent"}]` stamps each committed state; `parent` links it to the state it came from, and an executed write adds `undo`.
- `~intent=[{"role":"manager","text":"…","require":"$tax_year","if_empty":"HALT"}]` makes the address halt until `$tax_year` is bound.

## Results

All results come from `npm run gate` and are reproducible.

**Collection and probes.** 70 cases against PostgreSQL 18.3 (PGlite), 0 failures: 38 collection addresses and 32 construct probes. For reads, the result equals PostgreSQL. For writes, the affected count, the RETURNING rows and every table equal PostgreSQL, and the inverse restores the seed exactly. A write that breaks a foreign key fails with PostgreSQL's SQLSTATE. 12 constructs are declared unrepresentable.

**Backward compatibility.** All 49 v0.1 cases keep their canonical string, identity, SQL fiber and result (with the documented `gap` → `halt` rename in 5 of them), and the seeded generator streams are byte-identical to v0.1.

**Generated reads.** 2,000 addresses (seed 7): all pass the filter rules and round-trip; all 1,541 that ran as SQL or math match PostgreSQL.

**Generated writes.** 1,000 writes (seed 11): 622 match PostgreSQL table for table and their inverses restore the seed; 216 that break a constraint fail with the same SQLSTATE as PostgreSQL (23503, 23502, 23514, 23505, 22003); 162 halt on a gap.

**Edit, query and intent.** About 1,500 random edits all produce valid, canonical addresses with correct pulse parents; every `query` pointer resolves; `fromJSON(toJSON(t))` keeps the identity of all 538 test addresses; adding a required variable to any of 538 addresses makes it halt without changing its identity.

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
node test/compat.mjs            # every v0.1 address and seeded read stream still identical (test/v01-*.json)
node test/api.mjs               # edit / query / fromJSON / registerCSV properties, JS-special names
node test/intent.mjs            # ~intent rows: required variables halt, identity unchanged, ASK/ACT reserved
lean lean/Tcxp.lean             # Lean 4.19+, no sorry
```

The build runs twice because the workbench embeds `snapshot.json`, which `verify.mjs` writes: a single build before verify would ship the previous snapshot.

## Hooks

The conversation column is a placeholder. On send it calls `window.tcxpOnChat(text, context)` if defined, and dispatches a `tcxp:chat-submit` event with `{text, context}`. The context holds the current address, the latest pulse and the open gaps.

Element ids: `tcxp-chat-form`, `tcxp-chat-input`, `tcxp-chat-send`, `tcxp-chat-thread`.
