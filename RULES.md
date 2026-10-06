# tcxp rules

Every rule tcxp currently follows, one per row. Sourced from `SPEC.md` and the code (`src/engine.js`, `src/app.js`, `demo/demo.js`).

**Governance (R104).** No agent adds, changes or removes a rule without Ron's approval recorded in this file. IDs are stable: a rule keeps its ID for life, rules are never renumbered, and a retired rule stays listed as retired.

**Status.** Blank means the rule traces to a decision by Ron. **UNCONFIRMED** marks a rule awaiting his yes or no. As of PR #14 every rule is approved: R17, R45 and R50 were rejected as first written and now state Ron's decision.

**Tested in** names the file and the check (`test/*.mjs` check names in quotes; "in-app" is the workbench's test suite; `verify` and `fuzz` are `test/verify.mjs` and `test/fuzz.mjs`). **Lean** names theorems in `lean/Tcxp.lean`.

Three sections: **Protocol** (what an address is and means), **SDK** (how this implementation behaves), **Handler conventions** (what handlers agree on; not protocol).

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R104 | No agent adds, changes or removes a rule without Ron's approval recorded in this file. | this file | — | |  |

## Protocol

### Address formats

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R1 | There are exactly two address formats, `tcxp://<registry>/<path>` (resolvable) and `!tcxp:/<registry>/<path>` (virtual), and they are different states. | §2 | formats "tcxp://x and !tcxp:/x are different states", "round-trips exactly" | | |
| R2 | `@` is a call marker that can go in front of either format. | §2 | formats "@tcxp:// parses as a call"; verify (`@!tcxp:/` calls) | | |
| R3 | Any other spelling is rejected with an error and never rewritten: `!tcxp://`, `@!tcxp://`, `!tcxp:///`, `tcxp:/`, an empty path segment anywhere (`//`, trailing `/`), leading or trailing whitespace, and anything else that is not exactly one of the two formats. | §2 | formats "rejected: …" (20 cases), "the filter fails it too" | | |
| R4 | The first path segment names the registry, and every path segment is non-empty. | §2 | formats "missing registry", "rejected: // inside a virtual path" | | |
| R5 | A resolvable address needs a path after its registry. | §2 | formats "resolvable needs a path" | | |

### Grammar

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R6 | The query has three parts in this order: data keys, then `$variables`, then `~context`; anything out of that order is rejected. | §2, §3 | context "a data key after a $variable is rejected", "a data key after ~context is rejected", "a $variable after ~context is rejected" | | |
| R7 | A full address always carries exactly one `~context`, last; a missing or second `~context` is rejected. | §2 | context "a full address without ~context is rejected", "~context twice is rejected" | `missing_context_rejected` | |
| R8 | `~context` is one JSON object with exactly the keys `intent`, `observe`, `reason`, `decide`, `trace`, in that order, each an array (`[]` when empty); a missing, extra or out-of-order key is rejected. | §2, §6 | context "a missing context key is rejected", "an extra context key is rejected", "context keys out of order are rejected", "a context key that is … instead of an array is rejected" | `parse_serAddress`, `wrong_first_key_rejected` | |
| R9 | `~context` is the only `~` key; any other `~` key is rejected. | §3 | context "a separate ~… key is rejected" (12 keys) | | |
| R10 | Each context entry is a row (a JSON object) or a bare tcxp address; anything else is rejected. | §6 | context "an entry that is … is rejected", "rows of any shape are accepted", "bare references in both formats are accepted" | | |
| R11 | The protocol defines no fields inside rows and validates none. | §6 | context "rows of any shape are accepted" | | |
| R12 | The same rules apply to all five context arrays; `reason` and `decide` get no special rules. | §6 | context (every entry check runs on all five arrays) | | |
| R13 | A reference to another address is written bare, without `~context`: a call in a binding, a context entry, a spike facet, a registry entry, a write's inverse. | §2 | context "an entry that is a reference with its own ~context is rejected"; verify (bindings and inverses) | | |
| R14 | A reference gets a fresh context when it is executed. | §2, §12 | in-app "Inverse restores the data"; verify (inverses) | | |
| R15 | Identity is the address with `~context` removed; nothing in the context changes identity. | §8 | context "the context never changes identity", "the identity is the address with ~context removed"; in-app "Identity ignores the context", "The context never changes identity" | `identity_withContext`, `same_state_same_identity` | |
| R16 | The canonical `~context` is compact JSON with its keys in the fixed order, and canonical addresses round-trip byte for byte. | §8 | context "the context is written compactly", "a canonical address round-trips byte for byte", "every corpus address round-trips byte for byte" | `parse_serAddress` | |
| R17 | A `~context` with whitespace outside its strings is rejected, never rewritten. | §8 | context "a context with whitespace is rejected, not rewritten" (spaces, newline, tab, carriage return), "whitespace inside strings is kept" | |  |
| R18 | Both formats use the same grammar; only resolution differs. | §2 | formats "round-trips exactly" (resolvable with data keys, `$v` and context) | | |
| R19 | A data key on a `tcxp://` address may have any name; its value is kept exactly as written and given no meaning. | §2 | formats "a resolvable address keeps data keys as written, with no meaning" | | |
| R20 | On a `tcxp://` address, data keys keep the order they were written in. | §8 | formats "round-trips exactly" | |  |
| R21 | A data key cannot be empty. | — | not directly tested | |  |
| R22 | A data key appears at most once (`join=` may repeat), and a variable is bound at most once. | §2 | verify (collection), `python/vectors/errors.jsonl` cases | | |
| R23 | A binding is one literal value or a bare `@` call to a function. | §4 | verify (`cohort-from-call`, `write-update-call`) | | |
| R24 | A binding for a variable nothing uses is a warning, not an error. | — | not directly tested | | |

### Nodes and the halt rule

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R25 | An address is a tree of four node kinds: operator, value, variable, reference. | §4 | api "query pointers resolve"; verify | `parse_ser`, `roundtrip` | |
| R26 | The one halt rule: an unbound variable halts wherever an expression has one (SQL, math, functions, writes), and nothing runs or writes. | §4 | context "an unbound variable halts (math, select, function, write)"; in-app "A gap always halts"; verify (`write-update-gap`) | `gap_blocks`, `gap_blocks_list`, `gap_blocks_write` | |
| R27 | A halt returns `{kind:"halt", gaps}`. | §4 | compat (5 renamed cases); verify | | |
| R28 | Nothing in the context halts anything; there are no other halt, ask or act rules. | §4, §15 | context "intent rows that mention require never halt" | | |
| R29 | A variable takes its type from the reference or value it is compared with. | §4 | not directly tested | | |
| R30 | Names in an address are data, never JavaScript properties: `constructor`, `__proto__` and similar names behave like any unknown name. | §8 | api "JS-special names behave like ordinary names" (180 cases), "registerCSV with a JS-special registry and table name" | | |

### Resolvable addresses and resolution

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R31 | Resolving a `tcxp://` address fetches and returns the content at its entry's location, not the location string. | §2 | formats "resolve returns the fixture content" | | |
| R32 | Locked: reading never runs code and never fetches. Only an explicit resolve fetches; parsing, reading, displaying, serializing and references in a context never do. | §2 | formats "parse, read, display, serialize: no fetch", "a reference in the context is never resolved or fetched by reading"; context "reading never fetches a reference" | | |
| R33 | `!tcxp:/` addresses are never resolved and never fetched. | §2 | formats "virtual address -> never resolved" | | |
| R34 | A registry holds an ordered list of resolvable entries `{address, location}`. | §2 | formats "entries list in registration order" | | |
| R35 | An entry's address is exactly `tcxp://<registry>/<path>`: the part before `?`, with no `@`. | §2 | formats "a non-exact address cannot be registered", "an address with @ or a query cannot be registered (the entry is the part before ?)", "a virtual address cannot be registered" | | |
| R36 | An entry's location must use a scheme other than tcxp, so there are no chains or cycles. | §2 | formats "a tcxp: location -> error (no chains)", "a virtual location -> error", "a location without a scheme -> error" | | |
| R37 | The tcxp-scheme check on a location ignores letter case (`TCXP:` is also refused). | — | formats "a TCXP: location -> error (scheme is case-insensitive)" | |  |
| R38 | There is one entry per address; registering a duplicate is an error. | §2 | formats "duplicate registration -> error" | | |
| R39 | Lookup matches the part of the address before `?` as an exact string, with no normalization. | §2 | formats "lookup uses the part before ?: …", "a non-exact spelling is rejected, not looked up" | | |
| R40 | `resolve` does not check for gaps. | §2 | not directly tested (data keys on `tcxp://` have no variables) | | |
| R41 | `resolve` returns a clear error when the address is not registered or the fetch fails. | §2 | formats "unregistered address -> error", "failed fetch (missing file) -> error", "failed fetch (network off) -> error" | | |
| R42 | Virtual addresses never go in the entry list. | §2 | formats "virtual addresses never appear in the list" | | |
| R43 | `@tcxp://…` parses as a call, then executing or resolving it errors "External calls are not supported yet". | §2 | formats "@tcxp:// -> not supported yet (execute)", "… (resolve)" | | |
| R44 | Reading a `tcxp://` address returns its entry and location, or says it is not registered, without fetching. | §2 | formats "reading shows the location", "reading an unregistered address says so, without fetching" | | |
| R45 | Registering under a registry that does not exist is an error (`unknown-registry`): a resolvable entry, or a full address stored by its fingerprint. | §2 | formats "registering under a registry that does not exist -> error", "storing a full address under a registry that does not exist -> error" | |  |

### Rows that features use, pulses and fingerprints

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R48 | Features recognise the rows they use by their fields and ignore rows without them; a malformed row is never an error. | §6 | context "rows of any shape are accepted" | | |
| R49 | An annotation (spike) is an `observe` row that has `on`, a list of pointers. | §6, §7 | in-app "Every pointer resolves"; context "a spike can point into the context" | | |
| R50 | A spike row never has an id written into it: features refer to spike rows by their position among the spike rows (labelled `s1`, `s2`, … for display only), and an `id` field in a row is ignored. | §7 | context "annotate writes no id into the spike row", "annotate refuses an id", "spikes are labelled by position; an id field in a row is ignored" | |  |
| R51 | A facet is lit when it holds inline text or the address of a note that exists, and dark otherwise; a spike's state is three bits, compared exactly. | §7 | in-app "Every lit facet resolves" | `bitsOf_lt`, `bitsOf_inj`, `bits_eq_iff` | |
| R52 | An annotation pointer that does not resolve is a warning, never an error. | §7 | not directly tested | | |
| R53 | Pointers are `/<key>/<item>/<child>/…`, `/$name` (every occurrence), and `/~context/<key>[/<index>]`. | §7 | context "/~context/<key>/<i> resolves to the entry", "/~context/<key> resolves to the array", "out-of-range and unknown context pointers resolve to nothing"; api "query pointers resolve" | | |
| R54 | The pulse is the `trace` row `{step, at, debounce_ms, parent}`; `step` counts committed addresses, and a commit happens after a quiet period (300 ms in the workbench). | §8 | in-app "Pulse round-trips" | | |
| R55 | A pulse's `parent` is the SHA-256 fingerprint of the previous committed full address (`null` for the first). | §8 | api "edit pulse parent is the fingerprint of the previous full address"; in-app "Every parent is an earlier pulse" | | |
| R56 | A new pulse row goes first in `trace` and replaces the previous pulse row; other `trace` rows are kept. | §8 | context "a new pulse row replaces the old one, goes first, and keeps other trace rows" | |  |
| R57 | Stamping a pulse never changes identity. | §8 | in-app "A pulse never changes identity" | `identity_withPulse` | |
| R58 | `fingerprint(fullAddress)` is the SHA-256 of the full canonical address, context included. | §8 | context "fingerprint is SHA-256 of the full canonical address", "fingerprint is of the canonical form", "fingerprint handles non-ASCII text", "a different context gives a different fingerprint" | | |
| R59 | A fingerprint is written as 64 lowercase hexadecimal characters. | §8 | context "fingerprint is SHA-256 of the full canonical address" | |  |
| R60 | Full addresses live in the registry, by the same mechanism as resolvable entries: the registry named by the address's first segment holds an ordered list of `{fingerprint, address}`, and lookup is an exact fingerprint match. | §8 | context "stored addresses live in the registry named by their first segment", "storeAddress / lookupAddress round-trip", "a resolvable full address is stored in its registry too" | | |
| R61 | Storing an address that is already stored is a no-op. | §8 | context "storing the same address again is a no-op" | |  |
| R62 | Following pulse parents back through the registry returns every step exactly. | §8 | context "following parents back through the store returns every step exactly"; api "edit chain: parents trace the history" | | |
| R63 | An executed write's pulse row records its inverse as `undo`. | §12 | context "a new pulse row replaces the old one, …" (undo field); headless browser check | | |

### Canonical form and transport

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R65 | In the canonical form, data keys follow their profile's fixed order (SQL: `cols from join where group having order limit offset`; write profiles: their key order), bindings follow first appearance in the tree, and `~context` comes last. | §8 | verify (round-trip); fuzz "roundtrip" | | |
| R66 | Values escape only `%`, `&`, `#`, and `=` inside data literals. | §8 | fuzz "roundtrip", "strict" | | |
| R67 | The strict transport form percent-encodes every character outside RFC 3986's unreserved and sub-delimiter sets, and parses back to the identical canonical form. | §8 | fuzz "strict"; context "a canonical address round-trips byte for byte" | | |
| R68 | In a browser, an address travels in the URL fragment (`page.html#!tcxp:/…`). | §8 | not in the gate (workbench address bar) | | |
| R69 | Equality is syntactic: two equivalent states compare equal only after normalization maps them to the same tree. | §8 | — | | |

### Profiles and states

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R70 | A virtual path is `sql/select`, `sql/insert`, `sql/update`, `sql/delete`, `math/eval`, a function name, or a note; anything else is an error. | §2 | verify; `python/vectors/errors.jsonl` | | |
| R71 | `@` is allowed only on a function, a write, or a resolvable address. | §2, §11 | `FilterGenerator.filter` "call-target"; verify | | |
| R72 | The SQL, join, write and math profiles accept only their listed operators and keys; math has no references. | §5 | verify; fuzz "filter" | | |
| R101 | The protocol has three states, HALT, ASK and ACT; v0.2 implements only HALT, and ASK, ACT and the governor are future work. | §15 | — | | |

## SDK

### Resolution

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R46 | A relative `file:` location is read relative to the directory holding `tcxp.js` (in a browser, the page); `file:///…` is absolute; `http:` and `https:` are fetched with `fetch`. | §2 | formats "resolve returns the fixture content" | |  |
| R47 | `resolve` accepts an injected fetcher in place of the default. | §2 | formats "an injected fetcher gets the location and its text is returned", "an injected fetcher that throws -> error" | |  |

### Profiles

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R73 | `row()` and `assign()` are allowed only in the write profiles. | §5 | not directly tested | |  |
| R74 | Each SQL or math address runs the same in the tree evaluator and in PostgreSQL. | §9 | verify (68 cases); fuzz "pgMatch" (1,541) | | |

### Writes

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R75 | A write address without `@` previews the write and changes nothing; with `@` it performs the write. | §12 | in-app "A preview never writes"; verify (writes) | | |
| R76 | Writes apply to a per-session copy of the registry data; the shipped seed is never changed. | §12 | verify; fuzz `--writes` | | |
| R77 | A performed write returns the affected count, the RETURNING rows and its inverse addresses. | §12 | verify (writes) | | |
| R78 | An update or delete without `where=` is refused (diagnostic level `refused`); `where=true` means every row. | §12 | verify (`write-delete-no-where`, `write-delete-all`) | | |
| R79 | Inserted and assigned values are type-checked against their columns, and a mismatch is an error. | §12 | not directly tested in the gate | | |
| R80 | The engine rejects a fractional number for an integer column and a number for a text column, where PostgreSQL would round or cast. | §12 | not directly tested | |  |
| R81 | NOT NULL, PRIMARY KEY uniqueness and foreign keys (both directions) are enforced the way PostgreSQL enforces them, in its order, with plain-language errors. | §12 | verify (`write-fk-violation`); fuzz `--writes` "errorsMatched" | | |
| R82 | UNIQUE columns and CHECK constraints are also enforced; CHECK only in the forms `c > n`, `c BETWEEN a AND b`, `c IN (…)`. | §12 | fuzz `--writes` (23505, 23514) | |  |
| R83 | Write errors carry PostgreSQL's SQLSTATE as their `code`. | §12 | fuzz `--writes` "errorCodes" | |  |
| R84 | A write's inverse: insert → delete by primary key; delete → insert of the removed rows; update → update back to the old values by primary key. | §12 | verify; fuzz `--writes` "inverseRestores" | | |
| R85 | On a table without a primary key, an inverse matches rows on every column. | §12 | not directly tested | |  |
| R86 | Performing a write and then its inverse restores the data exactly. | §12 | verify; fuzz `--writes` (622); in-app "Inverse restores the data" | `delete_after_insert`, `update_after_update`, `insert_after_delete` (up to row order) | |
| R87 | The SQL fiber renders writes as INSERT/UPDATE/DELETE … RETURNING with `$n` parameters. | §12 | verify (reference SQL) | | |

### Edit, query and data sources

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R88 | `edit` applies JSON Patch–style operations in order: bind, unbind, param, replace, remove, add, annotate. | §13 | api (random edits) | | |
| R89 | The `context` edit operation `{key, value}` replaces one context array (`null` makes it `[]`); it replaced the retired `meta` operation. | §13 | api (random edits); context (identity checks) | |  |
| R90 | `edit` never returns an invalid address; an invalid edit throws a plain-language error naming the operation. | §13 | api "edit result passes FilterGenerator.filter", "edit result round-trips", "edit never throws a non-tcxp error" | | |
| R91 | Each `edit` stamps a new pulse whose parent is the fingerprint of the address before the edit, unless asked not to. | §13 | api "edit pulse parent is the fingerprint of the previous full address", "edit chain: parents trace the history" | | |
| R93 | `bind` applies only to a variable that occurs in the tree. | §13 | api (refused edits) | |  |
| R94 | `replace` and `remove` refuse a path inside a bound value. | §13 | not directly tested | |  |
| R95 | `query` supports gaps, variables, references[:name], operators[:op], annotations and pointer:<path>, and every pointer it returns resolves. | §13 | api "query pointers resolve", "query pointer:<path> round-trips", "gaps selector matches tree.gaps"; context "query pointer: works on the context" | | |
| R96 | `fromJSON(toJSON(t))` gives back the same address. | §13 | api "fromJSON(toJSON(t)) identity", "fromJSON(toJSON(t)) full address"; formats "fromJSON(toJSON) keeps the address" | | |
| R97 | `registerCSV` loads a CSV as a table with inferred types (integer, numeric, date, text) unless types are given. | §13 | api "registerCSV infers types", "registerCSV table equals PostgreSQL", "registerCSV rejects ragged rows" | | |

### Workbench

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R64 | Undo in the workbench runs the inverse and returns to the full address before the write, found through the write pulse's parent fingerprint. | §12 | headless browser check (not in the gate) | | |

### Process

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R102 | Every change passes `npm run gate` before it is committed. | README | the gate itself | | |
| R103 | Before a release, the Python package must reproduce `tcxp.js`'s output byte for byte over the vectors in `python/vectors/`. | §11 | `.github/workflows/release.yml` | | |

## Handler conventions

| ID | Rule | SPEC | Tested in | Lean | Status |
|---|---|---|---|---|---|
| R92 | A pulse stamped by `edit` has `debounce_ms` 0. | §13 | not directly tested | |  |
| R98 | A CSV table gets a first column `row_id integer PRIMARY KEY`, numbering the rows 1 to n. | §13 | api "registerCSV table equals PostgreSQL" | |  |
| R99 | Handler convention, not protocol: a plain question is written as one `intent` row `{"role":"user","text":"…"}`. | §14 | compat (conversion of v0.1 string intents) | | |
| R100 | What happens after a halt (asking, blocking, notifying) is the handler's choice, not the protocol's. | §14 | — | | |
