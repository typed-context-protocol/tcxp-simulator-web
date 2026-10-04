// Property test: random addresses from FilterGenerator must pass the filter, round-trip,
// and (for SQL and math) give the same result in the tree evaluator and in PostgreSQL.
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'module';
const T = createRequire(import.meta.url)('../tcxp.js');
const N = Number(process.argv[2] || 500), SEED = Number(process.argv[3] || 42);
const dbs = {};
for (const [name, reg] of Object.entries(T.REGISTRIES)) if (reg.db) { dbs[name] = new PGlite(); await dbs[name].exec(T.fullDDL(name)); }
const scratch = new PGlite();
const nv = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) { const s = v.toISOString(); return s.endsWith('T00:00:00.000Z') ? s.slice(0, 10) : s; }
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1e6) / 1e6;
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d/.test(v)) return new Date(v.replace(' ', 'T').replace(/\+00$/, '+00:00')).toISOString();
  return v;
};
const gen = new T.FilterGenerator(SEED);
const tally = {filter: 0, roundtrip: 0, strict: 0, pgMatch: 0, pgCompared: 0, gaps: 0, calls: 0}; let fail = 0;
for (let i = 0; i < N; i++) {
  const uri = gen.next();
  const f = T.FilterGenerator.filter(uri);
  if (f.ok) tally.filter++; else { fail++; console.log('FILTER', uri); continue; }
  tally.roundtrip++;
  if (T.serialize(T.parseURI(T.strictForm(uri))).uri === uri) tally.strict++; else { fail++; console.log('STRICT', uri); }
  const tree = f.tree; const mem = T.execute(tree);
  if (mem.kind === 'gap') { tally.gaps++; continue; }
  if (mem.kind === 'call') { tally.calls++; continue; }
  const g = T.toSQL(tree);
  const db = tree.parsed.mode === 'sql' ? dbs[tree.parsed.registry] : scratch;
  tally.pgCompared++;
  try {
    const pg = await db.query(g.sql, g.params, {rowMode: 'array'});
    const pgRows = pg.rows.map(r => r.map(nv));
    let ok;
    if (mem.kind === 'value') ok = pgRows.length === 1 && nv(mem.value) === pgRows[0][0];
    else {
      const ordered = !!tree.parsed.items.order;
      const key = rs => ordered ? JSON.stringify(rs) : JSON.stringify(rs.map(r => JSON.stringify(r)).sort());
      ok = key(pgRows) === key(mem.rows.map(r => r.map(nv))) && JSON.stringify(pg.fields.map(x => x.name)) === JSON.stringify(mem.columns);
    }
    if (ok) tally.pgMatch++; else { fail++; console.log('MISMATCH', uri, '\n', g.sql, g.params, '\n pg ', JSON.stringify(pgRows).slice(0, 200), '\n mem', JSON.stringify(mem.rows || mem.value).slice(0, 200)); }
  } catch (e) { fail++; console.log('PGERR', e.message, '\n', uri, '\n', g.sql); }
}
console.log(JSON.stringify({seed: SEED, generated: N, ...tally, failures: fail}));
process.exit(fail ? 1 : 0);
