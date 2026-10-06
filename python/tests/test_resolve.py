"""Resolution behaviour that vectors cannot compare byte for byte (OS error texts), and R32: nothing but
resolve() ever fetches."""
from __future__ import annotations

from typing import Any, Dict, Iterator, List

import pytest

import tcxp
from tcxp import engine

EMPTY = '~context={"intent":[],"observe":[],"reason":[],"decide":[],"trace":[]}'


@pytest.fixture
def entry() -> Iterator[str]:
    address = 'tcxp://registry/test/missing'
    tcxp.register_resolvable({'address': address, 'location': 'file:fixtures/no-such-file.md'})
    yield address
    r = tcxp.REGISTRIES['registry']
    r['resolvable'] = [x for x in r['resolvable'] if x['address'] != address]


def test_missing_file_is_a_fetch_failed_error(entry: str) -> None:
    with pytest.raises(tcxp.TcxpError) as e:
        tcxp.resolve(entry)
    assert e.value.code == 'fetch-failed'
    assert str(e.value).startswith('Fetching file:fixtures/no-such-file.md for ' + entry + ' failed: ')


def test_fixtures_ship_inside_the_package() -> None:
    for e in tcxp.list_resolvable():
        assert tcxp.resolve(e['address']).startswith('# ')


def test_nothing_but_resolve_fetches(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: List[str] = []

    def spy(location: str, opts: Dict[str, Any]) -> str:
        calls.append(location)
        return 'content'
    monkeypatch.setattr(engine, '_default_fetcher', spy)
    for ref in ['tcxp://firm.demo/rules/tax-year', 'tcxp://fleet.demo/env/sea-route']:
        address = ref + '?k=v&' + EMPTY
        tree = tcxp.parse_uri(address)
        tcxp.serialize(tree)
        tcxp.identity(tree)
        tcxp.to_json(tree)
        tcxp.from_json(tcxp.to_json(tree))
        tcxp.strict_form(address)
        tcxp.query(tree, 'references')
        tcxp.execute(tree)
        tcxp.FilterGenerator.filter(address)
        tcxp.edit(address, [{'op': 'context', 'key': 'observe', 'value': [ref]}], at='2026-10-06T00:00:00.000Z')
        tcxp.list_resolvable()
        # a reference in the context is never resolved by reading
        tcxp.parse_uri('!tcxp:/registry/notes/equation?~context={"intent":[],"observe":["' + ref + '"],"reason":[],"decide":[],"trace":[]}')
    assert calls == []
    assert tcxp.resolve('tcxp://firm.demo/rules/tax-year') == 'content'
    assert calls == ['file:fixtures/firm-tax-year.md']


def test_injected_fetcher_gets_location_and_base() -> None:
    seen: List[Any] = []
    out = tcxp.resolve('tcxp://firm.demo/rules/tax-year', fetcher=lambda loc, o: seen.append((loc, o)) or 'text', base='/b')
    assert out == 'text' and seen == [('file:fixtures/firm-tax-year.md', {'base': '/b'})]
