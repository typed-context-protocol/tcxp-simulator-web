"""JavaScript value semantics the engine depends on, so Python output matches tcxp.js exactly.

JavaScript has one number type (IEEE-754 double). Here a number is an ``int`` when it is a whole
number within +/-2**53 and a ``float`` otherwise; ``norm`` restores that after every arithmetic step.
Strings are compared and indexed in UTF-16 code units where JavaScript does so.
"""
from __future__ import annotations

import calendar
import math
import re
import time
from datetime import datetime, timezone
from typing import Any, List, NoReturn, Optional, Tuple

NAN = float('nan')
INF = float('inf')
SAFE = 2 ** 53


class URIError(ValueError):
    """Raised where JavaScript raises URIError (strict_form of a non-BMP or lone-surrogate character)."""


# ---------------------------------------------------------------- numbers
def is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def norm(x: Any) -> Any:
    """Canonical Python form of a JS number: int when whole and safe, float otherwise (-0 stays float)."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return x
    if isinstance(x, int):
        return x if -SAFE <= x <= SAFE else norm(float(x))
    if x.is_integer() and abs(x) <= SAFE and not (x == 0 and math.copysign(1.0, x) < 0):
        return int(x)
    return x


def is_integer(x: Any) -> bool:
    """Number.isInteger."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return False
    return isinstance(x, int) or (math.isfinite(x) and x.is_integer())


def num_to_str(x: Any) -> str:
    """Number.prototype.toString() (radix 10)."""
    if isinstance(x, int) and not isinstance(x, bool):
        if abs(x) < 10 ** 21:
            return str(x)
        x = float(x)
    if x != x:
        return 'NaN'
    if x == INF:
        return 'Infinity'
    if x == -INF:
        return '-Infinity'
    if x == 0:
        return '0'
    sign = '-' if x < 0 else ''
    r = repr(abs(x))
    mant, _, exp_s = r.partition('e')
    exp = int(exp_s) if exp_s else 0
    ip, _, fp = mant.partition('.')
    raw = ip + fp
    digits = raw.lstrip('0')
    stripped = digits.rstrip('0')
    tz = len(digits) - len(stripped)
    digits = stripped
    k = len(digits)
    n = k + exp - len(fp) + tz
    if k <= n <= 21:
        return sign + digits + '0' * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + '.' + digits[n:]
    if -6 < n <= 0:
        return sign + '0.' + '0' * (-n) + digits
    e = n - 1
    es = ('+' if e >= 0 else '-') + str(abs(e))
    if k == 1:
        return sign + digits + 'e' + es
    return sign + digits[0] + '.' + digits[1:] + 'e' + es


_WS = '\t\n\x0b\x0c\r \xa0                　﻿'


def trim(s: str) -> str:
    """String.prototype.trim (JavaScript's whitespace set, not Python's)."""
    return s.strip(_WS)


_DEC = re.compile(r'[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)')


def string_to_number(s: str) -> Any:
    t = trim(s)
    if t == '':
        return 0
    if _DEC.fullmatch(t):
        if t.endswith('Infinity'):
            return -INF if t[0] == '-' else INF
        return norm(float(t))
    m = re.fullmatch(r'0([xXoObB])([0-9a-fA-F]+)', t)
    if m:
        base = {'x': 16, 'o': 8, 'b': 2}[m.group(1).lower()]
        try:
            return norm(int(m.group(2), base))
        except ValueError:
            return NAN
    return NAN


def to_number(v: Any) -> Any:
    """Number(v)."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        return string_to_number(v)
    if isinstance(v, list):
        return string_to_number(to_string(v))
    return NAN


def to_string(v: Any) -> str:
    """String(v)."""
    if v is None:
        return 'null'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, (int, float)):
        return num_to_str(v)
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return ','.join('' if x is None else to_string(x) for x in v)
    return '[object Object]'


def truthy(v: Any) -> bool:
    if v is None or v is False:
        return False
    if v is True:
        return True
    if isinstance(v, (int, float)):
        return v == v and v != 0
    if isinstance(v, str):
        return v != ''
    return True


def to_int32(x: Any) -> int:
    n = to_number(x)
    if isinstance(n, float):
        if not math.isfinite(n):
            return 0
        n = math.trunc(n)
    n &= 0xFFFFFFFF
    return n - 0x100000000 if n >= 0x80000000 else n


def u32(x: int) -> int:
    return x & 0xFFFFFFFF


def i32(x: int) -> int:
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x >= 0x80000000 else x


def imul(a: int, b: int) -> int:
    return i32((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF))


def js_round(x: Any) -> Any:
    """Math.round: halves round toward +Infinity."""
    x = to_number(x)
    if isinstance(x, int):
        return x
    if not math.isfinite(x) or x == 0:
        return x
    f = math.floor(x)
    r = f + 1 if x - f >= 0.5 else f
    if r == 0 and x < 0:
        return -0.0
    return norm(r)


def js_sign(x: Any) -> Any:
    x = to_number(x)
    if x != x:
        return NAN
    if x > 0:
        return 1
    if x < 0:
        return -1
    return x


def js_pow(a: Any, b: Any) -> Any:
    """Math.pow, including the cases where Python's math.pow raises or differs."""
    a = to_number(a)
    b = to_number(b)
    if b != b:
        return NAN
    if b == 0:
        return 1
    if a != a:
        return NAN
    if abs(a) == 1 and math.isinf(b):
        return NAN
    try:
        return norm(math.pow(a, b))
    except OverflowError:
        neg = a < 0 and is_integer(b) and int(b) % 2 == 1
        return -INF if neg else INF
    except (ValueError, ZeroDivisionError):
        if a == 0:
            neg = math.copysign(1.0, float(a)) < 0 and is_integer(b) and int(b) % 2 == 1
            return -INF if neg else INF
        return NAN


def num_add(a: Any, b: Any) -> Any:
    return norm(a + b)


def num_sub(a: Any, b: Any) -> Any:
    return norm(a - b)


def num_mul(a: Any, b: Any) -> Any:
    if isinstance(a, int) and isinstance(b, int):
        return norm(a * b)
    return norm(float(a) * float(b))


def num_div(a: Any, b: Any) -> Any:
    if b == 0:
        if a != a or a == 0:
            return NAN
        neg = (a < 0) != (math.copysign(1.0, float(b)) < 0)
        return -INF if neg else INF
    return norm(a / b)


# ---------------------------------------------------------------- strings (UTF-16)
def u16(s: str) -> str:
    """The string as UTF-16 code units (astral characters become surrogate pairs)."""
    if all(ord(c) <= 0xFFFF for c in s):
        return s
    out = []
    for c in s:
        o = ord(c)
        if o > 0xFFFF:
            o -= 0x10000
            out.append(chr(0xD800 + (o >> 10)))
            out.append(chr(0xDC00 + (o & 0x3FF)))
        else:
            out.append(c)
    return ''.join(out)


def from_u16(s: str) -> str:
    """Combine surrogate pairs back into code points (lone surrogates stay)."""
    if not any(0xD800 <= ord(c) <= 0xDFFF for c in s):
        return s
    return s.encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'surrogatepass')


def u16_len(s: str) -> int:
    return sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def first_unit(c: str) -> str:
    """The first UTF-16 code unit of a character (what JavaScript sees as src[i])."""
    o = ord(c)
    if o > 0xFFFF:
        return chr(0xD800 + ((o - 0x10000) >> 10))
    return c


def lt(a: Any, b: Any) -> bool:
    """The abstract relational comparison a < b for primitives."""
    if isinstance(a, str) and isinstance(b, str):
        return u16(a) < u16(b)
    x, y = to_number(a), to_number(b)
    if x != x or y != y:
        return False
    return x < y


# ---------------------------------------------------------------- URI coding
_HEX = '0123456789abcdefABCDEF'


def _hex_byte(s: str, i: int) -> int:
    if i + 2 >= len(s):
        raise URIError('URI malformed')
    h = s[i + 1:i + 3]
    if h[0] not in _HEX or h[1] not in _HEX:
        raise URIError('URI malformed')
    return int(h, 16)


def decode_uri_component(s: str) -> str:
    out: List[str] = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c != '%':
            out.append(c)
            i += 1
            continue
        b = _hex_byte(s, i)
        i += 3
        if b < 0x80:
            out.append(chr(b))
            continue
        if b & 0xE0 == 0xC0:
            cnt = 2
        elif b & 0xF0 == 0xE0:
            cnt = 3
        elif b & 0xF8 == 0xF0:
            cnt = 4
        else:
            raise URIError('URI malformed')
        bs = [b]
        for _ in range(cnt - 1):
            if i >= n or s[i] != '%':
                raise URIError('URI malformed')
            bb = _hex_byte(s, i)
            if bb & 0xC0 != 0x80:
                raise URIError('URI malformed')
            bs.append(bb)
            i += 3
        try:
            out.append(bytes(bs).decode('utf-8'))
        except UnicodeDecodeError:
            raise URIError('URI malformed') from None
    return ''.join(out)


def encode_uri_component_char(c: str) -> str:
    o = ord(c)
    if o > 0xFFFF or 0xD800 <= o <= 0xDFFF:
        raise URIError('URI malformed')
    return ''.join('%%%02X' % b for b in c.encode('utf-8'))


# ---------------------------------------------------------------- JSON.stringify
_ESC = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t'}


def _quote(s: str) -> str:
    s = from_u16(s)
    out = ['"']
    for c in s:
        o = ord(c)
        if c in _ESC:
            out.append(_ESC[c])
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF:
            out.append('\\u%04x' % o)
        else:
            out.append(c)
    out.append('"')
    return ''.join(out)


def _is_index(k: str) -> bool:
    return (k == '0' or (k[:1] in '123456789' and k.isdigit() and k.isascii())) and k != '' and int(k) < 4294967295


def object_keys(d: dict) -> List[str]:
    """Own enumerable string keys in JavaScript order: array indices ascending, then insertion order."""
    idx = sorted((k for k in d if _is_index(k)), key=int)
    return idx + [k for k in d if not _is_index(k)]


def stringify(v: Any) -> str:
    """JSON.stringify(v) with no replacer or indentation."""
    if v is None:
        return 'null'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, (int, float)):
        return num_to_str(v) if (isinstance(v, int) or math.isfinite(v)) else 'null'
    if isinstance(v, str):
        return _quote(v)
    if isinstance(v, (list, tuple)):
        return '[' + ','.join('null' if callable(x) else stringify(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{' + ','.join(_quote(k) + ':' + stringify(v[k]) for k in object_keys(v) if not callable(v[k])) + '}'
    raise TypeError('cannot stringify ' + type(v).__name__)


# ---------------------------------------------------------------- JSON.parse (V8 messages)
class JSONSyntaxError(ValueError):
    pass


_SPECIAL = ('[object Object]', 'undefined', 'Infinity', 'NaN')


class _JsonParser:
    def __init__(self, source: str) -> None:
        self.orig = source
        self.s = u16(source)
        self.i = 0
        self.n = len(self.s)

    # error reporting, following V8's JsonParser::ReportUnexpectedToken
    def _loc(self) -> str:
        line, last, j = 1, 0, 0
        while j < self.i:
            c = self.s[j]
            if c == '\r' and j < self.i - 1 and self.s[j + 1] == '\n':
                j += 1
                c = '\n'
            if c in '\r\n':
                line += 1
                last = j + 1
            j += 1
        col = 1 + j - last
        return 'in JSON at position %d (line %d column %d)' % (self.i, line, col)

    @staticmethod
    def _token(c: Optional[str]) -> str:
        if c is None:
            return 'EOS'
        if c == '"':
            return 'STRING'
        if c == '-' or '0' <= c <= '9':
            return 'NUMBER'
        if c in ' \t\r\n':
            return 'WHITESPACE'
        return {'{': 'LBRACE', '}': 'RBRACE', '[': 'LBRACK', ']': 'RBRACK', 't': 'TRUE', 'f': 'FALSE',
                'n': 'NULL', ':': 'COLON', ',': 'COMMA'}.get(c, 'ILLEGAL')

    def fail(self, token: Optional[str] = None, message: Optional[str] = None) -> NoReturn:
        if token is None:
            token = self._token(self.peek_raw())
        if message is not None:
            loc = self._loc()
            # this one template reads "after JSON at position", without "in JSON"
            raise JSONSyntaxError(message + ' ' + (loc[8:] if message.endswith('after JSON') else loc))
        if token == 'EOS':
            raise JSONSyntaxError('Unexpected end of JSON input')
        if token == 'NUMBER':
            raise JSONSyntaxError('Unexpected number ' + self._loc())
        if token == 'STRING':
            raise JSONSyntaxError('Unexpected string ' + self._loc())
        if self.s in _SPECIAL:
            raise JSONSyntaxError('"%s" is not valid JSON' % self.orig)
        ch = self.s[self.i]
        length, pos, ctx = self.n, self.i, 10
        if length < ctx * 2 + 1:
            raise JSONSyntaxError("Unexpected token '%s', \"%s\" is not valid JSON" % (from_u16(ch), self.orig))
        if pos < ctx:
            sub, fmt = self.s[0:pos + ctx], "Unexpected token '%s', \"%s\"... is not valid JSON"
        elif pos < length - ctx:
            sub, fmt = self.s[pos - ctx:pos + ctx], "Unexpected token '%s', ...\"%s\"... is not valid JSON"
        else:
            sub, fmt = self.s[pos - ctx:], "Unexpected token '%s', ...\"%s\" is not valid JSON"
        raise JSONSyntaxError(fmt % (from_u16(ch), from_u16(sub)))

    def peek_raw(self) -> Optional[str]:
        return self.s[self.i] if self.i < self.n else None

    def skip_ws(self) -> None:
        while self.i < self.n and self.s[self.i] in ' \t\r\n':
            self.i += 1

    def peek(self) -> str:
        self.skip_ws()
        return self._token(self.peek_raw())

    def parse(self) -> Any:
        v = self.value()
        self.skip_ws()
        if self.i < self.n:
            self.fail(message='Unexpected non-whitespace character after JSON')
        return v

    def value(self) -> Any:
        tok = self.peek()
        if tok == 'STRING':
            return self.string()
        if tok == 'NUMBER':
            return self.number()
        if tok == 'LBRACE':
            return self.obj()
        if tok == 'LBRACK':
            return self.arr()
        if tok == 'TRUE':
            return self.literal('true', True)
        if tok == 'FALSE':
            return self.literal('false', False)
        if tok == 'NULL':
            return self.literal('null', None)
        self.fail(tok)

    def literal(self, word: str, val: Any) -> Any:
        remaining = self.n - self.i
        if remaining >= len(word) and self.s[self.i:self.i + len(word)] == word:
            self.i += len(word)
            return val
        self.i += 1
        for k in range(min(len(word) - 1, remaining - 1)):
            if word[1 + k] != self.s[self.i]:
                self.fail(self._token(self.s[self.i]))
            self.i += 1
        self.fail('EOS')

    def obj(self) -> dict:
        self.i += 1
        out: dict = {}
        if self.peek() == 'RBRACE':
            self.i += 1
            return out
        if self.peek() != 'STRING':
            self.fail(message="Expected property name or '}'")
        while True:
            key = from_u16(self.string(raw=True))
            if self.peek() != 'COLON':
                self.fail(message="Expected ':' after property name")
            self.i += 1
            out[key] = self.value()
            tok = self.peek()
            if tok == 'COMMA':
                self.i += 1
                if self.peek() != 'STRING':
                    self.fail(message='Expected double-quoted property name')
                continue
            if tok != 'RBRACE':
                self.fail(message="Expected ',' or '}' after property value")
            self.i += 1
            return out

    def arr(self) -> list:
        self.i += 1
        out: list = []
        if self.peek() == 'RBRACK':
            self.i += 1
            return out
        while True:
            out.append(self.value())
            tok = self.peek()
            if tok == 'COMMA':
                self.i += 1
                continue
            if tok != 'RBRACK':
                self.fail(message="Expected ',' or ']' after array element")
            self.i += 1
            return out

    def string(self, raw: bool = False) -> str:
        self.i += 1
        out: List[str] = []
        s = self.s
        while True:
            if self.i >= self.n:
                self.fail(message='Unterminated string')
            c = s[self.i]
            if c == '"':
                self.i += 1
                r = ''.join(out)
                return r if raw else from_u16(r)
            if c == '\\':
                self.i += 1
                if self.i >= self.n:
                    self.fail('EOS')
                e = s[self.i]
                if e == 'u':
                    code = 0
                    for _ in range(4):
                        self.i += 1
                        h = s[self.i] if self.i < self.n else ''
                        if h == '' or h not in _HEX:
                            self.fail(message='Bad Unicode escape')
                        code = code * 16 + int(h, 16)
                    out.append(chr(code))
                    self.i += 1
                    continue
                m = {'"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}.get(e)
                if m is None:
                    self.fail(message='Bad escaped character')
                out.append(m)
                self.i += 1
                continue
            if ord(c) < 0x20:
                self.fail(message='Bad control character in string literal')
            out.append(c)
            self.i += 1

    def number(self) -> Any:
        s, start = self.s, self.i
        dig = lambda: self.i < self.n and '0' <= s[self.i] <= '9'  # noqa: E731
        if s[self.i] == '-':
            self.i += 1
            if not dig():
                self.fail('ILLEGAL', 'No number after minus sign')
        if s[self.i] == '0':
            self.i += 1
            if dig():
                self.fail('NUMBER')
        else:
            while dig():
                self.i += 1
        if self.i < self.n and s[self.i] == '.':
            self.i += 1
            if not dig():
                self.fail('ILLEGAL', 'Unterminated fractional number')
            while dig():
                self.i += 1
        if self.i < self.n and s[self.i] in 'eE':
            self.i += 1
            if self.i < self.n and s[self.i] in '+-':
                self.i += 1
            if not dig():
                self.fail('ILLEGAL', 'Exponent part is missing a number')
            while dig():
                self.i += 1
        text = s[start:self.i]
        return norm(float(text))


def parse_json(source: str) -> Any:
    """JSON.parse(source), raising JSONSyntaxError with V8's message text."""
    return _JsonParser(source).parse()


# ---------------------------------------------------------------- dates
def _days_from_civil(y: int, m: int, d: int) -> int:
    y -= m <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _civil_from_days(z: int) -> Tuple[int, int, int]:
    z += 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    return y + (m <= 2), m, d


def _time_clip(ms: float) -> Any:
    if ms != ms or abs(ms) > 8.64e15:
        return NAN
    return norm(ms)


_ISO = re.compile(
    r'(?P<y>[+-][0-9]{6}|[0-9]{4})(?:-(?P<mo>[0-9]{2})(?:-(?P<d>[0-9]{2}))?)?'
    r'(?:[Tt ](?P<h>[0-9]{2}):(?P<mi>[0-9]{2})(?::(?P<s>[0-9]{2})(?:\.(?P<f>[0-9]+))?)?'
    r'(?P<z>[Zz]|[+-][0-9]{2}:?[0-9]{2})?)?')


def date_parse(s: str) -> Any:
    """Date.parse for the ISO 8601 forms V8 accepts. Other (legacy) formats return NaN."""
    m = _ISO.fullmatch(trim(s))
    if not m:
        return NAN
    ys = m.group('y')
    if ys == '-000000':
        return NAN
    y = int(ys)
    mo = int(m.group('mo') or 1)
    d = int(m.group('d') or 1)
    h = int(m.group('h') or 0)
    mi = int(m.group('mi') or 0)
    sec = int(m.group('s') or 0)
    ms = int((m.group('f') or '').ljust(3, '0')[:3])
    if not (1 <= mo <= 12 and 1 <= d <= 31 and mi <= 59 and sec <= 59):
        return NAN
    if h > 24 or (h == 24 and (mi or sec or ms)):
        return NAN
    z = m.group('z')
    local = m.group('h') is not None and z is None
    off = 0
    if z and z not in 'Zz':
        zz = z.replace(':', '')
        oh, om = int(zz[1:3]), int(zz[3:5])
        if oh > 23 or om > 59:
            return NAN
        off = (oh * 60 + om) * (1 if zz[0] == '+' else -1)
    if local:
        try:
            t = time.mktime((y, mo, d, h, mi, sec, 0, 0, -1))
        except (OverflowError, ValueError):
            return NAN
        return _time_clip(norm(int(t) * 1000 + ms))
    days = _days_from_civil(y, mo, 1) + d - 1
    total = ((days * 24 + h) * 60 + mi - off) * 60 * 1000 + sec * 1000 + ms
    return _time_clip(total)


def utc_ms(y: int, mon0: int, d: int, h: int = 0, mi: int = 0, s: int = 0, ms: int = 0) -> int:
    """Date.UTC(y, mon0, d, h, mi, s, ms) for integer arguments."""
    y += mon0 // 12
    mon0 %= 12
    days = _days_from_civil(y, mon0 + 1, 1) + d - 1
    return ((days * 24 + h) * 60 + mi) * 60000 + s * 1000 + ms


def iso_string(ms: int) -> str:
    """Date.prototype.toISOString()."""
    days, rem = divmod(int(ms), 86400000)
    y, mo, d = _civil_from_days(days)
    h, rem = divmod(rem, 3600000)
    mi, rem = divmod(rem, 60000)
    s, milli = divmod(rem, 1000)
    ys = '%04d' % y if 0 <= y <= 9999 else ('+' if y > 0 else '-') + '%06d' % abs(y)
    return '%s-%02d-%02dT%02d:%02d:%02d.%03dZ' % (ys, mo, d, h, mi, s, milli)


def now_iso() -> str:
    t = datetime.now(timezone.utc)
    return iso_string(calendar.timegm(t.timetuple()) * 1000 + t.microsecond // 1000)


def utc_year(ms: Any) -> Any:
    """new Date(ms).getUTCFullYear()."""
    ms = _time_clip(to_number(ms))
    if ms != ms:
        return NAN
    return _civil_from_days(math.trunc(ms) // 86400000)[0]
