# tcxp — Typed Context Protocol, v0.1 reference bundle

A decision state, written as one line of text, that parses into an expression tree, carries its own context, and runs.

```
!tcxp:/firm.demo/sql/select?cols=as(sum(work_logs.hours),us_hours)&from=work_logs&where=and(eq(work_logs.work_country,'US'),eq(year(work_logs.worked_on),$tax_year))&~intent=How many hours did our people work in the US?
```

`$tax_year` has no value, so it is a **gap**. Nothing runs until it is bound. Add `&$tax_year=2024` (before the `~` keys) and it runs.

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

**Tax intake demo.** `tax-intake.html` is a small app built only on `tcxp.js`, which it loads from next to it. A manager's checklist rule ("the user must state the tax year") requires `$tax_year`. Ask *"What are the US hours worked in my client CSV?"* and the address halts and the chat asks for the year; reply *2024* and it runs: 59.25 hours. Its sources are in `demo/` (`python3 demo/build_demo.py` writes an inline single-file build and a linked build into `demo/`; the linked build is `tax-intake.html`).

## What's inside

| Path | What it is |
|---|---|
| `tcxp-workbench.html` | The app: explorer, address + tree + decision + annotations + fibers + pulses, chat placeholder, test suite |
| `SPEC.md` | The v0.1 protocol: address forms, key classes, node kinds, gaps, meta, pointers, spikes, canonical form, guarantees |
| `lean/Tcxp.lean` | Machine-checked proofs (Lean 4.19, core only): lossless round-trip, gaps block execution, identity ignores meta, exact spike comparison |
| `lean/LEAN.md` | What is proved, and the order of the remaining proofs |
| `src/` | Sources: `engine.js` (protocol), `data_tail.js` and `_school.js` (registries, schemas, seed data, addresses), `app.js`, `shell.html`, build scripts |
| `tcxp.js` | The engine as one file. Works in browsers and Node |
| `tax-intake.html`, `demo/` | Tax intake demo built on `tcxp.js`: manager rules, chat, and the address that halts or runs |
| `test/verify.mjs` | Runs all 20 addresses and 29 construct probes in PostgreSQL and writes `snapshot.json` |
| `test/fuzz.mjs` | Property test: random addresses from `FilterGenerator`, checked against the rules and against PostgreSQL |

## The model in one table

| Node | What it is | In the address |
|---|---|---|
| Operator | Does something to its children | `eq(…)`, clause keys, `@` |
| Value | A literal | `'2026-fall'`, `3.5`, `date'2026-09-01'` |
| Variable | A name waiting to be filled | `$name` |
| Reference | A name for something that exists | `students.gpa`, a handler address |
| Gap | A variable with no value; blocks execution | `$name` with no `$name=` |
| Annotation | A spike pointing at nodes, with meaning, structure and environment lit or dark | `~spikes=[…]` |

Address forms:

- `!tcxp:/…` names a state.
- `@!tcxp:/…` calls a handler.
- `~` keys hold metadata and always come last.
- `~pulse=[{"step","at","debounce_ms"}]` stamps each committed state.

## Results

All results are reproducible with the commands below.

**Collection.** All 20 addresses pass every check:
- parse
- canonical round-trip
- strict percent-encoded round-trip
- SQL equal to the hand-written reference
- result equal to PostgreSQL 18.3

**Construct probes.** All 29 represented SQL constructs are verified, and 13 more are declared unrepresentable in v0.1.

**Generated addresses.** 2,500 addresses from two seeds:
- All pass the filter rules.
- All 1,918 that ran as SQL or math matched PostgreSQL.
- The fuzzer found one real bug (missing parentheses on `a − (b − c)` in the SQL fiber), which is fixed.

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
node test/intent.mjs            # ~intent rows: required variables, ask/block/default, identity unchanged
lean lean/Tcxp.lean             # Lean 4.19+, no sorry
```

The build runs twice because the workbench embeds `snapshot.json`, which `verify.mjs` writes: a single build before verify would ship the previous snapshot.

## Hooks

The conversation column is a placeholder. On send it calls `window.tcxpOnChat(text, context)` if defined, and dispatches a `tcxp:chat-submit` event with `{text, context}`. The context holds the current address, the latest pulse and the open gaps.

Element ids: `tcxp-chat-form`, `tcxp-chat-input`, `tcxp-chat-send`, `tcxp-chat-thread`.
