# tcxp (Python)

The Typed Context Protocol (tcxp) v0.1 reference engine for Python. A decision state is written as one line of text that parses into an expression tree, carries its own context, and runs.

This is the same engine as the [`@tcxp/tcxp` npm package](https://www.npmjs.com/package/@tcxp/tcxp), ported line for line. Both packages are released together from the same commit with the same version number. Every release must reproduce the JavaScript engine's output for thousands of conformance vectors, byte for byte.

Pure Python 3.10+, no dependencies, typed (`py.typed`).

## Install

```sh
pip install tcxp
```

## Quickstart

```python
import tcxp
uri = "!tcxp:/school.demo/sql/select?cols=*&from=students&where=eq(cohort,$cohort)&$cohort='2026-fall'"
tree = tcxp.parse_uri(uri)
print(tcxp.serialize(tree)["uri"])               # canonical form
print(tcxp.identity(tree))                       # identity (ignores ~ metadata)
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

## Gaps halt

A variable with no value is a gap, and a gap always halts: nothing runs or writes until it is bound. An `~intent` row can require a variable even if the query never uses it.

```python
tree = tcxp.parse_uri("!tcxp:/registry/math/eval?expr=eq(add(mul(2,$x),3),9)")
tcxp.execute(tree)          # {'kind': 'halt', 'gaps': ['x']}
tree = tcxp.parse_uri("!tcxp:/registry/math/eval?expr=eq(add(mul(2,$x),3),9)&$x=3")
tcxp.execute(tree)          # {'kind': 'value', 'value': True, 'decision': True}
tcxp.to_math(tree, True)    # '2x + 3 = 9'
```

## API

| Python | JavaScript | What it does |
|---|---|---|
| `parse_uri(uri)` | `parseURI` | Address → tree. Raises `TcxpError` (with `.where`) |
| `serialize(tree, meta=True)` | `serialize` | Tree → `{'uri', 'tokens'}` in canonical form |
| `identity(tree)` | `identity` | Canonical form without `~` meta keys |
| `strict_form(uri)` | `strictForm` | Percent-encoded transport form |
| `resolve_pointer(tree, ptr)` | `resolvePointer` | `/where/0/1` or `/$name` → nodes |
| `to_sql(tree, inline=False)` | `toSQL(tree, {inline})` | `{'sql', 'params', 'paramNames', 'via'}` for PostgreSQL |
| `to_math(tree, written=False)` | `toMath` | Math notation for `math/eval` addresses |
| `to_json(tree)` | `toJSON` | The tree as a JSON document |
| `execute(tree, store=None, preview=False)` | `execute(tree, {store, preview})` | Runs on the demo registries: rows, value, call, note, a write preview or write, or halt |
| `with_pulse(tree, step, at, debounce, parent, extra)` | `withPulse` | Stamps a `~pulse` row; `parent` chains states, `extra` adds fields such as `undo` |
| `new_store()`, `reset_data`, `data_changed`, `table_rows` | same names in camelCase | The session data that writes change; the shipped seed never changes |
| `edit(uri, ops, pulse=True, at=None)` | `edit(uri, ops, {pulse, at})` | `bind`, `unbind`, `param`, `replace`, `remove`, `add`, `annotate`, `meta`; never returns an invalid address |
| `query(uri_or_tree, selector)` | `query` | `gaps`, `variables`, `references[:name]`, `operators[:op]`, `annotations`, `pointer:<path>` |
| `from_json(j)` | `fromJSON` | The inverse of `to_json` |
| `register_csv(registry, table, csv, types=None)` | `registerCSV` | A CSV as a table, with inferred types and a `row_id` key |
| `result_key(tree)`, `expr_text(node)` | `resultKey`, `exprText` | Result key (identity plus intent requirements); an expression as address text |
| `FilterGenerator(seed)` | `FilterGenerator` | Seeded random addresses, the same sequence as JavaScript |
| `FilterGenerator.filter(uri)` | `FilterGenerator.filter` | Checks an address against the protocol rules |
| `REGISTRIES`, `QUERIES`, `COVERAGE`, `OPS`, … | same names | Demo registries, the 20-address collection, operator tables |

Trees and results are plain dicts and lists with the same keys as the JavaScript objects (`paramNames`, `debounce_ms`, …), so `json.dumps` of a Python result matches `JSON.stringify` of the JavaScript one. Numbers follow JavaScript: whole numbers are `int`, others `float`.

## Conformance

`vectors/` holds conformance vectors exported from `tcxp.js` (the engine shipped on npm as `@tcxp/tcxp`) by `tools/export_vectors.mjs`:
- every collection and coverage address, including writes, the CSV table and intent rows
- 5,000 `FilterGenerator` addresses with seed 7
- 1,000 `FilterGenerator.next_write` addresses with seed 11, previewed, performed and undone
- 2,071 recorded `edit` operations and their results
- `register_csv` cases, `with_pulse` chains, malformed addresses and their error messages
- JavaScript-special names (`constructor`, `__proto__`, …) in every position, each equal to an ordinary name
- the JavaScript number, JSON, date and URI semantics the engine relies on

Every record also checks `from_json(to_json(t))`, `result_key` and a set of `query` selectors.

`pytest` rebuilds every record in Python and compares it with the JavaScript line, byte for byte. `tests/test_postgres.py` also runs the collection and the 1,000 generated writes against a real PostgreSQL when `psycopg` and a server are available (`TCXP_PG_DSN`). For each write it compares RETURNING, row counts, every table and SQLSTATE error codes, then checks that the inverse restores the seed. Without a server it skips.

```sh
pip install -e ".[test]" && pytest
```

### Known differences

These are edges no vector covers, where matching V8 exactly was not worth the code:
- Date strings that are not ISO 8601 (V8's legacy date parser) compare as invalid dates in Python.
- `pow` with non-integer exponents may differ in the last bit between V8 and the C library.

## License

Apache-2.0. See `LICENSE`.
