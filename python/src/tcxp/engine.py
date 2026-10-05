"""tcxp v0.1 engine, a line-for-line port of tcxp.js.

Parse an address into an expression tree, serialize it back, resolve pointers, read annotations
(spikes), and interpret the tree as SQL, math, a function call, or a JSON document. Trees and results
are plain dicts and lists with the same keys as the JavaScript objects, so JSON output is identical.
"""
from __future__ import annotations

import builtins
import copy
import functools
import math
import re
from typing import Any, Callable, Dict, Iterator, List, Optional

from . import _data
from ._js import (
    JSONSyntaxError, URIError, date_parse, decode_uri_component, encode_uri_component_char, imul, is_integer,
    iso_string, js_pow, js_round, js_sign, lt, norm, now_iso, num_add, num_div, num_mul, num_sub, num_to_str,
    parse_json, stringify, to_int32, to_number, to_string, trim, truthy, u16, u16_len, u32,
    utc_ms, utc_year, first_unit,
)

Node = Dict[str, Any]
Tree = Dict[str, Any]


class TcxpError(Exception):
    """An address or tree the protocol rejects. ``where`` names the key or part at fault."""

    def __init__(self, msg: str, where: Optional[str] = None) -> None:
        super().__init__(msg)
        self.message = msg
        self.where = where


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


REGISTRIES: Dict[str, Any] = _build_registries()
QUERIES: List[Dict[str, Any]] = _data.QUERIES
GROUPS: List[List[str]] = _data.GROUPS
COVERAGE: List[List[Any]] = _data.COVERAGE
OPS: Dict[str, Dict[str, Any]] = _data.OPS
CLAUSES: Dict[str, Dict[str, Any]] = _data.CLAUSES
CLAUSE_ORDER: List[str] = _data.CLAUSE_ORDER
RULES: List[List[str]] = _data.RULES
FACETS: List[str] = _data.FACETS
SCHEME: str = _data.SCHEME
DEBOUNCE_MS: int = _data.DEBOUNCE_MS
CALL = '@'

MATH_OPS = {'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'add', 'sub', 'mul', 'div', 'pow', 'and', 'or', 'not'}


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
    db = REGISTRIES[reg]['db']
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
    if path == 'math/eval':
        return {'mode': 'math'}
    if path in reg['fns']:
        return {'mode': 'fn', 'fn': reg['fns'][path]}
    if path in reg['notes']:
        return {'mode': 'note', 'text': reg['notes'][path]}
    raise TcxpError('Nothing at "' + registry + '/' + path + '". Try sql/select, math/eval, a function or a note.', 'path')


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
    if call and r['mode'] != 'fn':
        raise TcxpError('"@" calls a function, and ' + registry + '/' + path + ' is not one', 'call')

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
                bindings[name] = {'kind': 'call', 'tree': parse_uri(v)}
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
            lst = _parse_expr_list(v, k)
            if not CLAUSES[k].get('list') and not CLAUSES[k].get('repeat') and len(lst) != 1:
                raise TcxpError('Clause "' + k + '" takes one expression', k)
            if k == 'join':
                for it in lst:
                    if it['kind'] != 'operator' or OPS[it['op']]['kind'] != 'join':
                        raise TcxpError('join= needs inner(), left(), right(), full() or cross()', k)
            items[k] = items.get(k, []) + lst
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
    return _build_tree({'call': call, 'registry': registry, 'path': path, 'mode': r['mode'], 'fn': r.get('fn'),
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

    # attach bound values (or nested calls) to variables; unbound variables are gaps
    all_slots: List[Node] = []

    def collect(n: Node) -> None:
        if n['kind'] == 'slot' and not n.get('param'):
            all_slots.append(n)
        for c in _children(n):
            collect(c)
    collect(root)
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
                diagnostics.append({'level': 'warn', 'msg': '$' + s['name'] + ' expects ' + to_string(base_type(s['type'])) + ' but is bound to a ' + b['type'] + ' value'})
    for name in slots_seen:
        if name not in bindings:
            diagnostics.append({'level': 'gap', 'msg': '$' + name + ' is a gap: no value is bound, so this cannot run'})
    for k in bindings:
        if k not in slots_seen:
            diagnostics.append({'level': 'warn', 'msg': '$' + k + ' is bound but never used'})

    tree: Tree = {'root': root, 'parsed': parsed, 'slots': slots_seen, 'diagnostics': diagnostics}
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
    push('/' + parsed['path'], 'path', tree['root']['children'][0] if mode == 'fn' else tree['root'] if mode in ('note', 'sql') else None)
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
    if p['mode'] not in ('sql', 'math'):
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
                b = p['bindings'][n['name']]
                return _sql_lit(bv['vals'][n['name']]) if b['kind'] == 'call' else value(b)
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
    return {'address': identity(tree), 'call': p['call'], 'registry': p['registry'], 'path': p['path'],
            'profile': p['mode'], 'tree': clean(tree['root']), 'gaps': tree['gaps'], 'meta': meta}


# ---------------------------------------------------------------- executor
def execute(tree: Tree) -> Dict[str, Any]:
    """Run the tree. Gaps block execution: nothing runs while any variable is unbound."""
    err = next((d for d in tree['diagnostics'] if d['level'] == 'error'), None)
    if err:
        raise TcxpError(err['msg'])
    p = tree['parsed']
    if tree['gaps']:
        return {'kind': 'gap', 'gaps': tree['gaps']}
    if p['mode'] == 'note':
        return {'kind': 'note', 'text': p['note']}
    if p['mode'] == 'fn':
        return {'kind': 'call', 'value': _invoke(tree), 'returns': p['fn']['returns']} if p['call'] else {'kind': 'address'}
    vals = _bound_values(tree)['vals']
    if p['mode'] == 'math':
        v = _eval(p['items']['expr'][0], {}, {'math': True}, vals, [])
        return {'kind': 'value', 'value': v, 'decision': v if isinstance(v, bool) else None}
    return dict({'kind': 'rows'}, **_execute_sql(tree, vals))


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


def _execute_sql(tree: Tree, vals: Dict[str, Any]) -> Dict[str, Any]:
    it = tree['parsed']['items']
    db = REGISTRIES[tree['parsed']['registry']]['db']

    def tdef(name: str) -> Dict[str, Any]:
        t = next((x for x in db['schema']['tables'] if x['name'] == name), None)
        if not t:
            raise TcxpError('Unknown table "' + name + '"')
        return t

    def load(name: str) -> List[Dict[str, Any]]:
        t = tdef(name)
        return [{name + '.' + c[0]: r[i] for i, c in enumerate(t['columns'])} for r in db['seed'][name]]

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
def with_pulse(tree: Tree, step: Any, at: Optional[str] = None, debounce: Optional[int] = None, parent: Optional[str] = None) -> str:
    """The canonical address with one ``~pulse`` row stamped first among the meta keys.

    ``parent`` is the identity of the previous committed state (None for the first), so pulses form a chain.
    """
    meta = [m for m in tree['parsed']['meta'] if m[0] != 'pulse']
    meta.insert(0, ['pulse', [{'step': step, 'at': at if truthy(at) else now_iso(),
                               'debounce_ms': debounce if truthy(debounce) else DEBOUNCE_MS,
                               'parent': parent if truthy(parent) else None}]])
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
        reg = self.pick(list(REGISTRIES.keys()))
        return self.with_bindings('!tcxp:/' + reg + '/math/eval?expr=' + expr, binds)

    def call(self) -> str:
        if self.chance(0.3):
            return '@!tcxp:/school.demo/fn/current_cohort'
        return '@!tcxp:/registry/hello?do=' + _enc_literal(self.pick(_WORDS))

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
        notes = ['!tcxp:/' + r + '/' + n for r, reg in REGISTRIES.items() for n in reg['notes']]
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
        res['call-target'] = not uri.startswith('@') or bool(tree and tree['parsed']['mode'] == 'fn')
        res['grammar'] = bool(tree) and not any(d['level'] == 'error' for d in tree['diagnostics'])  # type: ignore[index]
        res['canonical'] = bool(tree) and serialize(tree)['uri'] == uri  # type: ignore[arg-type]
        rules = [{'id': rid, 'name': name, 'pass': res[rid],
                  'msg': str(err) if not res[rid] and err and rid in ('grammar', 'call-target') else None}
                 for rid, name in RULES]
        return {'ok': all(r['pass'] for r in rules), 'rules': rules, 'tree': tree}
