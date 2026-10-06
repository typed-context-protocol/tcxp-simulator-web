// v0.1 compatibility under the v0.2 grammar (an approved break, declared here exactly).
//
// The frozen v0.1 baseline (test/v01-baseline.json) is never edited. Each v0.1 address is converted by migrate():
// its separate ~ keys become one ~context object (intent; observe <- observe, outcome, spikes, review; trace <- pulse,
// source), rows unchanged; a plain-string intent becomes the handlers' row {"role":"user","text":…}. Then:
//   - the migrated address must parse and re-serialize to exactly itself,
//   - identity and SQL fiber must equal the v0.1 baseline byte for byte,
//   - the result must equal the baseline, except the documented kind rename "gap" -> "halt" (counted).
// The seeded read streams: the v0.2 generator must produce exactly migrate(v0.1 stream), and the identities of
// that stream must equal the v0.1 identities. Hashes captured from the v0.1 engine (3fad546) with:
//   node test/compat.mjs --capture-stream <path to the v0.1 tcxp.js>
import { createRequire } from 'module';
import fs from 'fs';
import { createHash } from 'crypto';
const T = createRequire(import.meta.url)('../tcxp.js');
const FILE = new URL('./v01-baseline.json', import.meta.url);
const STREAM = new URL('./v01-stream.json', import.meta.url);
const STREAMS = [[7, 2000], [42, 500], [23, 500]];
const sha = s => createHash('sha256').update(s).digest('hex');
const enc = s => s.replace(/%/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23');

const V01_CONTEXT_MAP = {intent: 'intent', observe: 'observe', outcome: 'observe', spikes: 'observe', review: 'observe', pulse: 'trace', source: 'trace'};
// A v0.1 address (canonical v0.1 form) -> the same address in the v0.2 grammar.
function migrate(uri) {
  const qi = uri.indexOf('?');
  const head = qi < 0 ? uri : uri.slice(0, qi);
  const pairs = qi < 0 ? [] : uri.slice(qi + 1).split('&').filter(Boolean);
  const context = {intent: [], observe: [], reason: [], decide: [], trace: []};
  const kept = [];
  for (const p of pairs) {
    const eq = p.indexOf('='), k = decodeURIComponent(p.slice(0, eq)), raw = decodeURIComponent(p.slice(eq + 1));
    if (k[0] !== '~') { kept.push(p); continue; }
    const name = k.slice(1), to = V01_CONTEXT_MAP[name];
    if (!to) throw new Error('v0.1 key ~' + name + ' has no place in the v0.2 context');
    const t = raw.trim();
    let v = t[0] === '[' || t[0] === '{' ? JSON.parse(t) : /^-?\d+$/.test(t) ? Number(t) : raw;
    if (name === 'intent' && typeof v === 'string') v = [{role: 'user', text: v}];
    (Array.isArray(v) ? v : [v]).forEach(row => context[to].push(row));
  }
  return head + '?' + kept.concat(['~context=' + enc(JSON.stringify(context))]).join('&');
}

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

const at = process.argv.indexOf('--capture-stream');
if (at >= 0) {
  const T01 = createRequire(import.meta.url)(process.argv[at + 1]);
  const rows = STREAMS.map(([seed, n]) => {
    const stream = new T01.FilterGenerator(seed).batch(n);
    return {seed, n, sha256: sha(stream.join('\n')), migrated_sha256: sha(stream.map(migrate).join('\n')),
      identity_sha256: sha(stream.map(u => T01.identity(T01.parseURI(u))).join('\n'))};
  });
  fs.writeFileSync(STREAM, JSON.stringify(rows, null, 1) + '\n');
  console.log('captured', rows.length, 'stream hashes'); process.exit(0);
}

const base = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let fail = 0, renamed = 0, migrated = 0;
for (const b of base) {
  let input, now;
  try { input = migrate(b.input); now = describe(input); } catch (e) { fail++; console.log('ERR ', b.id, e.message); continue; }
  if (input !== b.input) migrated++;
  let expected = b.result;
  if (expected && expected.kind === 'gap') { expected = Object.assign({}, expected, {kind: 'halt'}); renamed++; }
  const diffs = ['identity', 'sql'].filter(k => JSON.stringify(now[k]) !== JSON.stringify(b[k]));
  if (JSON.stringify(now.result) !== JSON.stringify(expected)) diffs.push('result');
  if (now.uri !== input) diffs.unshift('roundtrip');
  if (diffs.length) { fail++; console.log('FAIL', b.id, diffs.join(',')); }
}
const streams = JSON.parse(fs.readFileSync(STREAM, 'utf8'));
const badSeeds = new Set();
for (const s of streams) {
  const stream = new T.FilterGenerator(s.seed).batch(s.n);
  if (sha(stream.join('\n')) !== s.migrated_sha256) { badSeeds.add(s.seed); console.log('FAIL read stream seed', s.seed, 'is not migrate(v0.1 stream)'); }
  if (sha(stream.map(u => T.identity(T.parseURI(u))).join('\n')) !== s.identity_sha256) { badSeeds.add(s.seed); console.log('FAIL read stream seed', s.seed, 'identities differ from v0.1'); }
}
const streamFail = badSeeds.size;
fail += streamFail;
console.log(JSON.stringify({compat: base.length, identical: base.length - (fail - streamFail), migratedToContext: migrated, gapRenamedToHalt: renamed,
  streams: streams.length, streamsMatchMigratedV01: streams.length - streamFail, failures: fail}));
process.exit(fail ? 1 : 0);
