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
  for (let i = 0; i < n; i++) rows.push(Object.assign({role: pick(['manager', 'auditor']), text: 'Rule ' + i, require: pick(['$req_a', '$req_b', ['$req_a', '$req_c']])}, rnd() < 0.5 ? {if_empty: 'HALT'} : {}));
  return rows;
};

for (const uri of corpus) {
  const t = T.parseURI(uri);
  const id = T.identity(t);
  // A resolvable address (tcxp://) takes no bindings: an intent row that requires a variable is an error there,
  // and rows that require nothing are meta like any other (identity unchanged).
  if (t.parsed.form === 'resolvable') {
    let err = null;
    try { T.edit(uri, [{op: 'meta', key: 'intent', value: [{role: 'manager', text: 'State the reason.', require: '$req_reason'}]}], {pulse: false}); } catch (e) { err = e; }
    tally('a resolvable address cannot require variables (error, never a silent pass)', !!err && /cannot require variables/.test(err.message), uri);
    const plain = T.edit(uri, [{op: 'meta', key: 'intent', value: [{role: 'user', text: 'Which rule applies?'}]}], {pulse: false});
    tally('intent rows never change identity (add)', T.identity(plain.tree) === id, plain.uri);
    continue;
  }
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
  // required variables produce gaps, and a gap always halts: nothing runs or writes
  const req = T.edit(uri, [{op: 'meta', key: 'intent', value: [{role: 'manager', text: 'State the reason.', require: '$req_reason', ...(rnd() < 0.5 ? {if_empty: 'HALT'} : {})}]}], {pulse: false}).tree;
  tally('a required variable is a gap', req.gaps.includes('req_reason') && T.query(req, 'gaps').some(g => g.label === '$req_reason'), uri);
  tally('every gaps pointer resolves (intent slots too)', T.query(req, 'gaps').every(g => T.resolvePointer(req, g.pointer).length > 0), uri);
  const st = T.newStore(); let r; try { r = T.execute(req, {store: st}); } catch (e) { r = {kind: 'error', code: e.code}; }
  // An address that is malformed or refused (an update/delete without where=) reports that first: binding the
  // variable could never make it run. Either way nothing runs or writes.
  const refusedFirst = req.diagnostics.some(d => d.level === 'error' || d.level === 'refused');
  tally('A gap always halts. Nothing runs or writes until every required variable is bound.', (refusedFirst ? r.kind === 'error' : r.kind === 'halt') && !T.dataChanged(st), uri + ' ' + JSON.stringify(r));
  if (!refusedFirst) tally('a halt lists the variables and the rows that require them', r.kind === 'halt' && r.gaps.includes('req_reason') && r.requiredBy.some(x => x.var === 'req_reason' && x.row === 0 && x.role === 'manager' && x.text === 'State the reason.'), uri + ' ' + JSON.stringify(r));
  // binding the required variable (bind is widened to intent-required variables) lifts the halt
  const bound = T.edit(T.serialize(req).uri, [{op: 'bind', var: 'req_reason', value: "'audit'"}], {pulse: false}).tree;
  tally('binding the required variable removes that gap', !bound.gaps.includes('req_reason') && T.identity(bound) !== T.identity(req), uri);
  tally('fromJSON keeps required-variable bindings', T.identity(T.fromJSON(JSON.parse(JSON.stringify(T.toJSON(bound))))) === T.identity(bound), uri);
}

// every plain gap in the query halts too, with no rows listed
for (const uri of corpus) {
  const t = T.parseURI(uri); if (!t.gaps.length || t.required.length) continue;
  const r = run(t);
  tally('a plain query gap halts (no requiredBy)', r.kind === 'halt' && JSON.stringify(r.gaps) === JSON.stringify(t.gaps) && r.requiredBy === undefined, uri);
}
// resultKey: same identity with and without a required variable, but a different result key (it halts)
{
  const base = T.QUERIES.find(x => x.id === 'csv-us-hours-2024').uri.replace('&$tax_year=2024', '').replace('eq(year(date),$tax_year)', 'true').replace('and(eq(work_country,\'US\'),true)', "eq(work_country,'US')");
  const plain = T.parseURI(T.QUERIES.find(x => x.id === 'intent-require-only').uri.replace(/&~intent=.*$/, ''));
  const req = T.parseURI(T.QUERIES.find(x => x.id === 'intent-require-only').uri);
  tally('required variable: same identity, different resultKey, halts', T.identity(plain) === T.identity(req) && T.resultKey(plain) !== T.resultKey(req) && run(req).kind === 'halt' && run(plain).kind === 'rows', base);
}
// the demo: halt until bound, then the Postgres-verified answer (verify.mjs checks 59.25 against PostgreSQL)
{
  const halted = T.parseURI(T.QUERIES.find(x => x.id === 'intent-halt').uri);
  const r1 = run(halted);
  tally('demo: halts until $tax_year is bound', r1.kind === 'halt' && r1.requiredBy[0].text === 'Before submitting, the user must state the tax year they are referencing.');
  const r2 = run(T.edit(T.serialize(halted).uri, [{op: 'bind', var: 'tax_year', value: '2024'}]).tree);
  tally('demo: bound, it runs (59.25)', r2.kind === 'rows' && r2.rows[0][0] === 59.25, JSON.stringify(r2));
}
// malformed intent rows are errors, so they cannot be silently ignored
for (const bad of [[{require: 'tax_year'}], [{require: '$x', if_empty: 'MAYBE'}], [{require: '$x', if_empty: 'BLOCK'}], [{require: '$x', if_empty: 'WARN'}], [{require: '$x', if_empty: 'DEFAULT', default: 1}], [{require: '$x', if_empty: 'halt'}], [{if_empty: 'HALT'}], ['just text in an array']]) {
  const t = T.parseURI('!tcxp:/registry/math/eval?expr=gt(1,0)&~intent=' + encodeURIComponent(JSON.stringify(bad)));
  tally('malformed intent rows are errors', t.diagnostics.some(d => d.level === 'error' && /~intent row/.test(d.msg)), JSON.stringify(bad));
}
// ASK and ACT are reserved: an error naming the reservation, never a silent HALT
for (const mode of ['ASK', 'ACT']) {
  const t = T.parseURI('!tcxp:/registry/math/eval?expr=gt(1,0)&~intent=' + encodeURIComponent(JSON.stringify([{role: 'manager', text: 'x', require: '$x', if_empty: mode}])));
  const d = t.diagnostics.find(x => x.level === 'error');
  let threw = false; try { T.execute(t); } catch (e) { threw = true; }
  tally('ASK and ACT are reserved (error, never a silent HALT)', !!d && d.msg.includes(mode + ' is reserved for a future version; v0.2 supports HALT only') && threw && t.required.length === 0, JSON.stringify(t.diagnostics));
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
