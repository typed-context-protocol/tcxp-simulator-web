# Changelog

## v0.2 (unreleased)

Spec: `SPEC.md` §12–§15. Every v0.1 address keeps its canonical string, identity, SQL fiber and result, except for the result-kind rename below; `test/compat.mjs` checks this against a frozen v0.1 baseline.

### Breaking

- **A gap's result kind is now `halt`** (was `gap`). `execute` on an address with an unbound variable returns `{kind:"halt", gaps:[…]}` with the same gaps list as before; when intent rows require the variables, it also lists them in `requiredBy`. In the v0.1 collection this affects 5 cases (`equation-gap`, `ice-gap`, `us-hours-gap` and the two probes that reuse them).
- `"@"` is now also valid on write addresses (`sql/insert`, `sql/update`, `sql/delete`), where it performs the write. The filter rule `call-target` reads "@ is only used on a function address or a write".

### Added

- **Writes** (§12). `sql/insert`, `sql/update`, `sql/delete` with `returning`, operators `row()` and `assign()`. Without `@`: a preview, nothing mutated. With `@`: the write, on a per-session copy of the data, with an `inverse` list of addresses that undo it exactly; the pulse records it as `undo`. Safety rules: a gap halts both preview and write; update and delete without `where=` are refused (diagnostic level `refused`; `where=true` means every row); types checked against columns; NOT NULL, CHECK, UNIQUE/PRIMARY KEY and foreign keys enforced in PostgreSQL's order, with PostgreSQL's SQLSTATE as the error `code`. SQL fiber for INSERT/UPDATE/DELETE … RETURNING. Session data: `newStore`, `resetData`, `dataChanged`, `tableRows`.
- **Edit and query API** (§13). `edit(uri, ops, opts)` with `bind`, `unbind`, `param`, `replace`, `remove`, `add`, `annotate`, `meta`; it never returns an invalid address, and each call stamps a pulse whose parent is the identity before the edit. `query(uri, selector)` with `gaps`, `variables`, `references[:name]`, `operators[:op]`, `annotations`, `pointer:<path>`; every pointer resolves. `fromJSON`, the inverse of `toJSON`. `exprText`.
- **CSV data source** (§13). `registerCSV(registry, table, csv, types?)`: RFC 4180, inferred types, a `row_id` primary key. New registry `client.demo` (`client_hours`).
- **Intent rows** (§14). `~intent` may be an array of rows `{role, text, require, if_empty}`. A required variable must be bound before anything runs, even if the query never uses it; until then the address halts. `if_empty` accepts only `"HALT"` (the default). `resultKey(tree)` keys stored results by identity plus requirements, since intent rows never change identity.
- **Reserved: ASK and ACT** (§15). Writing either in `if_empty` is an error diagnostic ("ASK is reserved for a future version; v0.2 supports HALT only"), never a silent HALT. They belong to a future governor.
- `withPulse(tree, step, at, debounce, parent, extra)`: `extra` adds fields such as `undo`.
- **Workbench:** write preview with highlighting, *Run this write*, *Undo*, *Reset data*; Find box with hover highlighting; halt panel listing missing variables and the rows that require them; required-only variables drawn under *REQUIRED BY ~intent*; header link to the tax intake demo.
- **Tax intake demo** (`tax-intake.html`, `demo/`): manager rules with *If missing: HALT*; the chat asking for the year is the app's handler for a halt.
- **Lean:** `gap_blocks_write`, `delete_after_insert`, `update_after_update`, `insert_after_delete` (up to row order), no `sorry`.
- **Tests and gate:** `npm run gate` (build, verify, build, read fuzz, write fuzz, compat, api, intent, lean) is the official gate. New: `test/compat.mjs` (+ `v01-baseline.json`, `v01-stream.json`), `test/fuzz.mjs --writes`, `test/api.mjs`, `test/intent.mjs`.

### Fixed

- **Names are data.** Names such as `constructor`, `__proto__`, `toString` in any position (registry, path, key, table, column, operator, variable, meta key, parameter, alias) crashed with JavaScript errors or were read from `Object.prototype`. In the worst case an unbound `$constructor` counted as bound, so its gap was skipped and the query ran. All lookups now read own properties only; these names behave like any other unknown name.
- The read generator now draws only on the v0.1 registries, so adding registries cannot change a seeded stream (adding `client.demo` had silently changed seed 7's addresses while every count stayed the same).
- `toJSON` now carries bindings for variables nothing uses, so `fromJSON` loses nothing.
- The workbench test "Identity ignores meta" split addresses on `?` and broke on a `?` inside a meta value.

### Not yet released

The npm and PyPI release workflow checks the Python port against `tcxp.js`. v0.2.0 ships once the Python package is updated to match.

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
