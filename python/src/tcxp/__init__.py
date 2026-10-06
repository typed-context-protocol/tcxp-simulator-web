"""tcxp: Typed Context Protocol v0.2 reference engine (Python port of tcxp.js).

    >>> import tcxp
    >>> tree = tcxp.parse_uri(tcxp.full_address("!tcxp:/registry/math/eval?expr=eq(add(mul(2,$x),3),9)&$x=3"))
    >>> tcxp.execute(tree)['decision']
    True

Every function returns the same values as its JavaScript counterpart (parseURI -> parse_uri, ...);
results are plain dicts and lists with the same keys, so their JSON is identical.
"""
from ._js import URIError
from .engine import (
    CLAUSE_ORDER, CLAUSES, CONTEXT_KEYS, COVERAGE, DEBOUNCE_MS, FACETS, GROUPS, OPS, QUERIES, REGISTRIES, RESOLVABLE,
    RULES, SCHEME, WRITE_CLAUSES, WRITE_ORDER, FilterGenerator, TcxpError, base_type, data_changed, edit, execute,
    expr_text, find_slot, fingerprint, from_json, full_address, full_ddl, identity, list_addresses, list_resolvable,
    lookup_address, new_store, parse_uri, query, register_csv, register_resolvable, reset_data, resolve,
    resolve_pointer, serialize, store_address, strict_form, table_ddl, table_inserts, table_rows, to_json, to_math,
    to_sql, with_pulse,
)

__version__ = "0.2.0"

__all__ = [
    "REGISTRIES", "QUERIES", "GROUPS", "OPS", "CLAUSES", "CLAUSE_ORDER", "COVERAGE", "FACETS", "SCHEME", "DEBOUNCE_MS",
    "RULES", "parse_uri", "serialize", "identity", "strict_form", "resolve_pointer", "to_sql", "to_math", "to_json",
    "execute", "with_pulse", "full_ddl", "table_ddl", "table_inserts", "TcxpError", "URIError", "base_type",
    "find_slot", "FilterGenerator", "__version__",
    "WRITE_CLAUSES", "WRITE_ORDER", "new_store", "reset_data", "data_changed", "table_rows",
    "edit", "query", "from_json", "register_csv", "expr_text",
    "RESOLVABLE", "register_resolvable", "list_resolvable", "resolve",
    "CONTEXT_KEYS", "full_address", "fingerprint", "store_address", "lookup_address", "list_addresses",
]
