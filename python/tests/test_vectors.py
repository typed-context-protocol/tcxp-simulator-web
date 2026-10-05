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


def _lines(name: str) -> List[str]:
    path = VECTORS / name
    opener: Callable[..., Any] = gzip.open if name.endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as f:
        return [line.rstrip('\n') for line in f if line.strip()]


def _err(e: BaseException) -> Dict[str, Any]:
    return {'error': str(e), 'type': type(e).__name__, 'where': getattr(e, 'where', None)}


def _attempt(f: Callable[[], Any]) -> Any:
    try:
        return f()
    except Exception as e:  # noqa: BLE001 - recorded, like the JS exporter
        return _err(e)


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
    rec['strict'] = _attempt(lambda: tcxp.strict_form(uri))
    rec['slots'] = tree['slots']
    rec['gaps'] = tree['gaps']
    rec['diagnostics'] = tree['diagnostics']
    rec['spikes'] = [{'id': s['id'], 'on': s['on'], 'bits': s['bits'], 'data': s['data'], 'problems': s['problems'],
                      'facets': s['facets'], 'targets': [{'ptr': t['ptr'], 'count': len(t['nodes'])} for t in s['targets']]}
                     for s in tree['spikes']]
    rec['json'] = tcxp.to_json(tree)
    rec['sql'] = _attempt(lambda: tcxp.to_sql(tree))
    rec['sql_inline'] = _attempt(lambda: tcxp.to_sql(tree, inline=True))
    rec['math'] = tcxp.to_math(tree, False)
    rec['math_written'] = tcxp.to_math(tree, True)
    rec['execute'] = _attempt(lambda: tcxp.execute(tree))
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
        out = tcxp.with_pulse(tree, exp['step'], exp['at'], exp['debounce'], exp['parent'])
        reparsed = tcxp.parse_uri(out)
        return {'uri': exp['uri'], 'step': exp['step'], 'at': exp['at'], 'debounce': exp['debounce'], 'parent': exp['parent'],
                'out': out, 'out_identity': tcxp.identity(reparsed),
                'out_pulse': next(m for m in reparsed['parsed']['meta'] if m[0] == 'pulse')[1]}
    _check('pulse.jsonl', build)


def test_pulse_chain_parents() -> None:
    recs = [json.loads(line) for line in _lines('pulse.jsonl')]
    for prev, cur in zip(recs, recs[1:]):
        if cur['parent'] is not None:
            assert cur['parent'] == tcxp.identity(tcxp.parse_uri(prev['uri']))
        assert cur['out_pulse'][0]['parent'] == cur['parent']


def test_constants() -> None:
    exp = json.loads(_lines('constants.json')[0])
    registries = {}
    for name, reg in tcxp.REGISTRIES.items():
        registries[name] = {'title': reg['title'], 'description': reg['description'], 'db': reg.get('db'), 'notes': reg['notes'],
                            'fns': {p: {'params': f['params'], 'returns': f['returns'], 'doc': f['doc']} for p, f in reg['fns'].items()}}
    actual = {'registries': registries, 'queries': tcxp.QUERIES, 'groups': tcxp.GROUPS, 'coverage': tcxp.COVERAGE,
              'ops': tcxp.OPS, 'clauses': tcxp.CLAUSES, 'clause_order': tcxp.CLAUSE_ORDER, 'rules': tcxp.RULES,
              'facets': tcxp.FACETS, 'scheme': tcxp.SCHEME, 'debounce_ms': tcxp.DEBOUNCE_MS,
              'ddl': {r: tcxp.full_ddl(r) for r in tcxp.REGISTRIES if tcxp.REGISTRIES[r].get('db')},
              'base_type': [[t, tcxp.base_type(t)] for t in ['numeric(3,2)', 'integer', 'text', None, 'varchar(10)', 'a(b)(c)']]}
    for k in exp:
        assert stringify(actual[k]) == stringify(exp[k]), k
    assert stringify(actual) == _lines('constants.json')[0]


@pytest.mark.parametrize('seed', [1, 7, 42, -3, 2 ** 31, 0])
def test_generator_is_deterministic(seed: int) -> None:
    assert tcxp.FilterGenerator(seed).batch(50) == tcxp.FilterGenerator(seed).batch(50)
