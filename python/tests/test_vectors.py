"""Conformance: reproduce every field of every vector exported from tcxp.js, byte for byte.

Each vector line is JSON.stringify(record) from python/tools/export_vectors.mjs. The Python engine
builds the same record and serializes it with a port of JSON.stringify; the two strings must match.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any, Callable, Dict, List

import pytest

import tcxp
from tcxp._js import stringify

VECTORS = Path(__file__).resolve().parent.parent / 'vectors'
EMPTY = '~context={"intent":[],"observe":[],"reason":[],"decide":[],"trace":[]}'
RESOLVABLE_AT_START = tcxp.list_resolvable()   # the demo entries, before any test registers more


def full(u: str) -> str:
    return u + ('&' if '?' in u else '?') + EMPTY


def _lines(name: str) -> List[str]:
    path = VECTORS / name
    opener: Callable[..., Any] = gzip.open if name.endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as f:
        return [line.rstrip('\n') for line in f if line.strip()]


def _err(e: BaseException) -> Dict[str, Any]:
    return {'error': str(e), 'type': type(e).__name__, 'where': getattr(e, 'where', None), 'code': getattr(e, 'code', None)}


def _attempt(f: Callable[[], Any]) -> Any:
    try:
        return f()
    except Exception as e:  # noqa: BLE001 - recorded, like the JS exporter
        return _err(e)


def _query_set(tree: Dict[str, Any]) -> List[Any]:
    sels = ['gaps', 'variables', 'references', 'operators', 'annotations', 'operators:eq', 'references:', 'pointer:/nope',
            'pointer:/~context/intent', 'pointer:/~context/intent/0', 'pointer:/~context/observe/0', 'pointer:/~context/trace/0',
            'pointer:/~context/nope', 'pointer:/~context/observe/99', 'pointer:/~context/observe/0/on']
    labels: List[str] = []
    for r in tcxp.query(tree, 'references'):
        if r['label'] not in labels:
            labels.append(r['label'])
    sels += ['references:' + label for label in labels]
    nodes = tcxp.query(tree, 'variables') + tcxp.query(tree, 'operators')
    if nodes:
        sels.append('pointer:' + nodes[0]['pointer'])
    return [[sel, _attempt(lambda sel=sel: tcxp.query(tree, sel))] for sel in sels]


def _json_roundtrip(v: Any) -> Any:
    return json.loads(stringify(v))


def fields(uri: str) -> Dict[str, Any]:
    """The Python twin of fields() in export_vectors.mjs."""
    rec: Dict[str, Any] = {'uri': uri}
    f = tcxp.FilterGenerator.filter(uri)
    rec['filter'] = {'ok': f['ok'], 'rules': [[r['id'], r['pass'], r['msg']] for r in f['rules']]}
    try:
        tree = tcxp.parse_uri(uri)
    except Exception as e:  # noqa: BLE001
        rec['parse'] = _err(e)
        return rec
    rec['canonical'] = tcxp.serialize(tree)['uri']
    rec['identity'] = tcxp.identity(tree)
    rec['fingerprint'] = _attempt(lambda: tcxp.fingerprint(uri))
    rec['strict'] = _attempt(lambda: tcxp.strict_form(uri))
    rec['slots'] = tree['slots']
    rec['gaps'] = tree['gaps']
    rec['diagnostics'] = tree['diagnostics']
    rec['spikes'] = [{'id': s['id'], 'on': s['on'], 'bits': s['bits'], 'data': s['data'], 'problems': s['problems'],
                      'facets': s['facets'], 'targets': [{'ptr': t['ptr'], 'count': len(t['nodes'])} for t in s['targets']]}
                     for s in tree['spikes']]
    rec['json'] = tcxp.to_json(tree)
    rec['from_json'] = _attempt(lambda: tcxp.serialize(tcxp.from_json(_json_roundtrip(tcxp.to_json(tree))))['uri'])
    rec['query'] = _query_set(tree)
    rec['sql'] = _attempt(lambda: tcxp.to_sql(tree))
    rec['sql_inline'] = _attempt(lambda: tcxp.to_sql(tree, inline=True))
    rec['math'] = tcxp.to_math(tree, False)
    rec['math_written'] = tcxp.to_math(tree, True)
    rec['execute'] = _attempt(lambda: tcxp.execute(tree, store=tcxp.new_store()))
    return rec


def _diff(expected_line: str, actual: Dict[str, Any]) -> str:
    """Which top-level fields differ, for a readable failure."""
    exp = json.loads(expected_line)
    bad = [k for k in list(exp) + [k for k in actual if k not in exp]
           if stringify(exp.get(k)) != stringify(actual.get(k))]
    parts = []
    for k in bad[:4]:
        parts.append('  %s:\n    js: %s\n    py: %s' % (k, stringify(exp.get(k))[:400], stringify(actual.get(k))[:400]))
    return '\n'.join(parts) or '  (key order or encoding differs)'


def _check(name: str, build: Callable[[Dict[str, Any], int], Dict[str, Any]]) -> None:
    lines = _lines(name)
    failures = []
    for i, line in enumerate(lines):
        exp = json.loads(line)
        actual = build(exp, i)
        if stringify(actual) != line:
            failures.append('line %d (%s):\n%s' % (i + 1, exp.get('id', exp.get('index', '')), _diff(line, actual)))
    print('\n%s: %d passed, %d failed' % (name, len(lines) - len(failures), len(failures)))
    assert not failures, '%d of %d vectors differ in %s\n%s' % (len(failures), len(lines), name, '\n'.join(failures[:10]))


def test_collection() -> None:
    def build(exp: Dict[str, Any], i: int) -> Dict[str, Any]:
        return {'source': exp['source'], 'id': exp['id'], **fields(exp['uri'])}
    _check('collection.jsonl', build)


def test_collection_covers_every_address() -> None:
    uris = [json.loads(line)['uri'] for line in _lines('collection.jsonl')]
    assert uris == [q['uri'] for q in tcxp.QUERIES] + [c[3] for c in tcxp.COVERAGE if c[3]]


def test_generated_seed_7() -> None:
    gen = tcxp.FilterGenerator(7)

    def build(exp: Dict[str, Any], i: int) -> Dict[str, Any]:
        assert exp['index'] == i
        return {'seed': 7, 'index': i, **fields(gen.next())}
    _check('generated.jsonl.gz', build)


def test_errors() -> None:
    _check('errors.jsonl', lambda exp, i: {'id': exp['id'], **fields(exp['uri'])})


def test_pulse() -> None:
    def build(exp: Dict[str, Any], i: int) -> Dict[str, Any]:
        tree = tcxp.parse_uri(exp['uri'])
        out = tcxp.with_pulse(tree, exp['step'], exp['at'], exp['debounce'], exp['parent'], exp['extra'])
        reparsed = tcxp.parse_uri(out)
        return {'uri': exp['uri'], 'step': exp['step'], 'at': exp['at'], 'debounce': exp['debounce'], 'parent': exp['parent'],
                'extra': exp['extra'],
                'out': out, 'out_identity': tcxp.identity(reparsed), 'out_trace': reparsed['parsed']['context']['trace']}
    _check('pulse.jsonl', build)


def test_pulse_chain_parents() -> None:
    recs = [json.loads(line) for line in _lines('pulse.jsonl')]
    for prev, cur in zip(recs, recs[1:]):
        if cur['parent'] is not None:
            assert cur['parent'] == tcxp.fingerprint(prev['uri'])
        assert cur['out_trace'][0]['parent'] == cur['parent']


def test_constants() -> None:
    exp = json.loads(_lines('constants.json')[0])
    registries = {}
    for name, reg in tcxp.REGISTRIES.items():
        registries[name] = {'title': reg['title'], 'description': reg['description'], 'db': reg.get('db'), 'notes': reg['notes'],
                            'fns': {p: {'params': f['params'], 'returns': f['returns'], 'doc': f['doc']} for p, f in reg['fns'].items()}}
    actual = {'registries': registries, 'queries': tcxp.QUERIES, 'write_clauses': tcxp.WRITE_CLAUSES, 'write_order': tcxp.WRITE_ORDER, 'groups': tcxp.GROUPS, 'coverage': tcxp.COVERAGE,
              'ops': tcxp.OPS, 'clauses': tcxp.CLAUSES, 'clause_order': tcxp.CLAUSE_ORDER, 'rules': tcxp.RULES,
              'facets': tcxp.FACETS, 'scheme': tcxp.SCHEME, 'debounce_ms': tcxp.DEBOUNCE_MS,
              'resolvable_scheme': tcxp.RESOLVABLE, 'context_keys': tcxp.CONTEXT_KEYS, 'resolvable': RESOLVABLE_AT_START,
              'ddl': {r: tcxp.full_ddl(r) for r in tcxp.REGISTRIES if tcxp.REGISTRIES[r].get('db')},
              'base_type': [[t, tcxp.base_type(t)] for t in ['numeric(3,2)', 'integer', 'text', None, 'varchar(10)', 'a(b)(c)']]}
    for k in exp:
        assert stringify(actual[k]) == stringify(exp[k]), k
    assert stringify(actual) == _lines('constants.json')[0]


def _write_record(uri: str) -> Dict[str, Any]:
    rec = fields(uri)
    if 'parse' in rec:
        return rec
    st = tcxp.new_store()
    try:
        rec['perform'] = tcxp.execute(tcxp.parse_uri(uri if uri.startswith('@') else '@' + uri), store=st)
    except Exception as e:  # noqa: BLE001
        rec['perform'] = _err(e)
        rec['changed'] = tcxp.data_changed(st)
        return rec
    rec['changed'] = tcxp.data_changed(st)
    rec['undo'] = [_attempt(lambda inv=inv: tcxp.execute(tcxp.parse_uri(tcxp.full_address(inv)), store=st)['kind'])
                   for inv in rec['perform'].get('inverse') or []]
    rec['restored'] = not tcxp.data_changed(st)
    return rec


def test_writes() -> None:
    gen = tcxp.FilterGenerator(11)

    def build(exp: Dict[str, Any], i: int) -> Dict[str, Any]:
        if exp['source'] == 'query':
            q = next(q for q in tcxp.QUERIES if q['id'] == exp['id'])
            return {'source': 'query', 'id': exp['id'], **_write_record(q['uri'])}
        return {'source': 'nextWrite', 'seed': 11, 'index': exp['index'], **_write_record(gen.next_write())}
    _check('writes.jsonl.gz', build)


def test_edits() -> None:
    def build(exp: Dict[str, Any], i: int) -> Dict[str, Any]:
        opts = exp['opts'] or {}
        try:
            r = tcxp.edit(exp['uri'], exp['ops'], pulse=opts.get('pulse', True) is not False, at=opts.get('at'))
            out = {'uri': r['uri'], 'identity': tcxp.identity(r['tree']), 'gaps': r['tree']['gaps']}
        except Exception as e:  # noqa: BLE001
            out = _err(e)
        return {'uri': exp['uri'], 'ops': exp['ops'], 'opts': exp['opts'], 'out': out}
    _check('edits.jsonl.gz', build)


def test_csv() -> None:
    def build(exp: Dict[str, Any], i: int) -> Dict[str, Any]:
        reg, table = exp['registry'], exp['table']
        existed = reg in tcxp.REGISTRIES
        rec: Dict[str, Any] = {'registry': reg, 'table': table, 'csv': exp['csv'], 'types': exp['types']}
        try:
            rec['def'] = tcxp.register_csv(reg, table, exp['csv'], exp['types'])
            rec['seed'] = tcxp.REGISTRIES[reg]['db']['seed'][table]
            r = tcxp.REGISTRIES[reg]
            rec['registry_after'] = {'title': r['title'], 'description': r['description'], 'tables': [t['name'] for t in r['db']['schema']['tables']]}
            rec['ddl'] = tcxp.full_ddl(reg)
            rec['select'] = _attempt(lambda: tcxp.execute(tcxp.parse_uri('!tcxp:/' + reg + '/sql/select?cols=*&from=' + table + '&order=asc(row_id)&' + EMPTY),
                                                          store=tcxp.new_store()))
        except Exception as e:  # noqa: BLE001
            rec['error'] = _err(e)
        if not existed:
            tcxp.REGISTRIES.pop(reg, None)
        elif 'def' in rec:
            db = tcxp.REGISTRIES[reg]['db']
            db['schema']['tables'] = [t for t in db['schema']['tables'] if t['name'] != table]
            db['seed'].pop(table, None)
        return rec
    _check('csv.jsonl', build)


def test_names() -> None:
    _check('names.jsonl', lambda exp, i: {'name': exp['name'], 'position': exp['position'], **fields(exp['uri'])})


class _Boom(Exception):
    pass


def _fetchers() -> Dict[str, Callable[[str, Dict[str, Any]], Any]]:
    def boom(loc: str, o: Dict[str, Any]) -> Any:
        raise _Boom('boom')
    return {'echo': lambda loc, o: 'fetched ' + loc + ' base=' + ('undefined' if o.get('base') is None else o['base']),
            'boom': boom, 'number': lambda loc, o: 5}


def test_registry() -> None:
    fetchers = _fetchers()
    added: List[str] = []

    def run(f: Callable[[], Any]) -> Dict[str, Any]:
        try:
            return {'ok': f()}
        except Exception as e:  # noqa: BLE001
            return _err(e)

    def build(exp: Dict[str, Any], i: int) -> Dict[str, Any]:
        what, args = exp['what'], exp['args']
        if what == 'fullAddress':
            out = run(lambda: tcxp.full_address(args[0]) if args[1] is None else tcxp.full_address(args[0], args[1]))
        elif what == 'fingerprint':
            out = run(lambda: tcxp.fingerprint(args[0]))
        elif what in ('storeAddress', 'storeAddress again'):
            out = run(lambda: tcxp.store_address(args[0]))
        elif what == 'lookupAddress':
            out = run(lambda: tcxp.lookup_address(args[0]))
        elif what == 'registerResolvable':
            def reg() -> None:
                tcxp.register_resolvable(args[0])
            out = run(reg)
            if 'ok' in out:
                added.extend(e['address'] for e in (args[0] if isinstance(args[0], list) else [args[0]]))
        elif what == 'listResolvable':
            out = run(lambda: tcxp.list_resolvable(args[0]))
        elif what == 'execute':
            out = run(lambda: tcxp.execute(tcxp.parse_uri(args[0])))
        elif what == 'resolve':
            out = run(lambda: tcxp.resolve(args[0], fetcher=fetchers[args[1]] if args[1] else None, base=args[2]))
        else:
            raise AssertionError(what)
        return {'what': what, 'args': args, 'out': out}
    try:
        _check('registry.jsonl', build)
    finally:
        for r in tcxp.REGISTRIES.values():
            if 'resolvable' in r:
                r['resolvable'] = [x for x in r['resolvable'] if x['address'] not in added]
            r.pop('addresses', None)


@pytest.mark.parametrize('seed', [1, 7, 42, -3, 2 ** 31, 0])
def test_generator_is_deterministic(seed: int) -> None:
    assert tcxp.FilterGenerator(seed).batch(50) == tcxp.FilterGenerator(seed).batch(50)
