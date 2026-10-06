// Phase B properties of the edit and query API, fromJSON and registerCSV.
//   node test/api.mjs [n=500] [seed=23]
// Addresses come from the whole collection plus n generated read addresses (a separate seed, so the
// read fuzz baseline of fuzz.mjs is untouched).
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'module';
import { nv } from './writes-lib.mjs';
import { NAMES, nameCases } from './names-cases.mjs';
const T = createRequire(import.meta.url)('../tcxp.js');
const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const N = Number(ARGS[0] || 500), SEED = Number(ARGS[1] || 23);
const gen = new T.FilterGenerator(SEED);
const corpus = [...T.QUERIES.map(q => q.uri), ...gen.batch(N)];
const res = {}; let fail = 0;
const tally = (name, ok, msg) => { res[name] = res[name] || {pass: 0, total: 0}; res[name].total++; if (ok) res[name].pass++; else { fail++; if (msg) console.log('FAIL', name, msg); } };
const rnd = (() => { let a = SEED * 7919; return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; })();
const pick = xs => xs[Math.floor(rnd() * xs.length)];

// 1. query: every returned pointer resolves to the node it describes, for every selector
for (const uri of corpus) {
  const tree = T.parseURI(uri);
  const sels = ['gaps', 'variables', 'references', 'operators', 'annotations', 'operators:eq', 'operators:and'];
  T.query(tree, 'references').forEach(r => sels.push('references:' + r.label));
  for (const sel of sels) {
    const hits = T.query(tree, sel);
    tally('query pointers resolve', hits.every(h => T.resolvePointer(tree, h.pointer).length > 0), sel + ' ' + uri);
    hits.forEach(h => { if (h.kind !== 'annotation' && !h.pointer.startsWith('/$')) tally('query pointer:<path> round-trips', T.query(tree, 'pointer:' + h.pointer).some(x => x.label === h.label), h.pointer + ' ' + uri); });
  }
  tally('gaps selector matches tree.gaps', JSON.stringify([...new Set(T.query(tree, 'gaps').map(h => h.label.replace(/^\$/, '')))].sort()) === JSON.stringify(tree.gaps.slice().sort()), uri);
}

// 2. fromJSON is the inverse of toJSON on identity (and on the whole address)
for (const uri of corpus) {
  const tree = T.parseURI(uri);
  let back = null; try { back = T.fromJSON(JSON.parse(JSON.stringify(T.toJSON(tree)))); } catch (e) { tally('fromJSON(toJSON(t)) identity', false, e.message + ' ' + uri); continue; }
  tally('fromJSON(toJSON(t)) identity', T.identity(back) === T.identity(tree), uri + '\n   got ' + T.identity(back));
  tally('fromJSON(toJSON(t)) full address', T.serialize(back).uri === T.serialize(tree).uri, uri);
}

// 3. edit: random edits either throw a plain TcxpError or return an address that passes the filter,
//    round-trips, and carries a pulse whose parent is the identity before the edit.
const litFor = slot => { const f = slot && slot.type ? T.baseType(slot.type) : 'numeric'; return /int|numeric|bigint|real/.test(f) ? String(1 + Math.floor(rnd() * 5)) : /date|time/.test(f) ? "date'2026-01-15'" : pick(["'x'", "'R&D'", "'100%'", "'a=b'"]); };
const randomOp = tree => {
  const r = rnd();
  const gaps = T.query(tree, 'gaps').filter(g => g.kind === 'gap' && g.label.startsWith('$'));
  const bound = Object.keys(tree.parsed.bindings);
  const leaves = T.query(tree, 'references').concat(T.query(tree, 'variables'));
  if (r < 0.25 && gaps.length) { const g = pick(gaps); return {op: 'bind', var: g.label.slice(1), value: litFor(T.resolvePointer(tree, g.pointer)[0])}; }
  if (r < 0.35 && bound.length) return {op: 'unbind', var: pick(bound)};
  if (r < 0.5) { const vals = T.query(tree, 'variables').concat(T.query(tree, 'operators')); if (vals.length) { const v = pick(vals); return {op: 'replace', path: v.pointer, expr: v.kind === 'operator' ? 'true' : litFor(T.resolvePointer(tree, v.pointer)[0])}; } }
  if (r < 0.6) return {op: 'remove', path: '/' + pick(Object.keys(tree.parsed.items).concat(['order', 'where', '~context/intent', '~context/observe/0']))};
  if (r < 0.7 && tree.parsed.mode === 'sql') return {op: 'add', key: pick(['order', 'where', 'limit']), expr: pick(['asc(' + (leaves.length ? pick(leaves).label.replace(/^\$/, '') : 'x') + ')', 'true', '5'])};
  if (r < 0.85 && leaves.length) return {op: 'annotate', on: [pick(leaves).pointer], meaning: pick([null, 'Edited by the API test']), structure: null, environment: null};
  return {op: 'context', key: pick(['intent', 'observe', 'reason', 'decide', 'trace']), value: pick([[{amount: 5, currency: 'USD'}], [{role: 'user', text: 'Edited intent & more'}], ['tcxp://firm.demo/rules/tax-year'], null])};
};
let applied = 0, refused = 0;
for (const uri of corpus) {
  let cur = uri, tree = T.parseURI(uri);
  for (let step = 0; step < 4; step++) {
    const ops = [randomOp(tree)];
    if (rnd() < 0.3) ops.push(randomOp(tree));
    let out;
    try { out = T.edit(cur, ops, {at: '2026-10-04T12:00:0' + step + '.000Z'}); }
    catch (e) { if (e instanceof T.TcxpError && e.code === 'edit') { refused++; continue; } tally('edit never throws a non-tcxp error', false, e.stack + '\n ' + JSON.stringify(ops) + ' ' + cur); continue; }
    applied++;
    const f = T.FilterGenerator.filter(out.uri);
    tally('edit result passes FilterGenerator.filter', f.ok, out.uri + ' ' + JSON.stringify(f.rules.filter(r => !r.pass)));
    tally('edit result round-trips', T.serialize(T.parseURI(out.uri)).uri === out.uri && T.serialize(T.parseURI(T.strictForm(out.uri))).uri === out.uri, out.uri);
    const pulse = out.tree.parsed.context.trace.find(r => r && r.step !== undefined);
    tally('edit pulse parent is the fingerprint of the previous full address', !!pulse && pulse.parent === T.fingerprint(cur) && T.lookupAddress(pulse.parent) === T.serialize(T.parseURI(cur)).uri, out.uri);
    cur = out.uri; tree = out.tree;
  }
}
// an edit chain: each pulse's parent is the fingerprint of the full address before it (the store returns it), and steps count up
{
  const base = T.QUERIES.find(q => q.id === 'us-hours-gap').uri;
  const chain = [[{op: 'bind', var: 'tax_year', value: '2023'}], [{op: 'bind', var: 'tax_year', value: '2024'}], [{op: 'add', key: 'order', expr: 'desc(us_hours)'}], [{op: 'remove', path: '/order'}]];
  let cur = base, ok = true, steps = [];
  chain.forEach((ops, i) => { const out = T.edit(cur, ops, {at: '2026-10-04T13:00:0' + i + '.000Z'}); const p = out.tree.parsed.context.trace.find(r => r && r.step !== undefined); ok = ok && T.lookupAddress(p.parent) === cur; steps.push(p.step); cur = out.uri; });
  tally('edit chain: parents trace the history', ok && JSON.stringify(steps) === '[1,2,3,4]', JSON.stringify(steps));
}

// 4. registerCSV: inference, quoting, empty cells; select * equals PostgreSQL loading the same rows through generated DDL and inserts
{
  const csv = 'Name,"Amount, USD",Joined,Note\n"Ada, Countess",12.50,2024-01-31,"She said ""hi"""\nBob,3,2024-02-29,\nCleo,,2023-12-01,plain\n';
  const def = T.registerCSV('csvtest.demo', 'people', csv);
  tally('registerCSV infers types', JSON.stringify(def.columns.map(c => c[1])) === JSON.stringify(['integer', 'text', 'numeric', 'date', 'text']), JSON.stringify(def.columns));
  const pg = new PGlite(); await pg.exec(T.fullDDL('csvtest.demo'));
  const t = T.parseURI(T.fullAddress('!tcxp:/csvtest.demo/sql/select?cols=*&from=people&order=asc(row_id)'));
  const mem = T.execute(t, {store: T.newStore()}).rows.map(r => r.map(nv));
  const g = T.toSQL(t); const pr = (await pg.query(g.sql, g.params, {rowMode: 'array'})).rows.map(r => r.map(nv));
  tally('registerCSV table equals PostgreSQL', JSON.stringify(mem) === JSON.stringify(pr), JSON.stringify([mem, pr]));
  let threw = false; try { T.registerCSV('csvtest.demo', 'bad', 'a,b\n1,2,3\n'); } catch (e) { threw = e instanceof T.TcxpError; }
  tally('registerCSV rejects ragged rows', threw);
  // a column named like an Object.prototype member gets an inferred type, never a prototype member
  for (const h of ['constructor', 'toString', 'hasOwnProperty']) {
    const d = T.registerCSV('csvtest.demo', 'protohdr', h + ',plain\n1,2\n');
    tally('registerCSV header named ' + h + ' is an ordinary column', d.columns[1][1] === d.columns[2][1] && d.columns[1][1] === 'integer', JSON.stringify(d.columns.map(c => typeof c[1] === 'function' ? 'FUNCTION' : c[1])));
  }
  delete T.REGISTRIES['csvtest.demo'];
}
// 5. JavaScript-special names (constructor, __proto__, …) behave exactly like an ordinary unknown name in every
//    position: same outcome as the control name "plain_name", never a JS error or a prototype member read as data.
{
  const outcome = (uri, n) => {
    const norm = x => String(x).split(n).join('NAME');
    try {
      const t = T.parseURI(uri);
      const r = (() => { try { return T.execute(t, {store: T.newStore()}); } catch (e) { return {kind: e instanceof T.TcxpError ? 'tcxp-error' : 'JS-ERROR', msg: e.message}; } })();
      T.toJSON(t); T.query(t, 'variables'); T.fromJSON(JSON.parse(JSON.stringify(T.toJSON(t))));
      // toSQL too, parameterized and inline: an unbound $constructor must render as a parameter, never as a prototype member
      const sql = (() => { try { return [T.toSQL(t), T.toSQL(t, {inline: true})]; } catch (e) { return (e instanceof T.TcxpError ? 'tcxp-error: ' : 'JS-ERROR: ') + e.message; } })();
      return norm(JSON.stringify({diag: t.diagnostics.filter(d => d.level !== 'info').map(d => d.level + ':' + d.msg), kind: r.kind, msg: r.msg, gaps: r.gaps, rows: r.rows ? r.rows.length : undefined, value: r.value, sql}));
    } catch (e) { return norm((e instanceof T.TcxpError ? 'tcxp-error: ' : 'JS-ERROR: ') + e.message); }
  };
  for (const n of NAMES) for (const [where, uri] of nameCases(n)) {
    const control = nameCases('plain_name').find(c => c[0] === where)[1];
    const got = outcome(uri, n), want = outcome(control, 'plain_name');
    tally('JS-special names behave like ordinary names', got === want && !got.includes('JS-ERROR'), n + ' / ' + where + '\n   got  ' + got + '\n   want ' + want);
  }
  for (const n of NAMES) {
    let ok = true;
    try { T.registerCSV(n, n, 'a,b\n1,x\n'); const t = T.parseURI(T.fullAddress('!tcxp:/' + n + '/sql/select?cols=*&from=' + n)); ok = T.execute(t, {store: T.newStore()}).rows.length === 1 && !Object.hasOwn(Object.prototype, 'a'); }
    catch (e) { ok = e instanceof T.TcxpError; }
    finally { if (Object.hasOwn(T.REGISTRIES, n)) delete T.REGISTRIES[n]; }
    tally('registerCSV with a JS-special registry and table name', ok && Object.getPrototypeOf(T.REGISTRIES) === Object.prototype, n);
  }
}
console.log(Object.entries(res).map(([k, v]) => (v.pass === v.total ? 'ok  ' : 'FAIL') + ' ' + k + ': ' + v.pass + '/' + v.total).join('\n'));
console.log(JSON.stringify({api: 'phase-b', seed: SEED, addresses: corpus.length, editsApplied: applied, editsRefused: refused, failures: fail}));
process.exit(fail ? 1 : 0);
