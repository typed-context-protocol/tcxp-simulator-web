// Backward compatibility: every v0.1 collection address and coverage probe must still parse,
// re-serialize to the identical string, keep its identity and SQL fiber, and give the same result.
// The baseline was captured from the v0.1 engine with: node test/compat.mjs --capture
import { createRequire } from 'module';
import fs from 'fs';
import { createHash } from 'crypto';
const T = createRequire(import.meta.url)('../tcxp.js');
const FILE = new URL('./v01-baseline.json', import.meta.url);
const describe = uri => {
  const tree = T.parseURI(uri);
  const r = T.execute(tree);
  const sql = T.toSQL(tree);
  return {
    uri: T.serialize(tree).uri, identity: T.identity(tree),
    sql: sql ? {sql: sql.sql, params: sql.params} : null,
    result: r.kind === 'rows' ? {kind: r.kind, columns: r.columns, rows: r.rows} : r
  };
};
if (process.argv.includes('--capture')) {
  const cases = [...T.QUERIES.map(q => ({id: q.id, uri: q.uri})), ...T.COVERAGE.filter(c => c[2] === 'yes').map(c => ({id: 'probe:' + c[1], uri: c[3]}))];
  fs.writeFileSync(FILE, JSON.stringify(cases.map(c => ({id: c.id, input: c.uri, ...describe(c.uri)})), null, 1) + '\n');
  console.log('captured', cases.length, 'v0.1 cases');
  process.exit(0);
}
// The seeded read stream: fuzz.mjs's addresses for a seed must never change. Hashes captured from the v0.1
// engine (main) with: node test/compat.mjs --capture-stream <path to v0.1 tcxp.js>
const STREAM = new URL('./v01-stream.json', import.meta.url);
const streamHash = (TT, seed, n) => createHash('sha256').update(new TT.FilterGenerator(seed).batch(n).join('\n')).digest('hex');
const STREAMS = [[7, 2000], [42, 500], [23, 500]];
const at = process.argv.indexOf('--capture-stream');
if (at >= 0) {
  const T01 = createRequire(import.meta.url)(process.argv[at + 1]);
  fs.writeFileSync(STREAM, JSON.stringify(STREAMS.map(([seed, n]) => ({seed, n, sha256: streamHash(T01, seed, n)})), null, 1) + '\n');
  console.log('captured', STREAMS.length, 'stream hashes'); process.exit(0);
}
const base = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let fail = 0;
for (const b of base) {
  let now;
  try { now = describe(b.input); } catch (e) { fail++; console.log('ERR ', b.id, e.message); continue; }
  const diffs = ['uri', 'identity', 'sql', 'result'].filter(k => JSON.stringify(now[k]) !== JSON.stringify(b[k]));
  if (now.uri !== b.input) diffs.unshift('roundtrip');
  if (diffs.length) { fail++; console.log('FAIL', b.id, diffs.join(',')); }
}
const streams = JSON.parse(fs.readFileSync(STREAM, 'utf8'));
let streamFail = 0;
for (const s of streams) if (streamHash(T, s.seed, s.n) !== s.sha256) { streamFail++; console.log('FAIL read stream seed', s.seed, 'n', s.n, 'changed'); }
fail += streamFail;
console.log(JSON.stringify({compat: base.length, identical: base.length - (fail - streamFail), streams: streams.length, streamsIdentical: streams.length - streamFail, failures: fail}));
process.exit(fail ? 1 : 0);
