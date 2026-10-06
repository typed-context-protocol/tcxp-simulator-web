// Shared by verify.mjs and fuzz.mjs --writes: run one write in the engine and in PostgreSQL and compare.
export const nv = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) { const s = v.toISOString(); return s.endsWith('T00:00:00.000Z') ? s.slice(0, 10) : s; }
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1e6) / 1e6;
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d/.test(v)) return new Date(v.replace(' ', 'T').replace(/\+00$/, '+00:00')).toISOString();
  return v;
};
const sortRows = rs => rs.map(r => JSON.stringify(r)).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Every table of a registry, normalized and sorted: from PostgreSQL, from the engine's store, and from the seed.
export const pgTables = async (T, pg, reg) => { const o = {}; for (const t of T.REGISTRIES[reg].db.schema.tables) o[t.name] = sortRows((await pg.query('SELECT * FROM ' + t.name, [], {rowMode: 'array'})).rows.map(r => r.map(nv))); return o; };
export const memTables = (T, store, reg) => Object.fromEntries(T.REGISTRIES[reg].db.schema.tables.map(t => [t.name, sortRows(T.tableRows(reg, t.name, store).map(r => r.map(nv)))]));
export const seedTables = (T, reg) => Object.fromEntries(T.REGISTRIES[reg].db.schema.tables.map(t => [t.name, sortRows(T.REGISTRIES[reg].db.seed[t.name].map(r => r.map(nv)))]));

// plain: the address without @ (preview); at: the same address with @ (performs the write).
// pg must hold the registry's seed. Returns {ok, outcome: 'write'|'error'|'gap'|'refused', detail, result}.
export async function compareWrite(T, pg, plain, at) {
  const reg = at.parsed.registry;
  const errDiag = at.diagnostics.find(d => d.level === 'error' || d.level === 'refused');
  if (errDiag) {
    let threw = null; try { T.execute(at, {store: T.newStore()}); } catch (e) { threw = e; }
    return {ok: !!threw && threw.code === errDiag.code, outcome: 'refused', detail: 'refused (' + errDiag.code + ')', result: {kind: 'error', code: errDiag.code || null}};
  }
  if (at.gaps.length) {
    const store = T.newStore();
    const ok = T.execute(plain, {store}).kind === 'halt' && T.execute(at, {store}).kind === 'halt' && !T.dataChanged(store);
    return {ok, outcome: 'gap', detail: 'halt ' + at.gaps.join(',') + ': no preview, no write', result: {kind: 'halt', gaps: at.gaps}};
  }
  const store = T.newStore();
  let pv = null, mem = null, memErr = null, pgRes = null, pgErr = null;
  try { pv = T.execute(plain, {store}); } catch (e) { memErr = e; }
  const previewClean = !T.dataChanged(store);
  if (!memErr) { try { mem = T.execute(at, {store}); } catch (e) { memErr = e; } }
  const g = T.toSQL(at);
  try { pgRes = await pg.query(g.sql, g.params, {rowMode: 'array'}); } catch (e) { pgErr = e; }
  if (memErr || pgErr) {
    const ok = previewClean && !!memErr && !!pgErr && memErr.code === pgErr.code;
    return {ok, outcome: 'error', code: pgErr ? pgErr.code : null, detail: 'error ' + (pgErr ? pgErr.code : 'none') + (ok ? ' in both' : ' MISMATCH engine=' + (memErr ? memErr.code + ' ' + memErr.message : 'ok') + ' pg=' + (pgErr ? pgErr.message : 'ok')),
      result: {kind: 'error', code: pgErr ? pgErr.code : null}};
  }
  const pgRet = pgRes.rows.map(r => r.map(nv)), memRet = mem.returning.rows.map(r => r.map(nv));
  const okPreview = previewClean && pv.kind === 'preview' && pv.count === mem.count && same(sortRows(pv.returning.rows.map(r => r.map(nv))), sortRows(memRet));
  const okCount = pgRes.affectedRows === mem.count;
  const okRet = same(sortRows(pgRet), sortRows(memRet)) && same(pgRes.fields.map(f => f.name), mem.returning.columns);
  const okTables = same(await pgTables(T, pg, reg), memTables(T, store, reg));
  let okInverse = true;
  try {
    for (const u of mem.inverse) { const it = T.parseURI(T.fullAddress(u)); T.execute(it, {store}); const ig = T.toSQL(it); await pg.query(ig.sql, ig.params); }   // an inverse is a bare reference: fresh context
    okInverse = same(await pgTables(T, pg, reg), seedTables(T, reg)) && same(memTables(T, store, reg), seedTables(T, reg)) && !T.dataChanged(store);
  } catch (e) { okInverse = false; }
  const ok = okPreview && okCount && okRet && okTables && okInverse;
  return {ok, outcome: 'write', okTables, okInverse,
    detail: mem.op + ' ' + mem.count + ' row(s)' + (okPreview ? '' : ' PREVIEW-DIFF') + (okCount ? '' : ' COUNT-DIFF') + (okRet ? '' : ' RETURNING-DIFF') +
      (okTables ? ', tables match' : ' TABLES-DIFF') + (okInverse ? ', inverse restores seed (' + mem.inverse.length + ' address' + (mem.inverse.length === 1 ? '' : 'es') + ')' : ' INVERSE-DIFF'),
    result: {kind: 'write', count: mem.count, columns: pgRes.fields.map(f => f.name), rows: pgRet}};
}
