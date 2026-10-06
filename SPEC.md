# Typed Context Protocol (tcxp) — v0.2 draft

Author: Ron Itelman · Status: working draft, October 2026 · Reference implementation: `tcxp.js`

v0.2 adds two exact address formats (§2), one `~context` that carries everything about a state except its identity (§6), writes (§12), one API to edit and query any address plus CSV data sources (§13), and fingerprints that chain states exactly (§8). It is a deliberate break from v0.1: v0.1's separate `~` keys are gone, and a gap's result kind is called `halt`. See `CHANGELOG.md`.

## 1. Purpose

tcxp writes a decision state as a single line of text: an **address**. The address parses into an expression tree built from four kinds of node. The context of that state (what was asked, what was observed, how it got here) rides along in one `~context` that points into the tree without changing it.

The protocol constrains only the grammar. Anything expressible in the grammar is a valid state. Handlers interpret states; bindings fill variables.

## 2. Address forms

tcxp has exactly two address formats. They are different states, not two spellings of one state, and both can exist on a registry. Both use the same grammar; only resolution differs.

| Format | Meaning |
|---|---|
| `tcxp://<registry>/<path>?…` | **Resolvable.** Its registry entry (the part before `?`) points to an external location (for example `https://…` or `file:…`). This is the URI scheme being registered with IANA. |
| `!tcxp:/<registry>/<path>?…` | **Virtual.** It is never resolved and never fetched. |

**`@` is a call marker, not a format.** It can go in front of either format: `@tcxp://…` or `@!tcxp:/…`.

### Grammar

```
tcxp://<address>?<key>=<value>&…&$<var>=<value>&…&~context={"intent":[…],"observe":[…],"reason":[…],"decide":[…],"trace":[…]}
!tcxp:/<address>?<key>=<value>&…&$<var>=<value>&…&~context={"intent":[…],"observe":[…],"reason":[…],"decide":[…],"trace":[…]}
```

1. The query has three parts, in this order: data keys, then `$variables`, then `~context`, always last.
2. A **full address** (what `parseURI` and `execute` take) always carries `~context`: one JSON object with exactly the five keys `intent`, `observe`, `reason`, `decide`, `trace`, in that order, each a JSON array (`[]` when empty). A missing, extra or out-of-order key, a second `~context`, or any other `~` key is rejected.
3. A **reference** to another address is written **bare**, as its identity (§8), without `~context`: a call in a binding (`$c=@!tcxp:/…`), an address entry in a context array, a spike facet, a registry entry's address, and a write's inverse address. A reference gets a fresh context when it is executed (`fullAddress(reference)`).
4. Example (virtual):
   ```
   !tcxp:/fleet.demo/math/eval?expr=lt($water_temp,$freezing_point)&$water_temp=29&$freezing_point=31.3&~context={"intent":[],"observe":[],"reason":[],"decide":[],"trace":[{"step":3,"at":"2026-10-06T14:45:00Z","debounce_ms":300}]}
   ```
   Example (resolvable):
   ```
   tcxp://firm.demo/rules/tax-year?~context={"intent":[],"observe":[],"reason":[],"decide":[],"trace":[]}
   ```

### Exact spelling

An address is one of the two formats, optionally preceded by `@`, written exactly. There is no tolerance and no normalization: any other spelling is rejected with an error, never rewritten into a valid one. That includes `!tcxp://…` and `@!tcxp://…` (a virtual address with two slashes), `!tcxp:///…` (empty segments after the scheme), `tcxp:/…` (one slash without `!`), an empty path segment anywhere (`//` inside the path, or a trailing `/`), and leading or trailing whitespace.

### The resolvable format

**Resolving** `tcxp://name` means fetching and returning the **content** at the location its registry entry points to. It does not return the location string.

**Locked rule: reading never runs code and never fetches.** Fetching happens only when resolve is called explicitly. Parsing, reading, displaying or serializing a `tcxp://` address never fetches, and neither does any reference in a context. `!tcxp:/` addresses are never resolved and never fetched.

**Resolvable entries.**

1. A registry holds a list of resolvable entries. Each entry is one bare `tcxp://` address and the external location it points to:
   ```json
   [
     {"address": "tcxp://bank.demo/env/api-timezones", "location": "file:fixtures/api-timezones.md"},
     {"address": "tcxp://time.demo/notes/yesterday",   "location": "https://example.com/yesterday.md"}
   ]
   ```
2. `address` is exactly `tcxp://<registry>/<path>`: the part before `?`, with no `@`. The first segment after `//` is the registry name, the same convention as the virtual format.
3. `location` must use a scheme other than tcxp (`https:`, `file:`, and so on). An entry cannot point to another tcxp address, so there are no chains and no cycles.
4. One entry per address. Registering a duplicate is an error.
5. Lookup matches the part of the address before `?`, as an exact string, with no normalization.
6. `resolve(address)` looks the entry up and fetches the content at `location`. It does not check for gaps. It returns a clear error if the address is not registered or the fetch fails.
7. Virtual `!tcxp:/` addresses never go in this list.
8. The API registers entries, lists entries in order, and resolves an address. JavaScript and Python behave identically.
9. Not yet: content hashes, caching, and external calls. `@tcxp://…` parses as a call, then returns a clear "external calls not supported yet" error.

**In the v0.2 engine.**

- **Data keys and variables.** A resolvable address takes data keys with any names and `$variables`, like a virtual one. A registry entry has no handler, so data key values are kept exactly as written and given no meaning.
- **Reading.** `execute` on a `tcxp://` address returns `{kind:"resolvable", address, registered, location}`, where `address` is the entry (the part before `?`) and `location` is where it points (`registered:false, location:null` if there is no entry). It never fetches.
- **Resolving.** `resolve(address, {fetcher, base})` takes a full address or a bare reference and returns a promise of the content (text). `file:` locations with a relative path (`file:fixtures/x.md`) are read relative to `base`, which defaults to the directory holding `tcxp.js` (in a browser, the page); `file:///…` is absolute; `http:` and `https:` use `fetch`. A `fetcher(location, {base})` can replace the default. Errors carry a `code`: `not-registered`, `fetch-failed`, `not-resolvable` (a virtual address), `not-supported` (`@tcxp://`).
- **Registering.** `registerResolvable(entry | entries)` adds entries in order; errors carry `code` `duplicate`, `location` (no scheme, or a tcxp location) or `register` (not exactly `tcxp://<registry>/<path>`). `listResolvable(registry?)` lists them in order. Registering under a registry that does not exist creates it.

### The virtual format

- **`!`** marks the address as virtual. It is never resolved, on a network or anywhere else.
- **`@`** in front means *call*: the system you are running in finds the named handler in its registry and invokes it. On a write address (§12) it means *perform the write*; without `@` the same address only describes the write.
- **`<registry>`** is the first path segment. It names an in-memory, virtual registry (for example `school.demo`, `registry`).
- **`<path>`** selects what inside the registry the address refers to. Every segment is non-empty. v0.2 defines:
  - `sql/select` (the SQL profile; the registry must hold a database)
  - `sql/insert`, `sql/update`, `sql/delete` (the write profiles, §12; the registry must hold a database)
  - `math/eval` (the math profile; available in every registry)
  - a function name (callable with `@`)
  - a note (`notes/…`, `rules/…`, `env/…`), which is text that annotation facets point to

## 3. Key classes

Every query key belongs to exactly one class, decided by its first character after percent-decoding.

| First character | Class | Example |
|---|---|---|
| anything but `$` and `~` | Data key: a clause (SQL), `expr` (math), a function parameter, or any name on a `tcxp://` address | `where=eq(gpa,$min)` |
| `$` | Variable binding | `$min=3.5` |
| `~` | The context; `~context` is the only `~` key | `~context={"intent":[],…}` |

Data keys come before `$variables`, and `~context` comes last. Anything out of that order is rejected.

## 4. The four node kinds, and the one halt rule

| Kind | What it is | Who binds it | Written as |
|---|---|---|---|
| Operator | Does something to its children | n/a | `eq(…)`, clause keys, `@` |
| Value | A literal | n/a | `'text'`, `42`, `3.5`, `date'2026-09-01'`, `true`, `null` |
| Variable | A name declared open, waiting to be filled | The caller: a person, a form, a model, a call | `$name` |
| Reference | A name for something that already exists | The data or the registry | `gpa`, `students.email`, a handler address |

**Gap.** A variable with no binding is a *gap*. Gaps are first-class: they are counted, highlighted, and typed (a variable takes its type from the reference or value it is compared with).

**The one halt rule: an unbound variable halts**, wherever an expression has one (SQL, math, functions, writes). Executing such an address returns `{kind:"halt", gaps:[…]}`; nothing runs or writes. There is no other halt, ask or act rule: nothing in the context halts anything. A model may propose a binding; the grammar decides whether the tree is complete.

**Binding.** `$name=<value>` binds a variable to a literal. `$name=@!tcxp:/…` binds it to the result of a call (a bare reference); that call is itself a subtree.

## 5. Expression grammar

```
expr      := operator "(" expr ("," expr)* ")" | reference | "$" name | value
value     := "'" text "'" | number | "date'" yyyy-mm-dd "'" | true | false | null
reference := name ("." name)* | "*"
```

**SQL profile operators:** `eq ne lt le gt ge like ilike in between isnull notnull and or not add sub mul div count sum avg min max round lower upper coalesce year as asc desc`

**Join operators:** `inner left right full cross`

**SQL clause keys:** `cols from join where group having order limit offset`

**Write profile:** keys `into cols values returning` (insert), `table set where returning` (update), `from where returning` (delete), in that canonical order. Operators `row(v1,…)` (one inserted row) and `assign(column, expr)` (one assignment), plus the SQL profile operators inside expressions. `row` and `assign` are not allowed in `sql/select` or `math/eval`.

**Math profile operators:** `eq ne lt le gt ge add sub mul div pow and or not`. Math has no references; unknowns are variables.

## 6. The context

`~context` is one JSON object with five arrays, always present and always in this order: `intent`, `observe`, `reason`, `decide`, `trace`.

1. **Entries.** Each entry is either a **row** (a JSON object, JSON Lines style) or a **bare tcxp address** (`tcxp://…`, `!tcxp:/…`, or either with `@`). Anything else (a number, `null`, a nested array, plain text, an address that is not exactly one of the two formats, or an address carrying its own `~context`) is rejected.
2. **Rows are not defined by the protocol.** The protocol defines no fields inside rows and validates none. The same rules apply to all five arrays; `reason` and `decide` get no special rules.
3. **A tcxp address entry is a reference.** Reading never resolves, fetches or runs it.
4. **The context never changes identity** (§8).
5. **Features that use rows** recognise them by their fields and ignore rows without them; a row they don't recognise is never an error:
   - annotations (§7) read the `observe` rows that have `on`;
   - the pulse chain reads the `trace` row that has `step` (§8);
   - an executed write's pulse row also carries `undo` (§12).

Where v0.1's separate keys went: `~intent` → `intent`; `~observe`, `~outcome`, `~spikes` and the tax demo's `~review` → `observe`; `~pulse` and the tax demo's `~source` → `trace`. Row fields are unchanged.

## 7. Pointers and annotations (spikes)

A **pointer** addresses a node: `/<key>/<item>/<child>/…`.

- `/expr/0/0/0` is the `mul` node in `eq(add(mul(2,$x),3),9)`.
- `/$name` addresses every occurrence of a variable.
- `/~context/<key>` addresses one context array, and `/~context/<key>/<index>` one entry in it (for example `/~context/observe/0`).
- Together with a pulse step, `(step, pointer)` is a coordinate in space and time.

A **spike** is one annotation: an `observe` row with `on`, a list of pointers, so one spike can anchor to several nodes; that makes it a hyperedge. The **data** facet is the anchor itself (the nodes pointed at). Three facets are projected from it:

- **Meaning:** what it means, in human language.
- **Structure:** the rules it must satisfy (units, types, normalization, validation).
- **Environment:** what you must know before acting on it, that the data itself can't tell you:
  - Origin: where it came from.
  - Conditions: when and where it holds true.
  - Consequences: how it should change the decision.

Each facet holds a bare tcxp address of a note, inline text, or `null`. A facet is **lit** when it holds inline text or the address of a note that exists in the registry, and **dark** otherwise. A spike's state is three bits (meaning, structure, environment), so 8 states. Comparing two spikes is a bitwise check plus string equality on identities. An unresolved pointer is shown as a warning, never an error.

A *reason card* is a spike whose meaning facet carries the human-readable definition of a decision.

## 8. Canonical form, identity, fingerprints, transport

- **Canonical form.** Data keys in their profile's fixed order (for SQL, `cols from join where group having order limit offset`; on a `tcxp://` address, the order written), then bindings in order of first appearance in the tree, then `~context` written compactly (no whitespace) with its keys in the fixed order. Values escape only `%`, `&`, `#` (and `=` inside data literals), so the form stays readable. Round trips of canonical addresses are byte-identical.
- **Identity.** The address with `~context` removed. Nothing in the context changes identity. Equality is syntactic: two *equivalent* states compare equal only after normalization rules map them to the same tree.
- **Fingerprint.** `fingerprint(fullAddress)` is the SHA-256 (lowercase hex) of the full canonical address, context included. Full addresses live in the registry, by the same mechanism as resolvable entries: the registry named by the address's first segment holds an ordered list of `{fingerprint, address}` entries. `storeAddress` registers one (storing it again is a no-op), `lookupAddress(fingerprint)` finds it by exact match, and `listAddresses(registry?)` lists them in order.
- **Pulse chain.** Each committed state stamps one pulse row first in `trace`: `{step, at, debounce_ms, parent}`. `step` counts committed addresses, not keystrokes; a commit happens after a `debounce_ms` quiet period. `parent` is the fingerprint of the previous committed full address (`null` for the first), so following parents back through the registry returns every step exactly. A new pulse row replaces the previous one; other `trace` rows (such as a source row) are kept.
- **Strict transport form.** Every character outside RFC 3986's unreserved and sub-delimiter sets is percent-encoded. It parses back to the identical canonical form.
- **Browsers.** An address travels in the fragment: `page.html#!tcxp:/…`.
- **Names are data.** A name in an address (registry, path, key, table, column, operator, variable, context key) is never a JavaScript property: `constructor`, `__proto__`, `toString` and the like behave exactly like any other unknown name.

## 9. Guarantees and their status

| Guarantee | Status in v0.2 |
|---|---|
| Lossless: tree → canonical address → tree | By construction; proved in Lean for trees (`parse_ser`) and for the whole address with its five-key context (`parse_serAddress`); tested on 36 collection addresses, 32 probes, 2,000 generated reads, 1,000 generated writes, about 1,600 random edits and 536 addresses with random contexts |
| The context is exactly five arrays in a fixed order | By construction; proved in Lean that a missing context or a wrong first key is rejected; tested on every rejection case (`test/context.mjs`) |
| The context never changes identity | By construction; proved in Lean (`identity_withContext`, `identity_withPulse`, `same_state_same_identity`); tested on 536 addresses with random contexts |
| v0.1 addresses carry over | Tested: all 49 v0.1 cases, converted by the declared mapping (§6), keep their identity, SQL fiber and result (kind renamed `gap` → `halt` in 5); each seeded generator stream is exactly the converted v0.1 stream, with identical identities (`test/compat.mjs`) |
| An unbound variable halts: nothing runs or writes | By construction; tested on every collection address and in math, SQL, functions and writes; proved in Lean for evaluation (`gap_blocks`) and for a keyed-table write model (`gap_blocks_write`) |
| Following pulse parents returns every step exactly | Tested on a chain through the 36 collection addresses and on edit chains (`T.lookupAddress`); target for a Lean proof |
| A write's inverse restores the data | Tested against PostgreSQL 18.3 on 7 collection writes and 622 generated writes; proved in Lean for a keyed-table model (exact for insert and update, up to row order for delete) |
| Writes and their failures agree with PostgreSQL | Tested: same affected count, RETURNING rows and table contents, or the same SQLSTATE, on every collection write and 1,000 generated writes. Evidence, not proof |
| SQL fiber and tree evaluator agree | Tested against PostgreSQL 18.3: 68 fixed cases (49 from v0.1) and 1,541 generated reads (seed 7), all matching. Evidence, not proof |
| Reading never fetches | Tested with spies on every way to fetch: parsing, reading, displaying, serializing and references in the context fetch nothing; only `resolve` does |
| Names in an address are data, never JavaScript properties | Tested: `constructor`, `__proto__`, `toString`, `hasOwnProperty`, `valueOf`, `prototype` in 30 positions each behave exactly like an ordinary unknown name |
| Persistence | An address is a string; store it anywhere |

## 10. Not representable in v0.2

These are declared out of scope, and the test suite lists them: table aliases, DISTINCT, count(DISTINCT), CASE, subqueries, set operations, CTEs, window functions, casts, DDL, list-valued variables, and calls with arguments nested inside expressions.

## 11. Reference implementation

`tcxp.js` exposes:

- **Parsing and serialization:** `parseURI` (full addresses), `fullAddress(reference, context?)`, `serialize`, `identity`, `strictForm`, `CONTEXT_KEYS`
- **Fingerprints:** `fingerprint(fullAddress)`, and the registry's stored addresses: `storeAddress(fullAddress)`, `lookupAddress(fingerprint)`, `listAddresses(registry?)`
- **Pointers:** `resolvePointer`
- **Fibers:** `toSQL`, `toMath`, `toJSON`
- **Execution:** `execute(tree, {store, preview})`, `withPulse(tree, step, at, debounce, parent, extra)`
- **Session data:** `newStore`, `resetData`, `dataChanged`, `tableRows`
- **Edit and query (§13):** `edit(uri, ops, opts)`, `query(uri, selector)`, `fromJSON(json)`, `exprText(node)`
- **Resolvable entries (§2):** `RESOLVABLE`, `registerResolvable(entries)`, `listResolvable(registry?)`, `resolve(address, {fetcher, base})`, the only function that fetches
- **Data sources (§13):** `registerCSV(registry, table, csvText, types)`
- **Result kinds of `execute`:** `rows` (select), `value` (math), `call`, `address` (a function named without `@`), `note`, `preview` and `write` (§12), `halt` (an unbound variable, §4), and `resolvable` (a `tcxp://` address: where it points, never fetched, §2). Errors and refusals throw a `TcxpError` with a `code`.
- **Testing:** `FilterGenerator` (seeded random addresses; `nextWrite()` for random writes; `FilterGenerator.filter(uri)` to check any address against the rules `scheme`, `context-last`, `call-target`, `grammar`, `canonical`)

It is published in two languages, released together under the same version:

| Language | Install | Import |
|---|---|---|
| JavaScript | `npm install @tcxp/tcxp` | `require('@tcxp/tcxp')` |
| Python 3.10+ | `pip install tcxp` | `import tcxp` (the same API in snake_case: `parse_uri`, `to_sql`, …) |

The Python package is a conformance port of `tcxp.js`. Before every release it must reproduce the JavaScript engine's output byte for byte over the vectors in `python/vectors/`.

## 12. Writes

```
!tcxp:/<registry>/sql/insert?into=<table>&cols=<c1,c2,…>&values=row(v1,v2,…)[,row(…)]&returning=<cols or *>&~context={…}
!tcxp:/<registry>/sql/update?table=<table>&set=assign(<col>,<expr>)[,assign(…)]&where=<expr>&returning=…&~context={…}
!tcxp:/<registry>/sql/delete?from=<table>&where=<expr>&returning=…&~context={…}
```

**Describe, then perform.** An address without `@` describes a proposed write. Executing it returns kind `preview`: the rows that would be inserted, changed (before and after) or removed, the RETURNING rows and the inverse, with nothing mutated. The same address with `@` performs the write and returns kind `write`: the affected count, the RETURNING rows, and `inverse`. A write is applied to a per-session copy of the registry data; the shipped seed is never mutated.

**Values.** Inserted values and assigned expressions may use literals, `$variables` and operators; variables may be bound by `@` calls to functions, as in select. Inserted values may not refer to columns. In an update, every `assign` reads the row as it was before the update, as in SQL. A variable or literal written straight into a column takes that column's type.

**Safety rules.**

1. *An unbound variable halts.* While any variable is unbound, both the preview and the write return kind `halt` and touch nothing.
2. *update and delete require `where=`.* An address without it is well formed but **refused** (diagnostic level `refused`): it cannot preview or run. To affect every row, write `where=true`.
3. *Types.* A literal or bound literal of the wrong type for its column is an error before anything runs. At run time each value is coerced to the column type the way PostgreSQL stores it: integers must be whole and in range, `numeric(p,s)` rounds to `s` places and must fit `p`, dates must be real dates.
4. *Constraints,* checked in PostgreSQL's order: per row, value coercion, then NOT NULL, then CHECK, then UNIQUE and PRIMARY KEY against the rows so far; after the last row, foreign keys against the state the statement leaves behind (NO ACTION), in both directions (a child must point at an existing parent; a parent still referred to cannot be deleted or re-keyed).

Errors are plain language and carry PostgreSQL's SQLSTATE as `code`: `23502` NOT NULL, `23514` CHECK, `23505` UNIQUE, `23503` FOREIGN KEY, `22P02`/`22007` invalid input, `22003` out of range, `42804` wrong type, `refused` for rule 2.

**Inverse.** `inverse` is a list of bare `@` addresses that undo the write exactly when executed in order, each with a fresh context:

| Write | Inverse |
|---|---|
| insert | one delete of the inserted rows by primary key (`eq` or `in`) |
| delete | one insert of the removed rows, every column |
| update | one update per changed row, assigning the old values back, matched by primary key |

Tables without a primary key are matched on every column. The pulse row of an executed write records the inverse as `undo` (§6). Its `parent` fingerprint returns the full address before the write, which the workbench's Undo goes back to.

**SQL fiber.** `INSERT INTO t (…) VALUES (…), (…) RETURNING …`, `UPDATE t SET c = … WHERE … RETURNING …`, `DELETE FROM t WHERE … RETURNING …`, with `$n` parameters for variables as in select.

**Known differences from PostgreSQL,** all on inputs the engine is stricter about: the engine rejects a fractional number for an integer column (PostgreSQL rounds a literal) and a number for a text column (PostgreSQL casts it); and it checks UNIQUE against the rows so far, in table order, which is how PostgreSQL checks non-deferred constraints. The generated write tests never assign UNIQUE or PRIMARY KEY columns in an update, so that ordering is untested.

## 13. Edit and query

One way to change any address, and one way to search it. Both work on any profile.

**`edit(uri, ops, opts) → {uri, tree}`.** `uri` is a full address. `ops` is a list in the style of JSON Patch (RFC 6902), using tcxp pointers (§7):

| Operation | Effect |
|---|---|
| `{op:"bind", var:"tax_year", value:"2024"}` | Bind `$tax_year`. `value` is the literal as written in an expression (`2024`, `'2026-fall'`, `date'2026-01-31'`, or a bare `@!tcxp:/…` call); `edit` does the percent-encoding. The variable must occur in the tree. |
| `{op:"unbind", var:"tax_year"}` | Remove the binding; the variable becomes a gap again. |
| `{op:"param", name:"do", value:"world"}` | Set a function parameter (`null` clears it, leaving a gap). The counterpart of `bind` for function addresses. |
| `{op:"replace", path:"/where/0/1", expr:"eq(a,$b)"}` | Replace the node at the pointer. A path of just `/key` replaces the whole value. Paths into a bound value are refused (use `bind`). On a `tcxp://` address the value is kept as written. |
| `{op:"remove", path:"/order"}` | Remove a key, a list item (`/cols/1`), an operand (`/where/0/2`), a binding (`/$x`), a context array's entries (`/~context/observe`, leaving `[]`) or one entry (`/~context/observe/0`). |
| `{op:"add", key:"order", expr:"desc(gpa)"}` | Add a data key, or append to a list key (`cols`, `order`, `group`, `join`, `values`, `set`, `returning`). Adding to a single-valued key that is already set is refused (use `replace`). |
| `{op:"annotate", on:["/$tax_year"], meaning, structure, environment}` | Append a spike row to `observe` (id `s<n>` unless given). Every pointer in `on` must resolve. |
| `{op:"context", key:"observe", value:[…]}` | Replace one context array; `null` makes it `[]`. |

Operations apply in order; the address is re-parsed after each one. If an operation would produce an address that does not parse, has an error diagnostic, or fails `FilterGenerator.filter`, `edit` throws a plain-language `TcxpError` with `code:"edit"` that names the operation, and returns nothing. It never returns an invalid address.

Unless `opts.pulse === false`, each `edit` call stamps a new pulse row (§8): `step` is the previous pulse's step plus one (1 if there was none), `parent` is the fingerprint of the full address before the edit (registered, so `lookupAddress` returns it), `debounce_ms` is 0 (a programmatic edit is not debounced), and `at` is now (or `opts.at`).

**`query(uri, selector) → [{pointer, kind, label}]`.** Selectors: `gaps`, `variables`, `references`, `references:<name>` (matches `name` or `table.name`), `operators`, `operators:<op>`, `annotations` (one row per resolving `on` pointer, labelled with the spike id and its MSE bits), `pointer:<path>` (including `/~context/…`). Pointers are positional (`/key/item/child/…`), one per occurrence. **Invariant:** every returned pointer resolves with `resolvePointer`.

**`fromJSON(json)`** is the inverse of `toJSON`: it rebuilds the full address from the profile, the tree and the context alone (it does not read `toJSON`'s `address` field). `identity(fromJSON(toJSON(t))) = identity(t)`, and the full canonical address is preserved too.

**CSV as a data source.** `registerCSV(registry, table, csvText, types)` creates a table that `sql/select` and the write profiles use like any other. The first row is the header; names are lower-cased and non-alphanumerics become `_`. RFC 4180 quoting is supported; an empty cell is `null`. Column types are inferred (`integer`, `numeric`, `date`, else `text`) unless `types` gives them (`{hours: "numeric(6,2)"}`). Because CSV rows have no identity of their own, the table gets a first column `row_id integer PRIMARY KEY` numbering the rows 1 to n; that keeps write inverses exact when two rows are identical. The registry `client.demo` holds `client_hours` (employee, date, hours, work_country), loaded this way, and is verified in PostgreSQL by loading the same rows through the generated DDL and inserts.

## 14. Handlers

Handlers are applications built on the protocol: the workbench, the tax intake demo, and yours. They decide what rows to write and what to do after a halt. Their conventions are not protocol rules; another handler may choose differently.

- **A plain question** is written as one `intent` row `{"role":"user","text":"…"}`. The workbench shows the first such row as the address's question.
- **Annotations** are `observe` rows `{"id","on":[pointers],"meaning","structure","environment"}` (§7).
- **The pulse** is the `trace` row `{"step","at","debounce_ms","parent"}`, plus `undo` after an executed write (§8, §12). The tax intake demo also writes a source row `{"file","rows","fnv1a"}` in `trace`.
- **What happens after a halt is the handler's.** The protocol decides only *whether* something may run: an unbound variable halts. The tax intake demo keeps a manager's checklist as `intent` rows (`{"role":"manager","text":…,"require":"$tax_year",…}`), applies those rules itself, asks for the tax year in its chat, and records the manager's verdicts as `observe` rows `{"rule","verdict","at"}`. All of that is the demo's own handling; none of it is protocol.

## 15. Future: the governor

The protocol has three states for a decision that is not yet complete: **HALT**, **ASK** and **ACT**. v0.2 implements HALT only, through the one halt rule (§4). ASK and ACT, and the *governor* that moves a decision between the three states, are future work. Nothing in v0.2's context carries ask or act semantics.
