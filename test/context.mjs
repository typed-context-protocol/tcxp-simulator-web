// The ~context grammar (v0.2).   node test/context.mjs [n=500] [seed=31]
// One ~context key, last, on every full address: {"intent":[],"observe":[],"reason":[],"decide":[],"trace":[]}.
// Entries are rows (JSON objects, fields not defined) or bare tcxp addresses. The context never changes identity.
// No test touches the network or the disk except through explicit resolve (none here).
import { createRequire } from 'module';
import fs from 'fs';
import { createHash } from 'crypto';
const T = createRequire(import.meta.url)('../tcxp.js');
const ARGS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const N = Number(ARGS[0] || 500), SEED = Number(ARGS[1] || 31);
const corpus = [...T.QUERIES.map(q => q.uri), ...new T.FilterGenerator(SEED).batch(N)];
const res = {}; let fail = 0;
const tally = (name, ok, msg) => { res[name] = res[name] || {pass: 0, total: 0}; res[name].total++; if (ok) res[name].pass++; else { fail++; if (msg) console.log('FAIL', name, msg); } };
let a = SEED; const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; const pick = xs => xs[Math.floor(rnd() * xs.length)];
const enc = s => s.replace(/%/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23');
const EMPTY = {intent: [], observe: [], reason: [], decide: [], trace: []};
const C = obj => '~context=' + enc(typeof obj === 'string' ? obj : JSON.stringify(obj));
const V = '!tcxp:/registry/math/eval?expr=gt(2,1)';
const withQ = (base, part) => base + (base.includes('?') ? '&' : '?') + part;
const rejected = (uri, re) => { try { T.parseURI(uri); return false; } catch (e) { return e instanceof T.TcxpError && (!re || re.test(e.message)); } };
const accepted = uri => { try { T.parseURI(uri); return true; } catch (e) { console.log('   rejected:', e.message); return false; } };

// spies: reading never fetches or reads files
const calls = {fetch: 0, readFile: 0};
globalThis.fetch = async () => { calls.fetch++; throw new Error('network is off in tests'); };
const fsp = fs.promises.readFile; fs.promises.readFile = (...x) => { calls.readFile++; return fsp(...x); };

// 1. Grammar: exactly one ~context, last, with exactly five arrays in order.
tally('a full address without ~context is rejected', rejected(V, /ends with ~context/));
for (const k of ['intent', 'observe', 'reason', 'decide', 'trace', 'pulse', 'spikes', 'outcome', 'review', 'source', 'meta', 'foo'])
  tally('a separate ~' + k + ' key is rejected', rejected(withQ(V, '~' + k + '=[]&' + C(EMPTY)), /the only ~ key is ~context/) && rejected(withQ(V, C(EMPTY) + '&~' + k + '=[]'), /comes last/));
tally('~context twice is rejected', rejected(withQ(V, C(EMPTY) + '&' + C(EMPTY)), /appears twice/));
tally('a data key after ~context is rejected', rejected(withQ(V, C(EMPTY) + '&x=1'), /comes last/));
tally('a $variable after ~context is rejected', rejected(withQ(V, C(EMPTY) + '&$x=1'), /comes last/));
tally('a data key after a $variable is rejected', rejected('!tcxp:/registry/math/eval?$x=1&expr=gt($x,1)&' + C(EMPTY), /Data keys come before \$variables/));
for (const k of Object.keys(EMPTY)) { const o = Object.assign({}, EMPTY); delete o[k]; tally('a missing context key is rejected', rejected(withQ(V, C(o)), new RegExp('missing "' + k + '"')), k); }
tally('an extra context key is rejected', rejected(withQ(V, C(Object.assign({}, EMPTY, {pulse: []}))), /no key "pulse"/));
for (let i = 0; i < 8; i++) {
  const keys = Object.keys(EMPTY).sort(() => rnd() - 0.5); if (keys.join() === Object.keys(EMPTY).join()) continue;
  tally('context keys out of order are rejected', rejected(withQ(V, C('{' + keys.map(k => '"' + k + '":[]').join(',') + '}')), /out of order/), keys.join());
}
for (const [what, val] of [['not JSON', '{intent:[]}'], ['an array', '[]'], ['a string', '"x"'], ['null', 'null']])
  tally('~context that is ' + what + ' is rejected', rejected(withQ(V, C(val))));
for (const [what, v] of [['an object', {}], ['a string', 'x'], ['null', null], ['a number', 1]])
  tally('a context key that is ' + what + ' instead of an array is rejected', rejected(withQ(V, C(Object.assign({}, EMPTY, {observe: v}))), /is a JSON array/));
for (const [what, e] of [['a number', 5], ['null', null], ['true', true], ['a nested array', []], ['plain text', 'hello'], ['!tcxp:// (aberration)', '!tcxp://x/y'],
  ['a reference with its own ~context', V + '&' + C(EMPTY)], ['a reference with whitespace', ' ' + V], ['tcxp:/ (aberration)', 'tcxp:/x/y']])
  for (const k of Object.keys(EMPTY))
    tally('an entry that is ' + what + ' is rejected (in any of the five arrays)', rejected(withQ(V, C(Object.assign({}, EMPTY, {[k]: [e]}))), /neither a row/), k + ' ' + JSON.stringify(e));

// 2. Accepted entries: any row, any bare reference in either format; the same rules for all five arrays.
const refs = ['!tcxp:/fleet.demo/notes/water-temp', 'tcxp://firm.demo/rules/tax-year', '@!tcxp:/registry/hello?do=x', '@tcxp://firm.demo/rules/tax-year', 'tcxp://not.registered/x?k=v&$y=1'];
const rows = [{}, {a: 1}, {anything: [1, {deep: true}], 'odd key': null}, {role: 'user', text: 'q'}, {step: 'not a number', parent: 7}];
for (const k of Object.keys(EMPTY)) {
  tally('rows of any shape are accepted', accepted(withQ(V, C(Object.assign({}, EMPTY, {[k]: rows})))), k);
  tally('bare references in both formats are accepted', accepted(withQ(V, C(Object.assign({}, EMPTY, {[k]: refs})))), k);
}

// 3. Canonical form: compact, keys fixed, byte-identical round trips (strict transport form too).
{
  const spaced = withQ(V, '~context=' + enc('{ "intent": [ {"role": "user", "text": "q?"} ], "observe": [], "reason": [], "decide": [], "trace": [] }'));
  const t = T.parseURI(spaced), canon = T.serialize(t).uri;
  tally('the context is written compactly', canon.endsWith('~context={"intent":[{"role":"user","text":"q?"}],"observe":[],"reason":[],"decide":[],"trace":[]}'), canon);
  tally('a canonical address round-trips byte for byte', T.serialize(T.parseURI(canon)).uri === canon && T.serialize(T.parseURI(T.strictForm(canon))).uri === canon);
}
for (const uri of corpus) tally('every corpus address round-trips byte for byte', T.serialize(T.parseURI(uri)).uri === uri && T.serialize(T.parseURI(T.strictForm(uri))).uri === uri, uri);

// 4. The context never changes identity; it does change the fingerprint.
const randomContext = () => { const c = {intent: [], observe: [], reason: [], decide: [], trace: []}; Object.keys(c).forEach(k => { const n = Math.floor(rnd() * 3); for (let i = 0; i < n; i++) c[k].push(rnd() < 0.7 ? pick(rows) : pick(refs)); }); return c; };
for (const uri of corpus) {
  const t = T.parseURI(uri), id = T.identity(t);
  const other = T.edit(uri, Object.keys(EMPTY).map(k => ({op: 'context', key: k, value: randomContext()[k]})), {pulse: false});
  tally('the context never changes identity', T.identity(other.tree) === id, other.uri);
  tally('the identity is the address with ~context removed', T.fullAddress(id) === T.serialize(T.parseURI(T.fullAddress(id))).uri && T.identity(T.parseURI(T.fullAddress(id))) === id, uri);
  if (other.uri !== T.serialize(t).uri) tally('a different context gives a different fingerprint', T.fingerprint(other.uri) !== T.fingerprint(uri));
}

// 5. Pointers into the context.
{
  const c = Object.assign({}, EMPTY, {observe: [{a: 1}, 'tcxp://firm.demo/rules/tax-year'], trace: [{step: 1}]});
  const t = T.parseURI(withQ(V, C(c)));
  tally('/~context/<key>/<i> resolves to the entry', JSON.stringify(T.resolvePointer(t, '/~context/observe/0')) === '[{"a":1}]' && T.resolvePointer(t, '/~context/observe/1')[0] === 'tcxp://firm.demo/rules/tax-year');
  tally('/~context/<key> resolves to the array', T.resolvePointer(t, '/~context/trace')[0].length === 1);
  tally('out-of-range and unknown context pointers resolve to nothing', T.resolvePointer(t, '/~context/observe/2').length === 0 && T.resolvePointer(t, '/~context/pulse/0').length === 0 && T.resolvePointer(t, '/~context/observe/0/a').length === 0);
  tally('query pointer: works on the context', T.query(t, 'pointer:/~context/observe/1')[0].label === 'tcxp://firm.demo/rules/tax-year');
  tally('a spike can point into the context', (() => { const u = T.edit(T.serialize(t).uri, [{op: 'annotate', on: ['/~context/observe/0'], meaning: 'm'}], {pulse: false}); return u.tree.spikes[0].data === true; })());
}

// 6. Reading never resolves, fetches or runs a reference in the context.
{
  const before = calls.fetch + calls.readFile;
  const uri = withQ(V, C(Object.assign({}, EMPTY, {observe: refs, intent: refs, trace: refs})));
  const t = T.parseURI(uri); T.serialize(t); T.execute(t); T.toJSON(t); T.query(t, 'annotations'); T.edit(uri, [{op: 'context', key: 'decide', value: refs}]);
  tally('reading never fetches a reference', calls.fetch + calls.readFile === before);
}

// 7. The one halt rule: an unbound variable halts, wherever an expression has one. Context rows never halt anything.
{
  const C2 = "!tcxp:/client.demo/sql/select?cols=as(sum(hours),us_hours)&from=client_hours&where=eq(work_country,'US')";
  const rowsSayRequire = {intent: [{role: 'manager', text: 'State the tax year.', require: '$tax_year', if_empty: 'HALT'}]};
  tally('intent rows that mention require never halt', T.execute(T.parseURI(T.fullAddress(C2, Object.assign({}, EMPTY, rowsSayRequire)))).kind === 'rows');
  for (const ref of ['!tcxp:/registry/math/eval?expr=gt($x,1)', "!tcxp:/school.demo/sql/select?cols=*&from=students&where=eq(gpa,$g)", '@!tcxp:/registry/hello',
    "!tcxp:/school.demo/sql/update?table=students&set=assign(gpa,$gpa)&where=eq(student_id,1)"]) {
    const st = T.newStore(); const r = T.execute(T.parseURI(T.fullAddress(ref)), {store: st});
    tally('an unbound variable halts (math, select, function, write)', r.kind === 'halt' && r.gaps.length === 1 && !T.dataChanged(st), ref + ' ' + JSON.stringify(r));
  }
}

// 8. Fingerprints, the address store and the pulse chain.
{
  const u = T.fullAddress(V);
  tally('fingerprint is SHA-256 of the full canonical address', T.fingerprint(u) === createHash('sha256').update(u, 'utf8').digest('hex'));
  const long = T.QUERIES.find(q => q.id === 'ice-baltic').uri;
  tally('fingerprint handles non-ASCII text', T.fingerprint(long) === createHash('sha256').update(long, 'utf8').digest('hex'));
  tally('fingerprint is of the canonical form', T.fingerprint(withQ(V, '~context=' + enc('{"intent": [], "observe":[],"reason":[],"decide":[],"trace":[]}'))) === T.fingerprint(u));
  const fp = T.storeAddress(long);
  tally('storeAddress / lookupAddress round-trip', T.lookupAddress(fp) === long && T.lookupAddress('0'.repeat(64)) === null);
  let cur = u; const seen = [u];
  for (let i = 0; i < 4; i++) { cur = T.edit(cur, [{op: 'context', key: 'observe', value: [{n: i}]}], {at: '2026-10-06T00:00:0' + i + '.000Z'}).uri; seen.push(cur); }
  let ok = true, node = cur, steps = [];
  while (true) { const p = T.parseURI(node).parsed.context.trace.find(r => r && r.step !== undefined); if (!p || p.parent === null) break; steps.push(p.step); node = T.lookupAddress(p.parent); if (!node) { ok = false; break; } }
  tally('following parents back through the store returns every step exactly', ok && node === u && JSON.stringify(steps) === '[4,3,2,1]', JSON.stringify(steps));
  const withSource = T.fullAddress(V, Object.assign({}, EMPTY, {trace: [{file: 'x.csv', rows: 3}]}));
  const p1 = T.withPulse(T.parseURI(withSource), 1, '2026-10-06T00:00:00.000Z', 300, null);
  const p2 = T.withPulse(T.parseURI(p1), 2, '2026-10-06T00:00:01.000Z', 300, T.storeAddress(p1), {undo: ['@!tcxp:/school.demo/sql/delete?from=courses&where=eq(course_id,6)']});
  const tr = T.parseURI(p2).parsed.context.trace;
  tally('a new pulse row replaces the old one, goes first, and keeps other trace rows', tr.length === 2 && tr[0].step === 2 && tr[1].file === 'x.csv' && T.lookupAddress(tr[0].parent) === p1 && tr[0].undo.length === 1);
}

console.log(Object.entries(res).map(([k, v]) => (v.pass === v.total ? 'ok  ' : 'FAIL') + ' ' + k + ': ' + v.pass + '/' + v.total).join('\n'));
console.log(JSON.stringify({context: 'v0.2', seed: SEED, addresses: corpus.length, checks: Object.values(res).reduce((x, v) => x + v.total, 0), failures: fail}));
process.exit(fail ? 1 : 0);
