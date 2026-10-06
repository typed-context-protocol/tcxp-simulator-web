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
from typing import Any, Dict, Iterator, List

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
                    schema = _schema(reg)
                    c.execute('CREATE SCHEMA ' + schema)
                    c.execute('SET LOCAL search_path TO ' + schema)
                    c.execute(tcxp.full_ddl(reg))
            yield c
    finally:
        conn.close()


def _schema(reg: str) -> str:
    return 'tcxp_test_' + re.sub(r'[^a-z0-9_]', '_', reg)


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
    mode = tree['parsed']['mode']
    if mode == 'write':
        _compare_write(cur, tree, tcxp.parse_uri('@' + uri))
        if ref:
            assert re.sub(r'\s+', ' ', tcxp.to_sql(tcxp.parse_uri('@' + uri), inline=True)['sql']) == ref  # type: ignore[index]
        return
    mem = tcxp.execute(tree, store=tcxp.new_store())
    if mem['kind'] == 'halt' or mode not in ('sql', 'math'):
        return
    g = tcxp.to_sql(tree)
    assert g is not None
    if mode == 'sql':
        cur.execute('SET LOCAL search_path TO ' + _schema(tree['parsed']['registry']))
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


def _rows_of(cur: Any, sql: str) -> List[str]:
    cur.execute(sql)
    return sorted((stringify([nv(x) for x in r]) for r in cur.fetchall()))


def _pg_tables(cur: Any, reg: str) -> Dict[str, List[str]]:
    return {t['name']: _rows_of(cur, 'SELECT * FROM ' + t['name']) for t in tcxp.REGISTRIES[reg]['db']['schema']['tables']}


def _mem_tables(store: Dict[str, Any], reg: str) -> Dict[str, List[str]]:
    return {t['name']: sorted(stringify([nv(x) for x in r]) for r in tcxp.table_rows(reg, t['name'], store))
            for t in tcxp.REGISTRIES[reg]['db']['schema']['tables']}


def _seed_tables(reg: str) -> Dict[str, List[str]]:
    return {t['name']: sorted(stringify([nv(x) for x in r]) for r in tcxp.REGISTRIES[reg]['db']['seed'][t['name']])
            for t in tcxp.REGISTRIES[reg]['db']['schema']['tables']}


def _compare_write(cur: Any, plain: Dict[str, Any], at: Dict[str, Any]) -> None:
    """Port of compareWrite (test/writes-lib.mjs): preview, write and inverse in the engine and in PostgreSQL."""
    reg = at['parsed']['registry']
    cur.execute('SET LOCAL search_path TO ' + _schema(reg))
    err_diag = next((d for d in at['diagnostics'] if d['level'] in ('error', 'refused')), None)
    if err_diag:
        with pytest.raises(tcxp.TcxpError) as e:
            tcxp.execute(at, store=tcxp.new_store())
        assert e.value.code == err_diag.get('code')
        return
    if at['gaps']:
        store = tcxp.new_store()
        assert tcxp.execute(plain, store=store)['kind'] == 'halt' and tcxp.execute(at, store=store)['kind'] == 'halt'
        assert not tcxp.data_changed(store)
        return
    store = tcxp.new_store()
    pv = mem = mem_err = pg_err = None
    try:
        pv = tcxp.execute(plain, store=store)
    except tcxp.TcxpError as e:
        mem_err = e
    assert not tcxp.data_changed(store), 'a preview must not change data'
    if not mem_err:
        try:
            mem = tcxp.execute(at, store=store)
        except tcxp.TcxpError as e:
            mem_err = e
    g = tcxp.to_sql(at)
    assert g is not None
    cur.execute('SAVEPOINT w')
    try:
        cur.execute(g['sql'], [None if x is None else to_string(x) for x in g['params']])
        pg_ret = [[nv(x) for x in r] for r in cur.fetchall()] if cur.description else []
        pg_cols = [d.name for d in cur.description] if cur.description else []
        pg_count = cur.rowcount
    except psycopg.Error as e:
        pg_err = e
    if mem_err or pg_err:
        cur.execute('ROLLBACK TO SAVEPOINT w')
        assert mem_err is not None and pg_err is not None, 'engine: %s; PostgreSQL: %s' % (mem_err, pg_err)
        assert mem_err.code == pg_err.sqlstate, (mem_err.code, pg_err.sqlstate, str(mem_err))
        return
    assert pv is not None and mem is not None
    mem_ret = [[nv(x) for x in r] for r in mem['returning']['rows']]
    assert pv['kind'] == 'preview' and pv['count'] == mem['count']
    assert sorted(stringify([nv(x) for x in r]) for r in pv['returning']['rows']) == sorted(stringify(r) for r in mem_ret)
    assert pg_count == mem['count']
    assert sorted(stringify(r) for r in pg_ret) == sorted(stringify(r) for r in mem_ret)
    if at['parsed']['items'].get('returning'):
        assert pg_cols == mem['returning']['columns']
    assert _pg_tables(cur, reg) == _mem_tables(store, reg)
    for u in mem['inverse']:
        it = tcxp.parse_uri(tcxp.full_address(u))   # an inverse is a bare reference: it runs with a fresh context (R14)
        tcxp.execute(it, store=store)
        ig = tcxp.to_sql(it)
        assert ig is not None
        cur.execute(ig['sql'], [None if x is None else to_string(x) for x in ig['params']])
    assert _pg_tables(cur, reg) == _seed_tables(reg) == _mem_tables(store, reg)
    assert not tcxp.data_changed(store)
    cur.execute('ROLLBACK TO SAVEPOINT w')


@pytest.mark.parametrize('index', range(0, 1000, 1))
def test_generated_write_matches_postgres(cur: Any, index: int, _stream: List[str] = []) -> None:  # noqa: B006
    if not _stream:
        g = tcxp.FilterGenerator(11)
        _stream.extend(g.next_write() for _ in range(1000))
    plain = tcxp.parse_uri(_stream[index])
    _compare_write(cur, plain, tcxp.parse_uri('@' + _stream[index]))


def test_cases_cover_the_collection() -> None:
    assert len(CASES) == len(tcxp.QUERIES) + sum(1 for c in tcxp.COVERAGE if c[2] == 'yes')
