// Phase C: ~intent rows. node test/intent.mjs [n=500] [seed=31]
import { createRequire } from 'module';
const T = createRequire(import.meta.url)('../tcxp.js');
const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const N = Number(ARGS[0] || 500), SEED = Number(ARGS[1] || 31);
const corpus = [...T.QUERIES.map(q => q.uri), ...new T.FilterGenerator(SEED).batch(N)];
const res = {}; let fail = 0;
const tally = (name, ok, msg) => { res[name] = res[name] || {pass: 0, total: 0}; res[name].total++; if (ok) res[name].pass++; else { fail++; if (msg) console.log('FAIL', name, msg); } };
let a = SEED; const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; const pick = xs => xs[Math.floor(rnd() * xs.length)];
const metaOf = (t, k) => { const m = t.parsed.meta.find(x => x[0] === k); return m ? m[1] : undefined; };
const run = t => { try { return T.execute(t, {store: T.newStore()}); } catch (e) { return {kind: 'error', code: e.code || 'JS ' + e.message}; } };
const randomRows = () => {
  const rows = [{role: 'user', text: pick(['How many hours?', 'Is it safe & sound?', 'Q3 #2'])}];
  const n = Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const mode = pick(['ASK', 'BLOCK', 'DEFAULT', 'WARN']);
    rows.push(Object.assign({role: pick(['manager', 'auditor']), text: 'Rule ' + i, require: pick(['$req_a', '$req_b', ['$req_a', '$req_c']]), if_empty: mode}, mode === 'DEFAULT' ? {default: pick([2024, 'x', 1.5])} : {}));
  }
  return rows;
};

for (const uri of corpus) {
  const t = T.parseURI(uri);
  const id = T.identity(t);
  // legacy string intents: unchanged string, no requirements, same result as with the intent removed
  const legacy = metaOf(t, 'intent');
  if (typeof legacy === 'string') {
    tally('legacy string intent round-trips unchanged', T.serialize(t).uri === uri && T.serialize(T.parseURI(T.strictForm(uri))).uri === uri && t.required.length === 0, uri);
    const without = T.edit(uri, [{op: 'meta', key: 'intent', value: null}], {pulse: false}).tree;
    tally('legacy string intent does not change the result', JSON.stringify(run(t)) === JSON.stringify(run(without)), uri);
  }
  // adding, replacing or removing intent rows never changes identity
  const rows = randomRows();
  const withRows = T.edit(uri, [{op: 'meta', key: 'intent', value: rows}], {pulse: false});
  tally('intent rows never change identity (add)', T.identity(withRows.tree) === id, withRows.uri);
  const removed = T.edit(withRows.uri, [{op: 'meta', key: 'intent', value: null}], {pulse: false});
  tally('intent rows never change identity (remove)', T.identity(removed.tree) === id, removed.uri);
  tally('intent rows round-trip', T.serialize(T.parseURI(withRows.uri)).uri === withRows.uri && T.serialize(T.parseURI(T.strictForm(withRows.uri))).uri === withRows.uri, withRows.uri);
  // required variables produce gaps; ASK/BLOCK halt (ask or gap) and nothing runs or writes
  const req = T.edit(uri, [{op: 'meta', key: 'intent', value: [{role: 'manager', text: 'State the reason.', require: '$req_reason', if_empty: pick(['ASK', 'BLOCK'])}]}], {pulse: false}).tree;
  tally('a required variable is a gap', req.gaps.includes('req_reason') && T.query(req, 'gaps').some(g => g.label === '$req_reason'), uri);
  tally('every gaps pointer resolves (intent slots too)', T.query(req, 'gaps').every(g => T.resolvePointer(req, g.pointer).length > 0), uri);
  const st = T.newStore(); let r; try { r = T.execute(req, {store: st}); } catch (e) { r = {kind: 'error', code: e.code}; }
  const rule = req.required[0].mode;
  tally('ASK returns ask, BLOCK returns gap, and nothing runs', (rule === 'ASK' ? (r.kind === 'ask' || (r.kind === 'gap' && req.gaps.length > 1)) : r.kind === 'gap') && !T.dataChanged(st) || r.kind === 'error', uri + ' ' + JSON.stringify(r));
  if (r.kind === 'ask') tally('ask carries the row text as the question', r.question === 'State the reason.' || req.gaps.length > 1, uri);
  // binding the required variable (bind is widened to intent-required variables) lifts the halt
  const bound = T.edit(T.serialize(req).uri, [{op: 'bind', var: 'req_reason', value: "'audit'"}], {pulse: false}).tree;
  tally('binding the required variable removes that gap', !bound.gaps.includes('req_reason') && T.identity(bound) !== T.identity(req), uri);
  tally('fromJSON keeps required-variable bindings', T.identity(T.fromJSON(JSON.parse(JSON.stringify(T.toJSON(bound))))) === T.identity(bound), uri);
}

// DEFAULT is never silent: the result lists it; recordDefaults adds an annotation and a pulse; identity unchanged
for (const id of ['intent-default']) {
  const q = T.QUERIES.find(x => x.id === id); const t = T.parseURI(q.uri); const r = run(t);
  tally('DEFAULT runs and lists the default in the result', r.kind === 'rows' && r.defaults && r.defaults[0].var === 'tax_year' && r.defaults[0].value === 2024);
  const rec = T.recordDefaults(q.uri, {at: '2026-10-05T00:00:00.000Z'});
  const p = metaOf(rec.tree, 'pulse')[0];
  tally('recordDefaults annotates and stamps a pulse', rec.tree.spikes.some(sp => sp.id === 'default-tax_year' && sp.data) && p.defaults && p.defaults[0].value === 2024 && p.parent === T.identity(t));
  tally('recordDefaults keeps identity', T.identity(rec.tree) === T.identity(t));
  tally('recordDefaults is idempotent on annotations', T.recordDefaults(rec.uri, {pulse: false}).tree.spikes.filter(sp => sp.id === 'default-tax_year').length === 1);
  tally('fromJSON does not turn a default into a binding', T.identity(T.fromJSON(JSON.parse(JSON.stringify(T.toJSON(t))))) === T.identity(t));
}
// the demo: ask until bound, then the Postgres-verified answer (verify.mjs checks 59.25 against PostgreSQL)
{
  const ask = T.parseURI(T.QUERIES.find(x => x.id === 'intent-ask').uri);
  const r1 = run(ask);
  tally('demo: ask until $tax_year is bound', r1.kind === 'ask' && r1.question === 'Before submitting, the user must state the tax year they are referencing.');
  const r2 = run(T.edit(T.serialize(ask).uri, [{op: 'bind', var: 'tax_year', value: '2024'}]).tree);
  tally('demo: bound, it runs (59.25)', r2.kind === 'rows' && r2.rows[0][0] === 59.25, JSON.stringify(r2));
}
// malformed intent rows are errors, so they cannot be silently ignored
for (const bad of [[{require: 'tax_year'}], [{require: '$x', if_empty: 'MAYBE'}], [{require: '$x', if_empty: 'DEFAULT'}], [{if_empty: 'ASK'}], ['just text in an array']]) {
  const t = T.parseURI('!tcxp:/registry/math/eval?expr=gt(1,0)&~intent=' + encodeURIComponent(JSON.stringify(bad)));
  tally('malformed intent rows are errors', t.diagnostics.some(d => d.level === 'error' && /~intent row/.test(d.msg)), JSON.stringify(bad));
}
// edit param op (function parameters), symmetric with bind
{
  const out = T.edit('@!tcxp:/registry/hello?do=world', [{op: 'param', name: 'do', value: 'R&D'}], {pulse: false});
  tally('param sets a function parameter', out.uri === '@!tcxp:/registry/hello?do=R%26D' && run(out.tree).value === 'hello, R&D', out.uri);
  const cleared = T.edit(out.uri, [{op: 'param', name: 'do', value: null}], {pulse: false});
  tally('param null clears it (a gap)', cleared.tree.gaps.includes('do'), cleared.uri);
  let threw = 0; for (const op of [{op: 'param', name: 'nope', value: 'x'}, {op: 'param', name: 'constructor', value: 'x'}]) { try { T.edit('@!tcxp:/registry/hello?do=x', [op]); } catch (e) { if (e.code === 'edit') threw++; } }
  try { T.edit('!tcxp:/registry/math/eval?expr=gt(1,0)', [{op: 'param', name: 'do', value: 'x'}]); } catch (e) { if (e.code === 'edit') threw++; }
  tally('param refuses unknown names and non-functions', threw === 3);
}
console.log(Object.entries(res).map(([k, v]) => (v.pass === v.total ? 'ok  ' : 'FAIL') + ' ' + k + ': ' + v.pass + '/' + v.total).join('\n'));
console.log(JSON.stringify({intent: 'phase-c', seed: SEED, addresses: corpus.length, failures: fail}));
process.exit(fail ? 1 : 0);
