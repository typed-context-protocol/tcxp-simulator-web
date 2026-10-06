"""tcxp engine, a line-for-line port of tcxp.js (v0.2).

Parse an address into an expression tree, serialize it back, resolve pointers, read annotations
(spikes), and interpret the tree as SQL, math, a function call, or a JSON document; preview, perform
and undo writes; edit and query addresses. Trees and results are plain dicts and lists with the same
keys as the JavaScript objects, so JSON output is identical.
"""
from __future__ import annotations

import builtins
import calendar
import copy
import functools
import math
import re
from typing import Any, Callable, Dict, Iterator, List, NoReturn, Optional, Tuple

from . import _data
from ._js import (
    JSONSyntaxError, URIError, date_parse, decode_uri_component, encode_uri_component_char, from_u16, imul, is_integer, is_num,
    object_keys,
    iso_string, js_pow, js_round, js_sign, lt, norm, now_iso, num_add, num_div, num_mul, num_sub, num_to_str,
    parse_json, stringify, to_int32, to_number, to_string, trim, truthy, u16, u16_len, u32,
    utc_ms, utc_year, first_unit,
)

Node = Dict[str, Any]
Tree = Dict[str, Any]


class TcxpError(Exception):
    """An address or tree the protocol rejects. ``where`` names the key or part at fault; ``code`` is a
    PostgreSQL SQLSTATE for write errors, ``'refused'`` for a refused write and ``'edit'`` for edit()."""

    def __init__(self, msg: str, where: Optional[str] = None, code: Optional[str] = None) -> None:
        super().__init__(msg)
        self.message = msg
        self.where = where
        self.code = code if code else None


# ---------------------------------------------------------------- data
def _build_registries() -> Dict[str, Any]:
    regs = copy.deepcopy(_data.REGISTRIES_DATA)
    impl: Dict[str, Dict[str, Callable[[Dict[str, Any]], Any]]] = {
        'school.demo': {'fn/current_cohort': lambda a: '2026-fall'},
        'registry': {'hello': lambda a: 'hello, ' + ('undefined' if a.get('do') is None else to_string(a['do']))},
    }
    for name, fns in impl.items():
        for path, f in fns.items():
            regs[name]['fns'][path]['fn'] = f
    return regs


REGISTRIES: Dict[str, Any] = _build_registries()   # CSV-backed tables are added at the end of this module
QUERIES: List[Dict[str, Any]] = _data.QUERIES
GROUPS: List[List[str]] = _data.GROUPS
COVERAGE: List[List[Any]] = _data.COVERAGE
OPS: Dict[str, Dict[str, Any]] = _data.OPS
CLAUSES: Dict[str, Dict[str, Any]] = _data.CLAUSES
CLAUSE_ORDER: List[str] = _data.CLAUSE_ORDER
WRITE_CLAUSES: Dict[str, Dict[str, Dict[str, Any]]] = _data.WRITE_CLAUSES
WRITE_ORDER: Dict[str, List[str]] = _data.WRITE_ORDER
RULES: List[List[str]] = _data.RULES
FACETS: List[str] = _data.FACETS
SCHEME: str = _data.SCHEME
DEBOUNCE_MS: int = _data.DEBOUNCE_MS
CALL = '@'

MATH_OPS = {'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'add', 'sub', 'mul', 'div', 'pow', 'and', 'or', 'not'}
# row() and assign() exist only in write addresses; select and math never see them.
SELECT_OPS = {k for k, o in OPS.items() if not o.get('write')}


def _label_for(op: str) -> str:
    o = OPS[op]
    return o.get('label') or (o['sql'].upper() if o['kind'] == 'func' else o['sql'])


# ---------------------------------------------------------------- DDL helpers
def _sql_lit(v: Any) -> str:
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return num_to_str(v)
    return "'" + to_string(v).replace("'", "''") + "'"


def table_ddl(t: Dict[str, Any]) -> str:
    w = max(len(c[0]) for c in t['columns'])
    lines = ['  ' + c[0].ljust(w) + ' ' + c[1] + ((' ' + c[2]) if c[2] else '') for c in t['columns']]
    s = 'CREATE TABLE ' + t['name'] + ' (\n' + ',\n'.join(lines) + '\n);\n'
    s += 'COMMENT ON TABLE ' + t['name'] + ' IS ' + _sql_lit(t['description']) + ';\n'
    for c in t['columns']:
        s += 'COMMENT ON COLUMN ' + t['name'] + '.' + c[0] + ' IS ' + _sql_lit(c[3]) + ';\n'
    return s


def table_inserts(t: Dict[str, Any], seed: Dict[str, Any]) -> str:
    return ('INSERT INTO ' + t['name'] + ' (' + ', '.join(c[0] for c in t['columns']) + ') VALUES\n' +
            ',\n'.join('  (' + ', '.join(_sql_lit(v) for v in r) + ')' for r in seed[t['name']]) + ';\n')


def full_ddl(reg: str) -> str:
    r = REGISTRIES.get(reg)
    if not r or not r.get('db'):
        raise TcxpError('Registry "' + reg + '" has no database')
    db = r['db']
    return ('-- tcxp registry "' + reg + '" (PostgreSQL)\n-- ' + db['schema']['description'] + '\n\n' +
            '\n'.join(table_ddl(t) for t in db['schema']['tables']) + '\n' +
            '\n'.join(table_inserts(t, db['seed']) for t in db['schema']['tables']))


# ---------------------------------------------------------------- tokenizer
_ID_CHARS = set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.')
_NAME_CHARS = set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_')
_DIGITS = set('0123456789')
_NUM_CHARS = set('0123456789.')
_NAME_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')


def _tokenize(src: str, where: str) -> List[Dict[str, Any]]:
    toks: List[Dict[str, Any]] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == ' ':
            i += 1
            continue
        if c in '(),':
            toks.append({'t': c})
            i += 1
            continue
        if c == "'" or src.startswith("date'", i):
            typ = 'text'
            if c != "'":
                typ = 'date'
                i += 4
            j, s = i + 1, []
            while True:
                if j >= n:
                    raise TcxpError('Unterminated string literal', where)
                if src[j] == "'":
                    if j + 1 < n and src[j + 1] == "'":
                        s.append("'")
                        j += 2
                        continue
                    break
                s.append(src[j])
                j += 1
            toks.append({'t': 'val', 'v': ''.join(s), 'type': typ})
            i = j + 1
            continue
        if c == '$':
            j = i + 1
            while j < n and src[j] in _NAME_CHARS:
                j += 1
            if j == i + 1:
                raise TcxpError('A variable needs a name after "$"', where)
            toks.append({'t': 'slot', 'v': src[i + 1:j]})
            i = j
            continue
        if c == '*':
            toks.append({'t': 'ref', 'v': '*'})
            i += 1
            continue
        if c in _DIGITS or (c == '-' and i + 1 < n and src[i + 1] in _DIGITS):
            j = i + 1
            while j < n and src[j] in _NUM_CHARS:
                j += 1
            text = src[i:j]
            if not re.fullmatch(r'-?[0-9]+(?:\.[0-9]*)?', text):
                raise TcxpError('Bad number "' + text + '"', where)
            v = norm(float(text))
            toks.append({'t': 'val', 'v': v, 'type': 'integer' if is_integer(v) else 'numeric'})
            i = j
            continue
        if c in _ID_CHARS:
            j = i
            while j < n and src[j] in _ID_CHARS:
                j += 1
            w = src[i:j]
            if w in ('true', 'false'):
                toks.append({'t': 'val', 'v': w == 'true', 'type': 'boolean'})
            elif w == 'null':
                toks.append({'t': 'val', 'v': None, 'type': 'null'})
            else:
                toks.append({'t': 'id', 'v': w})
            i = j
            continue
        raise TcxpError('Unexpected character "' + first_unit(c) + '"', where)
    return toks


def _parse_expr_list(src: str, where: str, allowed: Optional[set] = None) -> List[Node]:
    toks = _tokenize(src, where)
    p = 0

    def expr() -> Node:
        nonlocal p
        tk = toks[p] if p < len(toks) else None
        p += 1
        if tk is None:
            raise TcxpError('Expression ended early', where)
        if tk['t'] == 'val':
            return {'kind': 'value', 'value': tk['v'], 'type': tk['type']}
        if tk['t'] == 'slot':
            return {'kind': 'slot', 'name': tk['v'], 'children': []}
        if tk['t'] == 'ref':
            return {'kind': 'reference', 'name': '*'}
        if tk['t'] == 'id':
            if p < len(toks) and toks[p]['t'] == '(':
                p += 1
                op = OPS.get(tk['v'])
                if not op or (allowed is not None and tk['v'] not in allowed):
                    raise TcxpError('Operator "' + tk['v'] + '" is not in this profile', where)
                args: List[Node] = []
                if not (p < len(toks) and toks[p]['t'] == ')'):
                    while True:
                        args.append(expr())
                        nx = toks[p] if p < len(toks) else None
                        p += 1
                        if nx is None:
                            raise TcxpError('Missing ")" after ' + tk['v'] + '(', where)
                        if nx['t'] == ')':
                            break
                        if nx['t'] != ',':
                            raise TcxpError('Expected "," or ")" in ' + tk['v'] + '(…)', where)
                else:
                    p += 1
                mn, mx = op['arity']
                if len(args) < mn or (mx is not None and len(args) > mx):
                    want = str(mn) if mx == mn else str(mn) + (('–' + str(mx)) if mx else '+')
                    raise TcxpError(tk['v'] + '() takes ' + want + ' argument(s), got ' + str(len(args)), where)
                if tk['v'] == 'as':
                    if args[1]['kind'] != 'reference':
                        raise TcxpError('as() needs a bare name as its second argument', where)
                    args[1]['role'] = 'declares'
                if op['kind'] == 'join' and args[0]['kind'] != 'reference':
                    raise TcxpError(tk['v'] + '() needs a table name first', where)
                return {'kind': 'operator', 'op': tk['v'], 'label': _label_for(tk['v']), 'children': args}
            return {'kind': 'reference', 'name': tk['v']}
        raise TcxpError('Unexpected "' + tk['t'] + '"', where)

    out: List[Node] = []
    if not toks:
        raise TcxpError('Empty expression', where)
    while p < len(toks):
        out.append(expr())
        if p < len(toks):
            nx = toks[p]
            p += 1
            if nx['t'] != ',':
                raise TcxpError('Expected "," between items', where)
    return out


# ---------------------------------------------------------------- meta values
def _parse_meta_value(v: str, key: str) -> Any:
    t = trim(v)
    if t[:1] in ('[', '{'):
        try:
            return parse_json(t)
        except JSONSyntaxError as e:
            raise TcxpError('~' + key + ' is not valid JSON: ' + str(e), '~' + key) from None
    if re.fullmatch(r'-?[0-9]+', t):
        return norm(float(t))
    return v


def _enc_value(s: str) -> str:
    return s.replace('%', '%25').replace('&', '%26').replace('#', '%23')


def _enc_literal(s: str) -> str:
    return _enc_value(s).replace('=', '%3D')


def _meta_text(v: Any) -> str:
    if isinstance(v, str):
        return _enc_value(v)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return num_to_str(v)
    return _enc_value(stringify(v))


# ---------------------------------------------------------------- parse URI
def _split_pairs(query: str) -> List[List[str]]:
    out: List[List[str]] = []
    if not query:
        return out
    for pair in query.split('&'):
        if not pair:
            continue
        eq = pair.find('=')
        if eq < 0:
            raise TcxpError('Key "' + pair + '" has no "="', pair)
        try:
            k = decode_uri_component(pair[:eq])
            v = decode_uri_component(pair[eq + 1:])
        except URIError:
            raise TcxpError('Bad percent-encoding in "' + pair + '"', pair) from None
        out.append([k, v])
    return out


def _route(registry: str, path: str) -> Dict[str, Any]:
    reg = REGISTRIES.get(registry)
    if not reg:
        raise TcxpError('Unknown registry "' + registry + '". Known: ' + ', '.join(REGISTRIES.keys()), 'registry')
    if path == 'sql/select':
        if not reg.get('db'):
            raise TcxpError('Registry "' + registry + '" has no database for sql/select', 'path')
        return {'mode': 'sql'}
    w = re.fullmatch(r'sql/(insert|update|delete)', path)
    if w:
        if not reg.get('db'):
            raise TcxpError('Registry "' + registry + '" has no database for ' + path, 'path')
        return {'mode': 'write', 'op': w.group(1)}
    if path == 'math/eval':
        return {'mode': 'math'}
    if reg['fns'].get(path):
        return {'mode': 'fn', 'fn': reg['fns'][path]}
    if path in reg['notes']:
        return {'mode': 'note', 'text': reg['notes'][path]}
    raise TcxpError('Nothing at "' + registry + '/' + path + '". Try sql/select, sql/insert, sql/update, sql/delete, math/eval, a function or a note.', 'path')


def parse_uri(input: Optional[str]) -> Tree:
    """Parse an address (``!tcxp:/…`` or ``@!tcxp:/…``) into a tree. Raises TcxpError."""
    uri = trim(input or '')
    call = False
    if uri.startswith(CALL):
        call = True
        uri = uri[1:]
    if not uri.startswith(SCHEME):
        raise TcxpError('An address starts with "!tcxp:/" (or "@!tcxp:/" to call a function)', 'scheme')
    rest = uri[len(SCHEME):]
    if rest.startswith('/'):
        rest = rest[1:]
    qi = rest.find('?')
    hierarchy = rest if qi < 0 else rest[:qi]
    query = '' if qi < 0 else rest[qi + 1:]
    segs = [s for s in hierarchy.split('/') if s]
    if not segs:
        raise TcxpError('Missing registry after !tcxp:/', 'registry')
    registry, path = segs[0], '/'.join(segs[1:])
    r = _route(registry, path)
    if call and r['mode'] != 'fn' and r['mode'] != 'write':
        raise TcxpError('"@" calls a function or performs a write, and ' + registry + '/' + path + ' is neither', 'call')

    items: Dict[str, List[Node]] = {}
    bindings: Dict[str, Node] = {}
    meta: List[List[Any]] = []
    for k, v in _split_pairs(query):
        if meta and k[:1] != '~':
            raise TcxpError('Meta keys (~) must come last; "' + k + '" appears after ~' + meta[-1][0], k)
        if k[:1] == '~':
            name = k[1:]
            if not _NAME_RE.fullmatch(name):
                raise TcxpError('Bad meta key "' + k + '"', k)
            if any(m[0] == name for m in meta):
                raise TcxpError('Meta key ' + k + ' appears twice', k)
            meta.append([name, _parse_meta_value(v, name)])
            continue
        if k[:1] == '$':
            name = k[1:]
            if not _NAME_RE.fullmatch(name):
                raise TcxpError('Bad variable name "' + k + '"', k)
            if name in bindings:
                raise TcxpError('Variable ' + k + ' is bound twice', k)
            if v.startswith(CALL + SCHEME):
                inner = parse_uri(v)
                if inner['parsed']['mode'] != 'fn':
                    raise TcxpError('Variable ' + k + ' can only be bound by an @ call to a function, not by a write', k)
                bindings[name] = {'kind': 'call', 'tree': inner}
            else:
                vals = _parse_expr_list(v, k)
                if len(vals) != 1 or vals[0]['kind'] != 'value':
                    raise TcxpError('Variable ' + k + ' must be bound to one literal value or an @!tcxp:/ call', k)
                bindings[name] = vals[0]
            continue
        mode = r['mode']
        if mode == 'sql':
            if k not in CLAUSES:
                raise TcxpError('Unknown key "' + k + '". Clause keys are ' + ', '.join(CLAUSE_ORDER) +
                                '; variables start with $, meta with ~.', k)
            if k in items and not CLAUSES[k].get('repeat'):
                raise TcxpError('Clause "' + k + '" appears twice', k)
            lst = _parse_expr_list(v, k, SELECT_OPS)
            if not CLAUSES[k].get('list') and not CLAUSES[k].get('repeat') and len(lst) != 1:
                raise TcxpError('Clause "' + k + '" takes one expression', k)
            if k == 'join':
                for it in lst:
                    if it['kind'] != 'operator' or OPS[it['op']]['kind'] != 'join':
                        raise TcxpError('join= needs inner(), left(), right(), full() or cross()', k)
            items[k] = items.get(k, []) + lst
        elif mode == 'write':
            wc = WRITE_CLAUSES[r['op']]
            if k not in wc:
                raise TcxpError('Unknown key "' + k + '" for sql/' + r['op'] + '. Keys are ' + ', '.join(WRITE_ORDER[r['op']]) +
                                '; variables start with $, meta with ~.', k)
            if k in items:
                raise TcxpError('Key "' + k + '" appears twice', k)
            lst = _parse_expr_list(v, k)
            if not wc[k].get('list') and len(lst) != 1:
                raise TcxpError('Key "' + k + '" takes one expression', k)
            if k == 'values':
                for it in lst:
                    if it['kind'] != 'operator' or it['op'] != 'row':
                        raise TcxpError('values= is a list of row(…), one per inserted row', k)
            if k == 'set':
                for it in lst:
                    if it['kind'] != 'operator' or it['op'] != 'assign' or it['children'][0]['kind'] != 'reference':
                        raise TcxpError('set= is a list of assign(column, value)', k)
            if k == 'cols':
                for it in lst:
                    if it['kind'] != 'reference' or it['name'] == '*':
                        raise TcxpError('cols= for an insert names the target columns', k)
            if k in ('into', 'table', 'from') and lst[0]['kind'] != 'reference':
                raise TcxpError(k + '= takes a table name', k)
            if k != 'values' and k != 'set':
                bad: List[str] = []

                def find_write_ops(n: Node) -> None:
                    if n['kind'] == 'operator' and OPS[n['op']].get('write'):
                        bad.append(n['op'])
                    for c in _children(n):
                        find_write_ops(c)
                find_write_ops({'kind': 'list', 'children': lst})
                if bad:
                    raise TcxpError(bad[0] + '() belongs in ' + ('values=' if bad[0] == 'row' else 'set='), k)
            items[k] = lst
        elif mode == 'math':
            if k != 'expr':
                raise TcxpError('math/eval takes one key, expr= (plus $variables and ~meta)', k)
            if 'expr' in items:
                raise TcxpError('expr= appears twice', k)
            lst = _parse_expr_list(v, k, MATH_OPS)
            if len(lst) != 1:
                raise TcxpError('expr= takes one expression', k)
            items['expr'] = lst
        elif mode == 'fn':
            decl = next((p for p in r['fn']['params'] if p['name'] == k), None)
            if not decl:
                raise TcxpError('"' + k + '" is not a parameter of this function. Parameters: ' +
                                (', '.join(p['name'] for p in r['fn']['params']) or 'none'), k)
            if k in items:
                raise TcxpError('Parameter "' + k + '" appears twice', k)
            value = v if decl['type'] == 'text' else to_number(v)
            if decl['type'] != 'text' and value != value:
                raise TcxpError('Parameter "' + k + '" expects a number', k)
            items[k] = [{'kind': 'value', 'value': value, 'type': decl['type']}]
        else:
            raise TcxpError('A note address takes no keys other than ~meta', k)
    if r['mode'] == 'sql':
        if 'from' not in items:
            raise TcxpError('A select needs from=', 'from')
        if items['from'][0]['kind'] != 'reference':
            raise TcxpError('from= takes a table name', 'from')
        if 'cols' not in items:
            raise TcxpError('A select needs cols=', 'cols')
    if r['mode'] == 'math' and 'expr' not in items:
        raise TcxpError('math/eval needs expr=', 'expr')
    if r['mode'] == 'write':
        for k in {'insert': ['into', 'cols', 'values'], 'update': ['table', 'set'], 'delete': ['from']}[r['op']]:
            if k not in items:
                raise TcxpError('A' + (' ' if r['op'] == 'delete' else 'n ') + r['op'] + ' needs ' + k + '=', k)
    return _build_tree({'call': call, 'registry': registry, 'path': path, 'mode': r['mode'], 'op': r.get('op'), 'fn': r.get('fn'),
                        'note': r.get('text'), 'items': items, 'bindings': bindings, 'meta': meta})


# ---------------------------------------------------------------- tree + type inference
def base_type(t: Any) -> Any:
    """The type without its modifier: base_type('numeric(3,2)') == 'numeric'."""
    return re.sub(r'\(.*\)', '', to_string(t), count=1) if t else t


def _family(t: Any) -> Any:
    t = base_type(t)
    if t in ('integer', 'bigint', 'numeric', 'smallint', 'real', 'double precision'):
        return 'number'
    if t in ('date', 'timestamptz', 'timestamp'):
        return 'time'
    return t


def _children(n: Node) -> List[Node]:
    return n.get('children') or []


def _build_tree(parsed: Dict[str, Any]) -> Tree:
    items, bindings, mode = parsed['items'], parsed['bindings'], parsed['mode']
    diagnostics: List[Dict[str, str]] = []
    slots_seen: List[str] = []

    if mode == 'sql':
        db = REGISTRIES[parsed['registry']]['db']
        cols_t: Dict[str, str] = {}
        for t in db['schema']['tables']:
            for c in t['columns']:
                cols_t[t['name'] + '.' + c[0]] = c[1]
        tables = {t['name'] for t in db['schema']['tables']}
        in_scope = [items['from'][0]['name']] + [j['children'][0]['name'] for j in items.get('join', [])]
        aliases: Dict[str, Any] = {}

        def resolve_ref(node: Node, ctx: str) -> None:
            if node['name'] == '*':
                return
            if node.get('role') == 'declares':
                return
            if ctx == 'table':
                if node['name'] not in tables:
                    diagnostics.append({'level': 'error', 'msg': 'Unknown table "' + node['name'] + '"'})
                node['role'] = 'table'
                return
            if '.' in node['name']:
                t = cols_t.get(node['name'])
                if not t:
                    diagnostics.append({'level': 'error', 'msg': 'Unknown column "' + node['name'] + '"'})
                elif node['name'].split('.')[0] not in in_scope:
                    diagnostics.append({'level': 'error', 'msg': 'Table for "' + node['name'] + '" is not in from= or join='})
                node['type'] = t or None
                node['role'] = 'column'
                return
            if node['name'] in aliases:
                node['type'] = aliases[node['name']]
                node['role'] = 'alias'
                return
            hits = [tb for tb in in_scope if cols_t.get(tb + '.' + node['name'])]
            if not hits:
                diagnostics.append({'level': 'error', 'msg': 'Unknown column "' + node['name'] + '"'})
            if len(hits) > 1:
                diagnostics.append({'level': 'error', 'msg': 'Column "' + node['name'] + '" is ambiguous; qualify it as table.column'})
            node['type'] = cols_t[hits[0] + '.' + node['name']] if hits else None
            node['role'] = 'column'

        walk = _make_walker(resolve_ref, aliases, slots_seen)
        for k in CLAUSE_ORDER:
            if k not in items:
                continue
            ctx = 'table' if k == 'from' else 'limit' if k in ('limit', 'offset') else 'expr'
            for it in items[k]:
                walk(it, ctx)
        root: Node = {'kind': 'operator', 'op': 'select', 'label': 'SELECT', 'children': []}
        for k in CLAUSE_ORDER:
            if k not in items:
                continue
            if k == 'join':
                root['children'].extend(items['join'])
                continue
            root['children'].append({'kind': 'operator', 'op': 'clause:' + k, 'label': CLAUSES[k]['label'], 'children': items[k]})
    elif mode == 'write':
        root = _build_write_tree(parsed, diagnostics, slots_seen)
    elif mode == 'math':
        def math_ref(node: Node, ctx: str) -> None:
            diagnostics.append({'level': 'error', 'msg': '"' + node['name'] + '" is a reference, and math/eval has no data to point at. Write variables as $' + node['name'] + '.'})
        walk = _make_walker(math_ref, {}, slots_seen)
        walk(items['expr'][0], 'expr')

        def numeric(n: Node) -> None:
            if n['kind'] == 'slot' and not n.get('type'):
                n['type'] = 'numeric'
                n['typedBy'] = 'math profile'
            for c in _children(n):
                numeric(c)
        numeric(items['expr'][0])
        root = items['expr'][0]
    elif mode == 'fn':
        params = []
        for p in parsed['fn']['params']:
            given = items.get(p['name'])
            if given:
                for v in given:
                    v['bound'] = True
            node = {'kind': 'slot', 'name': p['name'], 'param': True, 'type': p['type'], 'typedBy': 'function signature',
                    'children': given if given else []}
            if not given:
                diagnostics.append({'level': 'gap', 'msg': 'Parameter "' + p['name'] + '" is a gap (no value given)'})
            items[p['name']] = [node]
            params.append(node)
        root = {'kind': 'operator', 'op': 'call', 'label': '@ CALL' if parsed['call'] else 'FUNCTION',
                'children': [{'kind': 'reference', 'name': parsed['registry'] + '/' + parsed['path'], 'role': 'handler',
                              'type': parsed['fn']['returns']}] + params}
        if not parsed['call']:
            diagnostics.append({'level': 'info', 'msg': 'This address names a function. Prefix it with @ to call it.'})
    else:
        root = {'kind': 'reference', 'name': parsed['registry'] + '/' + parsed['path'], 'role': 'note', 'type': 'text'}

    # ~intent rows (v0.2): a row's "require" names a variable that must be bound before anything runs, even
    # one the query never uses. Such a variable gets its own slot beside the query tree (tree['intentSlots']).
    intent_meta = next((m for m in parsed['meta'] if m[0] == 'intent'), None)
    required = _read_intent(intent_meta[1] if intent_meta else _UNDEFINED, diagnostics)
    required_by: Dict[str, List[Dict[str, Any]]] = {}
    for r in required:
        required_by.setdefault(r['name'], []).append(r)
    intent_slots: List[Node] = []
    for name in required_by:
        if name in slots_seen:
            continue
        intent_slots.append({'kind': 'slot', 'name': name, 'children': [],
                             'requiredBy': [r['row'] for r in required if r['name'] == name]})
        slots_seen.append(name)

    # attach bound values (or nested calls) to variables; unbound variables are gaps
    all_slots: List[Node] = []

    def collect(n: Node) -> None:
        if n['kind'] == 'slot' and not n.get('param'):
            all_slots.append(n)
        for c in _children(n):
            collect(c)
    collect(root)
    all_slots.extend(intent_slots)
    for s in all_slots:
        b = bindings.get(s['name'])
        if not b:
            continue
        if b['kind'] == 'call':
            inner = b['tree']
            s['children'] = [inner['root']]
            rt = inner['parsed']['fn']['returns']
            if s.get('type') and _family(s['type']) != _family(rt):
                diagnostics.append({'level': 'warn', 'msg': '$' + s['name'] + ' expects ' + to_string(base_type(s['type'])) + ' but the call returns ' + rt})
            diagnostics.extend(inner['diagnostics'])
        else:
            s['children'] = [dict(b, bound=True)]
            if (s.get('type') and b['type'] != 'null' and _family(s['type']) != _family(b['type'])
                    and not (_family(s['type']) == 'time' and b['type'] == 'text')):
                d: Dict[str, Any] = {'level': 'error' if s.get('writeTarget') else 'warn'}
                if s.get('writeTarget'):
                    d['code'] = '42804'
                d['msg'] = '$' + s['name'] + ' expects ' + to_string(base_type(s['type'])) + ' but is bound to a ' + b['type'] + ' value'
                diagnostics.append(d)
    for name in slots_seen:
        if name in bindings:
            continue
        rows = required_by.get(name)
        if rows:
            msg = ('$' + name + ' is a gap: ' + ' and '.join('intent row ' + str(r['row'] + 1) + (' (' + r['role'] + ')' if r['role'] else '')
                                                         for r in rows) +
                   ' require' + ('s' if len(rows) == 1 else '') + ' it, so this halts. ' + rows[0]['text'])
        else:
            msg = '$' + name + ' is a gap: no value is bound, so this cannot run'
        diagnostics.append({'level': 'gap', 'msg': msg})
    for k in bindings:
        if k not in slots_seen:
            diagnostics.append({'level': 'warn', 'msg': '$' + k + ' is bound but never used'})

    tree: Tree = {'root': root, 'parsed': parsed, 'slots': slots_seen, 'diagnostics': diagnostics,
                  'intentSlots': intent_slots, 'required': required}
    tree['gaps'] = _gaps_of(tree)
    tree['spikes'] = _read_spikes(tree)
    for sp in tree['spikes']:
        for msg in sp['problems']:
            diagnostics.append({'level': 'warn', 'msg': 'Annotation ' + sp['id'] + ': ' + msg})
    return tree


def _make_walker(resolve_ref: Callable[[Node, str], None], aliases: Dict[str, Any], slots_seen: List[str]) -> Callable[[Node, str], None]:
    def type_of(n: Node) -> Any:
        if n['kind'] in ('reference', 'slot'):
            return n.get('type') or None
        if n['kind'] == 'value':
            return None if n['type'] == 'null' else n['type']
        if n['kind'] == 'operator':
            o = OPS.get(n['op'])
            if not o:
                return None
            if o.get('cmp') or n['op'] in ('and', 'or', 'not', 'isnull', 'notnull'):
                return 'boolean'
            if o.get('ret'):
                return o['ret']
            if o.get('arith'):
                return 'numeric'
            if n['op'] in ('as', 'asc', 'desc', 'coalesce') or o.get('agg'):
                return type_of(n['children'][0])
        return None

    def walk(n: Node, ctx: str) -> None:
        if n['kind'] == 'reference':
            resolve_ref(n, ctx)
            return
        if n['kind'] == 'value':
            return
        if n['kind'] == 'slot':
            if n['name'] not in slots_seen:
                slots_seen.append(n['name'])
            if ctx == 'limit':
                n['type'] = n.get('type') or 'bigint'
            return
        o = OPS[n['op']]
        if o['kind'] == 'join':
            walk(n['children'][0], 'table')
            if len(n['children']) > 1:
                walk(n['children'][1], 'expr')
            return
        for c in n['children']:
            walk(c, 'limit' if ctx == 'limit' else 'expr')
        if n['op'] == 'as':
            aliases[n['children'][1]['name']] = type_of(n['children'][0])
        if o.get('cmp') or o.get('arith') or n['op'] == 'coalesce':
            anchor = next((c for c in n['children'] if c['kind'] != 'slot' and type_of(c)), None)
            if anchor:
                for c in n['children']:
                    if c['kind'] == 'slot' and not c.get('type'):
                        c['type'] = type_of(anchor)
                        c['typedBy'] = anchor['name'] if anchor['kind'] == 'reference' else 'value'
    return walk


def _gaps_of(tree: Tree) -> List[str]:
    out: List[str] = []

    def walk(n: Node) -> None:
        if n['kind'] == 'slot' and not n['children'] and n['name'] not in out:
            out.append(n['name'])
        for c in _children(n):
            walk(c)
    walk(tree['root'])
    for s in tree.get('intentSlots') or []:
        walk(s)
    return out


# ~intent: a string (legacy: one user row, no requirements) or an array of flat rows
# {role, text, require: "$v" | ["$a","$b"], if_empty: "HALT"}. The protocol has three states, HALT, ASK and ACT;
# v0.2 implements HALT only. ASK and ACT are reserved: writing one is an error, never a silent HALT.
IF_EMPTY_RESERVED = ['ASK', 'ACT']
_UNDEFINED = object()
_REQ_RE = re.compile(r'\$[A-Za-z_][A-Za-z0-9_]*')


def _read_intent(v: Any, diagnostics: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if v is _UNDEFINED or isinstance(v, str) or (isinstance(v, (int, float)) and not isinstance(v, bool)):
        return []
    rows = v if isinstance(v, list) else [v]
    out: List[Dict[str, Any]] = []
    for i, row in enumerate(rows):
        def bad(msg: str, i: int = i) -> None:
            diagnostics.append({'level': 'error', 'msg': '~intent row ' + str(i + 1) + ': ' + msg})
        if not truthy(row) or not isinstance(row, dict):
            bad('each row is a JSON object like {"role":"user","text":"…"}')
            continue
        if row.get('require') is None:
            if 'if_empty' in row:
                bad('if_empty needs require')
            continue
        names = row['require'] if isinstance(row['require'], list) else [row['require']]
        mode = row['if_empty'] if 'if_empty' in row else 'HALT'
        if isinstance(mode, str) and mode in IF_EMPTY_RESERVED:
            bad(mode + ' is reserved for a future version; v0.2 supports HALT only')
            continue
        if mode != 'HALT' or not isinstance(mode, str):
            bad('if_empty must be "HALT" (or omitted, which means HALT), not ' + stringify(mode))
            continue
        for n in names:
            if not isinstance(n, str) or not _REQ_RE.fullmatch(n):
                bad('require names variables like "$tax_year", not ' + stringify(n))
                continue
            out.append({'name': n[1:], 'row': i, 'mode': mode, 'role': row['role'] if isinstance(row.get('role'), str) else None,
                        'text': row['text'] if isinstance(row.get('text'), str) else ''})
    return out


# ---------------------------------------------------------------- pointers
def _index(lst: Optional[List[Node]], s: str) -> Optional[Node]:
    if not lst:
        return None
    i = to_number(s)
    if not is_integer(i) or i < 0 or i >= len(lst):
        return None
    return lst[int(i)]


def resolve_pointer(tree: Tree, ptr: Any) -> List[Node]:
    """Nodes a pointer names: ``/<key>/<item>/<child>/…`` or ``/$name`` (every occurrence)."""
    if not isinstance(ptr, str) or ptr[:1] != '/':
        return []
    segs = [s.replace('~1', '/').replace('~0', '~') for s in ptr.split('/')[1:]]
    key = segs.pop(0)
    if key[:1] == '$':
        starts: List[Node] = []

        def walk(n: Node) -> None:
            if n['kind'] == 'slot' and n['name'] == key[1:]:
                starts.append(n)
            for c in _children(n):
                walk(c)
        walk(tree['root'])
        for s in tree.get('intentSlots') or []:
            walk(s)
        if segs:
            return [x for x in (_descend(s['children'], segs) for s in starts) if x]
        return starts
    lst = tree['parsed']['items'].get(key)
    if not lst:
        return []
    if not segs:
        return list(lst)
    first = _index(lst, segs[0])
    if not first:
        return []
    hit = _descend(_children(first), segs[1:]) if len(segs) > 1 else first
    return [hit] if hit else []


def _descend(children: Optional[List[Node]], segs: List[str]) -> Optional[Node]:
    node, kids = None, children
    for s in segs:
        node = _index(kids or [], s)
        if not node:
            return None
        kids = node.get('children')
    return node


# ---------------------------------------------------------------- annotations (spikes)
def _resolve_note(addr: Any) -> Optional[str]:
    if not isinstance(addr, str) or not addr.startswith(SCHEME):
        return None
    try:
        t = parse_uri(addr)
        return t['parsed']['note'] if t['parsed']['mode'] == 'note' else None
    except Exception:
        return None


def _prop(row: Any, key: str) -> Any:
    return row.get(key) if isinstance(row, dict) else None


def _read_spikes(tree: Tree) -> List[Dict[str, Any]]:
    m = next((x for x in tree['parsed']['meta'] if x[0] == 'spikes'), None)
    if not m:
        return []
    rows = m[1] if isinstance(m[1], list) else [m[1]]
    out = []
    for i, row in enumerate(rows):
        problems: List[str] = []
        rid = _prop(row, 'id')
        sid = to_string(rid) if truthy(row) and truthy(rid) else 's' + str(i + 1)
        ron = _prop(row, 'on')
        on = (ron if isinstance(ron, list) else [ron]) if truthy(row) and truthy(ron) else []
        targets = [{'ptr': p, 'nodes': resolve_pointer(tree, p)} for p in on]
        for t in targets:
            if not t['nodes']:
                problems.append('pointer ' + to_string(t['ptr']) + ' does not resolve to a node')
        facets: Dict[str, Any] = {}
        for f in FACETS:
            v = _prop(row, f) if truthy(row) else None
            if v is None or v == '':
                facets[f] = {'lit': False, 'value': None, 'text': None}
                continue
            if isinstance(v, str) and v.startswith(SCHEME):
                text = _resolve_note(v)
                if text is None:
                    problems.append(f + ' points at ' + v + ', which does not resolve')
                facets[f] = {'lit': text is not None, 'value': v, 'text': text}
            else:
                facets[f] = {'lit': True, 'value': v, 'text': to_string(v)}
        data = len(targets) > 0 and all(t['nodes'] for t in targets)
        bits = ''.join('1' if facets[f]['lit'] else '0' for f in FACETS)
        out.append({'id': sid, 'on': on, 'targets': targets, 'facets': facets, 'data': data, 'bits': bits,
                    'problems': problems, 'row': row})
    return out


# ---------------------------------------------------------------- canonical serialization
_nid = 0


def serialize(tree: Tree, meta: bool = True) -> Dict[str, Any]:
    """Canonical form: ``{'uri', 'tokens'}``. ``meta=False`` drops ~meta keys (that string is the identity)."""
    parsed = tree['parsed']
    toks: List[Dict[str, Any]] = []

    def tag(n: Node) -> str:
        global _nid
        if '_id' not in n:
            n['_id'] = 'n' + str(_nid)
            _nid += 1
        return n['_id']

    def push(text: str, kind: str, node: Optional[Node] = None) -> None:
        toks.append({'text': text, 'kind': kind, 'nodeId': tag(node) if node else None})

    def val_text(n: Node) -> str:
        if n['value'] is None:
            return 'null'
        if n['type'] == 'text':
            return "'" + _enc_literal(to_string(n['value']).replace("'", "''")) + "'"
        if n['type'] == 'date':
            return "date'" + _enc_literal(to_string(n['value'])) + "'"
        return to_string(n['value'])

    def ex(n: Node) -> None:
        if n['kind'] == 'value':
            return push(val_text(n), 'value', n)
        if n['kind'] == 'slot':
            return push('$' + n['name'], 'slot', n)
        if n['kind'] == 'reference':
            return push(n['name'], 'reference', n)
        push(n['op'], 'operator', n)
        push('(', 'punct')
        for i, c in enumerate(n['children']):
            if i:
                push(',', 'punct')
            ex(c)
        push(')', 'punct')

    if parsed['call']:
        push('@', 'call', tree['root'])
    push('!tcxp:/', 'scheme')
    push(parsed['registry'], 'registry')
    mode = parsed['mode']
    push('/' + parsed['path'], 'path', tree['root']['children'][0] if mode == 'fn' else tree['root'] if mode in ('note', 'sql', 'write') else None)
    first = [True]

    def sep() -> None:
        push('?' if first[0] else '&', 'punct')
        first[0] = False

    if mode == 'sql':
        for k in CLAUSE_ORDER:
            lst = parsed['items'].get(k)
            if not lst:
                continue
            clause_node = next((c for c in tree['root']['children'] if c.get('op') == 'clause:' + k), None)
            if k == 'join':
                for j in lst:
                    sep()
                    push('join', 'key')
                    push('=', 'punct')
                    ex(j)
                continue
            sep()
            push(k, 'key', clause_node)
            push('=', 'punct')
            for i, it in enumerate(lst):
                if i:
                    push(',', 'punct')
                ex(it)
    elif mode == 'write':
        for k in WRITE_ORDER[parsed['op']]:
            lst = parsed['items'].get(k)
            if not lst:
                continue
            sep()
            push(k, 'key', next((c for c in tree['root']['children'] if c.get('op') == 'clause:' + k), None))
            push('=', 'punct')
            for i, it in enumerate(lst):
                if i:
                    push(',', 'punct')
                ex(it)
    elif mode == 'math':
        sep()
        push('expr', 'key')
        push('=', 'punct')
        ex(parsed['items']['expr'][0])
    elif mode == 'fn':
        for p in parsed['fn']['params']:
            slot = parsed['items'][p['name']][0]
            if not slot['children']:
                continue
            sep()
            push(p['name'], 'param', slot)
            push('=', 'punct')
            v = slot['children'][0]
            push(_enc_literal(to_string(v['value'])) if p['type'] == 'text' else to_string(v['value']), 'value', v)
    binding_names = tree['slots'] + [k for k in parsed['bindings'] if k not in tree['slots']]
    for name in binding_names:
        b = parsed['bindings'].get(name)
        if not b:
            continue
        slot = find_slot(tree['root'], name)
        sep()
        push('$' + name, 'slotkey', slot)
        push('=', 'punct')
        if b['kind'] == 'call':
            inner = serialize(b['tree'], meta=False)
            for t in inner['tokens']:
                toks.append(dict(t, text=t['text'].replace('%', '%25').replace('&', '%26').replace('#', '%23')))
        else:
            push(val_text(b), 'value', slot['children'][0] if slot else None)
    if meta:
        for name, v in parsed['meta']:
            sep()
            push('~' + name, 'metakey')
            push('=', 'punct')
            push(_meta_text(v), 'meta')
    return {'uri': ''.join(t['text'] for t in toks), 'tokens': toks}


def find_slot(n: Node, name: str) -> Optional[Node]:
    """The first variable node named ``name`` (function parameters excluded)."""
    if n['kind'] == 'slot' and n['name'] == name and not n.get('param'):
        return n
    for c in _children(n):
        r = find_slot(c, name)
        if r:
            return r
    return None


def identity(tree: Tree) -> str:
    """The canonical form without ~meta keys: two states with equal identity are the same decision state."""
    return serialize(tree, meta=False)['uri']


def result_key(tree: Tree) -> str:
    """Key for a stored result: the identity, plus what the ~intent rows require (intent rows never change
    identity, but they decide whether a state runs). With no requirements it is the identity."""
    req = tree.get('required') or []
    if not req:
        return identity(tree)
    names = sorted(set(r['name'] for r in req), key=u16)
    return identity(tree) + ' ~requires ' + stringify(names)


_STRICT_SAFE = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/?%")


def strict_form(uri: str) -> str:
    """Strict transport form: every character outside RFC 3986 unreserved/sub-delims is percent-encoded."""
    s = ''.join(c if c in _STRICT_SAFE else encode_uri_component_char(c) for c in uri)
    return re.sub(r'%(?![0-9A-Fa-f]{2})', '%25', s)


# ---------------------------------------------------------------- bindings at runtime
def _invoke(tree: Tree) -> Any:
    p = tree['parsed']
    args: Dict[str, Any] = {}
    for prm in p['fn']['params']:
        s = p['items'][prm['name']][0]
        args[prm['name']] = s['children'][0]['value'] if s['children'] else None
    return p['fn']['fn'](args)


def _bound_values(tree: Tree) -> Dict[str, Dict[str, Any]]:
    vals: Dict[str, Any] = {}
    via: Dict[str, str] = {}
    for k, b in tree['parsed']['bindings'].items():
        if b['kind'] == 'call':
            vals[k] = _invoke(b['tree'])
            via[k] = 'call'
        else:
            vals[k] = b['value']
            via[k] = 'literal'
    return {'vals': vals, 'via': via}


# ---------------------------------------------------------------- SQL fiber
_PREC = {'or': 1, 'and': 2, 'not': 3, 'eq': 4, 'ne': 4, 'lt': 4, 'le': 4, 'gt': 4, 'ge': 4, 'add': 5, 'sub': 5,
         'mul': 6, 'div': 6, 'pow': 7}


def _prec(op: Any) -> int:
    return _PREC.get(op, 9) if isinstance(op, str) else 9


def to_sql(tree: Tree, inline: bool = False) -> Optional[Dict[str, Any]]:
    """PostgreSQL for a sql/select or math/eval tree: ``{'sql', 'params', 'paramNames', 'via'}``.

    ``inline=True`` writes bound values into the SQL instead of $n parameters. Other trees give None.
    """
    p = tree['parsed']
    if p['mode'] not in ('sql', 'math', 'write'):
        return None
    params: List[Any] = []
    order: List[str] = []
    gapless = not tree['gaps']
    bv = _bound_values(tree) if gapless else {'vals': {}, 'via': {}}
    cast_slots = p['mode'] == 'math'

    def slot_ref(name: str) -> str:
        if name in order:
            i = order.index(name)
        else:
            order.append(name)
            i = len(order) - 1
            params.append(bv['vals'].get(name))
        return '$' + str(i + 1) + ('::numeric' if cast_slots else '')

    def value(n: Node) -> str:
        return 'DATE ' + _sql_lit(n['value']) if n['type'] == 'date' else _sql_lit(n['value'])

    def needs_parens(child: Node, parent_op: str, is_right: Any) -> bool:
        if child['kind'] != 'operator':
            return False
        if child['op'] in ('and', 'or'):
            return child['op'] != parent_op
        co, po = OPS.get(child['op']), OPS.get(parent_op)
        if not co or not po or co['kind'] != 'infix' or po['kind'] != 'infix':
            return False
        if co.get('cmp') and po.get('cmp'):
            return True
        return _prec(child['op']) < _prec(parent_op) or (truthy(is_right) and _prec(child['op']) == _prec(parent_op))

    def e(n: Node, parent_op: Optional[str] = None) -> str:
        if n['kind'] == 'reference':
            return n['name']
        if n['kind'] == 'value':
            return value(n)
        if n['kind'] == 'slot':
            if inline and n['name'] in bv['vals']:
                b = p['bindings'].get(n['name'])
                return _sql_lit(bv['vals'][n['name']]) if not b or b['kind'] == 'call' else value(b)
            return slot_ref(n['name'])
        o = OPS[n['op']]
        c = n['children']

        def w(x: Node, is_right: Any = None) -> str:
            s = e(x, n['op'])
            return '(' + s + ')' if needs_parens(x, n['op'], is_right) else s
        kind = o['kind']
        if kind == 'infix':
            if p['mode'] == 'math' and n['op'] == 'div':
                return '(' + w(c[0]) + ')::numeric / ' + w(c[1], True)
            return w(c[0]) + ' ' + o['sql'] + ' ' + w(c[1], True)
        if kind == 'nary':
            return (' ' + o['sql'] + ' ').join(w(x, i) for i, x in enumerate(c))
        if kind == 'prefix':
            return o['sql'] + ' ' + w(c[0])
        if kind == 'postfix':
            return w(c[0]) + ' ' + o['sql']
        if kind == 'in':
            return w(c[0]) + ' IN (' + ', '.join(e(x) for x in c[1:]) + ')'
        if kind == 'between':
            return w(c[0]) + ' BETWEEN ' + w(c[1]) + ' AND ' + w(c[2])
        if kind == 'func':
            return o['sql'] + '(' + ', '.join(e(x) for x in c) + ')'
        if kind == 'extract':
            return 'extract(year from ' + e(c[0]) + ')'
        if kind == 'alias':
            return e(c[0]) + ' AS ' + c[1]['name']
        if kind == 'join':
            return o['sql'] + ' ' + c[0]['name'] + (' ON ' + e(c[1]) if len(c) > 1 else '')
        raise TcxpError('Cannot render ' + n['op'])

    if p['mode'] == 'math':
        return {'sql': 'SELECT ' + e(p['items']['expr'][0]) + ' AS result', 'params': params, 'paramNames': order, 'via': bv['via']}
    if p['mode'] == 'write':
        wi = p['items']
        wparts: List[str] = []

        def bare(n: Node) -> str:
            return n['name'].split('.')[-1]
        if p['op'] == 'insert':
            wparts.append('INSERT INTO ' + wi['into'][0]['name'] + ' (' + ', '.join(bare(c) for c in wi['cols']) + ')')
            wparts.append('VALUES ' + ', '.join('(' + ', '.join(e(x) for x in r['children']) + ')' for r in wi['values']))
        elif p['op'] == 'update':
            wparts.append('UPDATE ' + wi['table'][0]['name'])
            wparts.append('SET ' + ', '.join(bare(a['children'][0]) + ' = ' + e(a['children'][1]) for a in wi['set']))
            if 'where' in wi:
                wparts.append('WHERE ' + e(wi['where'][0]))
        else:
            wparts.append('DELETE FROM ' + wi['from'][0]['name'])
            if 'where' in wi:
                wparts.append('WHERE ' + e(wi['where'][0]))
        if 'returning' in wi:
            wparts.append('RETURNING ' + ', '.join(e(x) for x in wi['returning']))
        return {'sql': '\n'.join(wparts), 'params': params, 'paramNames': order, 'via': bv['via']}
    it = p['items']
    parts = ['SELECT ' + ', '.join(e(x) for x in it['cols']), 'FROM ' + it['from'][0]['name']]
    for j in it.get('join', []):
        parts.append(e(j))
    if 'where' in it:
        parts.append('WHERE ' + e(it['where'][0]))
    if 'group' in it:
        parts.append('GROUP BY ' + ', '.join(e(x) for x in it['group']))
    if 'having' in it:
        parts.append('HAVING ' + e(it['having'][0]))
    if 'order' in it:
        parts.append('ORDER BY ' + ', '.join(e(x) for x in it['order']))
    if 'limit' in it:
        parts.append('LIMIT ' + e(it['limit'][0]))
    if 'offset' in it:
        parts.append('OFFSET ' + e(it['offset'][0]))
    return {'sql': '\n'.join(parts), 'params': params, 'paramNames': order, 'via': bv['via']}


# ---------------------------------------------------------------- Math fiber
def to_math(tree: Tree, written: bool = False) -> Optional[str]:
    """Math notation for a math/eval tree. ``written=True`` uses the shorthand people write (2x)."""
    if tree['parsed']['mode'] != 'math':
        return None

    def m(n: Node, parent: Optional[str] = None, right: bool = False) -> str:
        if n['kind'] == 'value':
            return to_string(n['value'])
        if n['kind'] in ('slot', 'reference'):
            return n['name']
        o = OPS[n['op']]
        c = n['children']
        if n['op'] == 'not':
            s = '¬' + m(c[0], n['op'])
        elif n['op'] == 'pow':
            s = m(c[0], n['op']) + '^' + m(c[1], n['op'], True)
        elif (n['op'] == 'mul' and written and c[0]['kind'] == 'value' and isinstance(c[0]['value'], (int, float))
              and not isinstance(c[0]['value'], bool) and c[1]['kind'] in ('slot', 'reference')):
            s = to_string(c[0]['value']) + c[1]['name']
        elif o['kind'] == 'nary':
            s = (' ' + o['math'] + ' ').join(m(x, n['op']) for x in c)
        else:
            s = m(c[0], n['op']) + ' ' + o['math'] + ' ' + m(c[1], n['op'], True)
        needs = parent and (_prec(n['op']) < _prec(parent) or (right and _prec(n['op']) == _prec(parent) and parent in ('sub', 'div')))
        return '(' + s + ')' if needs else s
    return m(tree['parsed']['items']['expr'][0])


# ---------------------------------------------------------------- JSON fiber
def to_json(tree: Tree) -> Dict[str, Any]:
    """The tree as a JSON document: address (identity), profile, cleaned tree, gaps and meta."""
    def clean(n: Node) -> Dict[str, Any]:
        o: Dict[str, Any] = {'kind': n['kind']}
        if n['kind'] == 'operator':
            o['op'] = n['op']
        if n['kind'] == 'reference':
            o['name'] = n['name']
            if n.get('role'):
                o['role'] = n['role']
        if n['kind'] == 'slot':
            o['name'] = n['name']
            if not n['children']:
                o['gap'] = True
        if n['kind'] == 'value':
            o['value'] = n['value']
        if n.get('type'):
            o['type'] = base_type(n['type'])
        if n.get('children'):
            o['children'] = [clean(c) for c in n['children']]
        return o
    p = tree['parsed']
    meta: Dict[str, Any] = {}
    for k, v in p['meta']:
        meta[k] = v
    out = {'address': identity(tree), 'call': p['call'], 'registry': p['registry'], 'path': p['path'],
           'profile': p['mode'], 'tree': clean(tree['root']), 'gaps': tree['gaps'], 'meta': meta}
    if tree.get('intentSlots'):
        out['requires'] = [clean(n) for n in tree['intentSlots']]
    # bindings for variables nothing uses (kept so from_json loses nothing)
    extra = [clean({'kind': 'slot', 'name': k, 'children': [b['tree']['root'] if b['kind'] == 'call' else b]})
             for k, b in p['bindings'].items() if k not in tree['slots']]
    if extra:
        out['extra_bindings'] = extra
    return out


# ---------------------------------------------------------------- executor
def execute(tree: Tree, store: Optional[Dict[str, Any]] = None, preview: bool = False) -> Dict[str, Any]:
    """Run the tree. A gap always halts: nothing runs or writes while any variable is unbound.

    ``store`` is the data to read and write (default: this session's store, see ``new_store``).
    A write address runs only with ``@``; without it, or with ``preview=True``, it is described, not applied.
    """
    # An error means the address is malformed; "refused" means it is well formed but a safety rule forbids running it.
    err = (next((d for d in tree['diagnostics'] if d['level'] == 'error'), None) or
           next((d for d in tree['diagnostics'] if d['level'] == 'refused'), None))
    if err:
        raise TcxpError(err['msg'], None, err.get('code'))
    if tree['gaps']:
        res: Dict[str, Any] = {'kind': 'halt', 'gaps': tree['gaps']}
        rows = [r for r in (tree.get('required') or []) if r['name'] in tree['gaps']]
        if rows:
            res['requiredBy'] = [{'var': r['name'], 'row': r['row'], 'role': r['role'], 'text': r['text']} for r in rows]
        return res
    return _execute_ready(tree, store, preview)


def _execute_ready(tree: Tree, store: Optional[Dict[str, Any]], preview: bool) -> Dict[str, Any]:
    p = tree['parsed']
    if p['mode'] == 'note':
        return {'kind': 'note', 'text': p['note']}
    if p['mode'] == 'fn':
        return {'kind': 'call', 'value': _invoke(tree), 'returns': p['fn']['returns']} if p['call'] else {'kind': 'address'}
    vals = _bound_values(tree)['vals']
    if p['mode'] == 'math':
        v = _eval(p['items']['expr'][0], {}, {'math': True}, vals, [])
        return {'kind': 'value', 'value': v, 'decision': v if isinstance(v, bool) else None}
    st = store if store is not None else _STORE
    if p['mode'] == 'write':
        return _execute_write(tree, vals, st, not p['call'] or bool(preview))
    return dict({'kind': 'rows'}, **_execute_sql(tree, vals, st))


_DATEISH = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')


def _is_dateish(v: Any) -> bool:
    return isinstance(v, str) and _DATEISH.match(v) is not None


def _to_cmp(v: Any) -> Any:
    if _is_dateish(v):
        return date_parse(v + 'T00:00:00Z' if u16_len(v) <= 10 else re.sub(r'\+00\Z', '+00:00', v.replace(' ', 'T', 1)))
    return v


def _cmp(a: Any, b: Any) -> int:
    a, b = _to_cmp(a), _to_cmp(b)
    return -1 if lt(a, b) else 1 if lt(b, a) else 0


def _and3(vs: List[Any]) -> Any:
    return False if any(v is False for v in vs) else None if any(v is None for v in vs) else True


def _or3(vs: List[Any]) -> Any:
    return True if any(v is True for v in vs) else None if any(v is None for v in vs) else False


def _canon_char(ch: str) -> str:
    # RegExp ignoreCase canonicalization without the u flag (per UTF-16 code unit)
    u = ch.upper()
    if len(u) != 1 or (ord(ch) >= 128 and ord(u) < 128):
        return ch
    return u


def _like(a: Any, pt: Any, ci: bool) -> bool:
    pat, subj = u16(to_string(pt)), u16(to_string(a))
    if ci:
        pat = ''.join(_canon_char(c) for c in pat)
        subj = ''.join(_canon_char(c) for c in subj)
    rx = re.sub(r'[.*+?^${}()|\[\]\\]', lambda m: '\\' + m.group(0), pat).replace('%', '.*').replace('_', '.')
    return re.fullmatch(rx, subj, re.DOTALL) is not None


def _eval(n: Node, row: Dict[str, Any], ctx: Optional[Dict[str, Any]], vals: Dict[str, Any], scope: List[str]) -> Any:
    kind = n['kind']
    if kind == 'value':
        return n['value']
    if kind == 'slot':
        if n['name'] not in vals:
            raise TcxpError('$' + n['name'] + ' is a gap')
        return vals[n['name']]
    if kind == 'reference':
        name = n['name']
        if ctx and ctx.get('aliasVals') is not None and '.' not in name and name in ctx['aliasVals']:
            return ctx['aliasVals'][name]
        if '.' in name:
            if name not in row:
                raise TcxpError('Column "' + name + '" is not available here')
            return row[name]
        hit = next((t for t in scope if (t + '.' + name) in row), None)
        if hit is None:
            raise TcxpError('Unknown column "' + name + '"')
        return row[hit + '.' + name]
    op = n['op']
    o = OPS[op]
    c = n['children']

    def v(i: int) -> Any:
        return _eval(c[i], row, ctx, vals, scope)
    if o.get('agg'):
        g = ctx.get('group') if ctx else None
        if g is None:
            raise TcxpError(op + '() is only allowed in cols, having or order')
        if op == 'count' and c[0]['kind'] == 'reference' and c[0]['name'] == '*':
            return len(g)
        xs = [x for x in (_eval(c[0], r, ctx, vals, scope) for r in g) if x is not None]
        if op == 'count':
            return len(xs)
        if not xs:
            return None
        if op == 'sum':
            return functools.reduce(lambda a, b: num_add(a, to_number(b)), xs, 0)
        if op == 'avg':
            return num_div(functools.reduce(lambda a, b: num_add(a, to_number(b)), xs, 0), len(xs))
        if op == 'min':
            return functools.reduce(lambda a, b: a if _cmp(a, b) <= 0 else b, xs)
        if op == 'max':
            return functools.reduce(lambda a, b: a if _cmp(a, b) >= 0 else b, xs)
    if op in ('eq', 'ne', 'lt', 'le', 'gt', 'ge'):
        a, b = v(0), v(1)
        if a is None or b is None:
            return None
        r = _cmp(a, b)
        return {'eq': r == 0, 'ne': r != 0, 'lt': r < 0, 'le': r <= 0, 'gt': r > 0, 'ge': r >= 0}[op]
    if op in ('like', 'ilike'):
        a, pt = v(0), v(1)
        if a is None or pt is None:
            return None
        return _like(a, pt, op == 'ilike')
    if op in ('add', 'sub', 'mul', 'div'):
        a, b = v(0), v(1)
        if a is None or b is None:
            return None
        a, b = to_number(a), to_number(b)
        if op == 'div' and b == 0:
            raise TcxpError('Division by zero')
        r = {'add': num_add, 'sub': num_sub, 'mul': num_mul, 'div': num_div}[op](a, b)
        if op == 'div' and is_integer(a) and is_integer(b) and not (ctx and ctx.get('math')):
            return norm(math.trunc(r)) if isinstance(r, float) and r == r and abs(r) != float('inf') else r
        return r
    if op == 'pow':
        a, b = v(0), v(1)
        return None if a is None or b is None else js_pow(a, b)
    if op == 'and':
        return _and3([v(i) for i in range(len(c))])
    if op == 'or':
        return _or3([v(i) for i in range(len(c))])
    if op == 'not':
        a = v(0)
        return None if a is None else not truthy(a)
    if op == 'in':
        a = v(0)
        if a is None:
            return None
        lst = [v(i + 1) for i in range(len(c) - 1)]
        if any(x is not None and _cmp(a, x) == 0 for x in lst):
            return True
        return None if any(x is None for x in lst) else False
    if op == 'between':
        a, lo, hi = v(0), v(1), v(2)
        if a is None or lo is None or hi is None:
            return None
        return _cmp(a, lo) >= 0 and _cmp(a, hi) <= 0
    if op == 'isnull':
        return v(0) is None
    if op == 'notnull':
        return v(0) is not None
    if op == 'round':
        a = v(0)
        if a is None:
            return None
        d = to_number(v(1)) if len(c) > 1 else 0
        f = js_pow(10, d)
        return num_div(num_mul(js_sign(a), js_round(num_add(num_mul(abs(to_number(a)), f), 1e-9))), f)
    if op == 'year':
        a = v(0)
        if a is None:
            return None
        t = _to_cmp(a)
        return utc_year(date_parse(t) if isinstance(t, str) else t)
    if op == 'lower':
        a = v(0)
        return None if a is None else to_string(a).lower()
    if op == 'upper':
        a = v(0)
        return None if a is None else to_string(a).upper()
    if op == 'coalesce':
        for i in range(len(c)):
            a = v(i)
            if a is not None:
                return a
        return None
    if op in ('as', 'asc', 'desc'):
        return v(0)
    raise TcxpError('Cannot evaluate ' + op)


def _slice(lst: List[Any], start: Any, end: Any) -> List[Any]:
    """Array.prototype.slice with JavaScript's argument conversion."""
    n = len(lst)

    def rel(x: Any) -> int:
        x = to_number(x)
        if x != x:
            return 0
        if x == float('inf'):
            return n
        if x == float('-inf'):
            return 0
        x = math.trunc(x)
        return max(n + x, 0) if x < 0 else min(x, n)
    return lst[rel(start):rel(end)]


def _execute_sql(tree: Tree, vals: Dict[str, Any], store: Dict[str, Any]) -> Dict[str, Any]:
    it = tree['parsed']['items']
    db = REGISTRIES[tree['parsed']['registry']]['db']

    def tdef(name: str) -> Dict[str, Any]:
        t = next((x for x in db['schema']['tables'] if x['name'] == name), None)
        if not t:
            raise TcxpError('Unknown table "' + name + '"')
        return t

    def load(name: str) -> List[Dict[str, Any]]:
        t = tdef(name)
        return [{name + '.' + c[0]: r[i] for i, c in enumerate(t['columns'])} for r in table_rows(tree['parsed']['registry'], name, store)]

    def null_row(names: List[str]) -> Dict[str, Any]:
        o: Dict[str, Any] = {}
        for nm in names:
            for c in tdef(nm)['columns']:
                o[nm + '.' + c[0]] = None
        return o
    scope = [it['from'][0]['name']]

    def ev(n: Node, row: Dict[str, Any], ctx: Optional[Dict[str, Any]] = None) -> Any:
        return _eval(n, row, ctx, vals, scope)

    rows = load(it['from'][0]['name'])
    for j in it.get('join', []):
        tn = j['children'][0]['name']
        right = load(tn)
        cond = j['children'][1] if len(j['children']) > 1 else None
        out: List[Dict[str, Any]] = []
        left_names = list(scope)
        scope.append(tn)

        def match(lrow: Dict[str, Any], rrow: Dict[str, Any], j: Node = j, cond: Optional[Node] = cond) -> bool:
            if j['op'] == 'cross' or cond is None:
                return True
            return ev(cond, {**lrow, **rrow}) is True
        if j['op'] in ('cross', 'inner'):
            for lrow in rows:
                for rrow in right:
                    if match(lrow, rrow):
                        out.append({**lrow, **rrow})
        elif j['op'] in ('left', 'full'):
            used = set()
            for lrow in rows:
                anyhit = False
                for ri, rrow in enumerate(right):
                    if match(lrow, rrow):
                        anyhit = True
                        used.add(ri)
                        out.append({**lrow, **rrow})
                if not anyhit:
                    out.append({**lrow, **null_row([tn])})
            if j['op'] == 'full':
                for ri, rrow in enumerate(right):
                    if ri not in used:
                        out.append({**null_row(left_names), **rrow})
        elif j['op'] == 'right':
            for rrow in right:
                anyhit = False
                for lrow in rows:
                    if match(lrow, rrow):
                        anyhit = True
                        out.append({**lrow, **rrow})
                if not anyhit:
                    out.append({**null_row(left_names), **rrow})
        rows = out
    if 'where' in it:
        rows = [r for r in rows if ev(it['where'][0], r) is True]

    def has_agg(n: Node) -> bool:
        return n['kind'] == 'operator' and bool((OPS.get(n['op']) or {}).get('agg') or any(has_agg(x) for x in n['children']))
    grouped = 'group' in it or any(has_agg(x) for x in it['cols']) or 'having' in it
    units: List[Dict[str, Any]]
    if grouped:
        groups: Dict[str, List[Dict[str, Any]]] = {}
        if 'group' in it:
            for r in rows:
                k = stringify([ev(g, r) for g in it['group']])
                groups.setdefault(k, []).append(r)
        else:
            groups['all'] = rows
        units = [{'row': g[0] if g else {}, 'ctx': {'group': g}} for g in groups.values()]
        if 'having' in it:
            units = [u for u in units if ev(it['having'][0], u['row'], u['ctx']) is True]
    else:
        units = [{'row': r, 'ctx': {}} for r in rows]
    columns: List[str] = []
    cols_done = False

    def name_of(n: Node) -> str:
        if n['kind'] == 'operator' and n['op'] == 'as':
            return n['children'][1]['name']
        if n['kind'] == 'reference':
            return n['name'].split('.')[-1]
        if n['kind'] == 'operator' and OPS[n['op']]['kind'] in ('func', 'extract'):
            return OPS[n['op']]['sql']
        return '?column?'
    for u in units:
        out_row: List[Any] = []
        u['ctx']['aliasVals'] = {}
        for item in it['cols']:
            if item['kind'] == 'reference' and item['name'] == '*':
                for t in scope:
                    for c in tdef(t)['columns']:
                        out_row.append(u['row'].get(t + '.' + c[0]))
                        if not cols_done:
                            columns.append(c[0])
            else:
                x = ev(item, u['row'], u['ctx'])
                out_row.append(x)
                if not cols_done:
                    columns.append(name_of(item))
                if item['kind'] == 'operator' and item['op'] == 'as':
                    u['ctx']['aliasVals'][item['children'][1]['name']] = x
        cols_done = True
        u['out'] = out_row
    if not cols_done:
        for item in it['cols']:
            if item['kind'] == 'reference' and item['name'] == '*':
                for t in scope:
                    columns.extend(c[0] for c in tdef(t)['columns'])
            else:
                columns.append(name_of(item))
    if 'order' in it:
        keys = [{'desc': o['kind'] == 'operator' and o['op'] == 'desc',
                 'expr': o['children'][0] if o['kind'] == 'operator' and o['op'] in ('asc', 'desc') else o} for o in it['order']]
        for u in units:
            u['sort'] = [ev(k['expr'], u['row'], u['ctx']) for k in keys]

        def compare(pa: Any, pb: Any) -> int:
            a, ia = pa
            b, ib = pb
            for i, k in enumerate(keys):
                x, y = a['sort'][i], b['sort'][i]
                if x is None and y is None:
                    r = 0
                elif x is None:
                    r = 1
                elif y is None:
                    r = -1
                else:
                    r = _cmp(x, y)
                if k['desc']:
                    r = -r
                if r:
                    return r
            return ia - ib
        units = [u for u, _ in sorted(((u, i) for i, u in enumerate(units)), key=functools.cmp_to_key(compare))]
    out_rows = [u['out'] for u in units]
    off = to_number(ev(it['offset'][0], {})) if 'offset' in it else 0
    lim = to_number(ev(it['limit'][0], {})) if 'limit' in it else float('inf')
    return {'columns': columns, 'rows': _slice(out_rows, off, num_add(off, lim) if off == off and lim == lim else float('nan'))}


# ---------------------------------------------------------------- pulse
def with_pulse(tree: Tree, step: Any, at: Optional[str] = None, debounce: Optional[int] = None, parent: Optional[str] = None,
               extra: Optional[Dict[str, Any]] = None) -> str:
    """The canonical address with one ``~pulse`` row stamped first among the meta keys.

    ``parent`` is the identity of the previous committed state (None for the first), so pulses form a chain.
    ``extra`` adds fields to the row, e.g. ``{'undo': [inverse addresses]}`` for an executed write.
    """
    meta = [m for m in tree['parsed']['meta'] if m[0] != 'pulse']
    meta.insert(0, ['pulse', [{'step': step, 'at': at if truthy(at) else now_iso(),
                               'debounce_ms': DEBOUNCE_MS if debounce is None else debounce,
                               'parent': parent if truthy(parent) else None, **(extra or {})}]])
    t = dict(tree, parsed=dict(tree['parsed'], meta=meta))
    return serialize(t)['uri']


# ---------------------------------------------------------------- filter generator
def _mulberry32(seed: Any) -> Callable[[], float]:
    state = [to_int32(seed)]

    def rand() -> float:
        a = state[0]
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        a = a - 0x100000000 if a >= 0x80000000 else a
        state[0] = a
        t = imul(a ^ (u32(a) >> 15), 1 | a)
        t = ((t + imul(t ^ (u32(t) >> 7), 61 | t)) & 0xFFFFFFFF) ^ (t & 0xFFFFFFFF)
        return u32(t ^ (u32(t) >> 14)) / 4294967296
    return rand


_PHRASES = ['How many hours did we bill?', 'Is the route safe?', 'Who joined in August?', 'Q3 revenue & margin',
            'Ticket #42 follow-up', 'Discount of 15% applied', 'Check the roster before Friday']
_WORDS = ['world', 'team', 'Ada', 'café', 'R&D', 'issue #7', '100%', 'a b']
_FK = re.compile(r'REFERENCES ([A-Za-z0-9_]+)\(([A-Za-z0-9_]+)\)')
# The read stream draws only on the registries v0.1 shipped, so a seed gives the same addresses whatever
# registries are added later (client.demo, register_csv tables).
READ_REGISTRIES = ['school.demo', 'firm.demo', 'fleet.demo', 'registry']


class FilterGenerator:
    """Random, well-formed tcxp addresses (seeded, reproducible across Python and JavaScript),
    plus ``FilterGenerator.filter`` to check any address against the protocol rules."""

    def __init__(self, seed: Any = None) -> None:
        self.seed = 1 if seed is None else seed
        self.rand = _mulberry32(self.seed)
        self.count = 0

    def int(self, n: builtins.int) -> builtins.int:
        return math.floor(self.rand() * n)

    def pick(self, a: List[Any]) -> Any:
        return a[self.int(len(a))]

    def chance(self, p: float) -> bool:
        return self.rand() < p

    def batch(self, n: builtins.int) -> List[str]:
        return [self.next() for _ in range(n)]

    def __iter__(self) -> Iterator[str]:
        return self

    def __next__(self) -> str:
        return self.next()

    def next(self) -> str:
        self.count += 1
        r = self.rand()
        base = self.sql() if r < 0.6 else self.math() if r < 0.85 else self.call()
        tree = parse_uri(base)
        meta = self.meta(tree)
        return base + ('&' if '?' in base else '?') + '&'.join(meta) if meta else base

    def lit(self, v: Any, fam: Any) -> str:
        if fam == 'number':
            return to_string(v)
        if fam == 'time':
            return "date'" + to_string(v)[:10] + "'"
        return "'" + _enc_literal(to_string(v).replace("'", "''")) + "'"

    def with_bindings(self, uri_no_bind: str, binds: Dict[str, str]) -> str:
        tree = parse_uri(uri_no_bind)
        pairs = ['$' + s + '=' + binds[s] for s in tree['slots'] if s in binds]
        return uri_no_bind + '&' + '&'.join(pairs) if pairs else uri_no_bind

    def sql(self) -> str:
        reg_name = self.pick(['school.demo', 'firm.demo'])
        db = REGISTRIES[reg_name]['db']
        tables = db['schema']['tables']
        fks = []
        for t in tables:
            for c in t['columns']:
                m = _FK.search(c[2] or '')
                if m:
                    fks.append([t['name'], c[0], m.group(1), m.group(2)])
        base = self.pick(tables)['name']
        scope = [base]
        joins: List[str] = []
        if self.chance(0.4):
            edges = [f for f in fks if f[0] == base or f[2] == base]
            if edges:
                ct, cc, pt, pc = self.pick(edges)
                other = pt if ct == base else ct
                kind = self.pick(['inner', 'left', 'right', 'full'])
                joins.append(kind + '(' + other + ',eq(' + other + '.' + (cc if other == ct else pc) + ',' + base + '.' + (cc if base == ct else pc) + '))')
                scope.append(other)
        qual = len(joins) > 0
        cols: List[Dict[str, Any]] = []
        for t in scope:
            tdef = next(x for x in tables if x['name'] == t)
            for i, c in enumerate(tdef['columns']):
                vals = [r[i] for r in db['seed'][t]]
                cols.append({'t': t, 'c': c[0], 'ref': t + '.' + c[0] if qual else c[0], 'fam': _family(c[1]),
                             'vals': [v for v in vals if v is not None], 'nullable': any(v is None for v in vals), 'pk': i == 0})
        binds: Dict[str, str] = {}
        vn = [0]

        def new_name() -> str:
            vn[0] += 1
            return 'v' + str(vn[0])

        def operand(col: Dict[str, Any]) -> str:
            v = self.pick(col['vals'])
            if self.chance(0.4):
                name = new_name()
                if not self.chance(0.12):
                    binds[name] = self.lit(v, col['fam'])
                return '$' + name
            return self.lit(v, col['fam'])

        def pred() -> str:
            col = self.pick([c for c in cols if c['vals']])
            if col['nullable'] and self.chance(0.25):
                return ('isnull(' if self.chance(0.5) else 'notnull(') + col['ref'] + ')'
            if col['fam'] == 'text':
                if reg_name == 'school.demo' and col['c'] == 'cohort' and self.chance(0.3):
                    name = new_name()
                    binds[name] = '@!tcxp:/school.demo/fn/current_cohort'
                    return 'eq(' + col['ref'] + ',$' + name + ')'
                if self.chance(0.3):
                    a = self.lit(self.pick(col['vals']), 'text')
                    b = self.lit(self.pick(col['vals']), 'text')
                    return 'in(' + col['ref'] + ',' + a + ',' + b + ')'
                op = self.pick(['eq', 'ne'])
                return op + '(' + col['ref'] + ',' + operand(col) + ')'
            if self.chance(0.2):
                a, b = self.pick(col['vals']), self.pick(col['vals'])
                lo, hi = (a, b) if _cmp(a, b) <= 0 else (b, a)
                return 'between(' + col['ref'] + ',' + self.lit(lo, col['fam']) + ',' + self.lit(hi, col['fam']) + ')'
            op = self.pick(['eq', 'ne', 'lt', 'le', 'gt', 'ge'])
            return op + '(' + col['ref'] + ',' + operand(col) + ')'

        def bool_expr(depth: int) -> str:
            if depth > 0 and self.chance(0.45):
                op = self.pick(['and', 'and', 'or'])
                n = 2 + self.int(2)
                parts = [bool_expr(depth - 1) for _ in range(n)]
                return op + '(' + ','.join(parts) + ')'
            p = pred()
            return 'not(' + p + ')' if self.chance(0.1) else p

        keys: List[str] = []
        if self.chance(0.25):
            g = self.pick([c for c in cols if not c['pk']])
            numeric = [c for c in cols if c['fam'] == 'number' and not c['pk']]
            sel = [g['ref'], 'as(count(*),n)']
            if numeric and self.chance(0.7):
                fn = self.pick(['sum', 'avg', 'min', 'max'])
                sel.append('as(' + fn + '(' + self.pick(numeric)['ref'] + '),agg)')
            keys.append('cols=' + ','.join(sel))
            keys.append('from=' + base)
            keys.extend('join=' + j for j in joins)
            if self.chance(0.6):
                keys.append('where=' + bool_expr(1))
            keys.append('group=' + g['ref'])
            if self.chance(0.3):
                name = new_name()
                if not self.chance(0.12):
                    binds[name] = str(1 + self.int(3))
                keys.append('having=ge(count(*),$' + name + ')')
            keys.append('order=asc(' + g['ref'] + ')')
        else:
            if self.chance(0.25):
                sel = ['*']
            else:
                sel = []
                for _ in range(1 + self.int(3)):
                    c = self.pick(cols)
                    if c['ref'] not in sel:
                        sel.append(c['ref'])
            keys.append('cols=' + ','.join(sel))
            keys.append('from=' + base)
            keys.extend('join=' + j for j in joins)
            if self.chance(0.75):
                keys.append('where=' + bool_expr(2))
            if self.chance(0.5):
                c = self.pick(cols)
                tail = [o for o in ('asc(' + next(x for x in cols if x['t'] == t and x['pk'])['ref'] + ')' for t in scope) if o != 'asc(' + c['ref'] + ')']
                keys.append('order=' + ','.join([('desc(' if self.chance(0.5) else 'asc(') + c['ref'] + ')'] + tail))
                if self.chance(0.4):
                    if self.chance(0.5):
                        keys.append('limit=' + str(1 + self.int(5)))
                    else:
                        name = new_name()
                        if not self.chance(0.12):
                            binds[name] = str(1 + self.int(5))
                        keys.append('limit=$' + name)
        return self.with_bindings('!tcxp:/' + reg_name + '/sql/select?' + '&'.join(keys), binds)

    def math(self) -> str:
        vars_ = ['x', 'y', 'z'][:1 + self.int(3)]

        def arith(d: int) -> str:
            if d == 0 or self.chance(0.35):
                return '$' + self.pick(vars_) if self.chance(0.5) else str(self.int(19) - 9)
            op = self.pick(['add', 'sub', 'mul'])
            a = arith(d - 1)
            b = arith(d - 1)
            return op + '(' + a + ',' + b + ')'

        def cmpx() -> str:
            op = self.pick(['eq', 'ne', 'lt', 'le', 'gt', 'ge'])
            a = arith(2)
            b = arith(1)
            return op + '(' + a + ',' + b + ')'
        r = self.rand()
        if r < 0.2:
            expr = arith(3)
        elif r < 0.4:
            op = self.pick(['and', 'or'])
            a = cmpx()
            b = cmpx()
            expr = op + '(' + a + ',' + b + ')'
        else:
            expr = cmpx()
        binds: Dict[str, str] = {}
        for v in vars_:
            if self.chance(0.85):
                binds[v] = str(self.int(11) - 5)
        reg = self.pick(READ_REGISTRIES)
        return self.with_bindings('!tcxp:/' + reg + '/math/eval?expr=' + expr, binds)

    def call(self) -> str:
        if self.chance(0.3):
            return '@!tcxp:/school.demo/fn/current_cohort'
        return '@!tcxp:/registry/hello?do=' + _enc_literal(self.pick(_WORDS))

    def next_write(self) -> str:
        """A random insert, update or delete as a plain (preview) address; the same stream as JavaScript's
        ``nextWrite``. Mostly valid; a few rows deliberately break a constraint. Separate from ``next``, so
        the read stream for a given seed never changes."""
        self.count += 1
        reg_name = self.pick(['school.demo', 'firm.demo'])
        db = REGISTRIES[reg_name]['db']
        t = self.pick(db['schema']['tables'])
        seed = db['seed'][t['name']]
        cols = t['columns']
        flags = [_col_flags(c) for c in cols]

        def vals_of(i: builtins.int) -> List[Any]:
            return [r[i] for r in seed if r[i] is not None]
        binds: Dict[str, str] = {}
        vn = [0]

        def operand(v: Any, typ: Any) -> str:
            if self.chance(0.35):
                vn[0] += 1
                name = 'v' + str(vn[0])
                if not self.chance(0.1):
                    binds[name] = _literal_of(v, typ)
                return '$' + name
            return _literal_of(v, typ)
        pk_max = max(vals_of(0))

        def parent_vals(f: List[str]) -> List[Any]:
            pt = next(x for x in db['schema']['tables'] if x['name'] == f[0])
            i = next(k for k, c in enumerate(pt['columns']) if c[0] == f[1])
            return [r[i] for r in db['seed'][f[0]]]

        def fresh_number(c: List[Any], i: builtins.int) -> Any:
            hi = max(to_number(x) for x in vals_of(i))
            if base_type(c[1]) == 'numeric':
                return num_div(js_round(num_mul(num_sub(num_mul(num_mul(self.rand(), hi), 1.2), 0.2), 4)), 4)
            return js_round(num_mul(num_mul(self.rand(), hi), 1.2))

        def where() -> str:
            r = self.rand()
            if r < 0.1:
                return 'true'
            if r < 0.65:
                v = self.pick(vals_of(0)) if self.chance(0.85) else pk_max + 7
                return 'eq(' + cols[0][0] + ',' + operand(v, cols[0][1]) + ')'
            i = self.int(len(cols))
            c = cols[i]
            xs = vals_of(i)
            if not xs:
                return 'isnull(' + c[0] + ')'
            op = self.pick(['eq', 'ne']) if _family(c[1]) == 'text' else self.pick(['eq', 'ne', 'lt', 'le', 'gt', 'ge'])
            return op + '(' + c[0] + ',' + operand(self.pick(xs), c[1]) + ')'

        def returning() -> str:
            if self.chance(0.5):
                return ''
            if self.chance(0.4):
                return '&returning=*'
            sel: List[str] = []
            for _ in range(1 + self.int(3)):
                c = self.pick(cols)[0]
                if c not in sel:
                    sel.append(c)
            return '&returning=' + ','.join(sel)
        kind = self.pick(['insert', 'insert', 'update', 'update', 'delete'])
        if kind == 'insert':
            use = [i == 0 or flags[i]['notNull'] or self.chance(0.7) for i in range(len(cols))]
            names = [c[0] for i, c in enumerate(cols) if use[i]]
            n = 1 + self.int(3)
            rows = []
            for k in range(n):
                vals: List[str] = []
                for i, c in enumerate(cols):
                    if not use[i]:
                        continue
                    f = flags[i]
                    if i == 0:
                        v = self.pick(vals_of(0)) if self.chance(0.05) else pk_max + 1 + k
                    elif f['unique']:
                        v = self.pick(vals_of(i)) if self.chance(0.05) else 'gen-' + to_string(self.seed) + '-' + str(self.count) + '-' + str(k)
                    elif f['fk']:
                        v = 999 if self.chance(0.07) else self.pick([x for x in parent_vals(f['fk']) if x is not None])
                    elif not f['notNull'] and self.chance(0.15):
                        v = None
                    elif f['notNull'] and self.chance(0.03):
                        v = None
                    elif _family(c[1]) == 'number' and self.chance(0.3):
                        v = fresh_number(c, i)
                    elif _family(c[1]) == 'text' and self.chance(0.2):
                        v = self.pick(_WORDS)
                    else:
                        v = self.pick(vals_of(i))
                    vals.append(operand(v, c[1]))
                rows.append('row(' + ','.join(vals) + ')')
            uri = 'insert?into=' + t['name'] + '&cols=' + ','.join(names) + '&values=' + ','.join(rows)
            uri += returning()
        elif kind == 'update':
            choices = [i for i in range(len(cols)) if i > 0 and not flags[i]['unique']]
            n = min(len(choices), 1 + self.int(2))
            chosen: List[builtins.int] = []
            while len(chosen) < n:
                i = self.pick(choices)
                if i not in chosen:
                    chosen.append(i)
            assigns = []
            for i in chosen:
                c, f = cols[i], flags[i]
                if f['fk']:
                    e = operand(999 if self.chance(0.1) else self.pick([x for x in parent_vals(f['fk']) if x is not None]), c[1])
                elif _family(c[1]) == 'number' and self.chance(0.5):
                    fn = self.pick(['add', 'sub'])
                    amt = self.pick([0.25, 0.5, 1, 2.75, 7]) if base_type(c[1]) == 'numeric' else self.pick([1, 2, 10])
                    e = fn + '(' + c[0] + ',' + operand(amt, c[1]) + ')'
                elif not f['notNull'] and self.chance(0.15):
                    e = 'null'
                else:
                    e = operand(self.pick(vals_of(i)), c[1])
                assigns.append('assign(' + c[0] + ',' + e + ')')
            uri = 'update?table=' + t['name'] + '&set=' + ','.join(assigns) + '&where=' + where()
            uri += returning()
        else:
            uri = 'delete?from=' + t['name'] + '&where=' + where()
            uri += returning()
        base = '!tcxp:/' + reg_name + '/sql/' + uri
        tree = parse_uri(base)
        pairs = ['$' + sl + '=' + binds[sl] for sl in tree['slots'] if sl in binds]
        return serialize(parse_uri(base + '&' + '&'.join(pairs) if pairs else base))['uri']

    def random_pointer(self, tree: Tree) -> Optional[str]:
        if tree['slots'] and self.chance(0.3):
            return '/$' + self.pick(tree['slots'])
        keys = list(tree['parsed']['items'].keys())
        if not keys:
            return None
        key = self.pick(keys)
        lst = tree['parsed']['items'][key]
        idx = self.int(len(lst))
        node = lst[idx]
        path: List[Any] = ['', key, idx]
        while node.get('children') and self.chance(0.55):
            i = self.int(len(node['children']))
            path.append(i)
            node = node['children'][i]
        return '/'.join(str(x) for x in path)

    def meta(self, tree: Tree) -> List[str]:
        parts: List[str] = []
        notes = ['!tcxp:/' + r + '/' + n for r in READ_REGISTRIES for n in REGISTRIES[r]['notes']]
        if self.chance(0.6):
            step = 1 + self.int(500)
            d, h, mi, s, ms = self.int(28), self.int(24), self.int(60), self.int(60), self.int(1000)
            at = iso_string(utc_ms(2026, 9, 1 + d, h, mi, s, ms))
            parts.append('~pulse=' + _meta_text([{'step': step, 'at': at, 'debounce_ms': DEBOUNCE_MS}]))
        if self.chance(0.5):
            parts.append('~intent=' + _meta_text(self.pick(_PHRASES)))
        if self.chance(0.5):
            rows = []
            n = 1 + self.int(2)
            for i in range(n):
                ptr = self.random_pointer(tree)
                if not ptr:
                    break
                row: Dict[str, Any] = {'id': 's' + str(i + 1), 'on': [ptr]}
                for f in FACETS:
                    row[f] = (self.pick(notes) if self.chance(0.8) else 'Inline note for ' + f) if self.chance(0.5) else None
                rows.append(row)
            if rows:
                parts.append('~spikes=' + _meta_text(rows))
        if self.chance(0.2):
            frm = self.pick(['agent:planner', 'human:analyst', 'sensor:hull-07'])
            to = self.pick(['human:captain', 'agent:auditor', 'human:cpa'])
            ch = self.pick(['chat', 'email', 'telemetry'])
            parts.append('~observe=' + _meta_text([{'from': frm, 'to': to, 'channel': ch}]))
        if self.chance(0.2):
            amount = num_div(js_round(num_mul(num_sub(num_mul(self.rand(), 2000), 1000), 100)), 100)
            parts.append('~outcome=' + _meta_text([{'amount': amount, 'currency': 'USD'}]))
        return parts

    @staticmethod
    def filter(uri: str) -> Dict[str, Any]:
        """Check any address against the protocol rules: ``{'ok', 'rules': [{id, name, pass, msg}], 'tree'}``."""
        res: Dict[str, bool] = {}
        tree: Optional[Tree] = None
        err: Optional[BaseException] = None
        res['scheme'] = re.match(r'@?!tcxp:/', uri) is not None
        keys: List[str] = []
        try:
            q = uri.find('?')
            keys = [] if q < 0 else [p[0] for p in _split_pairs(uri[q + 1:])]
        except Exception as e:
            err = e
        first_meta = next((i for i, k in enumerate(keys) if k[:1] == '~'), -1)
        res['meta-last'] = first_meta < 0 or all(k[:1] == '~' for k in keys[first_meta:])
        try:
            tree = parse_uri(uri)
        except Exception as e:
            err = e
        res['call-target'] = not uri.startswith('@') or bool(tree and tree['parsed']['mode'] in ('fn', 'write'))
        res['grammar'] = bool(tree) and not any(d['level'] == 'error' for d in tree['diagnostics'])  # type: ignore[index]
        res['canonical'] = bool(tree) and serialize(tree)['uri'] == uri  # type: ignore[arg-type]
        rules = [{'id': rid, 'name': name, 'pass': res[rid],
                  'msg': str(err) if not res[rid] and err and rid in ('grammar', 'call-target') else None}
                 for rid, name in RULES]
        return {'ok': all(r['pass'] for r in rules), 'rules': rules, 'tree': tree}


# ---------------------------------------------------------------- writes (v0.2)
# sql/insert, sql/update, sql/delete. Without @ an address describes a proposed write (result kind
# "preview"); with @ it performs it (kind "write") on this session's copy of the registry data.
# The shipped seed is never mutated. Constraint checks follow PostgreSQL's order: value coercion,
# then NOT NULL, CHECK and UNIQUE row by row, then foreign keys at the end of the statement.
# Error codes are PostgreSQL SQLSTATEs so tests can compare failures as well as successes.
def _write_table(parsed: Dict[str, Any]) -> str:
    return parsed['items'][{'insert': 'into', 'update': 'table', 'delete': 'from'}[parsed['op']]][0]['name']


_FK_RE = re.compile(r'REFERENCES ([A-Za-z0-9_]+)\(([A-Za-z0-9_]+)\)')
_CHECK_RE = re.compile(r'CHECK \((.*)\)\Z')


def _col_flags(c: List[Any]) -> Dict[str, Any]:
    spec = c[2] or ''
    fk = _FK_RE.search(spec)
    ck = _CHECK_RE.search(spec)
    return {'notNull': bool(re.search(r'NOT NULL|PRIMARY KEY', spec)), 'unique': bool(re.search(r'UNIQUE|PRIMARY KEY', spec)),
            'pk': 'PRIMARY KEY' in spec, 'fk': [fk.group(1), fk.group(2)] if fk else [], 'check': ck.group(1) if ck else None}


def _build_write_tree(parsed: Dict[str, Any], diagnostics: List[Dict[str, Any]], slots_seen: List[str]) -> Node:
    items, op = parsed['items'], parsed['op']
    db = REGISTRIES[parsed['registry']]['db']
    tname = _write_table(parsed)
    t = next((x for x in db['schema']['tables'] if x['name'] == tname), None)
    cols_t: Dict[str, str] = {}
    if t:
        for c in t['columns']:
            cols_t[c[0]] = c[1]

    def col_of(name: str) -> Optional[str]:
        parts = name.split('.')
        if len(parts) == 2 and parts[0] != tname:
            return None
        return parts[-1] if cols_t.get(parts[-1]) else None
    aliases: Dict[str, Any] = {}

    def resolve_ref(node: Node, ctx: str) -> None:
        if node['name'] == '*' or node.get('role') == 'declares':
            return
        if ctx == 'table':
            if not t:
                diagnostics.append({'level': 'error', 'msg': 'Unknown table "' + node['name'] + '"'})
            node['role'] = 'table'
            return
        if ctx == 'value':
            diagnostics.append({'level': 'error', 'msg': '"' + node['name'] + '" is a column; inserted values must be literals, variables or expressions on them'})
            return
        if not t:
            return
        if '.' not in node['name'] and node['name'] in aliases:
            node['type'] = aliases[node['name']]
            node['role'] = 'alias'
            return
        c = col_of(node['name'])
        if not c:
            diagnostics.append({'level': 'error', 'msg': 'Table ' + tname + ' has no column "' + node['name'] + '"'})
        node['type'] = cols_t[c] if c else None
        node['role'] = 'column'
    walk = _make_walker(resolve_ref, aliases, slots_seen)

    # A variable or literal written straight into a column takes that column's type; a literal of another kind is an error.
    def target(n: Node, col: Optional[str]) -> None:
        if not col:
            return
        typ = cols_t[col]
        if n['kind'] == 'slot':
            n['type'] = typ
            n['typedBy'] = tname + '.' + col
            n['writeTarget'] = True
        if (n['kind'] == 'value' and n['type'] != 'null' and _family(typ) != _family(n['type'])
                and not (_family(typ) == 'time' and n['type'] == 'text')):
            shown = "'" + to_string(n['value']) + "'" if n['type'] == 'text' else to_string(n['value'])
            diagnostics.append({'level': 'error', 'code': '42804', 'msg': 'Column ' + tname + '.' + col + ' is ' + to_string(base_type(typ)) +
                                ', and ' + shown + ' is a ' + n['type'] + ' value'})

    for k in WRITE_ORDER[op]:
        lst = items.get(k)
        if not lst:
            continue
        if k in ('into', 'table', 'from'):
            walk(lst[0], 'table')
            continue
        if k == 'cols':
            seen: List[Optional[str]] = []
            for r in lst:
                resolve_ref(r, 'expr')
                c = col_of(r['name'])
                if c and c in seen:
                    diagnostics.append({'level': 'error', 'msg': 'Column "' + c + '" is listed twice in cols='})
                seen.append(c)
            continue
        if k == 'values':
            for i, row in enumerate(lst):
                if len(row['children']) != len(items['cols']):
                    diagnostics.append({'level': 'error', 'msg': 'Row ' + str(i + 1) + ' has ' + str(len(row['children'])) +
                                        ' value(s), but cols= names ' + str(len(items['cols'])) + ' column(s)'})
                for j, v in enumerate(row['children']):
                    walk(v, 'value')
                    if j < len(items['cols']):
                        target(v, col_of(items['cols'][j]['name']))
            continue
        if k == 'set':
            seen2: List[Optional[str]] = []
            for a in lst:
                resolve_ref(a['children'][0], 'expr')
                walk(a['children'][1], 'expr')
                c = col_of(a['children'][0]['name'])
                if c and c in seen2:
                    diagnostics.append({'level': 'error', 'msg': 'Column "' + c + '" is assigned twice in set='})
                seen2.append(c)
                target(a['children'][1], c)
            continue
        for it in lst:
            walk(it, 'expr')
    if op != 'insert' and 'where' not in items:
        diagnostics.append({'level': 'refused', 'code': 'refused', 'msg': 'Refused: a' + ('n ' if op == 'update' else ' ') + op +
                            ' without where= would ' + ('remove' if op == 'delete' else 'change') + ' every row of ' + tname +
                            '. Add a where= condition, or write where=true to mean every row on purpose.'})
    root: Node = {'kind': 'operator', 'op': op, 'label': op.upper(), 'children': []}
    for k in WRITE_ORDER[op]:
        if k in items:
            root['children'].append({'kind': 'operator', 'op': 'clause:' + k, 'label': WRITE_CLAUSES[op][k]['label'], 'children': items[k]})
    return root


# The session store: a lazily made copy of each table a write or read touches.
def new_store() -> Dict[str, Any]:
    """A fresh, empty data store (each table is copied from the seed the first time it is used)."""
    return {'tables': {}}


_STORE: Dict[str, Any] = new_store()


def table_rows(reg: str, name: str, store: Optional[Dict[str, Any]] = None) -> List[List[Any]]:
    """The current rows of a table in ``store`` (default: this session's store)."""
    store = store if store is not None else _STORE
    k = reg + '/' + name
    if k not in store['tables']:
        r = REGISTRIES.get(reg)
        seed = r['db']['seed'].get(name) if r and r.get('db') else None
        if seed is None:
            raise TcxpError('Unknown table "' + name + '"')
        store['tables'][k] = [list(row) for row in seed]
    rows: List[List[Any]] = store['tables'][k]
    return rows


def reset_data(store: Optional[Dict[str, Any]] = None) -> None:
    """Forget every write in ``store``: tables go back to the shipped seed."""
    (store if store is not None else _STORE)['tables'] = {}


def _row_set(rows: List[List[Any]]) -> str:
    return stringify(sorted((stringify(r) for r in rows), key=u16))


def data_changed(store: Optional[Dict[str, Any]] = None) -> bool:
    """True when ``store`` holds different rows from the shipped seed (row order is ignored, as in SQL)."""
    store = store if store is not None else _STORE
    for k, rows in store['tables'].items():
        reg, name = k.split('/')[0], k.split('/')[1]
        if _row_set(rows) != _row_set(REGISTRIES[reg]['db']['seed'][name]):
            return True
    return False


def _is_valid_date(s: str) -> bool:
    m = re.fullmatch(r'([0-9]{4})-([0-9]{2})-([0-9]{2})', s)
    if not m:
        return False
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    # Date.UTC maps years 0-99 to 1900-1999, so those never round-trip
    return y >= 100 and 1 <= mo <= 12 and 1 <= d <= calendar.monthrange(y, mo)[1]


def _slice16(s: str, n: int) -> str:
    return from_u16(u16(s)[:n])


# Coerce a value to a column type the way PostgreSQL stores it, or fail with a plain-language error.
def _coerce(v: Any, col: List[Any], tname: str) -> Any:
    if v is None:
        return None
    typ = col[1]
    b = base_type(typ)
    where = tname + '.' + col[0]

    def bad(code: str, what: str) -> NoReturn:
        raise TcxpError('Column ' + where + ' is ' + typ + ', and ' + stringify(v) + ' ' + what, where, code)
    if b in ('integer', 'bigint', 'smallint'):
        if not is_num(v) or not is_integer(v):
            bad('22P02', 'is not a whole number')
        lim = {'smallint': 32767, 'integer': 2147483647, 'bigint': 9007199254740991}[b]
        if v > lim or v < -lim - 1:
            bad('22003', 'is out of range')
        return v
    if b in ('numeric', 'real', 'double precision'):
        if not is_num(v) or not math.isfinite(v):
            bad('22P02', 'is not a number')
        m = re.search(r'numeric\(([0-9]+),([0-9]+)\)', typ)
        if not m:
            return v
        sc = int(m.group(2))
        f = js_pow(10, sc)
        r = num_div(num_mul(js_sign(v), js_round(num_add(num_mul(abs(v), f), 1e-9))), f)
        if abs(r) >= js_pow(10, int(m.group(1)) - sc):
            bad('22003', 'does not fit (at most ' + str(int(m.group(1)) - sc) + ' digit(s) before the decimal point)')
        return r
    if b == 'date':
        if (not isinstance(v, str) or not _is_valid_date(_slice16(v, 10)) or
                (u16_len(v) > 10 and not re.match(r'[0-9]{4}-[0-9]{2}-[0-9]{2}[ T]00:00(:00)?', v))):
            bad('22007', 'is not a date (YYYY-MM-DD)')
        return _slice16(v, 10)
    if b in ('timestamptz', 'timestamp'):
        c = _to_cmp(v) if isinstance(v, str) else None
        if not isinstance(v, str) or (isinstance(c, float) and c != c):
            bad('22007', 'is not a timestamp')
        return v
    if b == 'boolean':
        if not isinstance(v, bool):
            bad('22P02', 'is not true or false')
        return v
    if not isinstance(v, str):
        bad('42804', 'is not text')
    return v


# The CHECK forms used by the demo schemas: "c > n", "c BETWEEN a AND b", "c IN ('x','y')". Unknown forms are not enforced.
def _check_passes(check: str, v: Any) -> bool:
    if v is None:
        return True
    m = re.fullmatch(r'[A-Za-z0-9_]+ > (-?[0-9.]+)', check)
    if m:
        return lt(to_number(m.group(1)), to_number(v))
    m = re.fullmatch(r'[A-Za-z0-9_]+ BETWEEN (-?[0-9.]+) AND (-?[0-9.]+)', check)
    if m:
        x = to_number(v)
        return not lt(x, to_number(m.group(1))) and x == x and not lt(to_number(m.group(2)), x) and to_number(m.group(1)) == to_number(m.group(1)) and to_number(m.group(2)) == to_number(m.group(2))
    m = re.fullmatch(r'[A-Za-z0-9_]+ IN \((.*)\)', check)
    if m:
        return to_string(v) in [re.sub(r"^'|'\Z", '', trim(x)) for x in m.group(1).split(',')]
    return True


def _show_val(v: Any) -> str:
    return 'null' if v is None else "'" + v + "'" if isinstance(v, str) else to_string(v)


# Compute what a write would do, check every constraint, and return the plan without applying it.
def _plan_write(tree: Tree, vals: Dict[str, Any], store: Dict[str, Any]) -> Dict[str, Any]:
    p = tree['parsed']
    op, reg, it = p['op'], p['registry'], p['items']
    db = REGISTRIES[reg]['db']
    tname = _write_table(p)
    t = next(x for x in db['schema']['tables'] if x['name'] == tname)
    cols = t['columns']
    flags = [_col_flags(c) for c in cols]
    names = [c[0] for c in cols]

    def idx(ref: Node) -> int:
        n = ref['name'].split('.')[-1]
        return names.index(n) if n in names else -1
    rows = table_rows(reg, tname, store)

    def as_obj(r: List[Any]) -> Dict[str, Any]:
        return {tname + '.' + n: r[i] for i, n in enumerate(names)}

    def ev(n: Node, r: Optional[List[Any]] = None) -> Any:
        return _eval(n, as_obj(r) if r is not None else {}, {}, vals, [tname])
    working = [list(r) for r in rows]

    def fail(code: str, msg: str) -> NoReturn:
        raise TcxpError(msg, tname, code)

    def check_row(r: List[Any], n: str, self_row: Optional[List[Any]] = None) -> None:
        for i, f in enumerate(flags):
            if f['notNull'] and r[i] is None:
                fail('23502', 'Column ' + tname + '.' + names[i] + ' cannot be empty (NOT NULL), but ' + n + ' leaves it null.')
        for i, f in enumerate(flags):
            if f['check'] and not _check_passes(f['check'], r[i]):
                fail('23514', 'Column ' + tname + '.' + names[i] + ' must satisfy CHECK (' + f['check'] + '), and ' + n + ' sets it to ' + _show_val(r[i]) + '.')
        for i, f in enumerate(flags):
            if not f['unique'] or r[i] is None:
                continue
            if any(o is not self_row and o[i] is not None and _cmp(o[i], r[i]) == 0 for o in working):
                fail('23505', 'Column ' + tname + '.' + names[i] + ' must be unique (' + ('PRIMARY KEY' if f['pk'] else 'UNIQUE') + '), and ' +
                     _show_val(r[i]) + ' is already taken.')
    changes: List[Dict[str, Any]] = []
    affected: List[List[Any]] = []
    if op == 'insert':
        for ri, row_node in enumerate(it['values']):
            r: List[Any] = [None for _ in names]
            for j, c in enumerate(it['cols']):
                k = idx(c)
                if k >= 0:
                    r[k] = ev(row_node['children'][j])
            cr = [_coerce(v, cols[i], tname) for i, v in enumerate(r)]
            check_row(cr, 'inserted row ' + str(ri + 1))
            working.append(cr)
            affected.append(cr)
            changes.append({'before': None, 'after': cr})
    else:
        hits = [i for i, r in enumerate(rows) if ev(it['where'][0], r) is True]
        if op == 'update':
            for i in hits:
                before = rows[i]
                after = list(before)
                for a in it['set']:
                    k = idx(a['children'][0])
                    if k >= 0:
                        after[k] = ev(a['children'][1], before)
                cr = [_coerce(v, cols[k], tname) for k, v in enumerate(after)]
                working[i] = cr
                check_row(cr, 'the update of row ' + _show_val(before[0]), cr)
                affected.append(cr)
                changes.append({'index': i, 'before': before, 'after': cr})
        else:
            for i in hits:
                affected.append(rows[i])
                changes.append({'index': i, 'before': rows[i], 'after': None})
            gone = set(hits)
            working[:] = [r for i, r in enumerate(working) if i not in gone]

    # Foreign keys, checked on the state the statement leaves behind (PostgreSQL's NO ACTION).
    def state(name: str) -> List[List[Any]]:
        return working if name == tname else table_rows(reg, name, store)

    def exists(name: str, col: str, v: Any) -> bool:
        ti = next(i for i, c in enumerate(next(x for x in db['schema']['tables'] if x['name'] == name)['columns']) if c[0] == col)
        return any(r[ti] is not None and _cmp(r[ti], v) == 0 for r in state(name))
    if op != 'delete':
        for i, f in enumerate(flags):
            if not f['fk']:
                continue
            for r in affected:
                if r[i] is not None and not exists(f['fk'][0], f['fk'][1], r[i]):
                    fail('23503', tname + '.' + names[i] + ' = ' + _show_val(r[i]) + ' does not match any ' + f['fk'][0] + '.' + f['fk'][1] +
                         ' (FOREIGN KEY). Add that ' + f['fk'][0] + ' row first, or use an existing ' + f['fk'][1] + '.')
    if op != 'insert':
        for ct in db['schema']['tables']:
            for ci, c in enumerate(ct['columns']):
                fk = _col_flags(c)['fk']
                if not fk or fk[0] != tname:
                    continue
                pi = names.index(fk[1]) if fk[1] in names else -1
                removed = [v for v in (ch['before'][pi] for ch in changes)
                           if v is not None and not any(r[pi] is not None and _cmp(r[pi], v) == 0 for r in working)]
                for v in removed:
                    if any(r[ci] is not None and _cmp(r[ci], v) == 0 for r in state(ct['name'])):
                        fail('23503', ('Cannot delete ' if op == 'delete' else 'Cannot change ') + tname + ' row with ' + fk[1] + ' = ' + _show_val(v) +
                             ': ' + ct['name'] + '.' + c[0] + ' still refers to it (FOREIGN KEY). Remove or repoint those ' + ct['name'] + ' rows first.')
    # RETURNING
    ret_cols: List[str] = []
    ret_rows: List[List[Any]] = []
    if 'returning' in it:
        def name_of(n: Node) -> str:
            if n['kind'] == 'operator' and n['op'] == 'as':
                return n['children'][1]['name']
            if n['kind'] == 'reference':
                return n['name'].split('.')[-1]
            if n['kind'] == 'operator' and OPS[n['op']]['kind'] in ('func', 'extract'):
                return OPS[n['op']]['sql']
            return '?column?'
        for x in it['returning']:
            if x['kind'] == 'reference' and x['name'] == '*':
                ret_cols.extend(names)
            else:
                ret_cols.append(name_of(x))
        for r in affected:
            out: List[Any] = []
            for x in it['returning']:
                if x['kind'] == 'reference' and x['name'] == '*':
                    out.extend(r)
                else:
                    out.append(ev(x, r))
            ret_rows.append(out)
    return {'op': op, 'registry': reg, 'table': tname, 'columns': names, 'changes': changes, 'count': len(changes),
            'returning': {'columns': ret_cols, 'rows': ret_rows}, 'working': working, 'inverse': _inverse_of(op, reg, t, changes, it)}


# Addresses that undo a write exactly: insert <-> delete by primary key, delete <-> insert of the removed
# rows, update <-> update back to the old values by primary key. Tables without a primary key match on every column.
def _literal_of(v: Any, typ: Any) -> str:
    if v is None:
        return 'null'
    if isinstance(v, (int, float, bool)):
        return to_string(v)
    if base_type(typ) == 'date':
        return "date'" + _enc_literal(to_string(v)) + "'"
    return "'" + _enc_literal(to_string(v).replace("'", "''")) + "'"


def _inverse_of(op: str, reg: str, t: Dict[str, Any], changes: List[Dict[str, Any]], it: Dict[str, Any]) -> List[str]:
    if not changes:
        return []
    names = [c[0] for c in t['columns']]
    pk = next((i for i, c in enumerate(t['columns']) if 'PRIMARY KEY' in (c[2] or '')), -1)
    base = '@!tcxp:/' + reg + '/sql/'

    def match(r: List[Any]) -> str:
        if pk >= 0:
            return 'eq(' + names[pk] + ',' + _literal_of(r[pk], t['columns'][pk][1]) + ')'
        return 'and(' + ','.join('isnull(' + n + ')' if r[i] is None else 'eq(' + n + ',' + _literal_of(r[i], t['columns'][i][1]) + ')'
                                 for i, n in enumerate(names)) + ')'

    def canon(s: str) -> str:
        return serialize(parse_uri(s))['uri']
    if op == 'insert':
        rows = [c['after'] for c in changes]
        if pk >= 0 and len(rows) > 1:
            where = 'in(' + names[pk] + ',' + ','.join(_literal_of(r[pk], t['columns'][pk][1]) for r in rows) + ')'
        elif len(rows) > 1:
            where = 'or(' + ','.join(match(r) for r in rows) + ')'
        else:
            where = match(rows[0])
        return [canon(base + 'delete?from=' + t['name'] + '&where=' + where)]
    if op == 'delete':
        return [canon(base + 'insert?into=' + t['name'] + '&cols=' + ','.join(names) + '&values=' +
                      ','.join('row(' + ','.join(_literal_of(v, t['columns'][i][1]) for i, v in enumerate(c['before'])) + ')' for c in changes))]
    set_idx = [names.index(a['children'][0]['name'].split('.')[-1]) for a in it['set']]
    return [canon(base + 'update?table=' + t['name'] + '&set=' +
                  ','.join('assign(' + names[i] + ',' + _literal_of(c['before'][i], t['columns'][i][1]) + ')' for i in set_idx) +
                  '&where=' + match(c['after'])) for c in changes]


def _execute_write(tree: Tree, vals: Dict[str, Any], store: Dict[str, Any], preview: bool) -> Dict[str, Any]:
    plan = _plan_write(tree, vals, store)
    out = {'kind': 'preview' if preview else 'write', 'op': plan['op'], 'table': plan['table'], 'columns': plan['columns'],
           'changes': plan['changes'], 'count': plan['count'], 'returning': plan['returning'], 'inverse': plan['inverse']}
    if not preview:
        store['tables'][plan['registry'] + '/' + plan['table']] = plan['working']
    return out


# ---------------------------------------------------------------- edit and query API (v0.2)
# One way to change and to search any address. edit() takes JSON Patch style operations that use tcxp
# pointers, re-parses after every operation, and returns only addresses that pass FilterGenerator.filter.
def _expr_val_text(n: Node) -> str:
    if n.get('value') is None:
        return 'null'
    if n.get('type') == 'text':
        return "'" + _enc_literal(to_string(n['value']).replace("'", "''")) + "'"
    if n.get('type') == 'date':
        return "date'" + _enc_literal(to_string(n['value'])) + "'"
    return to_string(n['value'])


def expr_text(n: Node) -> str:
    """The text of an expression node as it appears in an address (a variable is always $name, bound or not)."""
    if n['kind'] == 'value':
        return _expr_val_text(n)
    if n['kind'] == 'slot':
        return '$' + n['name']
    if n['kind'] == 'reference':
        return n['name']
    return n['op'] + '(' + ','.join(expr_text(c) for c in (n.get('children') or [])) + ')'


# The canonical address as a head and a list of raw (still encoded) key=value pairs.
def _pairs_of(uri: str) -> Tuple[str, List[Dict[str, str]]]:
    q = uri.find('?')
    if q < 0:
        return uri, []
    pairs = []
    for p in uri[q + 1:].split('&'):
        i = p.find('=')
        pairs.append({'k': decode_uri_component(p[:i]), 'raw': p})
    return uri[:q], pairs


def _join_pairs(head: str, pairs: List[Dict[str, str]]) -> str:
    return head + ('?' + '&'.join(p['raw'] for p in pairs) if pairs else '')


def _edit_error(i: int, op: Any, msg: str) -> TcxpError:
    return TcxpError('Edit ' + str(i + 1) + ' (' + _js_text(op.get('op') if isinstance(op, dict) else (None if not truthy(op) else _UNDEF_TEXT)) + '): ' + msg, 'edit', 'edit')


_UNDEF_TEXT = object()


def _js_text(v: Any) -> str:
    """String concatenation of a value that may be JavaScript's undefined (a missing property)."""
    if v is _UNDEF_TEXT:
        return 'undefined'
    return to_string(v)


def _is_data_key(k: str) -> bool:
    return k[:1] != '$' and k[:1] != '~'


def _allowed_ops_for(mode: str) -> Optional[set]:
    return MATH_OPS if mode == 'math' else SELECT_OPS if mode == 'sql' else None


# Re-render one data key from a list of item nodes, as raw pairs (join= repeats, other keys are one pair).
def _key_pairs(tree: Tree, key: str, lst: List[Node]) -> List[Dict[str, str]]:
    if tree['parsed']['mode'] == 'fn':
        return [{'k': key, 'raw': key + '=' + _enc_literal(_js_text(n.get('value', _UNDEF_TEXT)))} for n in lst]
    if key == 'join':
        return [{'k': key, 'raw': 'join=' + expr_text(n)} for n in lst]
    return [{'k': key, 'raw': key + '=' + ','.join(expr_text(n) for n in lst)}] if lst else []


# Replace the pairs of one data key, keeping its position (the parser restores canonical order anyway).
def _with_key(uri: str, tree: Tree, key: str, lst: List[Node]) -> str:
    head, pairs = _pairs_of(uri)
    at = next((i for i, p in enumerate(pairs) if p['k'] == key), -1)
    rest = [p for p in pairs if p['k'] != key]
    first_non_data = next((i for i, p in enumerate(rest) if not _is_data_key(p['k'])), -1)
    pos = min(at, len(rest)) if at >= 0 else (len(rest) if first_non_data < 0 else first_non_data)
    rest[pos:pos] = _key_pairs(tree, key, lst)
    return _join_pairs(head, rest)


def _clone_node(n: Node) -> Node:
    c = dict(n)
    c['children'] = [_clone_node(x) for x in n['children']] if n.get('children') else n.get('children')
    return c


class _EditPathError(Exception):
    pass


def _js_int_index(s: str) -> Optional[int]:
    x = to_number(s)
    return int(x) if is_integer(x) else None


# Item list for a key with node at path (segments after the key) replaced or removed.
def _edit_at(lst: List[Node], segs: List[str], fn: Callable[[List[Node], int], List[Node]]) -> List[Node]:
    lst = [_clone_node(n) for n in lst]
    if not segs:
        raise _EditPathError('a path needs an item index after the key')
    i0 = _js_int_index(segs[0])
    if i0 is None or i0 < 0 or i0 >= len(lst):
        raise _EditPathError('no item ' + segs[0])
    if len(segs) == 1:
        return fn(lst, i0)
    parent = lst[i0]
    for i in range(1, len(segs) - 1):
        if parent['kind'] == 'slot':
            raise _EditPathError('the path goes inside the value bound to $' + parent['name'] + '; use bind instead')
        parent = _index(parent.get('children') or [], segs[i])  # type: ignore[assignment]
        if not parent:
            raise _EditPathError('nothing at segment ' + segs[i])
    if parent['kind'] == 'slot':
        raise _EditPathError('the path goes inside the value bound to $' + parent['name'] + '; use bind instead')
    kids = parent.get('children') or []
    ci = _js_int_index(segs[-1])
    if ci is None or ci < 0 or ci >= len(kids):
        raise _EditPathError('nothing at segment ' + segs[-1])
    parent['children'] = fn(list(kids), ci)
    return lst


def _apply_edit(uri: str, tree: Tree, op: Any, i: int) -> str:
    def fail(msg: str) -> NoReturn:
        raise _edit_error(i, op, msg)

    def get(k: str) -> Any:
        return op.get(k, _UNDEF_TEXT) if isinstance(op, dict) else _UNDEF_TEXT

    def missing(v: Any) -> bool:
        return v is _UNDEF_TEXT or v is None

    def parse1(text: str, key: str) -> List[Node]:
        try:
            return _parse_expr_list(text, key, _allowed_ops_for(tree['parsed']['mode']))
        except TcxpError as e:
            fail('the expression "' + text + '" does not parse: ' + str(e))

    def path_segs(path: Any) -> List[str]:
        if not isinstance(path, str) or path[:1] != '/':
            fail('a path starts with "/", like /where/0/1')
        return [s.replace('~1', '/').replace('~0', '~') for s in path.split('/')[1:]]
    head, pairs = _pairs_of(uri)
    kind = op.get('op') if isinstance(op, dict) else None
    items = tree['parsed']['items']
    if kind == 'bind':
        var = get('var')
        if not truthy(var if var is not _UNDEF_TEXT else None) or not isinstance(var, str) or not _NAME_RE.fullmatch(var):
            fail('bind needs var, a variable name without $')
        if var not in tree['slots'] and var not in _required_vars(tree):
            fail('this address has no variable $' + var)
        value = get('value')
        if missing(value) or to_string(value) == '':
            fail("bind needs value, written as it would appear in the address (2024, 'text', date'2026-01-31' or an @!tcxp:/ call)")
        v = to_string(value)
        raw = v.replace('%', '%25').replace('&', '%26').replace('#', '%23') if v.startswith(CALL + SCHEME) else _enc_value(v)
        rest = [p for p in pairs if p['k'] != '$' + var]
        m = next((j for j, p in enumerate(rest) if p['k'][:1] == '~'), -1)
        at = len(rest) if m < 0 else m
        rest[at:at] = [{'k': '$' + var, 'raw': '$' + var + '=' + raw}]
        return _join_pairs(head, rest)
    if kind == 'param':
        if tree['parsed']['mode'] != 'fn':
            fail('param sets a function parameter; this address is not a function')
        name = get('name')
        decl = next((x for x in tree['parsed']['fn']['params'] if x['name'] == name), None)
        if not decl:
            fail('"' + _js_text(name) + '" is not a parameter of this function. Parameters: ' +
                 (', '.join(x['name'] for x in tree['parsed']['fn']['params']) or 'none'))
        rest = [x for x in pairs if x['k'] != name]
        value = get('value')
        if missing(value):
            return _join_pairs(head, rest)
        v = to_string(value)
        if decl['type'] != 'text' and to_number(v) != to_number(v):
            fail('parameter "' + name + '" expects a number, not ' + stringify(v))
        m = next((j for j, x in enumerate(rest) if not _is_data_key(x['k'])), -1)
        at = len(rest) if m < 0 else m
        rest[at:at] = [{'k': name, 'raw': name + '=' + (_enc_literal(v) if decl['type'] == 'text' else v)}]
        return _join_pairs(head, rest)
    if kind == 'unbind':
        var = _js_text(get('var'))
        if not any(p['k'] == '$' + var for p in pairs):
            fail('$' + var + ' is not bound')
        return _join_pairs(head, [p for p in pairs if p['k'] != '$' + var])
    if kind == 'replace':
        segs = path_segs(get('path'))
        key = segs.pop(0)
        if key[:1] == '$':
            fail("replace works on data keys; to change a variable's value use bind")
        if key[:1] == '~':
            fail('replace works on data keys; to change meta use meta')
        lst = items.get(key)
        if not lst:
            fail('this address has no ' + key + '=')
        if tree['parsed']['mode'] == 'fn':
            fail('a function parameter is a plain value; edit it with replace on the whole address')
        repl = parse1(_js_text(get('expr')), key)
        if not segs:
            nxt = repl
        else:
            if len(repl) != 1:
                fail('replace at ' + _js_text(get('path')) + ' takes one expression')

            def put(arr: List[Node], j: int) -> List[Node]:
                arr[j] = repl[0]
                return arr
            try:
                nxt = _edit_at(lst, segs, put)
            except _EditPathError as e:
                fail(_js_text(get('path')) + ': ' + str(e))
        return _with_key(uri, tree, key, nxt)
    if kind == 'remove':
        segs = path_segs(get('path'))
        key = segs.pop(0)
        if key[:1] == '$':
            if not any(p['k'] == key for p in pairs):
                fail(key + ' is not bound')
            return _join_pairs(head, [p for p in pairs if p['k'] != key])
        if key[:1] == '~':
            if not any(p['k'] == key for p in pairs):
                fail('there is no ' + key)
            return _join_pairs(head, [p for p in pairs if p['k'] != key])
        lst = items.get(key)
        if not lst:
            fail('this address has no ' + key + '=')
        if not segs:
            return _join_pairs(head, [p for p in pairs if p['k'] != key])

        def drop(arr: List[Node], j: int) -> List[Node]:
            del arr[j]
            return arr
        try:
            nxt = _edit_at(lst, segs, drop)
        except _EditPathError as e:
            fail(_js_text(get('path')) + ': ' + str(e))
        return _with_key(uri, tree, key, nxt)
    if kind == 'add':
        key = get('key')
        if not truthy(key if key is not _UNDEF_TEXT else None) or not isinstance(key, str) or not _is_data_key(key):
            fail('add needs key, a data key such as order or where')
        repl = parse1(_js_text(get('expr')), key)
        lst = items.get(key)
        mode = tree['parsed']['mode']
        cdef = CLAUSES.get(key) if mode == 'sql' else WRITE_CLAUSES[tree['parsed']['op']].get(key) if mode == 'write' else None
        listy = bool(cdef) and bool(cdef.get('list') or cdef.get('repeat'))  # type: ignore[union-attr]
        if lst and not listy:
            fail(key + '= is already set and holds one expression; use replace')
        return _with_key(uri, tree, key, [_clone_node(n) for n in (lst or [])] + repl)
    if kind == 'annotate':
        on_v = get('on')
        on = on_v if isinstance(on_v, list) else [None if on_v is _UNDEF_TEXT else on_v]
        if not on or any(not resolve_pointer(tree, p) for p in on):
            fail('every pointer in on must resolve to a node; ' +
                 ', '.join('' if p is None else to_string(p) for p in on if not resolve_pointer(tree, p)) + ' does not')
        m2 = next((x for x in tree['parsed']['meta'] if x[0] == 'spikes'), None)
        rows = (list(m2[1]) if isinstance(m2[1], list) else [m2[1]]) if m2 else []
        id_v = get('id')
        sid = id_v if truthy(None if id_v is _UNDEF_TEXT else id_v) else 's' + str(len(rows) + 1)
        if any(truthy(r) and isinstance(r, dict) and 'id' in r and _js_strict_eq(r['id'], sid) for r in rows):
            fail('an annotation ' + to_string(sid) + ' already exists')

        def facet(k: str) -> Any:
            v = get(k)
            return None if v is _UNDEF_TEXT else v
        rows.append({'id': sid, 'on': on, 'meaning': facet('meaning'), 'structure': facet('structure'), 'environment': facet('environment')})
        return _set_meta(head, pairs, 'spikes', rows)
    if kind == 'meta':
        key = get('key')
        if not truthy(None if key is _UNDEF_TEXT else key) or not isinstance(key, str) or not _NAME_RE.fullmatch(key):
            fail('meta needs key, a name without ~')
        value = get('value')
        return _set_meta(head, pairs, key, None if value is _UNDEF_TEXT else value)
    raise _edit_error(i, op, 'unknown op. Use bind, unbind, param, replace, remove, add, annotate or meta')


def _js_strict_eq(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if is_num(a) and is_num(b):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return a is b


def _set_meta(head: str, pairs: List[Dict[str, str]], key: str, value: Any) -> str:
    rest = list(pairs)
    at = next((i for i, p in enumerate(rest) if p['k'] == '~' + key), -1)
    if value is None:
        if at >= 0:
            del rest[at]
        return _join_pairs(head, rest)
    pair = {'k': '~' + key, 'raw': '~' + key + '=' + _meta_text(value)}
    if at >= 0:
        rest[at] = pair
    else:
        rest.append(pair)
    return _join_pairs(head, rest)


# Variables a ~intent row requires; none in v0.1-style addresses.
def _required_vars(tree: Tree) -> List[str]:
    return [r['name'] for r in (tree.get('required') or [])]


def edit(uri: str, ops: Any, pulse: bool = True, at: Optional[str] = None) -> Dict[str, Any]:
    """Apply edit operations (bind, unbind, param, replace, remove, add, annotate, meta) to an address.

    Returns ``{'uri', 'tree'}``. It never returns an invalid address: a bad edit raises TcxpError with
    code ``'edit'``. With ``pulse=True`` it stamps a ~pulse whose parent is the identity before the edit.
    """
    if not isinstance(ops, list):
        ops = [ops]
    tree = parse_uri(uri)
    before = identity(tree)
    prev = next((m for m in tree['parsed']['meta'] if m[0] == 'pulse'), None)
    cur = serialize(tree)['uri']
    for i, op in enumerate(ops):
        nxt = _apply_edit(cur, tree, op, i)
        try:
            tree = parse_uri(nxt)
        except TcxpError as e:
            raise _edit_error(i, op, 'the result would not parse: ' + str(e)) from None
        err = next((d for d in tree['diagnostics'] if d['level'] == 'error'), None)
        if err:
            raise _edit_error(i, op, 'the result would be invalid: ' + err['msg'])
        cur = serialize(tree)['uri']
    if pulse is not False:
        p0 = prev[1][0] if prev and isinstance(prev[1], list) and prev[1] and truthy(prev[1][0]) else None
        step = p0['step'] + 1 if isinstance(p0, dict) and is_integer(p0.get('step')) else 1
        cur = with_pulse(tree, step, at, 0, before)
        tree = parse_uri(cur)
    f = FilterGenerator.filter(cur)
    if not f['ok']:
        raise TcxpError('Edit produced an address that breaks ' + ', '.join(r['id'] for r in f['rules'] if not r['pass']), 'edit', 'edit')
    return {'uri': cur, 'tree': tree}


# query(uri, selector) -> [{pointer, kind, label}]. Every pointer resolves with resolve_pointer.
def _node_label(n: Node) -> str:
    if n['kind'] == 'operator':
        return n['op']
    if n['kind'] == 'slot':
        return '$' + n['name']
    if n['kind'] == 'value':
        return _expr_val_text(n)
    return n['name']


def _node_kind_of(n: Node) -> str:
    return ('variable' if n['children'] else 'gap') if n['kind'] == 'slot' else n['kind']


def _all_pointers(tree: Tree) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []

    def walk(n: Node, path: str) -> None:
        out.append({'pointer': path, 'node': n})
        for j, c in enumerate(n.get('children') or []):
            walk(c, path + '/' + str(j))
    for key, lst in tree['parsed']['items'].items():
        for i, item in enumerate(lst):
            walk(item, '/' + key + '/' + str(i))
    return out


def query(uri: Any, selector: str) -> List[Dict[str, Any]]:
    """Find nodes: ``gaps``, ``variables``, ``references[:name]``, ``operators[:op]``, ``annotations`` or
    ``pointer:<path>``. Returns ``[{'pointer', 'kind', 'label'}]``; every pointer resolves."""
    tree = parse_uri(uri) if isinstance(uri, str) else uri
    what, sep, rest = to_string(selector).partition(':')
    arg = rest if sep else None

    def pick(test: Callable[[Node], bool]) -> List[Dict[str, Any]]:
        return ([{'pointer': x['pointer'], 'kind': _node_kind_of(x['node']), 'label': _node_label(x['node'])}
                 for x in _all_pointers(tree) if test(x['node'])] +
                [{'pointer': '/$' + n['name'], 'kind': _node_kind_of(n), 'label': _node_label(n), 'source': 'intent'}
                 for n in (tree.get('intentSlots') or []) if test(n)])
    if what == 'gaps':
        return (pick(lambda n: n['kind'] == 'slot' and not n.get('param') and not n['children']) +
                (pick(lambda n: n['kind'] == 'slot' and bool(n.get('param')) and not n['children']) if tree['parsed']['mode'] == 'fn' else []))
    if what == 'variables':
        return pick(lambda n: n['kind'] == 'slot')
    if what == 'references':
        return pick(lambda n: n['kind'] == 'reference' and (arg is None or n['name'] == arg or n['name'].split('.')[-1] == arg))
    if what == 'operators':
        return pick(lambda n: n['kind'] == 'operator' and (arg is None or n['op'] == arg))
    if what == 'annotations':
        return [{'pointer': t['ptr'], 'kind': 'annotation', 'label': sp['id'] + ' · ' + sp['bits']}
                for sp in tree['spikes'] for t in sp['targets'] if t['nodes']]
    if what == 'pointer':
        return [{'pointer': arg, 'kind': _node_kind_of(n), 'label': _node_label(n)} for n in resolve_pointer(tree, arg)]
    raise TcxpError('Unknown selector "' + to_string(selector) + '". Use gaps, variables, references, references:<name>, operators:<op>, annotations or pointer:<path>', 'query')


def from_json(j: Dict[str, Any]) -> Tree:
    """The inverse of to_json: rebuild the address from the tree, profile and meta alone."""
    head = (CALL if j.get('call') else '') + SCHEME + j['registry'] + '/' + j['path']
    pairs: List[str] = []
    binds: List[str] = []
    seen: set = set()

    def jt(n: Node) -> str:
        if n['kind'] == 'value':
            return _expr_val_text(n)
        if n['kind'] == 'slot':
            return '$' + n['name']
        if n['kind'] == 'reference':
            return n['name']
        return n['op'] + '(' + ','.join(jt(c) for c in (n.get('children') or [])) + ')'

    def call_text(c: Node) -> str:
        h, params = c['children'][0], [p for p in c['children'][1:] if p.get('children')]
        return CALL + SCHEME + h['name'] + ('?' + '&'.join(p['name'] + '=' + _enc_literal(to_string(p['children'][0]['value'])) for p in params) if params else '')

    def collect(n: Node) -> None:
        if n.get('kind') == 'slot' and not n.get('param') and n.get('children') and n['name'] not in seen:
            seen.add(n['name'])
            b = n['children'][0]
            text = (call_text(b).replace('%', '%25').replace('&', '%26').replace('#', '%23')
                    if b['kind'] == 'operator' and b.get('op') == 'call' else jt(b))
            binds.append('$' + n['name'] + '=' + text)
            return
        for c in n.get('children') or []:
            collect(c)
    # a function's parameter slots are keys, not $bindings
    collect({'children': ([] if j['profile'] == 'fn' else [j['tree']]) + list(j.get('requires') or []) + list(j.get('extra_bindings') or [])})
    if j['profile'] in ('sql', 'write'):
        for c in j['tree'].get('children') or []:
            if c['op'].startswith('clause:'):
                pairs.append(c['op'][len('clause:'):] + '=' + ','.join(jt(x) for x in (c.get('children') or [])))
            else:
                pairs.append('join=' + jt(c))
    elif j['profile'] == 'math':
        pairs.append('expr=' + jt(j['tree']))
    elif j['profile'] == 'fn':
        for p in j['tree']['children'][1:]:
            if p.get('children'):
                pairs.append(p['name'] + '=' + _enc_literal(to_string(p['children'][0]['value'])))
    meta = j.get('meta') or {}
    metas = ['~' + k + '=' + _meta_text(meta[k]) for k in object_keys(meta)]
    alls = pairs + binds + metas
    return parse_uri(head + ('?' + '&'.join(alls) if alls else ''))


# ---------------------------------------------------------------- CSV data source (v0.2)
# register_csv: a CSV as a table that sql/select and writes can use. Types are inferred (integer, numeric,
# date, text) unless given as {column: type}. CSV rows have no identity of their own, so the table gets a
# row_id integer PRIMARY KEY (1..n) as its first column; that keeps write inverses exact when rows repeat.
def _parse_csv_text(text: str) -> List[List[str]]:
    rows: List[List[str]] = []
    row: List[str] = []
    cell: List[str] = []
    q = False
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if q:
            if c == '"' and i + 1 < n and text[i + 1] == '"':
                cell.append('"')
                i += 1
            elif c == '"':
                q = False
            else:
                cell.append(c)
            i += 1
            continue
        if c == '"':
            q = True
        elif c == ',':
            row.append(''.join(cell))
            cell = []
        elif c in '\n\r':
            if c == '\r' and i + 1 < n and text[i + 1] == '\n':
                i += 1
            row.append(''.join(cell))
            rows.append(row)
            row, cell = [], []
        else:
            cell.append(c)
        i += 1
    if cell or row:
        row.append(''.join(cell))
        rows.append(row)
    return [r for r in rows if any(trim(x) != '' for x in r)]


def register_csv(registry: str, table: str, csv_text: str, types: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Load a CSV as a table of ``registry`` (created if needed). Returns the table definition."""
    if not re.fullmatch(r'[a-z_][a-z0-9_]*', table):
        raise TcxpError('Table name "' + table + '" must be lower case letters, digits and _')
    rows = _parse_csv_text(trim(to_string(csv_text)))
    if len(rows) < 2:
        raise TcxpError('The CSV needs a header row and at least one data row')
    header = [re.sub(r'^_+|_+\Z', '', re.sub(r'[^a-z0-9_]+', '_', trim(h).lower())) or 'col' for h in rows[0]]
    if len(set(header)) != len(header) or 'row_id' in header:
        raise TcxpError('CSV column names must be distinct and not row_id')
    body: List[List[str]] = []
    for n, r in enumerate(rows[1:]):
        if len(r) > len(header):
            raise TcxpError('CSV row ' + str(n + 2) + ' has more cells than the header')
        body.append(['' if i >= len(r) else trim(r[i]) for i in range(len(header))])
    given = types or {}

    def infer(i: int, h: str) -> str:
        if given.get(h):
            return given[h]
        vals = [r[i] for r in body if r[i] != '']
        if vals and all(re.fullmatch(r'-?[0-9]+', v) for v in vals):
            return 'integer'
        if vals and all(re.fullmatch(r'-?[0-9]+(\.[0-9]+)?', v) for v in vals):
            return 'numeric'
        if vals and all(_is_valid_date(v) for v in vals):
            return 'date'
        return 'text'
    col_types = [infer(i, h) for i, h in enumerate(header)]

    def cell_value(v: str, i: int, n: int) -> Any:
        if v == '':
            return None
        b = base_type(col_types[i])
        if b in ('integer', 'bigint', 'smallint', 'numeric'):
            x = to_number(v)
            if x != x:
                raise TcxpError('CSV row ' + str(n + 2) + ', column ' + header[i] + ': "' + v + '" is not a number')
            return x
        if b == 'date' and not _is_valid_date(v):
            raise TcxpError('CSV row ' + str(n + 2) + ', column ' + header[i] + ': "' + v + '" is not a date (YYYY-MM-DD)')
        return v
    seed = [[n + 1] + [cell_value(v, i, n) for i, v in enumerate(r)] for n, r in enumerate(body)]
    reg = REGISTRIES.get(registry)
    if not reg:
        reg = REGISTRIES[registry] = {'title': registry, 'description': 'Registry with data loaded from CSV.', 'fns': {}, 'notes': {}}
    if not reg.get('db'):
        reg['db'] = {'schema': {'name': registry, 'description': 'Tables loaded from CSV files.', 'tables': []}, 'seed': {}}
    tdef = {'name': table, 'description': 'Loaded from CSV (' + str(len(seed)) + ' rows). row_id numbers the rows in file order.',
            'columns': [['row_id', 'integer', 'PRIMARY KEY', 'Row number in the file, 1 to n.']] +
                       [[h, col_types[i], '', 'CSV column "' + trim(rows[0][i]) + '".'] for i, h in enumerate(header)]}
    reg['db']['schema']['tables'] = [t for t in reg['db']['schema']['tables'] if t['name'] != table] + [tdef]
    reg['db']['seed'][table] = seed
    _STORE['tables'].pop(registry + '/' + table, None)
    return tdef


# client.demo and any other CSV-backed registry: built here exactly as tcxp.js builds them.
for _reg, _table, _text, _types in _data.CSV_SOURCES:
    register_csv(_reg, _table, _text, _types)
