# tcxp (Python)

The Typed Context Protocol (tcxp) v0.2 reference engine for Python. A decision state is written as one line of text that parses into an expression tree, carries its own context, and runs.

This is the same engine as the [`@tcxp/tcxp` npm package](https://www.npmjs.com/package/@tcxp/tcxp), ported line for line. Both packages are released together from the same commit with the same version number. Every release must reproduce the JavaScript engine's output for thousands of conformance vectors, byte for byte.

Pure Python 3.10+, no dependencies, typed (`py.typed`). The rules the engine follows are listed in [`RULES.md`](https://github.com/typed-context-protocol/tcxp-simulator-web/blob/main/RULES.md).

## Install

```sh
pip install tcxp
```

## Quickstart

```python
import tcxp
uri = ("!tcxp:/school.demo/sql/select?cols=*&from=students&where=eq(cohort,$cohort)&$cohort='2026-fall'"
       '&~context={"intent":[],"observe":[],"reason":[],"decide":[],"trace":[]}')
tree = tcxp.parse_uri(uri)
print(tcxp.serialize(tree)["uri"])               # canonical form
print(tcxp.identity(tree))                       # identity (the address without ~context)
print(tcxp.to_sql(tree)["sql"])                  # SELECT * FROM students WHERE cohort = $1
result = tcxp.execute(tree)                      # runs on the built-in demo data
print(result["kind"], len(result["rows"]))       # rows 7
```

The JavaScript version of the same lines:

```js
const tcxp = require('@tcxp/tcxp');
const tree = tcxp.parseURI(uri);
tcxp.serialize(tree).uri; tcxp.identity(tree); tcxp.toSQL(tree).sql; tcxp.execute(tree);
```

## Addresses

There are exactly two formats, optionally after `@` (a call): `!tcxp:/<registry>/<path>` (virtual) and `tcxp://<registry>/<path>` (resolvable). Any other spelling is rejected, never rewritten. The query is data keys, then `$variables`, then `~context`, which is always last on a full address:

```
~context={"intent":[…],"observe":[…],"reason":[…],"decide":[…],"trace":[…]}
```

Each entry is a row (a JSON object) or a bare tcxp address. The context never changes identity. A reference to another address (a call in a binding, a context entry, a write's inverse) is written bare; `full_address(reference)` gives it a fresh context.

## An unbound variable halts

An unbound variable halts: nothing runs or writes until it is bound.

```python
tree = tcxp.parse_uri(tcxp.full_address("!tcxp:/registry/math/eval?expr=eq(add(mul(2,$x),3),9)"))
tcxp.execute(tree)          # {'kind': 'halt', 'gaps': ['x']}
tree = tcxp.parse_uri(tcxp.full_address("!tcxp:/registry/math/eval?expr=eq(add(mul(2,$x),3),9)&$x=3"))
tcxp.execute(tree)          # {'kind': 'value', 'value': True, 'decision': True}
tcxp.to_math(tree, True)    # '2x + 3 = 9'
```

## API

| Python | JavaScript | What it does |
|---|---|---|
| `parse_uri(uri)` | `parseURI` | Full address → tree. Raises `TcxpError` (with `.where` and `.code`) |
| `full_address(reference, context=None)` | `fullAddress` | A bare reference with a fresh (or given) `~context` |
| `serialize(tree, context=True)` | `serialize(tree, {context})` | Tree → `{'uri', 'tokens'}` in canonical form; `context=False` is the bare form |
| `identity(tree)` | `identity` | The address without `~context` |
| `fingerprint(full)`, `store_address`, `lookup_address`, `list_addresses` | same names in camelCase | SHA-256 of the full canonical address; full addresses kept in their registry |
| `strict_form(uri)` | `strictForm` | Percent-encoded transport form |
| `resolve_pointer(tree, ptr)` | `resolvePointer` | `/where/0/1`, `/$name` or `/~context/<key>[/<index>]` |
| `to_sql(tree, inline=False)` | `toSQL(tree, {inline})` | `{'sql', 'params', 'paramNames', 'via'}` for PostgreSQL |
| `to_math(tree, written=False)` | `toMath` | Math notation for `math/eval` addresses |
| `to_json(tree)`, `from_json(j)` | `toJSON`, `fromJSON` | The tree as a JSON document, and back |
| `execute(tree, store=None, preview=False)` | `execute(tree, {store, preview})` | Rows, value, call, note, write preview or write, resolvable entry, or halt |
| `with_pulse(tree, step, at, debounce, parent, extra)` | `withPulse` | Puts a pulse row first in `trace`; `parent` is the previous fingerprint |
| `new_store()`, `reset_data`, `data_changed`, `table_rows` | same names in camelCase | The session data that writes change; the shipped seed never changes |
| `edit(uri, ops, pulse=True, at=None)` | `edit(uri, ops, {pulse, at})` | `bind`, `unbind`, `param`, `replace`, `remove`, `add`, `annotate`, `context`; never returns an invalid address |
| `query(uri_or_tree, selector)` | `query` | `gaps`, `variables`, `references[:name]`, `operators[:op]`, `annotations`, `pointer:<path>` |
| `register_csv(registry, table, csv, types=None)` | `registerCSV` | A CSV as a table, with inferred types and a `row_id` key |
| `register_resolvable(entries)`, `list_resolvable(registry=None)` | same names in camelCase | Resolvable entries `{address, location}` |
| `resolve(address, fetcher=None, base=None)` | `resolve(address, {fetcher, base})` | The content at an entry's location: the only function that fetches |
| `expr_text(node)` | `exprText` | An expression as address text |
| `FilterGenerator(seed)` | `FilterGenerator` | Seeded random addresses (`next`, `next_write`), the same sequences as JavaScript |
| `FilterGenerator.filter(uri)` | `FilterGenerator.filter` | Checks an address against the protocol rules |
| `REGISTRIES`, `QUERIES`, `COVERAGE`, `OPS`, `CONTEXT_KEYS`, … | same names | Demo registries, the collection, operator tables |

Trees and results are plain dicts and lists with the same keys as the JavaScript objects (`paramNames`, `debounce_ms`, …), so `json.dumps` of a Python result matches `JSON.stringify` of the JavaScript one. Numbers follow JavaScript: whole numbers are `int`, others `float`.

`resolve` is synchronous in Python (JavaScript returns a Promise). The default fetcher reads `file:` locations (relative paths against `base`, which defaults to this package's directory, where the demo fixtures ship) and `http(s):` locations.

## Conformance

`vectors/` holds conformance vectors exported from `tcxp.js` (the engine shipped on npm as `@tcxp/tcxp`) by `tools/export_vectors.mjs`:
- every collection and coverage address: reads, writes, the CSV table, intent rows and a resolvable entry
- 5,000 `FilterGenerator` addresses with seed 7, each with its `~context`
- 1,000 `FilterGenerator.next_write` addresses with seed 11, previewed, performed and undone through their bare inverses
- 1,409 recorded `edit` operations and their results, including the `context` operation and `/~context/…` paths
- malformed addresses: every format rule, the order of data keys, `$variables` and `~context`, and every `~context` error
- `full_address`, fingerprints and the address store, the resolvable registry and `resolve` with injected and default fetchers
- `register_csv` cases, `with_pulse` chains with fingerprint parents, and JavaScript-special names in every position
- the JavaScript number, JSON, date and URI semantics the engine relies on

Every record also checks its fingerprint, `from_json(to_json(t))` and a set of `query` selectors, including pointers into `~context`.

`pytest` rebuilds every record in Python and compares it with the JavaScript line, byte for byte. `tests/test_postgres.py` also runs the collection and the 1,000 generated writes against a real PostgreSQL when `psycopg` and a server are available (`TCXP_PG_DSN`). For each write it compares RETURNING, row counts, every table and SQLSTATE error codes, then checks that the inverse restores the seed. Without a server it skips. `tests/test_resolve.py` checks that nothing but `resolve` fetches.

```sh
pip install -e ".[test]" && pytest
```

### Known differences

These are edges no vector covers, where matching V8 exactly was not worth the code:
- Date strings that are not ISO 8601 (V8's legacy date parser) compare as invalid dates in Python.
- `pow` with non-integer exponents may differ in the last bit between V8 and the C library.
- A failed fetch reports the operating system's own error text after `Fetching … failed: `.
- On a `tcxp://` address, data keys keep the order they were written in (RULES.md R20) for every key name. `tcxp.js` 0.2.0 moves integer-like key names (such as `2`) first.

## License

Apache-2.0. See `LICENSE`.
