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
| `~intent` | text | The natural-language question this state answers |
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
