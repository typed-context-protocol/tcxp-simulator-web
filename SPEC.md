# Typed Context Protocol (tcxp) — v0.1 draft

Author: Ron Itelman · Status: working draft, October 2026 · Reference implementation: `tcxp.js`

## 1. Purpose

tcxp writes a decision state as a single line of text: an **address**. The address parses into an expression tree built from four kinds of node. Context about that tree (meaning, rules, environment, time, money, observation) rides along as metadata that points into the tree without changing it.

The protocol constrains only the grammar. Anything expressible in the grammar is a valid state. Handlers interpret states; bindings fill variables.

## 2. Address forms

```
!tcxp:/<registry>/<path>?<key>=<value>&…&$<var>=<value>&…&~<meta>=<value>&…     an address (names a state)
@!tcxp:/<registry>/<path>?<param>=<value>&…&~<meta>=<value>&…                   a call (invokes a handler)
```

- **`!`** marks the string as a tcxp address and not a resolvable URI. Nothing on a network resolves it.
- **`@`** in front means *call*: resolve the address in the registry of the system you are running in, then invoke the handler. On a write address (§12) it means *perform the write*; without `@` the same address only describes the write.
- **`<registry>`** is the first path segment. It names an in-memory, virtual registry (for example `school.demo`, `registry`).
- **`<path>`** selects what inside the registry the address refers to. v0.1 defines:
  - `sql/select` (the SQL profile; the registry must hold a database)
  - `sql/insert`, `sql/update`, `sql/delete` (the write profiles, §12; the registry must hold a database)
  - `math/eval` (the math profile; available in every registry)
  - a function name (callable with `@`)
  - a note (`notes/…`, `rules/…`, `env/…`), which is text that annotation facets point to
- The older `!tcxp://` form is accepted on input and normalized to `!tcxp:/`.

## 3. Key classes

Every query key belongs to exactly one class, decided by its first character after percent-decoding. The parser makes a single pass with no lookahead.

| First character | Class | Example |
|---|---|---|
| letter | Data key: a clause (SQL), `expr` (math), or a function parameter | `where=eq(gpa,$min)` |
| `$` | Variable binding | `$min=3.5` |
| `~` | Meta | `~intent=Who joined in August?` |

**Rule M (meta last).** Every `~` key comes after every data key and binding. An address that breaks this is rejected.

## 4. The four node kinds

| Kind | What it is | Who binds it | Written as |
|---|---|---|---|
| Operator | Does something to its children | n/a | `eq(…)`, clause keys, `@` |
| Value | A literal | n/a | `'text'`, `42`, `3.5`, `date'2026-09-01'`, `true`, `null` |
| Variable | A name declared open, waiting to be filled | The caller: a person, a form, a model, a call | `$name` |
| Reference | A name for something that already exists | The data or the registry | `gpa`, `students.email`, a handler address |

**Gap.** A variable with no binding is a *gap*. Gaps are first-class: they are counted, highlighted, and typed (a variable takes its type from the reference or value it is compared with). **Execution is blocked while any gap exists.** A model may propose a binding; the grammar decides whether the tree is complete.

**Binding.** `$name=<value>` binds a variable to a literal. `$name=@!tcxp:/…` binds it to the result of a call; that call is itself a subtree.

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

## 6. Meta

Meta values are readable JSON. A list is a JSON array of flat rows, one object per event, which is JSON Lines held inside an array. Scalars may be plain text or integers. Reserved keys in v0.1:

| Key | Shape | Meaning |
|---|---|---|
| `~pulse` | `[{"step":n,"at":"ISO 8601 ms","debounce_ms":300,"parent":"identity"\|null}]` | One movement of the local system. `step` counts committed addresses, not keystrokes. A commit happens after a `debounce_ms` quiet period. `parent` is the identity (§8) of the previous committed state, or `null` for the first, so following parents traces how a change travels through a chain of decisions. A row without `parent` (written before it existed) reads as `null`. |
| `~pulse` field `undo` | `["@!tcxp:/…", …]` | Present only on the pulse of an executed write (§12): the inverse addresses that undo it, in order. |
| `~intent` | text, or rows (§14) | The natural-language question this state answers. As rows, it can also require variables before anything runs. |
| `~spikes` | `[{"id","on":[pointers],"meaning","structure","environment"}]` | Annotations (see §7) |
| `~observe` | `[{"from","to","channel"}]` | A communication event: sender, receiver, channel |
| `~outcome` | `[{"amount","currency"}]` | Money tied to the decision, for later reward and regret analysis |

Other `~` keys are allowed and preserved in order.

## 7. Pointers and annotations (spikes)

A **pointer** addresses a node: `/<key>/<item>/<child>/…`.

- `/expr/0/0/0` is the `mul` node in `eq(add(mul(2,$x),3),9)`.
- `/$name` addresses every occurrence of a variable.
- Together with a pulse step, `(step, pointer)` is a coordinate in space and time.

A **spike** is one annotation. `on` lists pointers, so one spike can anchor to several nodes; that makes it a hyperedge. The **data** facet is the anchor itself (the nodes pointed at). Three facets are projected from it:

- **Meaning:** what it means, in human language.
- **Structure:** the rules it must satisfy (units, types, normalization, validation).
- **Environment:** what you must know before acting on it, that the data itself can't tell you:
  - Origin: where it came from.
  - Conditions: when and where it holds true.
  - Consequences: how it should change the decision.

Each facet holds a tcxp address of a note, inline text, or `null`. A facet is **lit** when it holds a value that resolves, and **dark** otherwise. A spike's state is three bits (meaning, structure, environment), so 8 states. Comparing two spikes is a bitwise check plus string equality on identities.

A *reason card* is a spike whose meaning facet carries the human-readable definition of a decision.

## 8. Canonical form, identity, transport

- **Canonical form.** Clauses in fixed order (`cols from join where group having order limit offset`), then bindings in order of first appearance in the tree, then meta in the order given. Values escape only `%`, `&`, `#` (and `=` inside data literals), so the form stays readable.
- **Identity.** The canonical form with every `~` key removed. Two snapshots of the same state have equal identities, whatever their time, pulse or annotations. Equality is syntactic: two *equivalent* states compare equal only after normalization rules map them to the same tree.
- **Strict transport form.** Every character outside RFC 3986's unreserved and sub-delimiter sets is percent-encoded. It parses back to the identical canonical form.
- **Browsers.** An address travels in the fragment: `page.html#!tcxp:/…`.

## 9. Guarantees and their status

| Guarantee | Status in v0.1 |
|---|---|
| Lossless: tree → canonical address → tree | By construction; tested on 20 collection addresses, 29 probes, 2,500 generated addresses |
| Canonical address is a fixed point of parse ∘ serialize | Tested (round-trip); target for a Lean proof |
| Identity is invariant under meta and pulses | Tested; target for a Lean proof |
| Gaps block execution | By construction; tested |
| Every pulse `parent` is the identity of an earlier pulse in the chain | Tested on a chain through the 20 collection addresses; target for a Lean proof |
| Gaps block writes: no preview, and nothing applied | By construction; tested; proved in Lean for a keyed-table model (`gap_blocks_write`) |
| A write's inverse restores the data | Tested against PostgreSQL 18.3 on 7 collection writes and 622 generated writes; proved in Lean for a keyed-table model (exact for insert and update, up to row order for delete) |
| Intent rows never change identity | By construction (meta); tested on 539 addresses with random rows added and removed |
| A variable an intent row requires blocks execution until bound (ASK → ask, BLOCK → gap) | By construction; tested on 539 addresses, writes included |
| Writes and their failures agree with PostgreSQL | Tested: same affected count, RETURNING rows and table contents, or the same SQLSTATE, on every collection write and 1,000 generated writes. Evidence, not proof |
| SQL fiber and tree evaluator agree | Tested against PostgreSQL 18.3: 49 fixed cases and 1,918 generated cases, all matching. Evidence, not proof |
| Persistence | An address is a string; store it anywhere |

## 10. Not representable in v0.1

These are declared out of scope, and the test suite lists them: table aliases, DISTINCT, count(DISTINCT), CASE, subqueries, set operations, CTEs, window functions, casts, DDL, list-valued variables, and calls with arguments nested inside expressions. Writes moved out of this list in v0.2 (§12).

## 11. Reference implementation

`tcxp.js` exposes:

- **Parsing and serialization:** `parseURI`, `serialize`, `identity`, `strictForm`
- **Pointers:** `resolvePointer`
- **Fibers:** `toSQL`, `toMath`, `toJSON`
- **Execution:** `execute(tree, {store, preview})`, `withPulse(tree, step, at, debounce, parent, extra)`
- **Session data:** `newStore`, `resetData`, `dataChanged`, `tableRows`
- **Edit and query (v0.2, §13):** `edit(uri, ops, opts)`, `query(uri, selector)`, `fromJSON(json)`, `exprText(node)`
- **Intent rows (v0.2, §14):** `recordDefaults(uri, opts)`, `resultKey(tree)`
- **Data sources (v0.2, §13):** `registerCSV(registry, table, csvText, types)`
- **Testing:** `FilterGenerator` (seeded random addresses; `nextWrite()` for random writes; `FilterGenerator.filter(uri)` to check any address against the rules)

It is published in two languages, released together under the same version:

| Language | Install | Import |
|---|---|---|
| JavaScript | `npm install @tcxp/tcxp` | `require('@tcxp/tcxp')` |
| Python 3.10+ | `pip install tcxp` | `import tcxp` (the same API in snake_case: `parse_uri`, `to_sql`, …) |

The Python package is a conformance port of `tcxp.js`. Before every release it must reproduce the JavaScript engine's output byte for byte over the vectors in `python/vectors/`.

## 12. Writes (added in v0.2)

```
!tcxp:/<registry>/sql/insert?into=<table>&cols=<c1,c2,…>&values=row(v1,v2,…)[,row(…)]&returning=<cols or *>
!tcxp:/<registry>/sql/update?table=<table>&set=assign(<col>,<expr>)[,assign(…)]&where=<expr>&returning=…
!tcxp:/<registry>/sql/delete?from=<table>&where=<expr>&returning=…
```

**Describe, then perform.** An address without `@` describes a proposed write. Executing it returns kind `preview`: the rows that would be inserted, changed (before and after) or removed, the RETURNING rows and the inverse, with nothing mutated. The same address with `@` performs the write and returns kind `write`: the affected count, the RETURNING rows, and `inverse`. A write is applied to a per-session copy of the registry data; the shipped seed is never mutated.

**Values.** Inserted values and assigned expressions may use literals, `$variables` and operators; variables may be bound by `@` calls to functions, as in select. Inserted values may not refer to columns. In an update, every `assign` reads the row as it was before the update, as in SQL. A variable or literal written straight into a column takes that column's type.

**Safety rules.**

1. *Gaps block writes.* While any variable is unbound, both the preview and the write return kind `gap` and touch nothing.
2. *update and delete require `where=`.* An address without it is well formed but **refused** (diagnostic level `refused`): it cannot preview or run. To affect every row, write `where=true`.
3. *Types.* A literal or bound literal of the wrong type for its column is an error before anything runs. At run time each value is coerced to the column type the way PostgreSQL stores it: integers must be whole and in range, `numeric(p,s)` rounds to `s` places and must fit `p`, dates must be real dates.
4. *Constraints,* checked in PostgreSQL's order: per row, value coercion, then NOT NULL, then CHECK, then UNIQUE and PRIMARY KEY against the rows so far; after the last row, foreign keys against the state the statement leaves behind (NO ACTION), in both directions (a child must point at an existing parent; a parent still referred to cannot be deleted or re-keyed).

Errors are plain language and carry PostgreSQL's SQLSTATE as `code`: `23502` NOT NULL, `23514` CHECK, `23505` UNIQUE, `23503` FOREIGN KEY, `22P02`/`22007` invalid input, `22003` out of range, `42804` wrong type, `refused` for rule 2.

**Inverse.** `inverse` is a list of `@` addresses that undo the write exactly when applied in order:

| Write | Inverse |
|---|---|
| insert | one delete of the inserted rows by primary key (`eq` or `in`) |
| delete | one insert of the removed rows, every column |
| update | one update per changed row, assigning the old values back, matched by primary key |

Tables without a primary key are matched on every column. The pulse of an executed write records the inverse in `~pulse` as `undo` (§6).

**SQL fiber.** `INSERT INTO t (…) VALUES (…), (…) RETURNING …`, `UPDATE t SET c = … WHERE … RETURNING …`, `DELETE FROM t WHERE … RETURNING …`, with `$n` parameters for variables as in select.

**Known differences from PostgreSQL,** all on inputs the engine is stricter about: the engine rejects a fractional number for an integer column (PostgreSQL rounds a literal) and a number for a text column (PostgreSQL casts it); and it checks UNIQUE against the rows so far, in table order, which is how PostgreSQL checks non-deferred constraints. The generated write tests never assign UNIQUE or PRIMARY KEY columns in an update, so that ordering is untested.

## 13. Edit and query (added in v0.2)

One way to change any address, and one way to search it. Both work on any profile.

**`edit(uri, ops, opts) → {uri, tree}`.** `ops` is a list in the style of JSON Patch (RFC 6902), using tcxp pointers (§7):

| Operation | Effect |
|---|---|
| `{op:"bind", var:"tax_year", value:"2024"}` | Bind `$tax_year`. `value` is the literal as written in an expression (`2024`, `'2026-fall'`, `date'2026-01-31'`, or an `@!tcxp:/…` call); `edit` does the percent-encoding. The variable must occur in the tree (or be required by an intent row, §14). |
| `{op:"unbind", var:"tax_year"}` | Remove the binding; the variable becomes a gap again. |
| `{op:"param", name:"do", value:"world"}` | Set a function parameter (`null` clears it, leaving a gap). The counterpart of `bind` for function addresses. |
| `{op:"replace", path:"/where/0/1", expr:"eq(a,$b)"}` | Replace the node at the pointer. A path of just `/key` replaces the whole value. Paths into a bound value are refused (use `bind`). |
| `{op:"remove", path:"/order"}` | Remove a key, a list item (`/cols/1`), an operand (`/where/0/2`), a binding (`/$x`) or a meta key (`/~intent`). |
| `{op:"add", key:"order", expr:"desc(gpa)"}` | Add a data key, or append to a list key (`cols`, `order`, `group`, `join`, `values`, `set`, `returning`). Adding to a single-valued key that is already set is refused (use `replace`). |
| `{op:"annotate", on:["/$tax_year"], meaning, structure, environment}` | Append a spike to `~spikes` (id `s<n>` unless given). Every pointer in `on` must resolve. |
| `{op:"meta", key:"outcome", value:[…]}` | Set a meta key; `null` removes it. |

Operations apply in order; the address is re-parsed after each one. If an operation would produce an address that does not parse, has an error diagnostic, or fails `FilterGenerator.filter` (canonical form, meta last, grammar), `edit` throws a plain-language `TcxpError` with `code:"edit"` that names the operation, and returns nothing. It never returns an invalid address.

Unless `opts.pulse === false`, each `edit` call stamps a new `~pulse` row: `step` is the previous pulse's step plus one (1 if there was none), `parent` is the identity before the edit, `debounce_ms` is 0 (a programmatic edit is not debounced), and `at` is now (or `opts.at`). Following the parents of a series of edits gives the edit history.

**`query(uri, selector) → [{pointer, kind, label}]`.** Selectors: `gaps`, `variables`, `references`, `references:<name>` (matches `name` or `table.name`), `operators`, `operators:<op>`, `annotations` (one row per resolving `on` pointer, labelled with the spike id and its MSE bits), `pointer:<path>`. Pointers are positional (`/key/item/child/…`), one per occurrence. **Invariant:** every returned pointer resolves with `resolvePointer`.

**`fromJSON(json)`** is the inverse of `toJSON`: it rebuilds the address from the profile, the tree and the meta alone (it does not read `toJSON`'s `address` field). `identity(fromJSON(toJSON(t))) = identity(t)`, and the full canonical address is preserved too.

**CSV as a data source.** `registerCSV(registry, table, csvText, types)` creates a table that `sql/select` and the write profiles use like any other. The first row is the header; names are lower-cased and non-alphanumerics become `_`. RFC 4180 quoting is supported; an empty cell is `null`. Column types are inferred (`integer`, `numeric`, `date`, else `text`) unless `types` gives them (`{hours: "numeric(6,2)"}`). Because CSV rows have no identity of their own, the table gets a first column `row_id integer PRIMARY KEY` numbering the rows 1 to n; that keeps write inverses exact when two rows are identical. The registry `client.demo` holds `client_hours` (employee, date, hours, work_country), loaded this way, and is verified in PostgreSQL by loading the same rows through the generated DDL and inserts.

## 14. Intent rows (added in v0.2)

`~intent` takes either form:

- **A string** (v0.1): one user row, no requirements. It serializes as a string, so every v0.1 address is unchanged.
- **An array of flat rows:** `{"role":"user"|"manager"|…, "text":…, "require":"$var" or ["$a","$b"], "if_empty":"ASK"|"BLOCK"|"DEFAULT"|"WARN", "default":…}`. Only `require` gives a row force; a row without it (a user's question, a note) changes nothing.

**Semantics.**

- Each `require` names a variable that must be bound before anything runs, **even if the query never uses it**. A required variable the query does not use gets its own variable node beside the query tree, so `/$name` resolves to it, it can be annotated and bound (`edit` `bind` accepts it), and `query(…, "gaps")` lists it.
- A required variable that is not bound is a **gap whose source is the intent row**. What happens next is the row's `if_empty`:
  - `ASK` returns result kind `ask`: `{kind:"ask", question: <the row's text>, questions:[{var, text, role, row}], gaps}`. Nothing runs.
  - `BLOCK` (the default when `if_empty` is absent) returns kind `gap`. Nothing runs.
  - `DEFAULT` binds the row's `default` (a number, text or true/false). The default is never written into the address as `$var=`, so the identity is unchanged, and it is never silent: the result carries `defaults:[{var, value, row}]`, and `recordDefaults(uri)` writes an annotation (`id:"default-<var>"`, `on:["/$var"]`) and stamps a `~pulse` whose row carries `defaults`. The workbench does this the first time it shows such an address.
  - `WARN` (advisory, kept for applications such as the tax intake demo) does not block a variable that only the intent row mentions; the result carries `warnings:[{var, text, row}]`. A variable the query itself uses is still a gap when unbound, whatever the row says.
- When several rows require the same variable, the strictest wins: `BLOCK` > `ASK` > `DEFAULT` > `WARN`. When several variables are missing, the result is `ask` if at least one has an `ASK` row and none has a `BLOCK` row; otherwise `gap`.
- A malformed row (`require` not of the form `"$name"`, an unknown `if_empty`, `DEFAULT` without a `default`) is an error diagnostic, so it cannot be ignored silently.

**Identity.** Intent rows are meta, so adding, changing or removing them never changes the identity (decided for v0.2). They can still decide *whether* a state runs. Two snapshots with the same identity can therefore halt or run differently. Anything that stores a result next to an identity must key it with `resultKey(tree)`: the identity, plus the required variables, their modes and defaults when there are any. With no requirements, `resultKey` is the identity, so every v0.1 key is unchanged.

**Example** (`client.demo`, verified in PostgreSQL):

```
!tcxp:/client.demo/sql/select?cols=as(sum(hours),us_hours)&from=client_hours
  &where=and(eq(work_country,'US'),eq(year(date),$tax_year))
  &~intent=[{"role":"user","text":"What are the US hours worked in my client CSV?"},
            {"role":"manager","text":"Before submitting, the user must state the tax year they are referencing.","require":"$tax_year","if_empty":"ASK"}]
```

returns `ask` with the manager's text until `$tax_year` is bound; with `$tax_year=2024` it runs and returns 59.25, the same as PostgreSQL.

**Names are data.** A name in an address (registry, path, key, table, column, operator, variable, meta key) is never a JavaScript property: `constructor`, `__proto__`, `toString` and the like behave exactly like any other unknown name (v0.2 fix; the tests compare every position against an ordinary name).

