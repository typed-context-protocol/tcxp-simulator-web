// fuzz.mjs --writes: random writes from FilterGenerator.nextWrite, each checked against PostgreSQL inside a
// transaction that is rolled back afterwards, so every case starts from the seed. Checks: the address passes the
// filter in both forms (with and without @) and round-trips; the preview mutates nothing; the write gives the same
// count, RETURNING rows and table contents as PostgreSQL, or fails with the same SQLSTATE; the inverse restores the seed.
import { PGlite } from '@electric-sql/pglite';
import { compareWrite } from './writes-lib.mjs';
export async function fuzzWrites(T, N, SEED) {
  const dbs = {};
  for (const [name, reg] of Object.entries(T.REGISTRIES)) if (reg.db) { dbs[name] = new PGlite(); await dbs[name].exec(T.fullDDL(name)); }
  const gen = new T.FilterGenerator(SEED);
  const tally = {filter: 0, roundtrip: 0, strict: 0, gaps: 0, written: 0, tablesMatch: 0, inverseRestores: 0, errorsMatched: 0, refused: 0, byOp: {insert: 0, update: 0, delete: 0}, errorCodes: {}};
  let fail = 0;
  for (let i = 0; i < N; i++) {
    const uri = gen.nextWrite();
    const f = T.FilterGenerator.filter(uri), fa = T.FilterGenerator.filter('@' + uri);
    if (f.ok && fa.ok) tally.filter++; else { fail++; console.log('FILTER', uri, f.rules.filter(r => !r.pass).map(r => r.id + ' ' + (r.msg || '')), fa.rules.filter(r => !r.pass).map(r => r.id)); continue; }
    tally.roundtrip++;
    if (T.serialize(T.parseURI(T.strictForm(uri))).uri === uri && T.serialize(T.parseURI(T.strictForm('@' + uri))).uri === '@' + uri) tally.strict++; else { fail++; console.log('STRICT', uri); }
    tally.byOp[f.tree.parsed.op]++;
    const pg = dbs[f.tree.parsed.registry];
    await pg.exec('BEGIN');
    let w;
    try { w = await compareWrite(T, pg, f.tree, fa.tree); } catch (e) { w = {ok: false, detail: 'THREW ' + e.message}; }
    await pg.exec('ROLLBACK');
    if (w.outcome === 'gap') tally.gaps++;
    if (w.outcome === 'refused') tally.refused++;
    if (w.outcome === 'write') { tally.written++; if (w.okTables) tally.tablesMatch++; if (w.okInverse) tally.inverseRestores++; }
    if (w.outcome === 'error' && w.ok) { tally.errorsMatched++; tally.errorCodes[w.code] = (tally.errorCodes[w.code] || 0) + 1; }
    if (!w.ok) { fail++; console.log('MISMATCH', uri, '\n ', w.detail); }
  }
  console.log(JSON.stringify({mode: 'writes', seed: SEED, generated: N, ...tally, failures: fail}));
  return fail ? 1 : 0;
}
