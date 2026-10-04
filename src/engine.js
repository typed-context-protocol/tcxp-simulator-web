/* ------------------------------------------------------------------ engine
   tcxp v0.1 engine: parse an address into an expression tree, serialize it back,
   resolve pointers, read annotations (spikes), interpret the tree as SQL, math,
   a function call, or a JSON document. */

class TcxpError extends Error { constructor(msg, where) { super(msg); this.where = where; } }

const SCHEME = '!tcxp:/';
const CALL = '@';

/* ----------------------------------------------------------- DDL helpers */
function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function tableDDL(t) {
  const w = Math.max(...t.columns.map(c => c[0].length));
  const lines = t.columns.map(c => '  ' + c[0].padEnd(w) + ' ' + c[1] + (c[2] ? ' ' + c[2] : ''));
  let s = 'CREATE TABLE ' + t.name + ' (\n' + lines.join(',\n') + '\n);\n';
  s += 'COMMENT ON TABLE ' + t.name + ' IS ' + sqlLit(t.description) + ';\n';
  t.columns.forEach(c => { s += 'COMMENT ON COLUMN ' + t.name + '.' + c[0] + ' IS ' + sqlLit(c[3]) + ';\n'; });
  return s;
}
function tableInserts(t, seed) {
  return 'INSERT INTO ' + t.name + ' (' + t.columns.map(c => c[0]).join(', ') + ') VALUES\n' +
    seed[t.name].map(r => '  (' + r.map(sqlLit).join(', ') + ')').join(',\n') + ';\n';
}
function fullDDL(reg) {
  const db = REGISTRIES[reg].db;
  return '-- tcxp registry "' + reg + '" (PostgreSQL)\n-- ' + db.schema.description + '\n\n' +
    db.schema.tables.map(tableDDL).join('\n') + '\n' + db.schema.tables.map(t => tableInserts(t, db.seed)).join('\n');
}

/* ------------------------------------------------- operator registry */
const OPS = {
  eq:{sql:'=',kind:'infix',arity:[2,2],cmp:true,math:'='}, ne:{sql:'<>',kind:'infix',arity:[2,2],cmp:true,math:'≠'},
  lt:{sql:'<',kind:'infix',arity:[2,2],cmp:true,math:'<'}, le:{sql:'<=',kind:'infix',arity:[2,2],cmp:true,math:'≤'},
  gt:{sql:'>',kind:'infix',arity:[2,2],cmp:true,math:'>'}, ge:{sql:'>=',kind:'infix',arity:[2,2],cmp:true,math:'≥'},
  like:{sql:'LIKE',kind:'infix',arity:[2,2],cmp:true}, ilike:{sql:'ILIKE',kind:'infix',arity:[2,2],cmp:true},
  add:{sql:'+',kind:'infix',arity:[2,2],arith:true,math:'+'}, sub:{sql:'-',kind:'infix',arity:[2,2],arith:true,math:'−'},
  mul:{sql:'*',kind:'infix',arity:[2,2],arith:true,math:'·'}, div:{sql:'/',kind:'infix',arity:[2,2],arith:true,math:'÷'},
  pow:{sql:'power',kind:'func',arity:[2,2],ret:'numeric',math:'^'},
  and:{sql:'AND',kind:'nary',arity:[2,null],math:'∧'}, or:{sql:'OR',kind:'nary',arity:[2,null],math:'∨'},
  not:{sql:'NOT',kind:'prefix',arity:[1,1],math:'¬'},
  in:{sql:'IN',kind:'in',arity:[2,null],cmp:true}, between:{sql:'BETWEEN',kind:'between',arity:[3,3],cmp:true},
  isnull:{sql:'IS NULL',kind:'postfix',arity:[1,1]}, notnull:{sql:'IS NOT NULL',kind:'postfix',arity:[1,1]},
  count:{sql:'count',kind:'func',arity:[1,1],agg:true,ret:'bigint'}, sum:{sql:'sum',kind:'func',arity:[1,1],agg:true},
  avg:{sql:'avg',kind:'func',arity:[1,1],agg:true,ret:'numeric'}, min:{sql:'min',kind:'func',arity:[1,1],agg:true},
  max:{sql:'max',kind:'func',arity:[1,1],agg:true}, round:{sql:'round',kind:'func',arity:[1,2],ret:'numeric'},
  lower:{sql:'lower',kind:'func',arity:[1,1],ret:'text'}, upper:{sql:'upper',kind:'func',arity:[1,1],ret:'text'},
  coalesce:{sql:'coalesce',kind:'func',arity:[1,null]},
  year:{sql:'extract',kind:'extract',arity:[1,1],ret:'numeric',label:'YEAR'},
  as:{sql:'AS',kind:'alias',arity:[2,2]},
  asc:{sql:'ASC',kind:'postfix',arity:[1,1]}, desc:{sql:'DESC',kind:'postfix',arity:[1,1]},
  inner:{sql:'INNER JOIN',kind:'join',arity:[2,2]}, left:{sql:'LEFT JOIN',kind:'join',arity:[2,2]},
  right:{sql:'RIGHT JOIN',kind:'join',arity:[2,2]}, full:{sql:'FULL OUTER JOIN',kind:'join',arity:[2,2]},
  cross:{sql:'CROSS JOIN',kind:'join',arity:[1,1]}
};
const MATH_OPS = new Set(['eq','ne','lt','le','gt','ge','add','sub','mul','div','pow','and','or','not']);
const CLAUSES = {
  cols:{label:'COLUMNS',list:true}, from:{label:'FROM'}, join:{label:'JOIN',repeat:true}, where:{label:'WHERE'},
  group:{label:'GROUP BY',list:true}, having:{label:'HAVING'}, order:{label:'ORDER BY',list:true},
  limit:{label:'LIMIT'}, offset:{label:'OFFSET'}
};
const CLAUSE_ORDER = ['cols','from','join','where','group','having','order','limit','offset'];
const labelFor = op => OPS[op].label || (OPS[op].kind === 'func' ? OPS[op].sql.toUpperCase() : OPS[op].sql);

/* ------------------------------------------------------------ tokenizer */
function tokenize(src, where) {
  const toks = []; let i = 0;
  const isId = c => /[A-Za-z0-9_.]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { toks.push({t:c}); i++; continue; }
    if (c === "'" || src.startsWith("date'", i)) {
      let typ = 'text';
      if (c !== "'") { typ = 'date'; i += 4; }
      let j = i + 1, s = '';
      for (;;) {
        if (j >= src.length) throw new TcxpError('Unterminated string literal', where);
        if (src[j] === "'") { if (src[j+1] === "'") { s += "'"; j += 2; continue; } break; }
        s += src[j++];
      }
      toks.push({t:'val', v:s, type:typ}); i = j + 1; continue;
    }
    if (c === '$') {
      let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      if (j === i + 1) throw new TcxpError('A variable needs a name after "$"', where);
      toks.push({t:'slot', v:src.slice(i+1, j)}); i = j; continue;
    }
    if (c === '*') { toks.push({t:'ref', v:'*'}); i++; continue; }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i+1] || ''))) {
      let j = i + 1; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const n = Number(src.slice(i, j));
      if (Number.isNaN(n)) throw new TcxpError('Bad number "' + src.slice(i, j) + '"', where);
      toks.push({t:'val', v:n, type: Number.isInteger(n) ? 'integer' : 'numeric'}); i = j; continue;
    }
    if (isId(c)) {
      let j = i; while (j < src.length && isId(src[j])) j++;
      const w = src.slice(i, j);
      if (w === 'true' || w === 'false') toks.push({t:'val', v: w === 'true', type:'boolean'});
      else if (w === 'null') toks.push({t:'val', v:null, type:'null'});
      else toks.push({t:'id', v:w});
      i = j; continue;
    }
    throw new TcxpError('Unexpected character "' + c + '"', where);
  }
  return toks;
}

/* Node shapes (the four primitives):
   {kind:'operator', op, label, children} | {kind:'reference', name, role}
   {kind:'slot', name, children:[value|call]}   (a variable; a slot with no children is a gap)
   {kind:'value', value, type} */
function parseExprList(src, where, allowed) {
  const toks = tokenize(src, where); let p = 0;
  function expr() {
    const tk = toks[p++];
    if (!tk) throw new TcxpError('Expression ended early', where);
    if (tk.t === 'val') return {kind:'value', value:tk.v, type:tk.type};
    if (tk.t === 'slot') return {kind:'slot', name:tk.v, children:[]};
    if (tk.t === 'ref') return {kind:'reference', name:'*'};
    if (tk.t === 'id') {
      if (toks[p] && toks[p].t === '(') {
        p++;
        const op = OPS[tk.v];
        if (!op || (allowed && !allowed.has(tk.v))) throw new TcxpError('Operator "' + tk.v + '" is not in this profile', where);
        const args = [];
        if (!(toks[p] && toks[p].t === ')')) {
          for (;;) {
            args.push(expr());
            const n = toks[p++];
            if (!n) throw new TcxpError('Missing ")" after ' + tk.v + '(', where);
            if (n.t === ')') break;
            if (n.t !== ',') throw new TcxpError('Expected "," or ")" in ' + tk.v + '(…)', where);
          }
        } else p++;
        const [mn, mx] = op.arity;
        if (args.length < mn || (mx !== null && args.length > mx))
          throw new TcxpError(tk.v + '() takes ' + (mx === mn ? mn : mn + (mx ? '–' + mx : '+')) + ' argument(s), got ' + args.length, where);
        if (tk.v === 'as') {
          if (args[1].kind !== 'reference') throw new TcxpError('as() needs a bare name as its second argument', where);
          args[1].role = 'declares';
        }
        if (op.kind === 'join' && args[0].kind !== 'reference') throw new TcxpError(tk.v + '() needs a table name first', where);
        return {kind:'operator', op:tk.v, label:labelFor(tk.v), children:args};
      }
      return {kind:'reference', name:tk.v};
    }
    throw new TcxpError('Unexpected "' + tk.t + '"', where);
  }
  const out = [];
  if (!toks.length) throw new TcxpError('Empty expression', where);
  while (p < toks.length) {
    out.push(expr());
    if (p < toks.length) { const n = toks[p++]; if (n.t !== ',') throw new TcxpError('Expected "," between items', where); }
  }
  return out;
}

/* ------------------------------------------------------------ meta values */
// Meta values are a JSON array of flat rows ("JSON Lines inside an array"), a JSON object, an integer, or text.
function parseMetaValue(v, key) {
  const t = v.trim();
  if (t[0] === '[' || t[0] === '{') {
    try { return JSON.parse(t); } catch (e) { throw new TcxpError('~' + key + ' is not valid JSON: ' + e.message, '~' + key); }
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  return v;
}
// Canonical form stays readable: only the characters that would break parsing are escaped (% & #).
const encValue = s => s.replace(/%/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23');
const encLiteral = s => encValue(s).replace(/=/g, '%3D');
function metaText(v) { return typeof v === 'string' ? encValue(v) : typeof v === 'number' ? String(v) : encValue(JSON.stringify(v)); }

/* ------------------------------------------------------------- parse URI */
function splitPairs(query) {
  const out = [];
  if (!query) return out;
  query.split('&').forEach(pair => {
    if (!pair) return;
    const eq = pair.indexOf('=');
    if (eq < 0) throw new TcxpError('Key "' + pair + '" has no "="', pair);
    let k, v;
    try { k = decodeURIComponent(pair.slice(0, eq)); v = decodeURIComponent(pair.slice(eq + 1)); }
    catch (e) { throw new TcxpError('Bad percent-encoding in "' + pair + '"', pair); }
    out.push([k, v]);
  });
  return out;
}
function route(registry, path) {
  const reg = REGISTRIES[registry];
  if (!reg) throw new TcxpError('Unknown registry "' + registry + '". Known: ' + Object.keys(REGISTRIES).join(', '), 'registry');
  if (path === 'sql/select') { if (!reg.db) throw new TcxpError('Registry "' + registry + '" has no database for sql/select', 'path'); return {mode:'sql'}; }
  if (path === 'math/eval') return {mode:'math'};
  if (reg.fns[path]) return {mode:'fn', fn: reg.fns[path]};
  if (reg.notes[path] !== undefined) return {mode:'note', text: reg.notes[path]};
  throw new TcxpError('Nothing at "' + registry + '/' + path + '". Try sql/select, math/eval, a function or a note.', 'path');
}

function parseURI(input) {
  let uri = (input || '').trim();
  let call = false;
  if (uri.startsWith(CALL)) { call = true; uri = uri.slice(1); }
  if (!uri.startsWith(SCHEME)) throw new TcxpError('An address starts with "!tcxp:/" (or "@!tcxp:/" to call a function)', 'scheme');
  let rest = uri.slice(SCHEME.length);
  if (rest.startsWith('/')) rest = rest.slice(1);           // tolerate the older "!tcxp://" form
  const qi = rest.indexOf('?');
  const hierarchy = qi < 0 ? rest : rest.slice(0, qi);
  const query = qi < 0 ? '' : rest.slice(qi + 1);
  const segs = hierarchy.split('/').filter(Boolean);
  if (!segs.length) throw new TcxpError('Missing registry after !tcxp:/', 'registry');
  const registry = segs[0], path = segs.slice(1).join('/');
  const r = route(registry, path);
  if (call && r.mode !== 'fn') throw new TcxpError('"@" calls a function, and ' + registry + '/' + path + ' is not one', 'call');

  const items = {}; const bindings = {}; const meta = []; const order = [];
  splitPairs(query).forEach(([k, v]) => {
    if (meta.length && k[0] !== '~') throw new TcxpError('Meta keys (~) must come last; "' + k + '" appears after ~' + meta[meta.length - 1][0], k);
    if (k[0] === '~') {
      const name = k.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TcxpError('Bad meta key "' + k + '"', k);
      if (meta.some(m => m[0] === name)) throw new TcxpError('Meta key ' + k + ' appears twice', k);
      meta.push([name, parseMetaValue(v, name)]); return;
    }
    if (k[0] === '$') {
      const name = k.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TcxpError('Bad variable name "' + k + '"', k);
      if (bindings[name]) throw new TcxpError('Variable ' + k + ' is bound twice', k);
      if (v.startsWith(CALL + SCHEME)) {
        const inner = parseURI(v);
        bindings[name] = {kind:'call', tree: inner};
      } else {
        const vals = parseExprList(v, k);
        if (vals.length !== 1 || vals[0].kind !== 'value') throw new TcxpError('Variable ' + k + ' must be bound to one literal value or an @!tcxp:/ call', k);
        bindings[name] = vals[0];
      }
      return;
    }
    if (r.mode === 'sql') {
      if (!CLAUSES[k]) throw new TcxpError('Unknown key "' + k + '". Clause keys are ' + CLAUSE_ORDER.join(', ') + '; variables start with $, meta with ~.', k);
      if (items[k] && !CLAUSES[k].repeat) throw new TcxpError('Clause "' + k + '" appears twice', k);
      const list = parseExprList(v, k);
      if (!CLAUSES[k].list && !CLAUSES[k].repeat && list.length !== 1) throw new TcxpError('Clause "' + k + '" takes one expression', k);
      if (k === 'join') list.forEach(it => { if (it.kind !== 'operator' || OPS[it.op].kind !== 'join') throw new TcxpError('join= needs inner(), left(), right(), full() or cross()', k); });
      items[k] = (items[k] || []).concat(list);
    } else if (r.mode === 'math') {
      if (k !== 'expr') throw new TcxpError('math/eval takes one key, expr= (plus $variables and ~meta)', k);
      if (items.expr) throw new TcxpError('expr= appears twice', k);
      const list = parseExprList(v, k, MATH_OPS);
      if (list.length !== 1) throw new TcxpError('expr= takes one expression', k);
      items.expr = list;
    } else if (r.mode === 'fn') {
      const decl = r.fn.params.find(p => p.name === k);
      if (!decl) throw new TcxpError('"' + k + '" is not a parameter of this function. Parameters: ' + (r.fn.params.map(p => p.name).join(', ') || 'none'), k);
      if (items[k]) throw new TcxpError('Parameter "' + k + '" appears twice', k);
      const value = decl.type === 'text' ? v : Number(v);
      if (decl.type !== 'text' && Number.isNaN(value)) throw new TcxpError('Parameter "' + k + '" expects a number', k);
      items[k] = [{kind:'value', value, type: decl.type}];
    } else {
      throw new TcxpError('A note address takes no keys other than ~meta', k);
    }
    if (!order.includes(k)) order.push(k);
  });
  if (r.mode === 'sql') {
    if (!items.from) throw new TcxpError('A select needs from=', 'from');
    if (items.from[0].kind !== 'reference') throw new TcxpError('from= takes a table name', 'from');
    if (!items.cols) throw new TcxpError('A select needs cols=', 'cols');
  }
  if (r.mode === 'math' && !items.expr) throw new TcxpError('math/eval needs expr=', 'expr');
  return buildTree({call, registry, path, mode: r.mode, fn: r.fn, note: r.text, items, bindings, meta});
}

/* ----------------------------------------------- tree + type inference */
const baseType = t => t ? String(t).replace(/\(.*\)/, '') : t;
const family = t => {
  t = baseType(t);
  if (['integer','bigint','numeric','smallint','real','double precision'].includes(t)) return 'number';
  if (['date','timestamptz','timestamp'].includes(t)) return 'time';
  return t;
};

function buildTree(parsed) {
  const {items, bindings, mode} = parsed;
  const diagnostics = [];
  const slotsSeen = [];
  let root;

  if (mode === 'sql') {
    const db = REGISTRIES[parsed.registry].db;
    const COLS = {}; db.schema.tables.forEach(t => t.columns.forEach(c => { COLS[t.name + '.' + c[0]] = c[1]; }));
    const TABLES = new Set(db.schema.tables.map(t => t.name));
    const inScope = [items.from[0].name, ...(items.join || []).map(j => j.children[0].name)];
    const aliases = {};
    const resolveRef = (node, ctx) => {
      if (node.name === '*') return;
      if (node.role === 'declares') return;
      if (ctx === 'table') { if (!TABLES.has(node.name)) diagnostics.push({level:'error', msg:'Unknown table "' + node.name + '"'}); node.role = 'table'; return; }
      if (node.name.includes('.')) {
        const t = COLS[node.name];
        if (!t) diagnostics.push({level:'error', msg:'Unknown column "' + node.name + '"'});
        else if (!inScope.includes(node.name.split('.')[0])) diagnostics.push({level:'error', msg:'Table for "' + node.name + '" is not in from= or join='});
        node.type = t || null; node.role = 'column'; return;
      }
      if (aliases[node.name] !== undefined) { node.type = aliases[node.name]; node.role = 'alias'; return; }
      const hits = inScope.filter(tb => COLS[tb + '.' + node.name]);
      if (!hits.length) diagnostics.push({level:'error', msg:'Unknown column "' + node.name + '"'});
      if (hits.length > 1) diagnostics.push({level:'error', msg:'Column "' + node.name + '" is ambiguous; qualify it as table.column'});
      node.type = hits.length ? COLS[hits[0] + '.' + node.name] : null; node.role = 'column';
    };
    const walk = makeWalker(resolveRef, aliases, slotsSeen);
    CLAUSE_ORDER.forEach(k => {
      if (!items[k]) return;
      const ctx = k === 'from' ? 'table' : (k === 'limit' || k === 'offset') ? 'limit' : 'expr';
      items[k].forEach(it => walk(it, ctx));
    });
    root = {kind:'operator', op:'select', label:'SELECT', children:[]};
    CLAUSE_ORDER.forEach(k => {
      if (!items[k]) return;
      if (k === 'join') { items.join.forEach(j => root.children.push(j)); return; }
      root.children.push({kind:'operator', op:'clause:' + k, label:CLAUSES[k].label, children:items[k]});
    });
  } else if (mode === 'math') {
    const walk = makeWalker(node => { diagnostics.push({level:'error', msg:'"' + node.name + '" is a reference, and math/eval has no data to point at. Write variables as $' + node.name + '.'}); }, {}, slotsSeen);
    walk(items.expr[0], 'expr');
    (function numeric(n) { if (n.kind === 'slot' && !n.type) { n.type = 'numeric'; n.typedBy = 'math profile'; } (n.children || []).forEach(numeric); })(items.expr[0]);
    root = items.expr[0];
  } else if (mode === 'fn') {
    const params = parsed.fn.params.map(p => {
      const node = {kind:'slot', name:p.name, param:true, type:p.type, typedBy:'function signature', children: items[p.name] ? items[p.name].map(v => Object.assign(v, {bound:true})) : []};
      if (!items[p.name]) diagnostics.push({level:'gap', msg:'Parameter "' + p.name + '" is a gap (no value given)'});
      items[p.name] = [node];
      return node;
    });
    root = {kind:'operator', op:'call', label: parsed.call ? '@ CALL' : 'FUNCTION', children:[{kind:'reference', name: parsed.registry + '/' + parsed.path, role:'handler', type: parsed.fn.returns}, ...params]};
    if (!parsed.call) diagnostics.push({level:'info', msg:'This address names a function. Prefix it with @ to call it.'});
  } else {
    root = {kind:'reference', name: parsed.registry + '/' + parsed.path, role:'note', type:'text'};
  }

  // attach bound values (or nested calls) to variables; unbound variables are gaps
  const allSlots = [];
  (function collect(n) { if (n.kind === 'slot' && !n.param) allSlots.push(n); (n.children || []).forEach(collect); })(root);
  allSlots.forEach(s => {
    const b = bindings[s.name];
    if (!b) return;
    if (b.kind === 'call') {
      const inner = b.tree;
      s.children = [inner.root];
      const rt = inner.parsed.fn.returns;
      if (s.type && family(s.type) !== family(rt)) diagnostics.push({level:'warn', msg:'$' + s.name + ' expects ' + baseType(s.type) + ' but the call returns ' + rt});
      inner.diagnostics.forEach(d => diagnostics.push(d));
    } else {
      s.children = [Object.assign({}, b, {bound:true})];
      if (s.type && b.type !== 'null' && family(s.type) !== family(b.type) && !(family(s.type) === 'time' && b.type === 'text'))
        diagnostics.push({level:'warn', msg:'$' + s.name + ' expects ' + baseType(s.type) + ' but is bound to a ' + b.type + ' value'});
    }
  });
  slotsSeen.forEach(name => { if (!bindings[name]) diagnostics.push({level:'gap', msg:'$' + name + ' is a gap: no value is bound, so this cannot run'}); });
  Object.keys(bindings).forEach(k => { if (!slotsSeen.includes(k)) diagnostics.push({level:'warn', msg:'$' + k + ' is bound but never used'}); });

  const tree = {root, parsed, slots: slotsSeen, diagnostics};
  tree.gaps = gapsOf(tree);
  tree.spikes = readSpikes(tree);
  tree.spikes.forEach(sp => sp.problems.forEach(msg => diagnostics.push({level:'warn', msg:'Annotation ' + sp.id + ': ' + msg})));
  return tree;
}

function makeWalker(resolveRef, aliases, slotsSeen) {
  function typeOf(n) {
    if (n.kind === 'reference' || n.kind === 'slot') return n.type || null;
    if (n.kind === 'value') return n.type === 'null' ? null : n.type;
    if (n.kind === 'operator') {
      const o = OPS[n.op]; if (!o) return null;
      if (o.cmp || ['and','or','not','isnull','notnull'].includes(n.op)) return 'boolean';
      if (o.ret) return o.ret;
      if (o.arith) return 'numeric';
      if (['as','asc','desc','coalesce'].includes(n.op) || o.agg) return typeOf(n.children[0]);
    }
    return null;
  }
  return function walk(n, ctx) {
    if (n.kind === 'reference') { resolveRef(n, ctx); return; }
    if (n.kind === 'value') return;
    if (n.kind === 'slot') { if (!slotsSeen.includes(n.name)) slotsSeen.push(n.name); if (ctx === 'limit') n.type = n.type || 'bigint'; return; }
    const o = OPS[n.op];
    if (o.kind === 'join') { walk(n.children[0], 'table'); if (n.children[1]) walk(n.children[1], 'expr'); return; }
    n.children.forEach(c => walk(c, ctx === 'limit' ? 'limit' : 'expr'));
    if (n.op === 'as') aliases[n.children[1].name] = typeOf(n.children[0]);
    if (o.cmp || o.arith || n.op === 'coalesce') {
      const anchor = n.children.find(c => c.kind !== 'slot' && typeOf(c));
      if (anchor) n.children.forEach(c => { if (c.kind === 'slot' && !c.type) { c.type = typeOf(anchor); c.typedBy = anchor.kind === 'reference' ? anchor.name : 'value'; } });
    }
  };
}

function gapsOf(tree) {
  const out = [];
  (function walk(n) { if (n.kind === 'slot' && !n.children.length && !out.includes(n.name)) out.push(n.name); (n.children || []).forEach(walk); })(tree.root);
  return out;
}

/* -------------------------------------------------------------- pointers */
// A pointer is a path from a URI key to a node: /<key>/<item index>/<child index>/...
// /$name points at the variable $name (every place it occurs). Coordinates = (pulse step, pointer).
function resolvePointer(tree, ptr) {
  if (typeof ptr !== 'string' || ptr[0] !== '/') return [];
  const segs = ptr.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const key = segs.shift();
  let starts;
  if (key && key[0] === '$') {
    starts = [];
    (function walk(n) { if (n.kind === 'slot' && n.name === key.slice(1)) starts.push(n); (n.children || []).forEach(walk); })(tree.root);
    return segs.length ? starts.map(s => descend(s.children, segs)).filter(Boolean) : starts;
  }
  const list = tree.parsed.items[key];
  if (!list) return [];
  if (!segs.length) return list.slice();
  const first = list[Number(segs[0])];
  if (!first) return [];
  const hit = segs.length > 1 ? descend(first.children || [], segs.slice(1)) : first;
  return hit ? [hit] : [];
}
function descend(children, segs) {
  let node = null, kids = children;
  for (const s of segs) { node = (kids || [])[Number(s)]; if (!node) return null; kids = node.children; }
  return node;
}

/* ------------------------------------------- annotations (spikes) */
// ~spikes=[{"id":..,"on":[pointers],"meaning":..,"structure":..,"environment":..}]
// Data is the anchor (the nodes pointed at). Each facet is lit when it holds a resolvable value, dark otherwise.
const FACETS = ['meaning','structure','environment'];
function resolveNote(addr) {
  if (typeof addr !== 'string' || !addr.startsWith(SCHEME)) return null;
  try { const t = parseURI(addr); return t.parsed.mode === 'note' ? t.parsed.note : null; } catch (e) { return null; }
}
function readSpikes(tree) {
  const m = tree.parsed.meta.find(x => x[0] === 'spikes');
  if (!m) return [];
  const rows = Array.isArray(m[1]) ? m[1] : [m[1]];
  return rows.map((row, i) => {
    const problems = [];
    const id = row && row.id ? String(row.id) : 's' + (i + 1);
    const on = row && row.on ? (Array.isArray(row.on) ? row.on : [row.on]) : [];
    const targets = on.map(p => ({ptr: p, nodes: resolvePointer(tree, p)}));
    targets.forEach(t => { if (!t.nodes.length) problems.push('pointer ' + t.ptr + ' does not resolve to a node'); });
    const facets = {};
    FACETS.forEach(f => {
      const v = row ? row[f] : null;
      if (v === null || v === undefined || v === '') { facets[f] = {lit:false, value:null, text:null}; return; }
      if (typeof v === 'string' && v.startsWith(SCHEME)) {
        const text = resolveNote(v);
        if (text === null) problems.push(f + ' points at ' + v + ', which does not resolve');
        facets[f] = {lit: text !== null, value:v, text};
      } else facets[f] = {lit:true, value:v, text:String(v)};
    });
    const data = targets.length > 0 && targets.every(t => t.nodes.length);
    const bits = FACETS.map(f => facets[f].lit ? '1' : '0').join('');
    return {id, on, targets, facets, data, bits, problems, row};
  });
}

/* ------------------------------------------------- canonical serialization */
let NID = 0;
// Returns {uri, tokens}. opts.meta === false drops ~meta keys: that string is the identity of the state.
function serialize(tree, opts) {
  opts = opts || {};
  const {parsed} = tree; const toks = [];
  const tag = n => (n._id === undefined ? (n._id = 'n' + (NID++)) : n._id);
  const push = (text, kind, node) => toks.push({text, kind, nodeId: node ? tag(node) : null});
  const valText = n => n.value === null ? 'null'
    : n.type === 'text' ? "'" + encLiteral(String(n.value).replace(/'/g, "''")) + "'"
    : n.type === 'date' ? "date'" + encLiteral(String(n.value)) + "'" : String(n.value);
  function ex(n) {
    if (n.kind === 'value') return push(valText(n), 'value', n);
    if (n.kind === 'slot') return push('$' + n.name, 'slot', n);
    if (n.kind === 'reference') return push(n.name, 'reference', n);
    push(n.op, 'operator', n); push('(', 'punct');
    n.children.forEach((c, i) => { if (i) push(',', 'punct'); ex(c); });
    push(')', 'punct');
  }
  if (parsed.call) push('@', 'call', tree.root);
  push('!tcxp:/', 'scheme'); push(parsed.registry, 'registry');
  push('/' + parsed.path, 'path', parsed.mode === 'fn' ? tree.root.children[0] : parsed.mode === 'note' ? tree.root : (parsed.mode === 'sql' ? tree.root : null));
  let first = true;
  const sep = () => { push(first ? '?' : '&', 'punct'); first = false; };
  if (parsed.mode === 'sql') {
    CLAUSE_ORDER.forEach(k => {
      const list = parsed.items[k]; if (!list) return;
      const clauseNode = tree.root.children.find(c => c.op === 'clause:' + k);
      if (k === 'join') { list.forEach(j => { sep(); push('join', 'key'); push('=', 'punct'); ex(j); }); return; }
      sep(); push(k, 'key', clauseNode); push('=', 'punct');
      list.forEach((it, i) => { if (i) push(',', 'punct'); ex(it); });
    });
  } else if (parsed.mode === 'math') {
    sep(); push('expr', 'key'); push('=', 'punct'); ex(parsed.items.expr[0]);
  } else if (parsed.mode === 'fn') {
    parsed.fn.params.forEach(p => {
      const slot = parsed.items[p.name][0];
      if (!slot.children.length) return;
      sep(); push(p.name, 'param', slot); push('=', 'punct');
      const v = slot.children[0];
      push(p.type === 'text' ? encLiteral(String(v.value)) : String(v.value), 'value', v);
    });
  }
  const bindingNames = tree.slots.concat(Object.keys(parsed.bindings).filter(k => !tree.slots.includes(k)));
  bindingNames.forEach(name => {
    const b = parsed.bindings[name]; if (!b) return;
    const slot = findSlot(tree.root, name);
    sep(); push('$' + name, 'slotkey', slot); push('=', 'punct');
    if (b.kind === 'call') {
      const inner = serialize(b.tree, {meta:false});
      inner.tokens.forEach(t => toks.push(Object.assign({}, t, {text: t.text.replace(/%/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23')})));
    } else push(valText(b), 'value', slot && slot.children[0]);
  });
  if (opts.meta !== false) parsed.meta.forEach(([name, v]) => { sep(); push('~' + name, 'metakey'); push('=', 'punct'); push(metaText(v), 'meta'); });
  return {uri: toks.map(t => t.text).join(''), tokens: toks};
}
function findSlot(n, name) {
  if (n.kind === 'slot' && n.name === name && !n.param) return n;
  for (const c of n.children || []) { const r = findSlot(c, name); if (r) return r; }
  return null;
}
const identity = tree => serialize(tree, {meta:false}).uri;
// Strict transport form: every character outside RFC 3986 unreserved/sub-delims is percent-encoded.
function strictForm(uri) {
  return uri.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@\/?%]/g, c => encodeURIComponent(c)).replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
}

/* ------------------------------------------------------- bindings at runtime */
function invoke(tree) {
  const p = tree.parsed;
  const args = {};
  p.fn.params.forEach(prm => { const s = p.items[prm.name][0]; args[prm.name] = s.children.length ? s.children[0].value : undefined; });
  return p.fn.fn(args);
}
function boundValues(tree) {
  const vals = {}; const via = {};
  Object.entries(tree.parsed.bindings).forEach(([k, b]) => {
    if (b.kind === 'call') { vals[k] = invoke(b.tree); via[k] = 'call'; }
    else { vals[k] = b.value; via[k] = 'literal'; }
  });
  return {vals, via};
}

/* --------------------------------------------------------- SQL fiber */
function toSQL(tree, opts) {
  opts = opts || {};
  const p = tree.parsed;
  if (p.mode !== 'sql' && p.mode !== 'math') return null;
  const params = []; const order = [];
  const gapless = !tree.gaps.length;
  const bv = gapless ? boundValues(tree) : {vals:{}, via:{}};
  const castSlots = p.mode === 'math';
  function slotRef(name) {
    let i = order.indexOf(name);
    if (i < 0) { order.push(name); i = order.length - 1; params.push(bv.vals[name]); }
    return '$' + (i + 1) + (castSlots ? '::numeric' : '');
  }
  const value = n => n.type === 'date' ? 'DATE ' + sqlLit(n.value) : sqlLit(n.value);
  // Parenthesize when precedence would regroup the tree: a lower-precedence child, an equal-precedence
  // right operand (a - (b - c)), or a comparison nested in a comparison.
  const needsParens = (child, parentOp, isRight) => {
    if (child.kind !== 'operator') return false;
    if (['and','or'].includes(child.op)) return child.op !== parentOp;
    const co = OPS[child.op], po = OPS[parentOp];
    if (!co || !po || co.kind !== 'infix' || po.kind !== 'infix') return false;
    if (co.cmp && po.cmp) return true;
    return prec(child.op) < prec(parentOp) || (isRight && prec(child.op) === prec(parentOp));
  };
  function e(n, parentOp) {
    if (n.kind === 'reference') return n.name;
    if (n.kind === 'value') return value(n);
    if (n.kind === 'slot') {
      if (opts.inline && n.name in bv.vals) { const b = p.bindings[n.name]; return b.kind === 'call' ? sqlLit(bv.vals[n.name]) : value(b); }
      return slotRef(n.name);
    }
    const o = OPS[n.op]; const c = n.children;
    const w = (x, isRight) => { const s = e(x, n.op); return needsParens(x, n.op, isRight) ? '(' + s + ')' : s; };
    switch (o.kind) {
      case 'infix':
        if (p.mode === 'math' && n.op === 'div') return '(' + w(c[0]) + ')::numeric / ' + w(c[1], true);
        return w(c[0]) + ' ' + o.sql + ' ' + w(c[1], true);
      case 'nary': return c.map(w).join(' ' + o.sql + ' ');
      case 'prefix': return o.sql + ' ' + w(c[0]);
      case 'postfix': return w(c[0]) + ' ' + o.sql;
      case 'in': return w(c[0]) + ' IN (' + c.slice(1).map(x => e(x)).join(', ') + ')';
      case 'between': return w(c[0]) + ' BETWEEN ' + w(c[1]) + ' AND ' + w(c[2]);
      case 'func': return o.sql + '(' + c.map(x => e(x)).join(', ') + ')';
      case 'extract': return 'extract(year from ' + e(c[0]) + ')';
      case 'alias': return e(c[0]) + ' AS ' + c[1].name;
      case 'join': return o.sql + ' ' + c[0].name + (c[1] ? ' ON ' + e(c[1]) : '');
    }
    throw new TcxpError('Cannot render ' + n.op);
  }
  if (p.mode === 'math') return {sql: 'SELECT ' + e(p.items.expr[0]) + ' AS result', params, paramNames: order, via: bv.via};
  const it = p.items; const parts = [];
  parts.push('SELECT ' + it.cols.map(x => e(x)).join(', '));
  parts.push('FROM ' + it.from[0].name);
  (it.join || []).forEach(j => parts.push(e(j)));
  if (it.where) parts.push('WHERE ' + e(it.where[0]));
  if (it.group) parts.push('GROUP BY ' + it.group.map(x => e(x)).join(', '));
  if (it.having) parts.push('HAVING ' + e(it.having[0]));
  if (it.order) parts.push('ORDER BY ' + it.order.map(x => e(x)).join(', '));
  if (it.limit) parts.push('LIMIT ' + e(it.limit[0]));
  if (it.offset) parts.push('OFFSET ' + e(it.offset[0]));
  return {sql: parts.join('\n'), params, paramNames: order, via: bv.via};
}

/* --------------------------------------------------------- Math fiber */
const PREC = {or:1, and:2, not:3, eq:4, ne:4, lt:4, le:4, gt:4, ge:4, add:5, sub:5, mul:6, div:6, pow:7};
const prec = op => PREC[op] || 9;
// written: true uses the shorthand people write (2x); false spells every operator out (2 · x)
function toMath(tree, written) {
  if (tree.parsed.mode !== 'math') return null;
  function m(n, parent, right) {
    if (n.kind === 'value') return String(n.value);
    if (n.kind === 'slot') return n.name;
    if (n.kind === 'reference') return n.name;
    const o = OPS[n.op]; const c = n.children;
    let s;
    if (n.op === 'not') s = '¬' + m(c[0], n.op);
    else if (n.op === 'pow') s = m(c[0], n.op) + '^' + m(c[1], n.op, true);
    else if (n.op === 'mul' && written && c[0].kind === 'value' && typeof c[0].value === 'number' && (c[1].kind === 'slot' || c[1].kind === 'reference')) s = String(c[0].value) + c[1].name;
    else if (o.kind === 'nary') s = c.map(x => m(x, n.op)).join(' ' + o.math + ' ');
    else s = m(c[0], n.op) + ' ' + o.math + ' ' + m(c[1], n.op, true);
    const needs = parent && (prec(n.op) < prec(parent) || (right && prec(n.op) === prec(parent) && ['sub','div'].includes(parent)));
    return needs ? '(' + s + ')' : s;
  }
  return m(tree.parsed.items.expr[0]);
}

/* --------------------------------------------------------- JSON fiber */
function toJSON(tree) {
  const clean = n => {
    const o = {kind: n.kind};
    if (n.kind === 'operator') { o.op = n.op; }
    if (n.kind === 'reference') { o.name = n.name; if (n.role) o.role = n.role; }
    if (n.kind === 'slot') { o.name = n.name; if (!n.children.length) o.gap = true; }
    if (n.kind === 'value') { o.value = n.value; }
    if (n.type) o.type = baseType(n.type);
    if (n.children && n.children.length) o.children = n.children.map(clean);
    return o;
  };
  const p = tree.parsed;
  return {
    address: identity(tree), call: p.call, registry: p.registry, path: p.path, profile: p.mode,
    tree: clean(tree.root), gaps: tree.gaps,
    meta: Object.fromEntries(p.meta)
  };
}

/* ------------------------------------------------------ executor */
// Gaps block execution: nothing runs while any variable is unbound.
function execute(tree) {
  if (tree.diagnostics.some(d => d.level === 'error')) throw new TcxpError(tree.diagnostics.find(d => d.level === 'error').msg);
  const p = tree.parsed;
  if (tree.gaps.length) return {kind:'gap', gaps: tree.gaps};
  if (p.mode === 'note') return {kind:'note', text: p.note};
  if (p.mode === 'fn') return p.call ? {kind:'call', value: invoke(tree), returns: p.fn.returns} : {kind:'address'};
  const {vals} = boundValues(tree);
  if (p.mode === 'math') {
    const v = evalExpr(p.items.expr[0], {}, {math:true}, vals, []);
    return {kind:'value', value: v, decision: typeof v === 'boolean' ? v : null};
  }
  return Object.assign({kind:'rows'}, executeSQL(tree, vals));
}

const isDateish = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
const toCmp = v => isDateish(v) ? Date.parse(v.length <= 10 ? v + 'T00:00:00Z' : v.replace(' ', 'T').replace(/\+00$/, '+00:00')) : v;
const cmp = (a, b) => { a = toCmp(a); b = toCmp(b); return a < b ? -1 : a > b ? 1 : 0; };
const and3 = vs => vs.some(v => v === false) ? false : vs.some(v => v === null) ? null : true;
const or3 = vs => vs.some(v => v === true) ? true : vs.some(v => v === null) ? null : false;

function evalExpr(n, row, ctx, vals, scope) {
  if (n.kind === 'value') return n.value;
  if (n.kind === 'slot') { if (!(n.name in vals)) throw new TcxpError('$' + n.name + ' is a gap'); return vals[n.name]; }
  if (n.kind === 'reference') {
    if (ctx && ctx.aliasVals && !n.name.includes('.') && n.name in ctx.aliasVals) return ctx.aliasVals[n.name];
    if (n.name.includes('.')) { if (!(n.name in row)) throw new TcxpError('Column "' + n.name + '" is not available here'); return row[n.name]; }
    const hit = scope.find(t => (t + '.' + n.name) in row);
    if (!hit) throw new TcxpError('Unknown column "' + n.name + '"');
    return row[hit + '.' + n.name];
  }
  const o = OPS[n.op]; const c = n.children; const v = i => evalExpr(c[i], row, ctx, vals, scope);
  if (o.agg) {
    const g = ctx && ctx.group;
    if (!g) throw new TcxpError(n.op + '() is only allowed in cols, having or order');
    if (n.op === 'count' && c[0].kind === 'reference' && c[0].name === '*') return g.length;
    const xs = g.map(r => evalExpr(c[0], r, ctx, vals, scope)).filter(x => x !== null && x !== undefined);
    if (n.op === 'count') return xs.length;
    if (!xs.length) return null;
    if (n.op === 'sum') return xs.reduce((a, b) => a + Number(b), 0);
    if (n.op === 'avg') return xs.reduce((a, b) => a + Number(b), 0) / xs.length;
    if (n.op === 'min') return xs.reduce((a, b) => cmp(a, b) <= 0 ? a : b);
    if (n.op === 'max') return xs.reduce((a, b) => cmp(a, b) >= 0 ? a : b);
  }
  switch (n.op) {
    case 'eq': case 'ne': case 'lt': case 'le': case 'gt': case 'ge': {
      const a = v(0), b = v(1); if (a === null || b === null) return null;
      const r = cmp(a, b);
      return {eq: r === 0, ne: r !== 0, lt: r < 0, le: r <= 0, gt: r > 0, ge: r >= 0}[n.op];
    }
    case 'like': case 'ilike': {
      const a = v(0), pt = v(1); if (a === null || pt === null) return null;
      const re = new RegExp('^' + String(pt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', n.op === 'ilike' ? 'is' : 's');
      return re.test(String(a));
    }
    case 'add': case 'sub': case 'mul': case 'div': {
      let a = v(0), b = v(1); if (a === null || b === null) return null; a = Number(a); b = Number(b);
      if (n.op === 'div' && b === 0) throw new TcxpError('Division by zero');
      const r = {add: a + b, sub: a - b, mul: a * b, div: a / b}[n.op];
      return (n.op === 'div' && Number.isInteger(a) && Number.isInteger(b) && !(ctx && ctx.math)) ? Math.trunc(r) : r;
    }
    case 'pow': { const a = v(0), b = v(1); return a === null || b === null ? null : Math.pow(Number(a), Number(b)); }
    case 'and': return and3(c.map((_, i) => v(i)));
    case 'or': return or3(c.map((_, i) => v(i)));
    case 'not': { const a = v(0); return a === null ? null : !a; }
    case 'in': {
      const a = v(0); if (a === null) return null;
      const list = c.slice(1).map((_, i) => v(i + 1));
      if (list.some(x => x !== null && cmp(a, x) === 0)) return true;
      return list.some(x => x === null) ? null : false;
    }
    case 'between': { const a = v(0), lo = v(1), hi = v(2); if (a === null || lo === null || hi === null) return null; return cmp(a, lo) >= 0 && cmp(a, hi) <= 0; }
    case 'isnull': return v(0) === null;
    case 'notnull': return v(0) !== null;
    case 'round': {
      const a = v(0); if (a === null) return null; const d = c[1] ? Number(v(1)) : 0; const f = Math.pow(10, d);
      return Math.sign(a) * Math.round(Math.abs(Number(a)) * f + 1e-9) / f;
    }
    case 'year': { const a = v(0); return a === null ? null : new Date(toCmp(a)).getUTCFullYear(); }
    case 'lower': { const a = v(0); return a === null ? null : String(a).toLowerCase(); }
    case 'upper': { const a = v(0); return a === null ? null : String(a).toUpperCase(); }
    case 'coalesce': { for (let i = 0; i < c.length; i++) { const a = v(i); if (a !== null) return a; } return null; }
    case 'as': case 'asc': case 'desc': return v(0);
  }
  throw new TcxpError('Cannot evaluate ' + n.op);
}

function executeSQL(tree, vals) {
  const it = tree.parsed.items;
  const db = REGISTRIES[tree.parsed.registry].db;
  const tdef = name => { const t = db.schema.tables.find(x => x.name === name); if (!t) throw new TcxpError('Unknown table "' + name + '"'); return t; };
  const load = name => { const t = tdef(name); return db.seed[name].map(r => { const o = {}; t.columns.forEach((c, i) => { o[name + '.' + c[0]] = r[i]; }); return o; }); };
  const nullRow = names => { const o = {}; names.forEach(nm => tdef(nm).columns.forEach(c => { o[nm + '.' + c[0]] = null; })); return o; };
  const scope = [it.from[0].name];
  const ev = (n, row, ctx) => evalExpr(n, row, ctx, vals, scope);
  const truthy = x => x === true;

  let rows = load(it.from[0].name);
  (it.join || []).forEach(j => {
    const tn = j.children[0].name; const right = load(tn); const cond = j.children[1]; const out = [];
    const leftNames = scope.slice(); scope.push(tn);
    const match = (l, r) => j.op === 'cross' || truthy(ev(cond, Object.assign({}, l, r)));
    if (j.op === 'cross' || j.op === 'inner') rows.forEach(l => right.forEach(r => { if (match(l, r)) out.push(Object.assign({}, l, r)); }));
    else if (j.op === 'left' || j.op === 'full') {
      const usedR = new Set();
      rows.forEach(l => { let any = false; right.forEach((r, ri) => { if (match(l, r)) { any = true; usedR.add(ri); out.push(Object.assign({}, l, r)); } }); if (!any) out.push(Object.assign({}, l, nullRow([tn]))); });
      if (j.op === 'full') right.forEach((r, ri) => { if (!usedR.has(ri)) out.push(Object.assign(nullRow(leftNames), r)); });
    } else if (j.op === 'right') {
      right.forEach(r => { let any = false; rows.forEach(l => { if (match(l, r)) { any = true; out.push(Object.assign({}, l, r)); } }); if (!any) out.push(Object.assign(nullRow(leftNames), r)); });
    }
    rows = out;
  });
  if (it.where) rows = rows.filter(r => truthy(ev(it.where[0], r)));
  const hasAgg = n => n.kind === 'operator' && ((OPS[n.op] && OPS[n.op].agg) || n.children.some(hasAgg));
  const grouped = !!it.group || it.cols.some(hasAgg) || !!it.having;
  let units;
  if (grouped) {
    const map = new Map();
    if (it.group) rows.forEach(r => { const k = JSON.stringify(it.group.map(g => ev(g, r))); if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
    else map.set('all', rows);
    units = [...map.values()].map(g => ({row: g[0] || {}, ctx: {group: g}}));
    if (it.having) units = units.filter(u => truthy(ev(it.having[0], u.row, u.ctx)));
  } else units = rows.map(r => ({row: r, ctx: {}}));
  const columns = []; let colsDone = false;
  const nameOf = n => n.kind === 'operator' && n.op === 'as' ? n.children[1].name
    : n.kind === 'reference' ? n.name.split('.').pop()
    : n.kind === 'operator' && (OPS[n.op].kind === 'func' || OPS[n.op].kind === 'extract') ? OPS[n.op].sql : '?column?';
  units.forEach(u => {
    const out = []; u.ctx.aliasVals = {};
    it.cols.forEach(item => {
      if (item.kind === 'reference' && item.name === '*') {
        scope.forEach(t => tdef(t).columns.forEach(c => { out.push(u.row[t + '.' + c[0]]); if (!colsDone) columns.push(c[0]); }));
      } else {
        const x = ev(item, u.row, u.ctx); out.push(x); if (!colsDone) columns.push(nameOf(item));
        if (item.kind === 'operator' && item.op === 'as') u.ctx.aliasVals[item.children[1].name] = x;
      }
    });
    colsDone = true; u.out = out;
  });
  if (!colsDone) it.cols.forEach(item => {
    if (item.kind === 'reference' && item.name === '*') scope.forEach(t => tdef(t).columns.forEach(c => columns.push(c[0])));
    else columns.push(nameOf(item));
  });
  if (it.order) {
    const keys = it.order.map(o => ({desc: o.kind === 'operator' && o.op === 'desc', expr: o.kind === 'operator' && (o.op === 'asc' || o.op === 'desc') ? o.children[0] : o}));
    units.forEach(u => { u.sort = keys.map(k => ev(k.expr, u.row, u.ctx)); });
    units = units.map((u, i) => [u, i]).sort(([a, ia], [b, ib]) => {
      for (let i = 0; i < keys.length; i++) {
        const x = a.sort[i], y = b.sort[i]; let r;
        if (x === null && y === null) r = 0; else if (x === null) r = 1; else if (y === null) r = -1; else r = cmp(x, y);
        if (keys[i].desc) r = -r;
        if (r) return r;
      }
      return ia - ib;
    }).map(([u]) => u);
  }
  let out = units.map(u => u.out);
  const off = it.offset ? Number(ev(it.offset[0], {})) : 0;
  const lim = it.limit ? Number(ev(it.limit[0], {})) : Infinity;
  return {columns, rows: out.slice(off, off + lim)};
}

/* ------------------------------------------------------- pulse */
// Each committed state gets one ~pulse row: {step, at, debounce_ms, parent}. Step counts commits, not keystrokes.
// parent is the identity of the previous committed state (null for the first), so pulses form a chain.
const DEBOUNCE_MS = 300;
function withPulse(tree, step, at, debounce, parent) {
  const meta = tree.parsed.meta.filter(m => m[0] !== 'pulse');
  meta.unshift(['pulse', [{step, at: at || new Date().toISOString(), debounce_ms: debounce || DEBOUNCE_MS, parent: parent || null}]]);
  const t = Object.assign({}, tree, {parsed: Object.assign({}, tree.parsed, {meta})});
  return serialize(t).uri;
}

/* ------------------------------------------------------ filter generator */
// FilterGenerator produces random, well-formed tcxp addresses (seeded, reproducible) and filters
// any address against the protocol rules. Generated batches double as property tests.
const RULES = [
  ['scheme', 'Starts with !tcxp:/ (an address) or @!tcxp:/ (a call)'],
  ['meta-last', 'Every ~meta key comes after every other key'],
  ['call-target', '@ is only used on a function address'],
  ['grammar', 'Parses under the profile grammar with no errors'],
  ['canonical', 'Re-serializes to exactly the same string']
];
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const PHRASES = ['How many hours did we bill?', 'Is the route safe?', 'Who joined in August?', 'Q3 revenue & margin', 'Ticket #42 follow-up', 'Discount of 15% applied', 'Check the roster before Friday'];
const WORDS = ['world', 'team', 'Ada', 'café', 'R&D', 'issue #7', '100%', 'a b'];

class FilterGenerator {
  constructor(seed) { this.seed = seed === undefined ? 1 : seed; this.rand = mulberry32(this.seed); this.count = 0; }
  int(n) { return Math.floor(this.rand() * n); }
  pick(a) { return a[this.int(a.length)]; }
  chance(p) { return this.rand() < p; }
  batch(n) { const out = []; for (let i = 0; i < n; i++) out.push(this.next()); return out; }
  next() {
    this.count++;
    const r = this.rand();
    let base = r < 0.6 ? this.sql() : r < 0.85 ? this.math() : this.call();
    const tree = parseURI(base);
    const meta = this.meta(tree);
    return meta.length ? base + (base.includes('?') ? '&' : '?') + meta.join('&') : base;
  }
  lit(v, fam) {
    if (fam === 'number') return String(v);
    if (fam === 'time') return "date'" + String(v).slice(0, 10) + "'";
    return "'" + encLiteral(String(v).replace(/'/g, "''")) + "'";
  }
  withBindings(uriNoBind, binds) {
    const tree = parseURI(uriNoBind);
    const pairs = tree.slots.filter(s => binds[s] !== undefined).map(s => '$' + s + '=' + binds[s]);
    return pairs.length ? uriNoBind + '&' + pairs.join('&') : uriNoBind;
  }
  sql() {
    const regName = this.pick(['school.demo', 'firm.demo']);
    const db = REGISTRIES[regName].db;
    const tables = db.schema.tables;
    const fks = [];
    tables.forEach(t => t.columns.forEach(c => { const m = /REFERENCES (\w+)\((\w+)\)/.exec(c[2]); if (m) fks.push([t.name, c[0], m[1], m[2]]); }));
    const base = this.pick(tables).name;
    const scope = [base]; const joins = [];
    if (this.chance(0.4)) {
      const edges = fks.filter(f => f[0] === base || f[2] === base);
      if (edges.length) {
        const [ct, cc, pt, pc] = this.pick(edges);
        const other = ct === base ? pt : ct;
        const kind = this.pick(['inner', 'left', 'right', 'full']);
        joins.push(kind + '(' + other + ',eq(' + other + '.' + (other === ct ? cc : pc) + ',' + base + '.' + (base === ct ? cc : pc) + '))');
        scope.push(other);
      }
    }
    const qual = joins.length > 0;
    const cols = [];
    scope.forEach(t => tables.find(x => x.name === t).columns.forEach((c, i) => {
      const vals = db.seed[t].map(r => r[i]);
      cols.push({t, c: c[0], ref: qual ? t + '.' + c[0] : c[0], fam: family(c[1]), vals: vals.filter(v => v !== null), nullable: vals.some(v => v === null), pk: i === 0});
    }));
    const binds = {}; let vn = 0;
    const operand = col => {
      const v = this.pick(col.vals);
      if (this.chance(0.4)) {
        const name = 'v' + (++vn);
        if (!this.chance(0.12)) binds[name] = this.lit(v, col.fam);
        return '$' + name;
      }
      return this.lit(v, col.fam);
    };
    const pred = () => {
      const col = this.pick(cols.filter(c => c.vals.length));
      if (col.nullable && this.chance(0.25)) return (this.chance(0.5) ? 'isnull(' : 'notnull(') + col.ref + ')';
      if (col.fam === 'text') {
        if (regName === 'school.demo' && col.c === 'cohort' && this.chance(0.3)) { const name = 'v' + (++vn); binds[name] = '@!tcxp:/school.demo/fn/current_cohort'; return 'eq(' + col.ref + ',$' + name + ')'; }
        if (this.chance(0.3)) return 'in(' + col.ref + ',' + this.lit(this.pick(col.vals), 'text') + ',' + this.lit(this.pick(col.vals), 'text') + ')';
        return this.pick(['eq', 'ne']) + '(' + col.ref + ',' + operand(col) + ')';
      }
      if (this.chance(0.2)) {
        const a = this.pick(col.vals), b = this.pick(col.vals);
        const [lo, hi] = cmp(a, b) <= 0 ? [a, b] : [b, a];
        return 'between(' + col.ref + ',' + this.lit(lo, col.fam) + ',' + this.lit(hi, col.fam) + ')';
      }
      return this.pick(['eq', 'ne', 'lt', 'le', 'gt', 'ge']) + '(' + col.ref + ',' + operand(col) + ')';
    };
    const boolExpr = depth => {
      if (depth > 0 && this.chance(0.45)) {
        const op = this.pick(['and', 'and', 'or']);
        const n = 2 + this.int(2);
        const parts = []; for (let i = 0; i < n; i++) parts.push(boolExpr(depth - 1));
        return op + '(' + parts.join(',') + ')';
      }
      const p = pred();
      return this.chance(0.1) ? 'not(' + p + ')' : p;
    };
    const keys = [];
    const grouped = this.chance(0.25);
    if (grouped) {
      const g = this.pick(cols.filter(c => !c.pk));
      const numeric = cols.filter(c => c.fam === 'number' && !c.pk);
      const sel = [g.ref, 'as(count(*),n)'];
      if (numeric.length && this.chance(0.7)) sel.push('as(' + this.pick(['sum', 'avg', 'min', 'max']) + '(' + this.pick(numeric).ref + '),agg)');
      keys.push('cols=' + sel.join(','));
      keys.push('from=' + base);
      joins.forEach(j => keys.push('join=' + j));
      if (this.chance(0.6)) keys.push('where=' + boolExpr(1));
      keys.push('group=' + g.ref);
      if (this.chance(0.3)) { const name = 'v' + (++vn); if (!this.chance(0.12)) binds[name] = String(1 + this.int(3)); keys.push('having=ge(count(*),$' + name + ')'); }
      keys.push('order=asc(' + g.ref + ')');
    } else {
      const sel = this.chance(0.25) ? ['*'] : (() => { const s = []; const n = 1 + this.int(3); for (let i = 0; i < n; i++) { const c = this.pick(cols); if (!s.includes(c.ref)) s.push(c.ref); } return s; })();
      keys.push('cols=' + sel.join(','));
      keys.push('from=' + base);
      joins.forEach(j => keys.push('join=' + j));
      if (this.chance(0.75)) keys.push('where=' + boolExpr(2));
      if (this.chance(0.5)) {
        const c = this.pick(cols);
        const tail = scope.map(t => 'asc(' + cols.find(x => x.t === t && x.pk).ref + ')').filter(o => o !== 'asc(' + c.ref + ')');
        keys.push('order=' + [(this.chance(0.5) ? 'desc(' : 'asc(') + c.ref + ')'].concat(tail).join(','));
        if (this.chance(0.4)) { if (this.chance(0.5)) keys.push('limit=' + (1 + this.int(5))); else { const name = 'v' + (++vn); if (!this.chance(0.12)) binds[name] = String(1 + this.int(5)); keys.push('limit=$' + name); } }
      }
    }
    return this.withBindings('!tcxp:/' + regName + '/sql/select?' + keys.join('&'), binds);
  }
  math() {
    const vars = ['x', 'y', 'z'].slice(0, 1 + this.int(3));
    const arith = d => {
      if (d === 0 || this.chance(0.35)) return this.chance(0.5) ? '$' + this.pick(vars) : String(this.int(19) - 9);
      return this.pick(['add', 'sub', 'mul']) + '(' + arith(d - 1) + ',' + arith(d - 1) + ')';
    };
    const cmpx = () => this.pick(['eq', 'ne', 'lt', 'le', 'gt', 'ge']) + '(' + arith(2) + ',' + arith(1) + ')';
    const r = this.rand();
    const expr = r < 0.2 ? arith(3) : r < 0.4 ? this.pick(['and', 'or']) + '(' + cmpx() + ',' + cmpx() + ')' : cmpx();
    const binds = {}; vars.forEach(v => { if (this.chance(0.85)) binds[v] = String(this.int(11) - 5); });
    const reg = this.pick(Object.keys(REGISTRIES));
    return this.withBindings('!tcxp:/' + reg + '/math/eval?expr=' + expr, binds);
  }
  call() {
    if (this.chance(0.3)) return '@!tcxp:/school.demo/fn/current_cohort';
    return '@!tcxp:/registry/hello?do=' + encLiteral(this.pick(WORDS));
  }
  randomPointer(tree) {
    if (tree.slots.length && this.chance(0.3)) return '/$' + this.pick(tree.slots);
    const keys = Object.keys(tree.parsed.items);
    if (!keys.length) return null;
    const key = this.pick(keys); const list = tree.parsed.items[key];
    const idx = this.int(list.length); let node = list[idx]; const path = ['', key, idx];
    while (node.children && node.children.length && this.chance(0.55)) { const i = this.int(node.children.length); path.push(i); node = node.children[i]; }
    return path.join('/');
  }
  meta(tree) {
    const parts = [];
    const notes = []; Object.entries(REGISTRIES).forEach(([r, reg]) => Object.keys(reg.notes).forEach(n => notes.push('!tcxp:/' + r + '/' + n)));
    if (this.chance(0.6)) parts.push('~pulse=' + metaText([{step: 1 + this.int(500), at: new Date(Date.UTC(2026, 9, 1 + this.int(28), this.int(24), this.int(60), this.int(60), this.int(1000))).toISOString(), debounce_ms: DEBOUNCE_MS}]));
    if (this.chance(0.5)) parts.push('~intent=' + metaText(this.pick(PHRASES)));
    if (this.chance(0.5)) {
      const rows = []; const n = 1 + this.int(2);
      for (let i = 0; i < n; i++) {
        const ptr = this.randomPointer(tree); if (!ptr) break;
        const row = {id: 's' + (i + 1), on: [ptr]};
        FACETS.forEach(f => { row[f] = this.chance(0.5) ? (this.chance(0.8) ? this.pick(notes) : 'Inline note for ' + f) : null; });
        rows.push(row);
      }
      if (rows.length) parts.push('~spikes=' + metaText(rows));
    }
    if (this.chance(0.2)) parts.push('~observe=' + metaText([{from: this.pick(['agent:planner', 'human:analyst', 'sensor:hull-07']), to: this.pick(['human:captain', 'agent:auditor', 'human:cpa']), channel: this.pick(['chat', 'email', 'telemetry'])}]));
    if (this.chance(0.2)) parts.push('~outcome=' + metaText([{amount: Math.round((this.rand() * 2000 - 1000) * 100) / 100, currency: 'USD'}]));
    return parts;
  }
  // Check any address against the protocol rules. Returns {ok, rules:[{id, name, pass, msg}]}.
  static filter(uri) {
    const res = {}; let tree = null, err = null;
    res.scheme = /^@?!tcxp:\//.test(uri);
    let keys = [];
    try { const q = uri.indexOf('?'); keys = q < 0 ? [] : splitPairs(uri.slice(q + 1)).map(p => p[0]); } catch (e) { err = e; }
    const firstMeta = keys.findIndex(k => k[0] === '~');
    res['meta-last'] = firstMeta < 0 || keys.slice(firstMeta).every(k => k[0] === '~');
    try { tree = parseURI(uri); } catch (e) { err = e; }
    res['call-target'] = !uri.startsWith('@') || !!(tree && tree.parsed.mode === 'fn');
    res.grammar = !!tree && !tree.diagnostics.some(d => d.level === 'error');
    res.canonical = !!tree && serialize(tree).uri === uri;
    const rules = RULES.map(([id, name]) => ({id, name, pass: res[id], msg: !res[id] && err && ['grammar', 'call-target'].includes(id) ? err.message : null}));
    return {ok: rules.every(r => r.pass), rules, tree};
  }
}

/* -------------------------------------------------- coverage declaration */
const SB = '!tcxp:/school.demo/sql/select?';
const COVERAGE = [
  ['Projection','SELECT column list','yes',SB + 'cols=first_name,gpa&from=students'],
  ['Projection','SELECT *','yes',SB + 'cols=*&from=students'],
  ['Projection','Column alias (AS)','yes',SB + 'cols=as(gpa,grade)&from=students'],
  ['Source','FROM table','yes',SB + 'cols=*&from=courses'],
  ['Filter','= <> < <= > >=','yes',SB + "cols=*&from=students&where=and(ge(gpa,3),ne(cohort,$c),lt(gpa,4))&$c='2025-fall'"],
  ['Filter','AND / OR / NOT','yes',SB + "cols=*&from=students&where=or(not(eq(cohort,'2026-fall')),gt(gpa,3.9))"],
  ['Filter','IN (list)','yes',SB + "cols=*&from=courses&where=in(department,'CS','DS')"],
  ['Filter','BETWEEN','yes',SB + 'cols=*&from=students&where=between(gpa,3,3.5)'],
  ['Filter','LIKE / ILIKE','yes',SB + "cols=*&from=students&where=ilike(email,$pat)&$pat='%25chen%25'"],
  ['Filter','IS NULL / IS NOT NULL','yes',SB + 'cols=*&from=assignments&where=notnull(course_id)'],
  ['Expressions','Arithmetic + - * /','yes',SB + 'cols=title,as(div(max_points,10),tenth)&from=assignments'],
  ['Expressions','Scalar functions (round, lower, upper, coalesce)','yes',SB + "cols=upper(code),coalesce(due_on,date'2026-12-31')&from=courses&join=left(assignments,eq(assignments.course_id,courses.course_id))"],
  ['Expressions','extract(year from …)','yes','!tcxp:/firm.demo/sql/select?cols=year(worked_on),count(*)&from=work_logs&group=year(worked_on)'],
  ['Aggregation','count / sum / avg / min / max','yes',SB + 'cols=count(*),avg(gpa),min(gpa),max(gpa),sum(gpa)&from=students'],
  ['Aggregation','GROUP BY','yes',SB + 'cols=cohort,count(*)&from=students&group=cohort'],
  ['Aggregation','HAVING','yes',SB + 'cols=cohort,count(*)&from=students&group=cohort&having=gt(count(*),2)'],
  ['Ordering','ORDER BY ASC / DESC','yes',SB + 'cols=*&from=students&order=desc(gpa),asc(last_name)'],
  ['Ordering','LIMIT / OFFSET','yes',SB + 'cols=*&from=students&order=asc(student_id)&limit=$n&offset=2&$n=3'],
  ['Joins','INNER JOIN','yes',QUERIES[6].uri],
  ['Joins','LEFT JOIN','yes',QUERIES[7].uri],
  ['Joins','RIGHT JOIN','yes',SB + 'cols=courses.code,enrollments.status&from=enrollments&join=right(courses,eq(courses.course_id,enrollments.course_id))'],
  ['Joins','FULL OUTER JOIN','yes',QUERIES[8].uri],
  ['Joins','CROSS JOIN','yes',SB + 'cols=courses.code,students.cohort&from=courses&join=cross(students)'],
  ['Variables','Typed variable bound by $key=value','yes',QUERIES[0].uri],
  ['Variables','Variable bound by an @ call','yes',QUERIES[11].uri],
  ['Gaps','Unbound variable blocks execution','yes',QUERIES[17].uri],
  ['Math','Arithmetic and comparison in math/eval','yes',QUERIES[13].uri],
  ['Calls','@ call to a registry function','yes',QUERIES[10].uri],
  ['Annotations','~spikes pointing at nodes, facets lit or dark','yes',QUERIES[14].uri],
  ['Joins','Table aliases (FROM students s)','no',null],
  ['Projection','SELECT DISTINCT','no',null],
  ['Aggregation','count(DISTINCT x)','no',null],
  ['Expressions','CASE WHEN','no',null],
  ['Subqueries','Scalar, IN (SELECT …), EXISTS','no',null],
  ['Composition','UNION / INTERSECT / EXCEPT','no',null],
  ['Composition','Common table expressions (WITH)','no',null],
  ['Analytics','Window functions (OVER, PARTITION BY)','no',null],
  ['Expressions','Casts (::type)','no',null],
  ['Writes','INSERT / UPDATE / DELETE','no',null],
  ['Schema','CREATE / ALTER / DROP','no',null],
  ['Variables','List-valued variables (IN $ids)','no',null],
  ['Calls','Calls with arguments nested inside expressions','no',null]
];
