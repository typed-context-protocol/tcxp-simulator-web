// Verifies every tcxp address against PostgreSQL (PGlite) and writes snapshot.json.
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'module';
import fs from 'fs';
const T = createRequire(import.meta.url)('../tcxp.js');
const dbs = {};
for (const [name, reg] of Object.entries(T.REGISTRIES)) {
  if (!reg.db) continue;
  dbs[name] = new PGlite(); await dbs[name].exec(T.fullDDL(name));
}
const scratch = new PGlite();
const ver = (await scratch.query('select version()')).rows[0].version;
const nv = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) { const s = v.toISOString(); return s.endsWith('T00:00:00.000Z') ? s.slice(0, 10) : s; }
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1e6) / 1e6;
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d/.test(v)) return new Date(v.replace(' ', 'T').replace(/\+00$/, '+00:00')).toISOString();
  return v;
};
const cases = [...T.QUERIES.map(q => ({id: q.id, uri: q.uri, ref: q.ref})),
  ...T.COVERAGE.filter(c => c[2] === 'yes').map(c => ({id: 'probe:' + c[1], uri: c[3]}))];
const results = {}; let fail = 0;
for (const c of cases) {
  try {
    const tree = T.parseURI(c.uri);
    const id = T.identity(tree);
    const rt = T.serialize(tree).uri === c.uri;
    const strictRt = T.serialize(T.parseURI(T.strictForm(c.uri))).uri === c.uri;
    const mem = T.execute(tree);
    const mode = tree.parsed.mode;
    let ok = rt && strictRt, detail = '';
    if (mem.kind === 'gap') {
      results[id] = {kind: 'gap', gaps: mem.gaps};
      detail = 'gap ' + mem.gaps.join(',');
    } else if (mode === 'sql' || mode === 'math') {
      const g = T.toSQL(tree);
      const db = mode === 'sql' ? dbs[tree.parsed.registry] : scratch;
      const pg = await db.query(g.sql, g.params, {rowMode: 'array'});
      const pgRows = pg.rows.map(r => r.map(nv));
      if (mode === 'math') {
        const okv = pgRows.length === 1 && nv(mem.value) === pgRows[0][0];
        ok = ok && okv; results[id] = {kind: 'value', value: pgRows[0][0]};
        detail = 'value ' + JSON.stringify(pgRows[0][0]) + (okv ? '' : ' MISMATCH mem=' + mem.value);
      } else {
        const ordered = !!tree.parsed.items.order;
        const key = rs => ordered ? JSON.stringify(rs) : JSON.stringify(rs.map(r => JSON.stringify(r)).sort());
        const memRows = mem.rows.map(r => r.map(nv));
        const okRows = key(pgRows) === key(memRows);
        const okCols = JSON.stringify(pg.fields.map(f => f.name)) === JSON.stringify(mem.columns);
        ok = ok && okRows && okCols;
        results[id] = {kind: 'rows', columns: pg.fields.map(f => f.name), rows: pgRows, ordered};
        detail = pgRows.length + ' rows' + (okRows ? '' : ' ROWS-DIFF') + (okCols ? '' : ' COLS ' + JSON.stringify([pg.fields.map(f => f.name), mem.columns]));
        if (!okRows) console.log(JSON.stringify(pgRows).slice(0, 300), '\n', JSON.stringify(memRows).slice(0, 300));
      }
      if (c.ref) { const inl = T.toSQL(tree, {inline: true}).sql.replace(/\s+/g, ' '); if (inl !== c.ref) { ok = false; console.log('  inline:', inl, '\n  ref:   ', c.ref); } }
    } else if (mem.kind === 'call') { results[id] = {kind: 'call', value: mem.value}; detail = 'call -> ' + mem.value; }
    if (!rt) detail += ' ROUNDTRIP';
    if (!strictRt) detail += ' STRICT-ROUNDTRIP';
    if (!ok) fail++;
    console.log(ok ? 'PASS' : 'FAIL', c.id.padEnd(48), detail);
  } catch (e) { fail++; console.log('ERR ', c.id, e.message); }
}
fs.writeFileSync(new URL('../snapshot.json', import.meta.url), JSON.stringify({engine: ver, results}));
console.log(ver.split(' on ')[0], '| cases', cases.length, '| failures', fail);
process.exit(fail ? 1 : 0);
