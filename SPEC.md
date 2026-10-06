# Typed Context Protocol (tcxp) — v0.1 draft

Author: Ron Itelman · Status: working draft, October 2026 · Reference implementation: `tcxp.js`

## 1. Purpose

tcxp writes a decision state as a single line of text: an **address**. The address parses into an expression tree built from four kinds of node. Context about that tree (meaning, rules, environment, time, money, observation) rides along as metadata that points into the tree without changing it.

The protocol constrains only the grammar. Anything expressible in the grammar is a valid state. Handlers interpret states; bindings fill variables.

## 2. Address forms

### Two forms: resolvable and virtual

tcxp has two forms. They are different, not two spellings of one thing:

- **`tcxp://…` is a resolvable address**, resolved through a registry. This is the URI scheme being registered with IANA.
- **`!tcxp:/…` is a virtual state.** It is not resolved.

Both can exist on a registry, and they are not the same state.

v0.1 and v0.2 implement only the virtual form; the rest of this specification describes it. The resolvable `tcxp://` form will be specified with A3 (external references and the network registry).

### The virtual form

```
!tcxp:/<registry>/<path>?<key>=<value>&…&$<var>=<value>&…&~<meta>=<value>&…     an address (names a state)
@!tcxp:/<registry>/<path>?<param>=<value>&…&~<meta>=<value>&…                   a call (invokes a handler)
```

- **`!`** marks the string as a tcxp address and not a resolvable URI. Nothing on a network resolves it.
- **`@`** in front means *call*: resolve the address in the registry of the system you are running in, then invoke the handler.
- **`<registry>`** is the first path segment. It names an in-memory, virtual registry (for example `school.demo`, `registry`).
- **`<path>`** selects what inside the registry the address refers to. v0.1 defines:
  - `sql/select` (the SQL profile; the registry must hold a database)
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

**Math profile operators:** `eq ne lt le gt ge add sub mul div pow and or not`. Math has no references; unknowns are variables.

## 6. Meta

Meta values are readable JSON. A list is a JSON array of flat rows, one object per event, which is JSON Lines held inside an array. Scalars may be plain text or integers. Reserved keys in v0.1:

| Key | Shape | Meaning |
|---|---|---|
| `~pulse` | `[{"step":n,"at":"ISO 8601 ms","debounce_ms":300,"parent":"identity"\|null}]` | One movement of the local system. `step` counts committed addresses, not keystrokes. A commit happens after a `debounce_ms` quiet period. `parent` is the identity (§8) of the previous committed state, or `null` for the first, so following parents traces how a change travels through a chain of decisions. A row without `parent` (written before it existed) reads as `null`. |
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
| SQL fiber and tree evaluator agree | Tested against PostgreSQL 18.3: 49 fixed cases and 1,918 generated cases, all matching. Evidence, not proof |
| Persistence | An address is a string; store it anywhere |

## 10. Not representable in v0.1

These are declared out of scope, and the test suite lists them: table aliases, DISTINCT, count(DISTINCT), CASE, subqueries, set operations, CTEs, window functions, casts, writes, DDL, list-valued variables, and calls with arguments nested inside expressions.

## 11. Reference implementation

`tcxp.js` exposes:

- **Parsing and serialization:** `parseURI`, `serialize`, `identity`, `strictForm`
- **Pointers:** `resolvePointer`
- **Fibers:** `toSQL`, `toMath`, `toJSON`
- **Execution:** `execute`, `withPulse`
- **Testing:** `FilterGenerator` (seeded random addresses, and `FilterGenerator.filter(uri)` to check any address against the rules)

It is published in two languages, released together under the same version:

| Language | Install | Import |
|---|---|---|
| JavaScript | `npm install @tcxp/tcxp` | `require('@tcxp/tcxp')` |
| Python 3.10+ | `pip install tcxp` | `import tcxp` (the same API in snake_case: `parse_uri`, `to_sql`, …) |

The Python package is a conformance port of `tcxp.js`. Before every release it must reproduce the JavaScript engine's output byte for byte over the vectors in `python/vectors/`.
