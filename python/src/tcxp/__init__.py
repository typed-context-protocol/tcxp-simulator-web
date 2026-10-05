"""tcxp: Typed Context Protocol v0.1 reference engine (Python port of tcxp.js).

    >>> import tcxp
    >>> tree = tcxp.parse_uri("!tcxp:/registry/math/eval?expr=eq(add(mul(2,$x),3),9)&$x=3")
    >>> tcxp.execute(tree)['decision']
    True

Every function returns the same values as its JavaScript counterpart (parseURI -> parse_uri, ...);
results are plain dicts and lists with the same keys, so their JSON is identical.
"""
from ._js import URIError
from .engine import (
    CLAUSE_ORDER, CLAUSES, COVERAGE, DEBOUNCE_MS, FACETS, GROUPS, OPS, QUERIES, REGISTRIES, RULES, SCHEME,
    FilterGenerator, TcxpError, base_type, execute, find_slot, full_ddl, identity, parse_uri, resolve_pointer,
    serialize, strict_form, table_ddl, table_inserts, to_json, to_math, to_sql, with_pulse,
)

__version__ = "0.1.0"

__all__ = [
    "REGISTRIES", "QUERIES", "GROUPS", "OPS", "CLAUSES", "CLAUSE_ORDER", "COVERAGE", "FACETS", "SCHEME", "DEBOUNCE_MS",
    "RULES", "parse_uri", "serialize", "identity", "strict_form", "resolve_pointer", "to_sql", "to_math", "to_json",
    "execute", "with_pulse", "full_ddl", "table_ddl", "table_inserts", "TcxpError", "URIError", "base_type",
    "find_slot", "FilterGenerator", "__version__",
]
