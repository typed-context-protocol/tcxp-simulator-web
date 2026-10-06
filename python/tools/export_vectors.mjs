// Exports conformance vectors from tcxp.js into python/vectors/ (JSON Lines).
// The Python package must reproduce every line byte for byte (see python/tests/test_vectors.py).
// Usage: node python/tools/export_vectors.mjs
// Vectors must not depend on the machine: pin the timezone before anything touches Date.
process.env.TZ = 'UTC';
import {createRequire} from 'module';
import fs from 'fs';
import zlib from 'zlib';
const T = createRequire(import.meta.url)('../../tcxp.js');
const dir = new URL('../vectors/', import.meta.url);
fs.mkdirSync(dir, {recursive: true});

const errOf = e => ({error: e.message, type: e instanceof T.TcxpError ? 'TcxpError' : e.constructor.name, where: e.where === undefined ? null : e.where});
const attempt = f => { try { return f(); } catch (e) { return errOf(e); } };

// Every field the two engines must agree on, for one address.
function fields(uri) {
  const rec = {uri};
  rec.filter = (f => ({ok: f.ok, rules: f.rules.map(r => [r.id, r.pass, r.msg])}))(T.FilterGenerator.filter(uri));
  let tree;
  try { tree = T.parseURI(uri); } catch (e) { rec.parse = errOf(e); return rec; }
  rec.canonical = T.serialize(tree).uri;
  rec.identity = T.identity(tree);
  rec.strict = attempt(() => T.strictForm(uri));
  rec.slots = tree.slots;
  rec.gaps = tree.gaps;
  rec.diagnostics = tree.diagnostics;
  rec.spikes = tree.spikes.map(s => ({id: s.id, on: s.on, bits: s.bits, data: s.data, problems: s.problems, facets: s.facets,
    targets: s.targets.map(t => ({ptr: t.ptr, count: t.nodes.length}))}));
  rec.json = T.toJSON(tree);
  rec.sql = attempt(() => T.toSQL(tree));
  rec.sql_inline = attempt(() => T.toSQL(tree, {inline: true}));
  rec.math = T.toMath(tree, false);
  rec.math_written = T.toMath(tree, true);
  rec.execute = attempt(() => T.execute(tree));
  return rec;
}

const counts = {};
function write(name, recs) {
  const text = recs.map(r => JSON.stringify(r)).join('\n') + '\n';
  // Large files are gzipped. zlib's compressed bytes differ by CPU, so an existing file whose
  // decompressed content is unchanged is left as is; the content is the contract.
  if (name.endsWith('.gz')) {
    const url = new URL(name, dir);
    const same = fs.existsSync(url) && zlib.gunzipSync(fs.readFileSync(url)).toString('utf8') === text;
    if (!same) fs.writeFileSync(url, zlib.gzipSync(Buffer.from(text, 'utf8'), {level: 9}));
  }
  else fs.writeFileSync(new URL(name, dir), text);
  counts[name] = recs.length;
}

// 1. The collection (20 addresses) and every coverage address.
const collection = [];
T.QUERIES.forEach(q => collection.push({source: 'query', id: q.id, ...fields(q.uri)}));
T.COVERAGE.forEach((c, i) => { if (c[3]) collection.push({source: 'coverage', id: 'coverage-' + i, ...fields(c[3])}); });
write('collection.jsonl', collection);

// 2. 5,000 FilterGenerator addresses, seed 7, in order.
const SEED = 7, N = 5000;
const gen = new T.FilterGenerator(SEED);
const generated = [];
for (let i = 0; i < N; i++) generated.push({seed: SEED, index: i, ...fields(gen.next())});
write('generated.jsonl.gz', generated);

// 3. withPulse, chained through parent, over the collection and every 25th generated address.
const pulseSrc = collection.map(r => r.uri).concat(generated.filter((_, i) => i % 25 === 0).map(r => r.uri));
const pulse = []; let parent;
const DEBOUNCES = [undefined, 0, 300, 150];
pulseSrc.forEach((uri, i) => {
  const tree = T.parseURI(uri);
  const step = i + 1;
  const at = new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + i * 1037).toISOString();
  const debounce = DEBOUNCES[i % 4];
  const usedParent = i % 7 === 3 ? undefined : parent;
  const out = T.withPulse(tree, step, at, debounce, usedParent);
  const reparsed = T.parseURI(out);
  pulse.push({uri, step, at, debounce: debounce === undefined ? null : debounce, parent: usedParent === undefined ? null : usedParent,
    out, out_identity: T.identity(reparsed), out_pulse: reparsed.parsed.meta.find(m => m[0] === 'pulse')[1]});
  parent = T.identity(tree);
});
write('pulse.jsonl', pulse);

// 4. Malformed addresses: every engine error message, plus the filter verdicts.
const S = '!tcxp:/school.demo/sql/select?';
const M = '!tcxp:/registry/math/eval?';
const BAD = [
  '', '   ', 'tcxp:/school.demo', 'http://example.com', '!tcxp:/', '!tcxp://school.demo/sql/select?cols=*&from=students',
  '!tcxp:/nowhere.demo/sql/select?cols=*&from=x', '!tcxp:/fleet.demo/sql/select?cols=*&from=x', '!tcxp:/school.demo/no/such/path',
  '@!tcxp:/school.demo/sql/select?cols=*&from=students', '@!tcxp:/registry/notes/equation',
  S + 'cols=*&from=students&~intent=x&where=eq(gpa,1)', S + 'cols=*&from=students&~bad-key=1', S + 'cols=*&from=students&~a=1&~a=2',
  S + 'cols=*&from=students&$1x=3', S + "cols=*&from=students&where=eq(cohort,$c)&$c='a'&$c='b'",
  S + "cols=*&from=students&where=eq(cohort,$c)&$c=lower('a')", S + 'cols=*&from=students&where=eq(cohort,$c)&$c=1,2',
  S + 'cols=*&from=students&bogus=1', S + 'cols=*&from=students&from=courses', S + 'cols=*&from=students,courses',
  S + 'cols=*&from=students&join=students', S + 'cols=*&from=students&where=eq(a,1),eq(b,2)', S + 'cols=*', S + 'from=students',
  S + 'cols=*&from=lower(x)', S + 'cols=*&from=students&noequals', S + 'cols=*&from=students&where=eq(cohort,%ZZ)',
  S + "cols=*&from=students&where=eq(cohort,'open", S + 'cols=*&from=students&where=eq(cohort,$)', S + 'cols=*&from=students&where=eq(gpa,1.2.3)',
  S + 'cols=*&from=students&where=eq(gpa,#)', S + 'cols=*&from=students&where=eq(gpa', S + 'cols=*&from=students&where=eq(gpa,1',
  S + 'cols=*&from=students&where=eq(gpa;1)', S + 'cols=*&from=students&where=frob(gpa)', S + 'cols=*&from=students&where=eq(gpa)',
  S + 'cols=*&from=students&where=and(eq(gpa,1))', S + 'cols=as(gpa,1)&from=students', S + 'cols=*&from=students&join=inner(eq(a,b),x)',
  S + 'cols=*&from=students&where=', S + 'cols=*&from=students&where=eq(gpa,1) eq(gpa,2)', S + 'cols=*&from=students&where=)',
  S + 'cols=*&from=students&where=eq(,1)', S + 'cols=*&from=students&where=round(gpa,1,2)', S + 'cols=*&from=students&where=in(gpa)',
  M + 'x=1', M + 'expr=1&expr=2', M + 'expr=lower(1)', M + 'expr=1,2', M, '!tcxp:/registry/hello?nope=1', '!tcxp:/registry/hello?do=a&do=b',
  '!tcxp:/registry/notes/equation?x=1', S + 'cols=*&from=students&~spikes=[1,', S + 'cols=*&from=students&~spikes={"a":}',
  S + 'cols=nope&from=students', S + 'cols=courses.code&from=students', S + 'cols=student_id&from=students&join=inner(enrollments,eq(enrollments.student_id,students.student_id))',
  S + 'cols=*&from=nope', S + "cols=*&from=students&where=eq(gpa,$g)&$g='high'", S + 'cols=*&from=students&$unused=1',
  M + 'expr=lt(water,1)', M + 'expr=div(1,0)&$x=1', M + 'expr=div($x,0)&$x=1',
  S + 'cols=*&from=students&where=eq(cohort,$c)&$c=@!tcxp:/registry/hello?do=x', S + 'cols=sum(gpa)&from=students&where=gt(sum(gpa),1)',
  S + 'cols=*&from=students&~spikes=[{"id":"s1","on":["/nope/0"],"meaning":"!tcxp:/registry/notes/missing"}]',
  S + 'cols=*&from=students&~spikes=[{"on":"/where/0","meaning":"!tcxp:/registry/notes/equation","structure":5,"environment":""},7,null,"x"]',
  S + 'cols=*&from=students&~spikes={"on":["/cols/0","/$x"],"meaning":"plain text"}', S + 'cols=*&from=students&~n=-12&~t= [1,2] &~u=12x',
  S + 'cols=*&from=students&~o={"b":1,"10":2,"a":{"2":3,"x":[1.50,-0,1e400]}}', S + "cols=*&from=students&where=eq(email,'a%26b%25c%23d%3De')",
  "!tcxp:/registry/math/eval?expr=eq(add(mul(2,$x),3),9)&$x=3&~intent=Is 2x + 3 = 9 é \u{1F600}?",
  S + "cols=*&from=students&where=like(email,'%25.chen@%25')", S + "cols=*&from=students&where=ilike(first_name,'m_ya')",
  S + "cols=first_name&from=students&where=eq(lower(first_name),'maya')&order=desc(gpa)&limit=$n&offset=$o&$n=2&$o=-1",
  M + "expr=add('a',1)", M + "expr=eq('a',1)", M + 'expr=pow(2,10)', M + 'expr=pow(-8,0.5)', M + 'expr=div(7,2)', M + 'expr=not(0)',
  M + 'expr=eq(99999999999999999999,100000000000000000000)', M + 'expr=mul(0.1,3)', M + 'expr=sub(0.3,0.1)', M + 'expr=div(1,3)'
];
write('errors.jsonl', BAD.map((uri, i) => ({id: 'case-' + i, ...fields(uri)})));

// 5. Constants and data: everything the Python package must carry unchanged.
const registries = {};
for (const [name, reg] of Object.entries(T.REGISTRIES)) {
  registries[name] = {title: reg.title, description: reg.description, db: reg.db || null, notes: reg.notes,
    fns: Object.fromEntries(Object.entries(reg.fns).map(([p, f]) => [p, {params: f.params, returns: f.returns, doc: f.doc}]))};
}
const constants = {registries, queries: T.QUERIES, groups: T.GROUPS, coverage: T.COVERAGE, ops: T.OPS, clauses: T.CLAUSES,
  clause_order: T.CLAUSE_ORDER, rules: T.RULES, facets: T.FACETS, scheme: T.SCHEME, debounce_ms: T.DEBOUNCE_MS,
  ddl: Object.fromEntries(Object.keys(T.REGISTRIES).filter(r => T.REGISTRIES[r].db).map(r => [r, T.fullDDL(r)])),
  base_type: ['numeric(3,2)', 'integer', 'text', null, 'varchar(10)', 'a(b)(c)'].map(t => [t, T.baseType(t) === undefined ? null : T.baseType(t)])};
fs.writeFileSync(new URL('constants.json', dir), JSON.stringify(constants) + '\n');
counts['constants.json'] = 1;

// 6. JavaScript semantics the engine relies on (number text, rounding, JSON.parse messages, dates, URI decoding).
const num = x => Object.is(x, -0) ? '-0' : Number.isFinite(x) ? x : String(x);
const NUMS = [0, -0, 1, -1, 0.1, 0.2, 0.1 + 0.2, 1 / 3, 2 / 3, 123.456, 1e21, 1e-7, 1.5e-7, 1e-6, 123e-20, 2 ** 53, 2 ** 53 + 2, 2 ** 64,
  1e300 * 10, 5e-324, 1.7976931348623157e308, 100, 1e20, 123456789012345680000, 0.000001234, -1.5e300, 3.92, 59.25, 988.4, -0.5, 12.5];
const ROUND = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994, -0.49999999999999994, 4503599627370495.5, 1e16, -1e-300, 98840.00000000001, 2.675 * 100];
const POW = [[2, 10], [10, -1], [10, 2], [-8, 0.5], [0, -1], [-0, -1], [-0, -2], [1, Infinity], [-1, Infinity], [NaN, 0], [1, NaN], [10, 400], [-10, 401], [2, 0.5], [0.1, 3]];
const JSONS = ['[1,', '{"a":}', '{a:1}', '[1 2]', '{"a":1 "b":2}', '{"a" 1}', '"abc', '"a\u0001"', '"\\x"', '"\\u12G4"', '-', '1e', '1.', '[1]x', 'tru',
  '[01]', '{"a":1,}', '[1,]', '[ "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", ? ]', '{\n"a":\n}', '[1,\r\n 2\n x]', '["€" x]', '[NaN]', '[-Infinity]', '[]  ]',
  '"\\', '"\\u12', '[tx]', '[t"]', '[t1]', '[1.5e+]', '[-01]', '[0.e1]', '[1e+5]', '["\\/"]', '[object Object]', '{"aaaaaaaaaaaaaaaaaaaaaaaaaa":1,]',
  '[1,2,3,4,5,6,7,8,9,10,],', '["\\uD83D\\uDE00", "\\ud800", "😀", 1.0, -0, 1e400, 1E-7]', '{"b":1,"10":2,"2":3,"a":{"1":true}}', '[1,"😀😀😀😀😀😀😀😀😀😀😀" ?]'];
const DATES = ['2026-08-12T00:00:00Z', '2026-09-11T21:04:00+00:00', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-09-11T24:00:00Z',
  '2026-09-11T24:00:01Z', '2026-08-12xyz', '2026-08-12T', '2026-08-12T10:00Z', '2026-08-12T10:00:00.5Z', '2026-08-12T10:00:00.123456Z',
  '2026-08-12T00:00:00z', '2026-08-12 10:00:00+01:00', '2026-08-12T00:00:00+0100', '2026', '2026-08', '+002026-08-12', '-000001-01-01',
  '2026-08-12T10:00:00+23:59', '2026-08-12T10:00:00+01:60', '0000-01-01T00:00:00Z', '+275760-09-13T00:00:00Z', '+275760-09-13T00:00:00.001Z'];
const DECODES = ['abc', '%41', '%e2%82%ac', '%E2%82', '%', '%4', '%zz', '%C0%80', '%ED%A0%80', '%F0%9F%98%80', '%F4%90%80%80', '%26%3D', 'caf%C3%A9'];
const NUMSTR = ['', ' 12 ', '0x1F', '1e3', '.5', '5.', '+1', '-', 'Infinity', '-Infinity', 'abc', '1_000', ' 12 ', '0b101', '1e400', '12abc'];
const CMP = [['a', 'b'], ['B', 'a'], ['😀', '￿'], ['￿', '😀'], ['10', '9'], [10, '9'], ['abc', 1], [true, 0], [null, 0]];
const semantics = {
  numbers: NUMS.map(x => [num(x), String(x)]),
  round: ROUND.map(x => [num(x), num(Math.round(x))]),
  pow: POW.map(([a, b]) => [num(a), num(b), num(Math.pow(a, b))]),
  json: JSONS.map(src => { try { return [src, null, JSON.stringify(JSON.parse(src))]; } catch (e) { return [src, e.message, null]; } }),
  dates: DATES.map(s => [s, num(Date.parse(s))]),
  decode: DECODES.map(s => { try { return [s, decodeURIComponent(s)]; } catch (e) { return [s, null]; } }),
  to_number: NUMSTR.map(s => [s, num(Number(s))]),
  compare: CMP.map(([a, b]) => [a, b, a < b, b < a]),
  utc: [[2026, 9, 29, 23, 59, 59, 999], [2026, 12, 1, 0, 0, 0, 0], [1969, 11, 31, 23, 59, 59, 999], [2026, 1, 31, 0, 0, 0, 0]].map(a => [a, new Date(Date.UTC(...a)).toISOString()])
};
fs.writeFileSync(new URL('semantics.json', dir), JSON.stringify(semantics) + '\n');
counts['semantics.json'] = Object.values(semantics).reduce((n, a) => n + a.length, 0);

console.log(JSON.stringify(counts));
