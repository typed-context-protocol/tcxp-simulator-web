# Changelog

## 0.2.0 (unreleased)

Spec: `SPEC.md`. v0.2 is a deliberate break from v0.1. `test/compat.mjs` converts every v0.1 address by a fixed mapping and checks it against a frozen v0.1 baseline: identity, SQL fiber and results are unchanged.

### Breaking

- **One `~context`** (SPEC §2, §6). The query is data keys, then `$variables`, then `~context={"intent":[…],"observe":[…],"reason":[…],"decide":[…],"trace":[…]}`, always last and always present on a full address, with exactly those five arrays in that order. Entries are rows (the protocol defines no fields) or bare tcxp addresses. Any other `~` key is rejected. v0.1's separate keys move as follows, rows unchanged: `~intent` → `intent` (a plain-string intent becomes the handlers' row `{"role":"user","text":…}`); `~observe`, `~outcome`, `~spikes` and the tax demo's `~review` → `observe`; `~pulse` and the tax demo's `~source` → `trace`. The word "meta" is retired.
- **References are bare.** A call in a binding, an address entry in a context array, a spike facet, a registry entry and a write's inverse are written without `~context`; `fullAddress(reference)` gives one a fresh context.
- **Pulse parents are fingerprints.** A pulse row's `parent` is the SHA-256 fingerprint of the previous full address (was its identity). `fingerprint`, `storeAddress` and `lookupAddress` follow the chain back exactly.
- **Exactly two address formats, spelled exactly** (SPEC §2). `tcxp://<registry>/<path>` is resolvable and `!tcxp:/…` is virtual; `@` is a call marker in front of either. Every other spelling is rejected, with no tolerance and no normalization: `!tcxp://…` and `@!tcxp://…` (v0.1 accepted these and rewrote them to `!tcxp:/`), `!tcxp:///…`, `tcxp:/…`, empty path segments anywhere (`//` inside the path, a trailing `/`), and leading or trailing whitespace (v0.1 trimmed it).
- **A gap's result kind is now `halt`** (was `gap`), with the same gaps list. The one halt rule is that an unbound variable halts, wherever an expression has one; nothing in the context halts anything. In the v0.1 collection this affects 5 cases (`equation-gap`, `ice-gap`, `us-hours-gap` and the two probes that reuse them).
- **A `~context` with whitespace outside its strings is rejected** (RULES.md R17), not rewritten to the compact form.
- **Registries are not created by registering** (R45). `registerResolvable` and `storeAddress` under a registry that does not exist are errors (`code` `unknown-registry`).
- **Spike rows have no id** (R50). Features refer to a spike by its position among the spike rows (labelled `s1`, `s2`, … for display); an `id` field in a row is ignored. `annotate` writes no id and refuses one. The v0.1 conversion drops `id` from `~spikes` rows, so the generated read streams changed: `test/v01-stream.json`'s `migrated_sha256` values were recaptured from the v0.1 engine (its `sha256` and `identity_sha256` are unchanged).
- `"@"` is now also valid on write addresses and on `tcxp://` addresses. The filter rules are `scheme`, `context-last` (was `meta-last`), `call-target`, `grammar`, `canonical`.
- **`serialize(tree, {meta: false})` is now `serialize(tree, {context: false})`.** The old option is ignored, so it now returns the full address, `~context` included. `identity(tree)` is unchanged.
- **`toJSON` returns `context`** (the five arrays) in place of `meta`; `fromJSON` reads it. For `tcxp://` addresses it also has `form` and `data`.
- **`withPulse` keeps a `debounce` of `0`.** 0.1.0 replaced any falsy debounce, 0 included, with 300; now only a missing one (`undefined` or `null`) becomes 300. The pulse row lives in `~context.trace`.
- **Seeded addresses change form.** Every `FilterGenerator(seed).next()` address now ends with `~context` (the generator makes the same random draws, so the data parts are identical), and spike rows no longer carry ids.
- **Error messages** for the address head changed with the exact formats (for example, the empty string and other schemes now get `An address is exactly "!tcxp:/<registry>/<path>" (virtual) or "tcxp://<registry>/<path>" (resolvable), optionally preceded by "@" to call it`). Errors now carry a `code`: `scheme`, `context` and `order` for the grammar, a PostgreSQL SQLSTATE for writes, `refused`, `edit`, and the resolvable-registry codes.

### Added

- **Writes** (§12). `sql/insert`, `sql/update`, `sql/delete` with `returning`, operators `row()` and `assign()`. Without `@`: a preview, nothing mutated. With `@`: the write, on a per-session copy of the data, with an `inverse` list of bare addresses that undo it exactly; the pulse row records it as `undo`. Safety rules: an unbound variable halts both preview and write; update and delete without `where=` are refused (diagnostic level `refused`; `where=true` means every row); types checked against columns; NOT NULL, CHECK, UNIQUE/PRIMARY KEY and foreign keys enforced in PostgreSQL's order, with PostgreSQL's SQLSTATE as the error `code`. SQL fiber for INSERT/UPDATE/DELETE … RETURNING. Session data: `newStore`, `resetData`, `dataChanged`, `tableRows`.
- **Edit and query API** (§13). `edit(uri, ops, opts)` with `bind`, `unbind`, `param`, `replace`, `remove` (including `/~context/…`), `add`, `annotate` (a spike row in `observe`) and `context` (replace one array); it never returns an invalid address, and each call stamps a pulse whose parent is the fingerprint of the address before the edit. `query(uri, selector)` with `gaps`, `variables`, `references[:name]`, `operators[:op]`, `annotations`, `pointer:<path>` (including `/~context/…`); every pointer resolves. `fromJSON`, the inverse of `toJSON`. `exprText`.
- **CSV data source** (§13). `registerCSV(registry, table, csv, types?)`: RFC 4180, inferred types, a `row_id` primary key. New registry `client.demo` (`client_hours`).
- **Resolvable entries** (§2). A registry holds an ordered list of `{address, location}` entries: `registerResolvable`, `listResolvable`, and `resolve(address)`, which looks up the part before `?` and fetches and returns the content at the location, without checking for gaps. Only `resolve` fetches; parsing, reading, displaying, serializing and references in a context never do. A `tcxp://` address takes data keys (kept as written, no meaning) and `$variables` like a virtual one. `@tcxp://` parses as a call and errors "not supported yet". Demo entries on `firm.demo` and `fleet.demo` point to local `file:` fixtures in `fixtures/`.
- **Pointers into the context:** `/~context/<key>[/<index>]`.
- `withPulse(tree, step, at, debounce, parent, extra)`: the pulse row goes first in `trace` and replaces the previous one; `extra` adds fields such as `undo`.
- **Workbench:** write preview with highlighting, *Run this write*, *Undo* (back to the exact pre-write address by fingerprint), *Reset data*; Find box with hover highlighting; halt panel; resolvable entries table and an explicit *Resolve* button; header link to the tax intake demo.
- **Tax intake demo** (`tax-intake.html`, `demo/`): manager rules with *If missing: HALT*, applied by the demo itself; the chat asking for the year is its handler. Its address carries one `~context` (intent rows; spike and review rows in `observe`; pulse and source rows in `trace`), and its pulse chain uses fingerprints.
- **Lean:** the context model (`identity_withContext`, `identity_withPulse`, `same_state_same_identity`, `parse_serAddress`, `missing_context_rejected`, `wrong_first_key_rejected`), `gap_blocks_write`, `delete_after_insert`, `update_after_update`, `insert_after_delete` (up to row order); no `sorry`.
- **Tests and gate:** `npm run gate` (build, verify, build, read fuzz, write fuzz, compat, api, context, formats, lean) is the official gate. New: `test/compat.mjs` (+ `v01-baseline.json`, `v01-stream.json`), `test/fuzz.mjs --writes`, `test/api.mjs`, `test/context.mjs`, `test/formats.mjs`.

### Fixed

- **Names are data.** Names such as `constructor`, `__proto__`, `toString` in any position (registry, path, key, table, column, operator, variable, context key, parameter, alias) crashed with JavaScript errors or were read from `Object.prototype`. In the worst case an unbound `$constructor` counted as bound, so its gap was skipped and the query ran. All lookups now read own properties only; these names behave like any other unknown name.
- The read generator draws only on the v0.1 registries, so adding registries cannot change a seeded stream.
- `toJSON` carries bindings for variables nothing uses, so `fromJSON` loses nothing.

### Python package (`tcxp` on PyPI)

The Python package is the same engine, ported line for line, and 0.2.0 has every change above under snake_case names. The breaking changes for Python code written against `tcxp` 0.1.0:
- **Full addresses end with `~context`.** `parse_uri` requires it, rejects every other `~` key, and no longer trims whitespace or rewrites `!tcxp://`. Use `full_address(reference)` to give a bare address an empty context.
- **`serialize(tree, meta=...)` is now `serialize(tree, context=...)`.** `identity(tree)` is unchanged.
- **`to_json(tree)` returns `context`** in place of `meta`, and `from_json` reads it.
- **`execute` returns `{'kind': 'halt', 'gaps': [...]}`** for an unbound variable (was `'gap'`).
- **`with_pulse`** puts the pulse row first in `context['trace']` and keeps a `debounce` of `0`. Its `parent` is a fingerprint (see `fingerprint`, `store_address`, `lookup_address`).
- **`FilterGenerator.meta(tree)` is now `FilterGenerator.context(tree)`.** Seeded addresses end with `~context`, and spike rows have no `id`.
- **`TcxpError` has a `code`** (`None` when there is none).

New in Python:
- `execute(tree, store=None, preview=False)`, writes, `new_store`, `reset_data`, `data_changed`, `table_rows`, `WRITE_CLAUSES`, `WRITE_ORDER`
- `edit`, `query`, `from_json`, `expr_text`, `register_csv`
- `full_address`, `fingerprint`, `store_address`, `lookup_address`, `list_addresses`, `CONTEXT_KEYS`
- `register_resolvable`, `list_resolvable`, `resolve` and `RESOLVABLE`
- `FilterGenerator.next_write`

`resolve` is synchronous (JavaScript returns a Promise), and the demo fixtures ship inside the package, so `file:` entries resolve from an installed wheel.

Conformance: the Python package reproduces `tcxp.js` byte for byte over 8,384 vector records:
- the collection (68)
- 5,000 seeded addresses
- 1,011 writes, previewed, performed and undone
- 1,409 edits
- 151 malformed addresses
- 268 pulse chains
- 79 registry, fingerprint and `resolve` steps
- 20 CSV cases
- 210 special-name cases

It also matches the JavaScript number, JSON, date and URI semantics on 165 cases. Its PostgreSQL test runs the collection and 1,000 generated writes against a real server.

Known differences (no vector covers them):
- non-ISO date strings
- the last bit of `pow` with a fractional exponent
- the operating system's text in a failed fetch
- **data-key order on `tcxp://` addresses.** Python keeps the written order for every key (RULES.md R20); `tcxp.js` moves integer-like key names first.

## 0.1.0 (2026-10-05)

First release, as two matching packages built from the same commit:
- npm: [`@tcxp/tcxp`](https://www.npmjs.com/package/@tcxp/tcxp). npm refused the unscoped name `tcxp` as too similar to existing packages.
- PyPI: [`tcxp`](https://pypi.org/project/tcxp/)

Both are licensed Apache-2.0.

### Note: the `v0.1.0` tag moved
The tag first pointed to `112addd9a11dc3be22056da4db7f4238d1511eb8`. It now points to `06685efeae86c09e516aca1688889fbe1fdff70d`, the merge of #3.

- **What changed:** only the release workflow's test-vector freshness check, in `python/tools/export_vectors.mjs` and `python/vectors/semantics.json`. The check depended on the machine's timezone and on gzip's compressed bytes, which differ by CPU, so it failed in CI on `112addd`.
- **What didn't change:** `tcxp.js`, the npm package and the Python package.
- **npm tarball:** `@tcxp/tcxp@0.1.0` on npm was published from `112addd`. Packing it from `06685ef` gives a byte-identical tarball, sha1 `a5ddd155c3f47a80e41c6edc09b10aafd491a51d`.
