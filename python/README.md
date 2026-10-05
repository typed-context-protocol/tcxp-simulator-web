# tcxp (Python)

The Typed Context Protocol (tcxp) v0.1 reference engine for Python. A decision state is written as one line of text that parses into an expression tree, carries its own context, and runs.

This is the same engine as the [`tcxp` npm package](https://www.npmjs.com/package/tcxp), ported line for line. Both packages are released together from the same commit with the same version number. Every release must reproduce the JavaScript engine's output for thousands of conformance vectors, byte for byte.

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
const tcxp = require('tcxp');
const tree = tcxp.parseURI(uri);
tcxp.serialize(tree).uri; tcxp.identity(tree); tcxp.toSQL(tree).sql; tcxp.execute(tree);
```

## Gaps

A variable with no value is a gap, and nothing runs until it is bound:

```python
tree = tcxp.parse_uri("!tcxp:/registry/math/eval?expr=eq(add(mul(2,$x),3),9)")
tcxp.execute(tree)          # {'kind': 'gap', 'gaps': ['x']}
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
| `execute(tree)` | `execute` | Runs on the demo registries: rows, value, call, note or gap |
| `with_pulse(tree, step, at, debounce, parent)` | `withPulse` | Stamps a `~pulse` row; `parent` chains states |
| `FilterGenerator(seed)` | `FilterGenerator` | Seeded random addresses, the same sequence as JavaScript |
| `FilterGenerator.filter(uri)` | `FilterGenerator.filter` | Checks an address against the protocol rules |
| `REGISTRIES`, `QUERIES`, `COVERAGE`, `OPS`, … | same names | Demo registries, the 20-address collection, operator tables |

Trees and results are plain dicts and lists with the same keys as the JavaScript objects (`paramNames`, `debounce_ms`, …), so `json.dumps` of a Python result matches `JSON.stringify` of the JavaScript one. Numbers follow JavaScript: whole numbers are `int`, others `float`.

## Conformance

`vectors/` holds conformance vectors exported from `tcxp.js` by `tools/export_vectors.mjs`:
- every collection and coverage address
- 5,000 `FilterGenerator` addresses with seed 7
- `with_pulse` chains
- malformed addresses and their error messages
- the JavaScript number, JSON, date and URI semantics the engine relies on

`pytest` rebuilds every record in Python and compares it with the JavaScript line, byte for byte. `tests/test_postgres.py` also runs the collection against a real PostgreSQL when `psycopg` and a server are available (`TCXP_PG_DSN`); otherwise it skips.

```sh
pip install -e ".[test]" && pytest
```

### Known differences

These are edges no vector covers, where matching V8 exactly was not worth the code:
- Date strings that are not ISO 8601 (V8's legacy date parser) compare as invalid dates in Python.
- `pow` with non-integer exponents may differ in the last bit between V8 and the C library.
- Addresses that use JavaScript object-prototype names as keys or operators (`constructor`, `__proto__`, `toString`, …) hit JavaScript-specific errors in `tcxp.js`; Python treats them as ordinary unknown names.

## License

Apache-2.0. See `LICENSE`.
