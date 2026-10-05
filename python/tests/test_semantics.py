"""The JavaScript semantics layer (tcxp._js) against values computed by Node (vectors/semantics.json)."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from tcxp import _js

SEM = json.loads((Path(__file__).resolve().parent.parent / 'vectors' / 'semantics.json').read_text(encoding='utf-8'))


def num(x: Any) -> Any:
    """Decode the exporter's number encoding (non-finite values and -0 travel as strings)."""
    if isinstance(x, str):
        return {'-0': -0.0, 'NaN': float('nan'), 'Infinity': float('inf'), '-Infinity': float('-inf')}[x]
    return _js.norm(x)


def same(a: Any, b: Any) -> bool:
    if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
        return True
    if a == 0 and b == 0:
        return math.copysign(1, a) == math.copysign(1, b)
    return a == b and type(a) is type(b)


@pytest.mark.parametrize('x,text', SEM['numbers'])
def test_number_to_string(x: Any, text: str) -> None:
    assert _js.num_to_str(num(x)) == text


@pytest.mark.parametrize('x,expected', SEM['round'])
def test_math_round(x: Any, expected: Any) -> None:
    assert same(_js.js_round(num(x)), num(expected))


@pytest.mark.parametrize('a,b,expected', SEM['pow'])
def test_math_pow(a: Any, b: Any, expected: Any) -> None:
    assert same(_js.js_pow(num(a), num(b)), num(expected))


@pytest.mark.parametrize('src,message,result', SEM['json'])
def test_json_parse(src: str, message: Any, result: Any) -> None:
    if message is None:
        assert _js.stringify(_js.parse_json(src)) == result
    else:
        with pytest.raises(_js.JSONSyntaxError) as e:
            _js.parse_json(src)
        assert str(e.value) == message


@pytest.mark.parametrize('s,expected', SEM['dates'])
def test_date_parse(s: str, expected: Any) -> None:
    assert same(_js.date_parse(s), num(expected))


@pytest.mark.parametrize('s,expected', SEM['decode'])
def test_decode_uri_component(s: str, expected: Any) -> None:
    if expected is None:
        with pytest.raises(_js.URIError):
            _js.decode_uri_component(s)
    else:
        assert _js.decode_uri_component(s) == expected


@pytest.mark.parametrize('s,expected', SEM['to_number'])
def test_to_number(s: str, expected: Any) -> None:
    assert same(_js.to_number(s), num(expected))


@pytest.mark.parametrize('a,b,a_lt_b,b_lt_a', SEM['compare'])
def test_less_than(a: Any, b: Any, a_lt_b: bool, b_lt_a: bool) -> None:
    assert _js.lt(a, b) is a_lt_b and _js.lt(b, a) is b_lt_a


@pytest.mark.parametrize('args,iso', SEM['utc'])
def test_date_utc_iso(args: Any, iso: str) -> None:
    assert _js.iso_string(_js.utc_ms(*args)) == iso
