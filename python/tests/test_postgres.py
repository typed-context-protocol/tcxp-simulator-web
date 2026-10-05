"""Collection addresses against a real PostgreSQL, mirroring test/verify.mjs.

Skips unless psycopg (3.2+) is installed and a server accepts connections. Set TCXP_PG_DSN to choose
the server (default: the local socket, database "postgres"). Everything runs in one transaction in
temporary schemas and is rolled back, so the database is left unchanged.
"""
from __future__ import annotations

import datetime as dt
import decimal
import os
import re
from typing import Any, Iterator, List

import pytest

import tcxp
from tcxp._js import is_num, js_round, norm, num_div, num_mul, stringify, to_string

psycopg = pytest.importorskip('psycopg', minversion='3.2')


@pytest.fixture(scope='module')
def cur() -> Iterator[Any]:
    try:
        conn = psycopg.connect(os.environ.get('TCXP_PG_DSN', 'dbname=postgres'), connect_timeout=3)
    except Exception as e:  # noqa: BLE001
        pytest.skip('no PostgreSQL available: %s' % e)
    try:
        with conn.transaction(force_rollback=True):
            c = psycopg.RawCursor(conn)
            c.execute('SET LOCAL TimeZone = UTC')
            for reg in tcxp.REGISTRIES:
                if tcxp.REGISTRIES[reg].get('db'):
                    schema = 'tcxp_test_' + reg.split('.')[0]
                    c.execute('CREATE SCHEMA ' + schema)
                    c.execute('SET LOCAL search_path TO ' + schema)
                    c.execute(tcxp.full_ddl(reg))
            yield c
    finally:
        conn.close()


def nv(v: Any) -> Any:
    """Normalize a value the way verify.mjs does, so PostgreSQL and the engine can be compared."""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (decimal.Decimal, float, int)):
        return num_div(js_round(num_mul(norm(float(v)) if isinstance(v, (decimal.Decimal, float)) else v, 1e6)), 1e6)
    if isinstance(v, dt.datetime):
        s = v.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (v.microsecond // 1000)
        return s[:10] if s.endswith('T00:00:00.000Z') else s
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, str) and re.fullmatch(r'-?[0-9]+(\.[0-9]+)?', v):
        return num_div(js_round(num_mul(norm(float(v)), 1e6)), 1e6)
    if isinstance(v, str) and re.match(r'[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]', v):
        d = dt.datetime.fromisoformat(v.replace(' ', 'T').replace('+00', '+00:00') if v.endswith('+00') else v.replace(' ', 'T'))
        return d.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (d.microsecond // 1000)
    if is_num(v):
        return v
    return v


CASES = [(q['id'], q['uri'], q['ref']) for q in tcxp.QUERIES] + \
        [('probe:' + c[1], c[3], None) for c in tcxp.COVERAGE if c[2] == 'yes']


@pytest.mark.parametrize('cid,uri,ref', CASES, ids=[c[0] for c in CASES])
def test_address_matches_postgres(cur: Any, cid: str, uri: str, ref: Any) -> None:
    tree = tcxp.parse_uri(uri)
    assert tcxp.serialize(tree)['uri'] == uri
    assert tcxp.serialize(tcxp.parse_uri(tcxp.strict_form(uri)))['uri'] == uri
    mem = tcxp.execute(tree)
    mode = tree['parsed']['mode']
    if mem['kind'] == 'gap' or mode not in ('sql', 'math'):
        return
    g = tcxp.to_sql(tree)
    assert g is not None
    if mode == 'sql':
        cur.execute('SET LOCAL search_path TO tcxp_test_' + tree['parsed']['registry'].split('.')[0])
    # parameters travel as untyped text, as PGlite sends them, so PostgreSQL infers their types
    cur.execute(g['sql'], [None if p is None else to_string(p) for p in g['params']])
    pg_rows: List[List[Any]] = [[nv(x) for x in r] for r in cur.fetchall()]
    if mode == 'math':
        assert len(pg_rows) == 1 and stringify(nv(mem['value'])) == stringify(pg_rows[0][0])
    else:
        ordered = 'order' in tree['parsed']['items']
        mem_rows = [[nv(x) for x in r] for r in mem['rows']]

        def key(rs: List[List[Any]]) -> str:
            return stringify(rs) if ordered else stringify(sorted(stringify(r) for r in rs))
        assert key(pg_rows) == key(mem_rows)
        assert [d.name for d in cur.description] == mem['columns']
    if ref:
        inline = re.sub(r'\s+', ' ', tcxp.to_sql(tree, inline=True)['sql'])  # type: ignore[index]
        assert inline == ref


def test_cases_cover_the_collection() -> None:
    assert len(CASES) == len(tcxp.QUERIES) + sum(1 for c in tcxp.COVERAGE if c[2] == 'yes')
