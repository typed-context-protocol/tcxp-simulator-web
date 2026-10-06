(function () {
'use strict';
const T = window.TCXP, SNAP = window.TCXP_SNAPSHOT || {results: {}};
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ENGINE = (SNAP.engine || 'PostgreSQL').split(' on ')[0];

const state = { queryId: null, uri: '', tree: null, fit: false, addressBar: false, lastFocus: null,
  pulses: [], step: 0, timer: null, fiber: null, fibers: {} };

/* ---------------------------------------------------------------- explorer */
const JOIN_TAG = {inner:'INNER', left:'LEFT', full:'FULL OUTER', right:'RIGHT', cross:'CROSS'};
function queryTag(q) {
  const w = q.uri.match(/\/sql\/(insert|update|delete)\?/);
  if (w) return w[1].toUpperCase();
  if (/^@?tcxp:\/\//.test(q.uri)) return 'RESOLVABLE';
  if (q.uri.startsWith('@')) return '@ CALL';
  if (q.uri.includes('/math/eval')) return 'MATH';
  const m = q.uri.match(/join=(inner|left|full|right|cross)\(/);
  if (m) return JOIN_TAG[m[1]];
  if (/[&?]group=/.test(q.uri)) return 'GROUP BY';
  if (/=@!tcxp/.test(q.uri)) return 'CALL BIND';
  return 'SELECT';
}
function hasGap(q) { try { return T.parseURI(q.uri).gaps.length > 0; } catch (e) { return false; } }
function renderExplorer() {
  const regs = Object.entries(T.REGISTRIES).map(([name, r]) => {
    const tables = r.db ? r.db.schema.tables.map(t => `<button class="ex-item" data-table="${name}|${t.name}"><span class="t"><code>${t.name}</code></span><span class="meta" data-count="${name}|${t.name}">${r.db.seed[t.name].length} rows</span></button>`).join('') : '';
    const fns = Object.keys(r.fns).map(f => `<button class="ex-item" data-uri="${esc('@!tcxp:/' + name + '/' + f)}"><span class="t"><code>${esc(f)}</code></span><span class="meta">function</span></button>`).join('');
    const notes = Object.keys(r.notes).map(n => `<button class="ex-item" data-uri="${esc('!tcxp:/' + name + '/' + n)}"><span class="t"><code>${esc(n)}</code></span><span class="meta">note</span></button>`).join('');
    const schema = r.db ? `<button class="ex-item" data-schema="${name}"><span class="t">Data dictionary and DDL</span><span class="meta">${r.db.schema.tables.length} tables</span></button>` : '';
    const entries = T.listResolvable(name);
    const links = entries.length ? `<table class="grid resolvable-list"><thead><tr><th>Resolvable address</th><th>Location</th></tr></thead><tbody>${entries.map(e =>
      `<tr><td><button class="ex-link" data-uri="${esc(e.address)}"><code>${esc(e.address)}</code></button></td><td><code>${esc(e.location)}</code></td></tr>`).join('')}</tbody></table>` : '';
    return `<div class="ex-group-label"><code>${esc(name)}</code> · ${esc(r.description)}</div>${schema}${tables}${fns}${notes}${links}`;
  }).join('');
  const groups = T.GROUPS.map(([g, label]) => {
    const items = T.QUERIES.filter(q => q.group === g).map(q =>
      `<button class="ex-item" data-query="${q.id}"><span class="t">${esc(q.title.replace(/ \((inner|left|full outer) join\)$/i, ''))}${hasGap(q) ? '<i class="gapdot" title="Has a gap"></i>' : ''}</span><span class="meta">${queryTag(q)}</span></button>`).join('');
    return `<div class="ex-group-label">${esc(label)}</div>${items}`;
  }).join('');
  $('#explorer').innerHTML = `
    <div style="padding:4px 6px 10px"><button class="btn small" id="gen-one" type="button" style="width:100%;justify-content:center">Generate a random address</button></div>
    <details class="ex-section" open><summary>Addresses</summary>${groups}</details>
    <details class="ex-section" open><summary>Registries</summary>${regs}</details>`;
  $('#explorer').addEventListener('click', e => {
    if (e.target.closest('#gen-one')) { state.gen = state.gen || new T.FilterGenerator(Date.now() % 100000); loadURI(state.gen.next()); return; }
    const lk = e.target.closest('.ex-link'); if (lk) { loadURI(lk.dataset.uri); return; }
    const b = e.target.closest('.ex-item'); if (!b) return;
    if (b.dataset.query) selectQuery(b.dataset.query);
    else if (b.dataset.table) { const [r, t] = b.dataset.table.split('|'); openTable(r, t, b); }
    else if (b.dataset.schema) openSchema(b.dataset.schema, b);
    else if (b.dataset.uri) loadURI(b.dataset.uri);
  });
}
// Table row counts in the explorer follow this session's data, which writes change.
function refreshCounts() {
  document.querySelectorAll('[data-count]').forEach(el => { const [r, t] = el.dataset.count.split('|'); el.textContent = T.tableRows(r, t).length + ' rows'; });
}
function markCurrent() {
  document.querySelectorAll('.ex-item[data-query]').forEach(b => b.setAttribute('aria-current', String(b.dataset.query === state.queryId)));
}

/* ------------------------------------------------------------------- load */
function selectQuery(id, opts) {
  const q = T.QUERIES.find(x => x.id === id); if (!q) return;
  state.queryId = id; $('#uri-input').value = q.uri; markCurrent(); update(q.uri);
  if (!(opts && opts.noScroll) && window.matchMedia('(max-width: 760px)').matches) $('.work').scrollIntoView({behavior: 'smooth', block: 'start'});
}
function loadURI(uri) {
  let match = T.QUERIES.find(q => q.uri === uri);
  if (!match) { try { const id = T.identity(T.parseURI(uri)); match = T.QUERIES.find(q => { try { return T.identity(T.parseURI(q.uri)) === id; } catch (e) { return false; } }); } catch (e) {} }
  state.queryId = match ? match.id : null;
  $('#uri-input').value = uri; markCurrent(); update(uri);
}
const metaOf = (tree, key) => { const m = tree.parsed.meta.find(x => x[0] === key); return m ? m[1] : undefined; };
// ~intent is a string (legacy) or rows; the label is the string or the user row's text.
const intentLabel = tree => { const v = metaOf(tree, 'intent'); if (typeof v === 'string') return v; const u = Array.isArray(v) ? v.find(r => r && r.role === 'user' && typeof r.text === 'string') : null; return u ? u.text : null; };

function update(uri) {
  state.uri = uri;   // exactly as typed: the engine rejects whitespace and every other non-exact spelling
  const q = T.QUERIES.find(x => x.id === state.queryId);
  $('#reset-uri').hidden = !(q && q.uri !== state.uri);
  let tree = null, err = null;
  try { tree = T.parseURI(state.uri); } catch (e) { err = e; }
  state.tree = tree;
  const intentMeta = tree ? metaOf(tree, 'intent') : undefined;
  const userRow = Array.isArray(intentMeta) ? intentMeta.find(r => r && r.role === 'user' && typeof r.text === 'string') : null;
  const intentText = (typeof intentMeta === 'string' ? intentMeta : userRow ? userRow.text : null) || (q ? q.intent : null);
  const sub = q ? q.title + (q.uri !== state.uri ? ' · edited' : '') : (tree ? tree.parsed.registry + '/' + tree.parsed.path : 'Address');
  $('#intent').innerHTML = intentText ? `${esc(intentText)}<small>${esc(sub)}</small>` : `${esc(sub)}<small>No ~intent on this address</small>`;
  if (!tree) {
    $('#anatomy').innerHTML = `<span class="tok k-punct">${esc(state.uri)}</span>`;
    $('#diags').innerHTML = `<li class="diag error">${esc(err.message)}</li>`;
    $('#tree-scroll').innerHTML = `<div class="empty-tree">Fix the address to draw the tree.</div>`;
    $('#legend').innerHTML = ''; $('#spikes-block').hidden = true;
    $('#result-card').innerHTML = `<div class="err-box">Nothing to run until the address parses.</div>`;
    $('#fiber-tabs').innerHTML = ''; $('#fiber-body').innerHTML = '';
    return;
  }
  const ser = T.serialize(tree);
  const gapIds = new Set();
  (function walk(n) { if (n.kind === 'slot' && !n.children.length && n._id) gapIds.add(n._id); (n.children || []).forEach(walk); })(tree.root);
  $('#anatomy').innerHTML = ser.tokens.map(t =>
    `<span class="tok k-${t.kind}${t.nodeId && gapIds.has(t.nodeId) ? ' gap' : ''}"${t.nodeId ? ` data-node="${t.nodeId}"` : ''}>${esc(t.text)}</span>`).join('');
  const diags = tree.diagnostics.slice();
  if (ser.uri !== state.uri) diags.push({level: 'info', msg: 'Canonical form differs from what was typed (spacing, key order or encoding). The colored line is the canonical form.'});
  $('#diags').innerHTML = diags.map(d => `<li class="diag ${d.level}">${esc(d.msg)}</li>`).join('');
  renderTree(tree);
  renderFind();
  renderResult(tree);
  renderSpikes(tree);
  renderFibers(tree);
  schedulePulse(tree);
}

/* -------------------------------------------------------------------- tree */
function nodeKind(n) {
  if (n.kind === 'slot') return n.children.length ? 'variable' : 'gap';
  return n.kind;
}
function nodeText(n) {
  if (n.kind === 'operator') {
    if (n.op === 'select') return ['SELECT', state.tree.parsed.registry];
    return [n.label, ''];
  }
  if (n.kind === 'reference') {
    if (n.name === '*') return ['*', 'all columns'];
    if (n.role === 'declares') return [n.name, 'declares name'];
    if (n.role === 'table') return [n.name, 'table'];
    if (n.role === 'handler') return [n.name, 'handler → ' + n.type];
    if (n.role === 'note') return [n.name, 'note'];
    if (n.role === 'resolvable') return [n.name, 'resolvable entry'];
    if (n.role === 'alias') return [n.name, 'alias' + (n.type ? ' · ' + T.baseType(n.type) : '')];
    return [n.name, n.type ? T.baseType(n.type) : 'column'];
  }
  if (n.kind === 'slot') {
    const t = n.type ? T.baseType(n.type) : 'untyped';
    return [(n.param ? '' : '$') + n.name, n.children.length ? t : 'gap · ' + t];
  }
  if (n.kind === 'value') return [n.value === null ? 'null' : n.type === 'text' ? `'${n.value}'` : String(n.value), n.type];
  return ['?', ''];
}
function renderTree(tree) {
  const GAP = 14, LEVEL = 78, PAD = 16, CH = 7.9, CH2 = 6.4;
  const counts = {operator: 0, value: 0, variable: 0, reference: 0, gap: 0};
  const bindings = tree.parsed.bindings;
  const annotated = new Map();
  tree.spikes.forEach((sp, i) => sp.targets.forEach(t => t.nodes.forEach(n => {
    if (!annotated.has(n)) annotated.set(n, []);
    if (!annotated.get(n).includes(sp.id)) annotated.get(n).push(sp.id);
  })));
  function prep(n) {
    if (!n.synthetic) counts[nodeKind(n)]++;
    if (n.kind === 'slot' && n.children[0] && bindings[n.name] && bindings[n.name].kind !== 'call' && !n.children[0]._id) n.children[0]._id = bindings[n.name]._id;
    const [a, b] = nodeText(n); n._t = [a, b];
    n._w = Math.max(44, Math.ceil(Math.max(a.length * CH, (b || '').length * CH2) + 26));
    n._h = b ? 44 : 34;
    const kids = n.children || [];
    kids.forEach(prep);
    const sum = kids.reduce((s, k) => s + k._tw, 0) + GAP * Math.max(0, kids.length - 1);
    n._tw = Math.max(n._w, sum);
  }
  function place(n, x, depth) {
    n._y = PAD + depth * LEVEL;
    const kids = n.children || [];
    if (!kids.length) { n._x = x + n._tw / 2; return; }
    const sum = kids.reduce((s, k) => s + k._tw, 0) + GAP * (kids.length - 1);
    let cx = x + (n._tw - sum) / 2;
    kids.forEach(k => { place(k, cx, depth + 1); cx += k._tw + GAP; });
    n._x = (kids[0]._x + kids[kids.length - 1]._x) / 2;
  }
  // Variables an ~intent row requires but the query never uses hang under a REQUIRES node beside the query tree.
  const top = tree.intentSlots && tree.intentSlots.length
    ? {kind: 'operator', op: 'intent', label: 'ADDRESS', synthetic: true, children: [tree.root, {kind: 'operator', op: 'requires', label: 'REQUIRED BY ~intent', synthetic: true, children: tree.intentSlots}]} : tree.root;
  prep(top); place(top, PAD, 0);
  let maxY = 0; const nodes = [], edges = [];
  (function walk(n) { nodes.push(n); maxY = Math.max(maxY, n._y + n._h); (n.children || []).forEach(k => { edges.push([n, k]); walk(k); }); })(top);
  const W = Math.ceil(top._tw + PAD * 2), H = Math.ceil(maxY + PAD);
  const e = edges.map(([p, c]) => {
    const y1 = p._y + p._h, y2 = c._y, my = (y1 + y2) / 2;
    return `<path class="edge${p.kind === 'slot' ? ' bind' : ''}" d="M${p._x} ${y1} C ${p._x} ${my}, ${c._x} ${my}, ${c._x} ${y2}"/>`;
  }).join('');
  const nd = nodes.map(n => {
    const x = n._x - n._w / 2, y = n._y, [a, b] = n._t, k = nodeKind(n);
    const title = k === 'gap' ? 'Gap: variable with no value. The address halts until it is bound.'
      : k === 'variable' ? 'Variable' + (n.typedBy ? ', type from ' + n.typedBy : '')
      : k === 'reference' ? 'Reference' + (n.role ? ' (' + n.role + ')' : '') : k === 'operator' ? 'Operator' : 'Value';
    const ann = annotated.get(n);
    const badge = ann ? ann.map((id, i) => `<g class="badge"><title>Annotation ${esc(id)}</title><circle cx="${x + n._w - 4 - i * 20}" cy="${y - 2}" r="9"/><text x="${x + n._w - 4 - i * 20}" y="${y - 2}" text-anchor="middle" dominant-baseline="central">${esc(id.replace(/^s/, ''))}</text></g>`).join('') : '';
    return `<g class="tn ${k}"${n._id ? ` data-node="${n._id}"` : ''}><title>${esc(title)}</title>
      <rect x="${x}" y="${y}" width="${n._w}" height="${n._h}" rx="${n._h / 2}"/>
      <text class="l1" x="${n._x}" y="${y + (b ? 18 : n._h / 2)}" text-anchor="middle" dominant-baseline="central" font-size="13">${esc(a)}</text>
      ${b ? `<text class="l2" x="${n._x}" y="${y + 33}" text-anchor="middle" dominant-baseline="central">${esc(b)}</text>` : ''}${badge}</g>`;
  }).join('');
  const sc = $('#tree-scroll');
  sc.innerHTML = `<svg id="tree" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Expression tree with ${nodes.length} nodes">${e}${nd}</svg>`;
  sc.classList.toggle('fit', state.fit);
  sc.scrollLeft = Math.max(0, top._x - sc.clientWidth / 2); sc.scrollTop = 0;
  $('#legend').innerHTML = `
    <span><i class="chip operator"></i>Operators <b>${counts.operator}</b></span>
    <span><i class="chip value"></i>Values <b>${counts.value}</b></span>
    <span><i class="chip variable"></i>Variables <b>${counts.variable}</b></span>
    <span><i class="chip reference"></i>References <b>${counts.reference}</b></span>
    <span><i class="chip gap"></i>Gaps <b>${counts.gap}</b></span>
    <span><i class="chip annotation"></i>Annotations <b>${tree.spikes.length}</b></span>
    <span><i class="dash"></i>Binding</span>`;
}
// Find: query(uri, selector) lists pointers; hovering one highlights its node in the tree and the address.
function renderFind() {
  const out = $('#find-results'); const sel = $('#find-input').value.trim();
  if (!sel || !state.tree) { out.innerHTML = ''; return; }
  let hits;
  try { hits = T.query(state.tree, sel); } catch (e) { out.innerHTML = `<li class="err">${esc(e.message)}</li>`; return; }
  out.innerHTML = hits.length ? hits.map(h => {
    const ids = T.resolvePointer(state.tree, h.pointer).map(n => n._id).filter(Boolean).join(' ');
    return `<li data-spike-nodes="${esc(ids)}" title="${esc(h.kind)}"><b>${esc(h.label)}</b><code>${esc(h.pointer)}</code></li>`;
  }).join('') : '<li class="none">No matches</li>';
}
function setHL(ids, on) { ids.forEach(id => document.querySelectorAll(`[data-node="${id}"]`).forEach(el => el.classList.toggle('hl', on))); }
['mouseover', 'mouseout'].forEach(type => document.addEventListener(type, e => {
  if (!e.target.closest) return;
  const el = e.target.closest('[data-node]');
  if (el && (el.closest('#anatomy') || el.closest('#tree'))) setHL([el.dataset.node], type === 'mouseover');
  const sp = e.target.closest('[data-spike-nodes]');
  if (sp) setHL(sp.dataset.spikeNodes.split(' ').filter(Boolean), type === 'mouseover');
}));

/* ------------------------------------------------------------------ result */
const norm = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d/.test(v)) return new Date(v.replace(' ', 'T').replace(/\+00$/, '+00:00')).toISOString();
  return v;
};
const unordered = rs => JSON.stringify(rs.map(r => JSON.stringify(r)).sort());
function snapshotCheck(tree, res) {
  const s = SNAP.results[T.resultKey(tree)];
  if (!s) return null;
  if (res.kind === 'preview' || res.kind === 'write') {
    if (s.kind !== 'write') return false;
    return res.count === s.count && JSON.stringify(res.returning.columns) === JSON.stringify(s.columns) && unordered(res.returning.rows.map(r => r.map(norm))) === unordered(s.rows);
  }
  if (res.kind === 'error') return s.kind === 'error' && s.code === res.code;
  if (res.kind === 'resolvable') return s.kind === 'resolvable' && s.location === res.location && s.registered === res.registered;
  if (s.kind !== res.kind) return false;
  if (s.kind === 'halt') return JSON.stringify(s.gaps) === JSON.stringify(res.gaps);
  if (s.kind === 'value') return norm(res.value) === s.value;
  if (s.kind === 'call') return res.value === s.value;
  const a = res.rows.map(r => r.map(norm));
  const key = rs => s.ordered ? JSON.stringify(rs) : JSON.stringify(rs.map(r => JSON.stringify(r)).sort());
  return key(a) === key(s.rows) && JSON.stringify(res.columns) === JSON.stringify(s.columns);
}
function badge(tree, res, dataWasClean) {
  if ((res.kind === 'rows' || res.kind === 'preview') && T.dataChanged()) return `<span class="pill warn">Session data changed by a write; the ${esc(ENGINE)} reference is for the shipped data</span>`;
  if (dataWasClean === false) return `<span class="pill warn">Ran on changed session data; the ${esc(ENGINE)} reference is for the shipped data</span>`;
  const ok = snapshotCheck(tree, res);
  if (ok === null) return `<span class="pill mute">No ${esc(ENGINE)} reference for this address</span>`;
  if (res.kind === 'call') return ok ? `<span class="pill ok">✓ Matches verified result</span>` : `<span class="pill bad">✗ Differs from verified result</span>`;
  if (res.kind === 'error') return ok ? `<span class="pill ok">✓ ${esc(ENGINE)} fails the same way (${esc(res.code)})</span>` : `<span class="pill bad">✗ ${esc(ENGINE)} does not fail this way</span>`;
  return ok ? `<span class="pill ok">✓ Matches ${esc(ENGINE)}</span>` : `<span class="pill bad">✗ Differs from ${esc(ENGINE)}</span>`;
}
function cell(v) {
  if (v === null || v === undefined) return '<td class="null">null</td>';
  if (typeof v === 'number') return `<td class="num">${Number.isInteger(v) ? v : (Math.round(v * 100) / 100)}</td>`;
  return `<td>${esc(v)}</td>`;
}
function resultTable(columns, rows) {
  return `<div class="tbl-wrap" style="max-height:420px;overflow:auto"><table class="grid"><thead><tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(cell).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}" class="null">No rows</td></tr>`}</tbody></table></div>`;
}
function literalFor(raw, type) {
  const v = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(v) && (!type || /int|numeric|bigint|number/.test(type))) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && (!type || /date|time/.test(type))) return "date'" + v + "'";
  if (v.startsWith('@!tcxp:/')) return v.replace(/%/g, '%25').replace(/&/g, '%26');
  return "'" + v.replace(/'/g, "''") + "'";
}
// A halt: every missing variable, and for each one the intent rows that require it.
function gapPanel(tree, res) {
  const by = (res && res.requiredBy) || [];
  const rows = tree.gaps.map(name => {
    const slot = T.findSlot(tree.root, name) || (tree.parsed.items[name] && tree.parsed.items[name][0]);
    const type = slot && slot.type ? T.baseType(slot.type) : null;
    const notes = tree.spikes.filter(sp => sp.targets.some(t => t.nodes.includes(slot)))
      .flatMap(sp => ['environment', 'structure'].filter(f => sp.facets[f].lit).map(f => `<div class="env"><b>${esc(sp.id)} · ${f}:</b> ${esc(sp.facets[f].text)}</div>`)).join('');
    const isParam = slot && slot.param;
    const reqs = by.filter(x => x.var === name).map(x => `<div class="env"><b>Required by intent row ${x.row + 1}${x.role ? ' (' + esc(x.role) + ')' : ''}:</b> ${esc(x.text)}</div>`).join('');
    return `<div class="gaprow"><div><b><code>${isParam ? '' : '$'}${esc(name)}</code></b>${type ? ` expects <code>${esc(type)}</code>` : ''}. Nothing runs until it has a value.</div>${reqs}${notes}
      <form data-gap="${esc(name)}" data-type="${esc(type || '')}" data-param="${isParam ? 1 : 0}"><input id="gap-${esc(name)}" placeholder="Value for ${isParam ? '' : '$'}${esc(name)}" aria-label="Value for ${esc(name)}"><button class="btn small" type="submit">Bind</button></form></div>`;
  }).join('');
  return `<div class="gapbox"><h3>HALT · ${tree.gaps.length} gap${tree.gaps.length === 1 ? '' : 's'}</h3>${rows}</div>`;
}
function renderResult(tree) {
  const card = $('#result-card'); const title = $('#result-title');
  const errDiag = tree.diagnostics.find(d => d.level === 'error' || d.level === 'refused');
  if (errDiag && errDiag.level === 'refused') { title.textContent = 'Write refused'; card.innerHTML = `<div class="err-box">${esc(errDiag.msg)}</div><div class="status-line"><span>Nothing ran. The engine refuses this before any data is touched.</span></div>`; return; }
  if (errDiag) { title.textContent = 'Result'; card.innerHTML = `<div class="err-box">Resolve the errors above to run this address.</div>`; return; }
  if (tree.parsed.mode === 'write') { renderWrite(tree, card, title); return; }
  let res;
  try { res = T.execute(tree); } catch (e) { title.textContent = 'Result'; card.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; return; }
  state.result = res;
  const mode = tree.parsed.mode;
  if (res.kind === 'halt') {
    title.textContent = mode === 'math' ? 'Decide (if)' : 'Halted';
    card.innerHTML = (mode === 'math' ? decidePanel(tree, null) : '') + gapPanel(tree, res) + `<div class="status-line"><span>A gap always halts. Nothing runs or writes until every required variable is bound.</span>${badge(tree, res)}</div>`;
  } else if (res.kind === 'value') {
    title.textContent = res.decision === null ? 'Value' : 'Decide (if)';
    card.innerHTML = (res.decision === null ? `<div class="returned"><span class="big">${esc(res.value)}</span></div>` : decidePanel(tree, res.decision)) + `<div class="status-line"><span>Computed in this page by evaluating the tree</span>${badge(tree, res)}</div>`;
  } else if (res.kind === 'call') {
    title.textContent = 'Call returned';
    card.innerHTML = `<div class="returned"><span class="big">${esc(JSON.stringify(res.value))}</span><span style="color:var(--ink-3);font-size:13px">${esc(tree.parsed.fn.doc)} Returns <code>${esc(res.returns)}</code>.</span></div><div class="status-line"><span>The handler ran inside this page's registry</span>${badge(tree, res)}</div>`;
  } else if (res.kind === 'address') {
    title.textContent = 'Function';
    card.innerHTML = `<div class="returned"><span>${esc(tree.parsed.fn.doc)}</span><span style="color:var(--ink-3);font-size:13px">This address names the function. Put <code>@</code> in front to call it.</span><div><button class="btn small" id="call-it" type="button">Call it</button></div></div>`;
    $('#call-it').onclick = () => loadURI('@' + T.serialize(tree).uri);
  } else if (res.kind === 'resolvable') {
    // Shows where the entry points. Nothing is fetched until "Resolve" is pressed.
    title.textContent = 'Resolvable address';
    card.innerHTML = res.registered
      ? `<div class="returned"><span>Its registry entry points to</span><code class="big" style="font-size:15px">${esc(res.location)}</code>
         <span style="color:var(--ink-3);font-size:13px">Reading never fetches. Resolve fetches and shows the content at this location.</span>
         <div><button class="btn small primary" id="resolve-it" type="button">Resolve</button></div><div id="resolved"></div></div>`
      : `<div class="err-box">${esc(res.address)} is not registered. Registered entries are listed under each registry in the explorer.</div>`;
    const btn = $('#resolve-it');
    if (btn) btn.onclick = () => {
      const out = $('#resolved'); out.innerHTML = '<span style="color:var(--ink-3)">Fetching…</span>';
      T.resolve(res.address).then(text => { out.innerHTML = `<div class="sub-h">Content</div><pre class="code" style="white-space:pre-wrap">${esc(text)}</pre>`; },
        err => { out.innerHTML = `<div class="err-box">${esc(err.message)}</div>`; });
    };
  } else if (res.kind === 'note') {
    title.textContent = 'Note';
    card.innerHTML = `<div class="returned"><span style="font-size:15px">${esc(res.text)}</span><span style="color:var(--ink-3);font-size:13px">Annotations point at this address to light up a facet.</span></div>`;
  } else {
    title.textContent = 'Result';
    card.innerHTML = resultTable(res.columns, res.rows) + `<div class="status-line"><span>${res.rows.length} row${res.rows.length === 1 ? '' : 's'}, computed in this page by evaluating the tree</span>${badge(tree, res)}</div>`;
  }
  card.querySelectorAll('form[data-gap]').forEach(f => f.addEventListener('submit', ev => {
    ev.preventDefault();
    const input = f.querySelector('input'); if (!input.value.trim()) { input.focus(); return; }
    let next;
    if (f.dataset.param === '1') {
      const base = state.uri.includes('?') ? state.uri + '&' : state.uri + '?';
      next = base + f.dataset.gap + '=' + input.value.trim().replace(/%/g, '%25').replace(/&/g, '%26');
      try { next = T.serialize(T.parseURI(next)).uri; } catch (e) {}
    } else {
      // The same edit API the engine exposes; the workbench stamps its own pulse when the state commits.
      const raw = input.value.trim();
      const value = raw.startsWith('@!tcxp:/') ? raw : literalFor(raw, f.dataset.type);
      try { next = T.edit(state.uri, [{op: 'bind', var: f.dataset.gap, value}], {pulse: false}).uri; }
      catch (e) { input.setCustomValidity(e.message); input.reportValidity(); input.addEventListener('input', () => input.setCustomValidity(''), {once: true}); return; }
    }
    $('#uri-input').value = next; update(next);
  }));
}
/* ------------------------------------------------------------------ writes */
// A write address shows a preview. It runs only when "Run this write" arms it, exactly once; opening or
// re-rendering an @ address never applies it by itself.
const OPWORD = {insert: ['inserted', 'insert'], update: ['changed', 'change'], delete: ['removed', 'remove']};
function changesTable(res) {
  const cols = res.columns;
  const body = res.changes.map(ch => {
    if (res.op === 'insert') return `<tr class="ins">${ch.after.map(cell).join('')}</tr>`;
    if (res.op === 'delete') return `<tr class="del">${ch.before.map(cell).join('')}</tr>`;
    return `<tr>${ch.after.map((v, i) => ch.before[i] === v ? cell(v) : `<td class="chg"><s>${esc(fmtVal(ch.before[i]))}</s> → <b>${esc(fmtVal(v))}</b></td>`).join('')}</tr>`;
  }).join('') || `<tr><td colspan="${cols.length}" class="null">No rows match</td></tr>`;
  return `<div class="tbl-wrap" style="max-height:420px;overflow:auto"><table class="grid changes"><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function plainOf(tree) { const u = T.serialize(tree).uri; return u.startsWith('@') ? u.slice(1) : u; }
function renderWrite(tree, card, title) {
  const id = T.identity(tree);
  const done = state.lastWrite && state.lastWrite.identity === id ? state.lastWrite : null;
  let res = null, err = null, clean = !T.dataChanged();
  if (tree.parsed.call && state.armed === id && !done) {
    state.armed = null;
    try { res = T.execute(tree); state.lastWrite = {identity: id, res, clean}; refreshCounts(); } catch (e) { err = e; }
  } else if (done) { res = done.res; clean = done.clean; }
  else { try { res = T.execute(tree, {preview: true}); } catch (e) { err = e; } }
  const resetBtn = T.dataChanged() ? `<button class="btn small" type="button" data-act="reset">Reset data</button>` : '';
  if (err) {
    title.textContent = 'Write would fail';
    card.innerHTML = `<div class="err-box">${esc(err.message)}${err.code ? ` <code>${esc(err.code)}</code>` : ''}</div><div class="status-line"><span>Nothing was changed.</span>${badge(tree, {kind: 'error', code: err.code}, clean ? undefined : false)}${resetBtn}</div>`;
  } else if (res.kind === 'halt') {
    title.textContent = 'Write halted';
    card.innerHTML = gapPanel(tree, res) + `<div class="status-line"><span>A gap always halts: no preview, and nothing is written, until every required variable is bound.</span>${badge(tree, res)}</div>`;
  } else {
    const [done1, verb] = OPWORD[res.op];
    const ret = res.returning.columns.length ? `<div class="sub-h">RETURNING</div>` + resultTable(res.returning.columns, res.returning.rows) : '';
    if (res.kind === 'preview') {
      title.textContent = 'Preview: nothing has changed yet';
      card.innerHTML = `<div class="write-note">This write would ${verb} <b>${res.count}</b> row${res.count === 1 ? '' : 's'} in <code>${esc(res.table)}</code>.</div>` + changesTable(res) + ret +
        `<div class="status-line"><button class="btn small primary" type="button" data-act="run">Run this write</button><span>Runs once, as <code>@</code>${esc(plainOf(tree).slice(0, 32))}…, on this session's copy of the data.</span>${badge(tree, res)}${resetBtn}</div>`;
    } else {
      title.textContent = 'Write applied';
      card.innerHTML = `<div class="write-note ok">${res.count} row${res.count === 1 ? '' : 's'} ${done1} in <code>${esc(res.table)}</code> (this session's copy; the shipped data is untouched).</div>` + changesTable(res) + ret +
        `<div class="sub-h">Inverse: ${res.inverse.length} address${res.inverse.length === 1 ? '' : 'es'} that undo this write exactly</div><ul class="inverse">${res.inverse.map(u => `<li><code>${esc(u)}</code></li>`).join('') || '<li class="null">Nothing to undo</li>'}</ul>` +
        `<div class="status-line">${res.inverse.length ? '<button class="btn small" type="button" data-act="undo">Undo</button>' : ''}${resetBtn}${badge(tree, res, clean)}</div>`;
    }
  }
  card.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'run') { const at = '@' + plainOf(tree); state.armed = T.identity(T.parseURI(at)); state.lastWrite = null; loadURI(at); }
    else if (act === 'undo') { res.inverse.forEach(u => T.execute(T.parseURI(u))); state.lastWrite = null; refreshCounts(); loadURI(plainOf(tree)); }
    else if (act === 'reset') { T.resetData(); state.lastWrite = null; refreshCounts(); update(state.uri); }
  }));
}
function decidePanel(tree, decision) {
  const q = T.toMath(tree, true);
  const t = decision === true, f = decision === false, open = decision === null;
  return `<div class="decide"><div class="q">if ${esc(q)}</div>
    <div class="diamond"><span>Decide<br>(if)</span></div>
    <div class="branches">
      <div class="branch true${t ? ' on' : ''}${open ? ' dark' : ''}"><b>True</b><span>→ ${t ? 'taken' : open ? 'waiting on a gap' : 'not taken'}</span></div>
      <div class="branch false${f ? ' on' : ''}${open ? ' dark' : ''}"><b>False</b><span>→ ${f ? 'taken' : open ? 'waiting on a gap' : 'not taken'}</span></div>
    </div></div>`;
}

/* ------------------------------------------------------------- annotations */
function renderSpikes(tree) {
  const blk = $('#spikes-block');
  if (!tree.spikes.length) { blk.hidden = true; return; }
  blk.hidden = false;
  $('#spikes-card').innerHTML = tree.spikes.map(sp => {
    const ids = sp.targets.flatMap(t => t.nodes.map(n => n._id)).filter(Boolean).join(' ');
    const facet = (name, f) => `<div class="facet${f.lit ? '' : ' off'}"><span class="fname"><i class="lamp${f.lit ? '' : ' dark'}"></i>${name}</span>
      <span class="ftext">${f.lit ? esc(f.text) : 'dark'}${f.value && String(f.value).startsWith('!tcxp:/') ? `<span class="faddr">${esc(f.value)}</span>` : ''}</span></div>`;
    return `<div class="spike" data-spike-nodes="${esc(ids)}">
      <div class="spike-head"><span class="sid">${esc(sp.id)}</span>${sp.on.map(p => `<span class="ptr">${esc(p)}</span>`).join('')}<span class="bits" title="meaning, structure, environment">MSE ${sp.bits}</span></div>
      <div class="facets">
        ${facet('Data', {lit: sp.data, text: sp.data ? 'Anchored to ' + sp.targets.reduce((a, t) => a + t.nodes.length, 0) + ' node(s) in the tree' : 'A pointer does not resolve'})}
        ${facet('Meaning', sp.facets.meaning)}${facet('Structure', sp.facets.structure)}${facet('Environment', sp.facets.environment)}
      </div></div>`;
  }).join('');
}

/* ------------------------------------------------------------------ fibers */
const KW = /\b(INSERT INTO|VALUES|RETURNING|UPDATE|SET|DELETE FROM|SELECT|FROM|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|OFFSET|INNER JOIN|LEFT JOIN|RIGHT JOIN|FULL OUTER JOIN|CROSS JOIN|ON|AND|OR|NOT|IN|BETWEEN|IS NOT NULL|IS NULL|LIKE|ILIKE|AS|ASC|DESC|DATE|extract|year from)\b/g;
function hiSQL(sql) {
  return sql.split(/('(?:[^']|'')*')/).map((part, i) => i % 2 ? `<span class="lit">${esc(part)}</span>`
    : esc(part).replace(KW, '<span class="kw">$1</span>').replace(/\$(\d+)/g, '<span class="pm">$$$1</span>')).join('');
}
function fmtVal(v) { return v === null || v === undefined ? 'null' : typeof v === 'string' ? `'${v}'` : String(v); }
function renderFibers(tree) {
  const mode = tree.parsed.mode; const fib = {};
  if (mode === 'sql' || mode === 'math' || mode === 'write') {
    const g = T.toSQL(tree);
    const rows = g.paramNames.map((name, i) => {
      const slot = T.findSlot(tree.root, name);
      const bound = name in tree.parsed.bindings;
      return `<tr><td><code class="pm">$${i + 1}</code></td><td><code class="tok k-slotkey">$${esc(name)}</code></td><td>${slot && slot.type ? esc(T.baseType(slot.type)) : '—'}</td>
        <td>${bound ? `<code class="lit">${esc(fmtVal(g.params[i]))}</code>${g.via[name] === 'call' ? ' <span class="pill mute">from @ call</span>' : ''}` : '<span class="pill gap">gap</span>'}</td></tr>`;
    }).join('');
    fib.SQL = {text: g.sql, html: `<pre class="code">${hiSQL(g.sql)}</pre>` + (rows ? `<div class="tbl-wrap" style="border-top:1px solid var(--line)"><table class="grid"><thead><tr><th>Param</th><th>Variable</th><th>Type</th><th>Bound value</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="status-line">No variables. Every value is written inline.</div>`)};
  }
  if (mode === 'math') {
    const w = T.toMath(tree, true), x = T.toMath(tree, false);
    fib.Math = {text: w, html: `<div class="mathline"><div class="big">${esc(w)}</div><small>Written form, with the shorthand people use</small><div class="big" style="font-size:18px;color:var(--ink-2)">${esc(x)}</div><small>Explicit form, every operator spelled out. Both are the same tree.</small></div>`};
    const order = ['Math', 'SQL']; order.forEach(k => { const v = fib[k]; delete fib[k]; fib[k] = v; });
  }
  if (mode === 'fn') {
    const args = tree.parsed.fn.params.map(p => { const s = tree.parsed.items[p.name][0]; return p.name + ': ' + (s.children.length ? JSON.stringify(s.children[0].value) : '/* gap */'); }).join(', ');
    const text = (tree.parsed.call ? 'await ' : '') + 'registry.resolve(' + JSON.stringify(tree.parsed.registry + '/' + tree.parsed.path) + ')({ ' + args + ' })';
    fib.Call = {text, html: `<pre class="code">${esc(text)}</pre><div class="status-line">${tree.parsed.call ? 'The @ prefix makes this an invocation: resolve the handler in the registry this system is running in, then apply it.' : 'Without @, the address only names the function.'}</div>`};
  }
  const json = JSON.stringify(T.toJSON(tree), null, 2);
  fib.JSON = {text: json, html: `<pre class="code">${esc(json)}</pre>`};
  fib.URI = {text: T.identity(tree), html: `<pre class="code" style="white-space:pre-wrap;word-break:break-all">${esc(T.identity(tree))}</pre><div class="status-line">Identity form: the address with every ~meta key removed. Two snapshots of the same state compare equal on this string.</div><pre class="code" style="white-space:pre-wrap;word-break:break-all;border-top:1px solid var(--line)">${esc(T.strictForm(T.serialize(tree).uri))}</pre><div class="status-line">Strict transport form: every character outside RFC 3986 percent-encoded. It parses back to the same tree.</div>`};
  state.fibers = fib;
  const names = Object.keys(fib);
  if (!names.includes(state.fiber)) state.fiber = names[0];
  $('#fiber-tabs').innerHTML = names.map(n => `<button class="tab" role="tab" aria-selected="${n === state.fiber}" data-f="${n}">${n}</button>`).join('');
  $('#fiber-body').innerHTML = fib[state.fiber].html;
}

/* ------------------------------------------------------------------ pulses */
// Each committed state (after a 300 ms quiet period) becomes one pulse: step + ISO 8601 ms time + debounce.
function schedulePulse(tree) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => commitPulse(tree), T.DEBOUNCE_MS);
}
function commitPulse(tree) {
  const withoutPulse = T.serialize(Object.assign({}, tree, {parsed: Object.assign({}, tree.parsed, {meta: tree.parsed.meta.filter(m => m[0] !== 'pulse')})})).uri;
  const last = state.pulses[state.pulses.length - 1];
  if (last && last.base === withoutPulse) return;
  state.step += 1;
  const at = new Date().toISOString();
  const parent = last ? last.identity : null;
  const id = T.identity(tree);
  const wrote = state.lastWrite && state.lastWrite.identity === id ? {undo: state.lastWrite.res.inverse} : {};
  const extra = Object.keys(wrote).length ? wrote : null;
  const uri = T.withPulse(tree, state.step, at, T.DEBOUNCE_MS, parent, extra);
  state.pulses.push({step: state.step, at, uri, base: withoutPulse, identity: id, parent, undo: wrote.undo || null, parentStep: last ? last.step : null, changed: !last || last.identity !== id, label: intentLabel(tree) || tree.parsed.registry + '/' + tree.parsed.path});
  renderPulses(); syncAddressBar();
}
function renderPulses() {
  const list = $('#pulses');
  if (!state.pulses.length) { list.innerHTML = `<li class="pulse-empty">No pulses yet.</li>`; }
  else list.innerHTML = state.pulses.slice().reverse().map(p => `<li class="pulse" data-step="${p.step}" title="${esc(p.uri)}">
    <span class="step">#${p.step}</span><span class="at">${esc(p.at.slice(11, 23))}</span><span class="what">${esc(p.label)}</span>
    <span class="from" title="${p.parent ? 'Parent: ' + esc(p.parent) : 'First pulse: no parent'}">${p.parentStep === null ? '' : 'from #' + p.parentStep}</span>
    <i class="apple${p.changed ? '' : ' meta'}" title="${p.changed ? 'State changed' : 'Only meta changed'}"></i></li>`).join('');
  $('#pulse-note').innerHTML = `<span>One pulse per committed address after a ${T.DEBOUNCE_MS} ms pause. Filled apple: the state changed. Hollow apple: only annotations or other meta changed. "from #n" names the parent pulse this state came from.</span>`;
}

/* ------------------------------------------------------------ sheets */
function openSheet(title, desc, tabs, opener) {
  state.lastFocus = opener || document.activeElement;
  $('#sheet-title').textContent = title; $('#sheet-desc').textContent = desc;
  $('#sheet-tabs').innerHTML = tabs.map((t, i) => `<button class="tab" role="tab" aria-selected="${i === 0}" data-i="${i}">${esc(t[0])}</button>`).join('');
  const show = i => { $('#sheet-tabs').querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(+b.dataset.i === i))); $('#sheet-body').innerHTML = tabs[i][1](); };
  $('#sheet-tabs').onclick = e => { const b = e.target.closest('.tab'); if (b) show(+b.dataset.i); };
  show(0); $('#sheet').hidden = false; $('#sheet-close').focus();
}
function closeSheet() { $('#sheet').hidden = true; if (state.lastFocus) state.lastFocus.focus(); }
function columnsTable(t) {
  return `<div class="card tbl-wrap"><table class="grid"><thead><tr><th>Column</th><th>Type</th><th>Constraints</th><th>Description</th></tr></thead><tbody>
    ${t.columns.map(c => `<tr><td><code>${c[0]}</code></td><td><code>${esc(c[1])}</code></td><td><code>${esc(c[2] || '')}</code></td><td class="wrap">${esc(c[3])}</td></tr>`).join('')}</tbody></table></div>`;
}
function openTable(reg, name, opener) {
  const db = T.REGISTRIES[reg].db; const t = db.schema.tables.find(x => x.name === name);
  openSheet(reg + ' · ' + name, t.description, [
    ['Rows (' + T.tableRows(reg, name).length + ')', () => `<div class="card">${resultTable(t.columns.map(c => c[0]), T.tableRows(reg, name))}</div>${T.dataChanged() ? '<div class="status-line">This session\'s data, after the writes run here. Reset data restores the shipped rows.</div>' : ''}`],
    ['Columns', () => columnsTable(t)],
    ['DDL', () => `<div class="card"><pre class="code">${hiSQL(T.tableDDL(t) + '\n' + T.tableInserts(t, db.seed))}</pre></div>`]
  ], opener);
}
function openSchema(reg, opener) {
  const db = T.REGISTRIES[reg].db; const rels = [];
  db.schema.tables.forEach(t => t.columns.forEach(c => { const m = /REFERENCES (\w+)\((\w+)\)/.exec(c[2]); if (m) rels.push(`<li><code>${t.name}.${c[0]}</code> → <code>${m[1]}.${m[2]}</code>${/NOT NULL/.test(c[2]) ? '' : ' (nullable)'}</li>`); }));
  openSheet(reg, db.schema.description, [
    ['Data dictionary', () => `<div><h3 style="margin:0 0 6px;font-size:14px">Relationships</h3><ul class="rel-list">${rels.join('')}</ul></div>` +
      db.schema.tables.map(t => `<div><h3 style="margin:0 0 4px;font:600 14px var(--font-code)">${t.name}</h3><p style="margin:0 0 8px;color:var(--ink-2)">${esc(t.description)}</p>${columnsTable(t)}</div>`).join('')],
    ['Full DDL', () => `<div class="card"><pre class="code">${hiSQL(T.fullDDL(reg))}</pre></div>`]
  ], opener);
}

/* ------------------------------------------------------------------ tests */
function runTests() {
  const Y = '<span class="pill ok">✓</span>', N = '<span class="pill bad">✗</span>', NA = '<span style="color:var(--ink-3)">—</span>';
  let qPass = 0;
  const qRows = T.QUERIES.map(q => {
    let parse = false, rt = false, strict = false, ref = null, res = false, note = '', kind = '';
    try {
      const tree = T.parseURI(q.uri); parse = !tree.diagnostics.some(d => d.level === 'error');
      rt = T.serialize(tree).uri === q.uri;
      strict = T.serialize(T.parseURI(T.strictForm(q.uri))).uri === q.uri;
      if (q.ref) ref = T.toSQL(tree, {inline: true}).sql.replace(/\s+/g, ' ') === q.ref;
      let r;
      try { r = T.execute(tree, {store: T.newStore()}); }
      catch (e) { if (!e.code) throw e; r = {kind: 'error', code: e.code}; }
      kind = r.kind === 'error' ? 'error ' + r.code : r.kind;
      res = snapshotCheck(tree, r) === true;
    } catch (e) { note = e.message; }
    const all = parse && rt && strict && ref !== false && res; if (all) qPass++;
    return `<tr><td class="wrap"><button class="probe title" data-uri="${esc(q.uri)}">${esc(q.title)}</button>${note ? `<div class="diag error">${esc(note)}</div>` : ''}</td>
      <td>${parse ? Y : N}</td><td>${rt ? Y : N}</td><td>${strict ? Y : N}</td><td>${ref === null ? NA : ref ? Y : N}</td>
      <td>${res ? Y : N} <span style="color:var(--ink-3);font-size:12px">${esc(kind === 'halt' ? 'halts: nothing runs' : kind)}</span></td></tr>`;
  }).join('');
  $('#test-queries').innerHTML = `<table class="grid"><thead><tr><th>Address</th><th>Parses</th><th>Round-trip</th><th>Strict form</th><th>SQL = reference</th><th>Result = verified</th></tr></thead><tbody>${qRows}</tbody></table>`;

  const trees = T.QUERIES.map(q => { try { return T.parseURI(q.uri); } catch (e) { return null; } }).filter(Boolean);
  const inv = [];
  const check = (name, why, fn) => { let pass = 0, total = 0; trees.forEach(t => { const r = fn(t); if (r === null) return; total++; if (r) pass++; }); inv.push([name, why, pass, total]); };
  check('Identity ignores meta', 'Removing every ~key leaves the identity unchanged', t => {
    if (!t.parsed.meta.length) return null;
    // Split only the query part, and only on "&": a meta value may contain "?" (canonical form escapes only % & #).
    const u = T.serialize(t).uri, qi = u.indexOf('?');
    const kept = u.slice(qi + 1).split('&').filter(p => !p.startsWith('~'));
    const stripped = u.slice(0, qi) + (kept.length ? '?' + kept.join('&') : '');
    return T.identity(T.parseURI(stripped)) === T.identity(t);
  });
  const PARENT = T.identity(trees[0]);
  check('A pulse never changes identity', 'Adding ~pulse=[{step, at, debounce_ms, parent}] keeps the same identity, with or without a parent', t => [null, PARENT].every(par => T.identity(T.parseURI(T.withPulse(t, 7, '2026-10-04T18:00:00.000Z', 300, par))) === T.identity(t)));
  check('Pulse round-trips', 'An address with a pulse (parent included) re-serializes to the identical string', t => { const u = T.withPulse(t, 7, '2026-10-04T18:00:00.000Z', 300, PARENT); return T.serialize(T.parseURI(u)).uri === u; });
  // One chain through the collection, as if a person walked it in order: each pulse names the previous identity.
  const chain = []; trees.forEach((t, i) => { const prev = chain[chain.length - 1]; chain.push({uri: T.withPulse(t, i + 1, '2026-10-04T18:00:00.000Z', 300, prev ? prev.identity : null), identity: T.identity(t)}); });
  { let pass = 0; chain.forEach((c, i) => { const row = T.parseURI(c.uri).parsed.meta.find(m => m[0] === 'pulse')[1][0]; if (i === 0 ? row.parent === null : chain.slice(0, i).some(e => e.identity === row.parent)) pass++; });
    inv.push(['Every parent is an earlier pulse', 'In a pulse chain, each parent equals the identity of an earlier pulse (the first has parent null)', pass, chain.length]); }
  check('Every pointer resolves', 'Each annotation pointer lands on at least one node', t => t.spikes.length ? t.spikes.every(sp => sp.data) : null);
  check('Every lit facet resolves', 'Facet addresses resolve to notes in a registry', t => t.spikes.length ? t.spikes.every(sp => !sp.problems.length) : null);
  check('A gap always halts', 'A gap always halts. Nothing runs or writes until every required variable is bound.', t => { if (!t.gaps.length) return null; const st = T.newStore(); return T.execute(t, {store: st}).kind === 'halt' && !T.dataChanged(st); });
  check('Intent rows never change identity', 'Removing ~intent (string or rows) leaves the identity unchanged', t => { const m = t.parsed.meta.find(x => x[0] === 'intent'); if (!m) return null; return T.identity(T.edit(T.serialize(t).uri, [{op: 'meta', key: 'intent', value: null}], {pulse: false}).tree) === T.identity(t); });
  check('Bound trees have no gaps', 'With every variable bound, execution produces a result or a plain-language refusal, never a halt', t => { if (t.gaps.length) return null; try { return T.execute(t, {store: T.newStore()}).kind !== 'halt'; } catch (e) { return !!e.code; } });
  check('A preview never writes', 'Running a write address without @ changes no data', t => { if (t.parsed.mode !== 'write' || t.gaps.length) return null; const st = T.newStore(); try { T.execute(t, {store: st, preview: true}); } catch (e) { if (!e.code) return false; } return !T.dataChanged(st); });
  check('Inverse restores the data', 'Applying a write and then its inverse addresses leaves every table as it was', t => {
    if (t.parsed.mode !== 'write' || t.gaps.length || t.diagnostics.some(d => d.level === 'error' || d.level === 'refused')) return null;
    const st = T.newStore(); let w;
    try { w = T.execute(T.parseURI('@' + T.serialize(t).uri.replace(/^@/, '')), {store: st}); } catch (e) { return e.code ? null : false; }
    w.inverse.forEach(u => T.execute(T.parseURI(u), {store: st}));
    return !T.dataChanged(st);
  });
  $('#test-invariants').innerHTML = `<table class="grid"><thead><tr><th>Invariant</th><th>What it means</th><th>Result</th></tr></thead><tbody>${inv.map(([n, w, p, tot]) =>
    `<tr><td>${esc(n)}</td><td class="wrap">${esc(w)}</td><td>${p === tot ? `<span class="pill ok">✓ ${p} / ${tot}</span>` : `<span class="pill bad">✗ ${p} / ${tot}</span>`}</td></tr>`).join('')}</tbody></table>`;

  let cYes = 0, cVer = 0, cNo = 0;
  const cRows = T.COVERAGE.map(([cat, name, st, uri]) => {
    let status;
    if (st === 'yes') {
      cYes++; let ok = false;
      try { const t = T.parseURI(uri); ok = T.serialize(t).uri === uri && snapshotCheck(t, T.execute(t, {store: T.newStore()})) === true; } catch (e) {}
      if (ok) cVer++;
      status = ok ? '<span class="pill ok">✓ Represented, verified</span>' : '<span class="pill bad">✗ Represented, check failed</span>';
    } else { cNo++; status = '<span class="pill warn">Not representable yet</span>'; }
    return `<tr><td style="color:var(--ink-3);font-size:12px">${esc(cat)}</td><td>${esc(name)}</td><td>${status}</td>
      <td class="wrap">${uri ? `<button class="probe" data-uri="${esc(uri)}">${esc(uri)}</button>` : '<span style="color:var(--ink-3)">Declared out of scope for v0.1</span>'}</td></tr>`;
  }).join('');
  $('#test-coverage').innerHTML = `<table class="grid"><thead><tr><th>Area</th><th>Construct</th><th>Status</th><th>Probe address</th></tr></thead><tbody>${cRows}</tbody></table>`;
  const invPass = inv.filter(i => i[2] === i[3]).length;
  $('#test-summary').innerHTML = `
    <div class="stat"><b>${qPass} / ${T.QUERIES.length}</b><span>addresses pass every check</span></div>
    <div class="stat"><b>${invPass} / ${inv.length}</b><span>protocol invariants hold</span></div>
    <div class="stat"><b>${cVer} / ${cYes}</b><span>represented constructs verified</span></div>
    <div class="stat"><b>${cNo}</b><span>constructs declared unrepresentable</span></div>
    <div class="stat"><b style="font-size:14px;padding-top:6px">${esc(ENGINE)}</b><span>reference engine</span></div>`;
}
function runGenerator() {
  const seed = Number($('#gen-seed').value) || 0, n = Math.min(5000, Math.max(1, Number($('#gen-n').value) || 300));
  const g = new T.FilterGenerator(seed); const uris = g.batch(n);
  const tally = {}; T.RULES.forEach(([id]) => { tally[id] = 0; });
  let strict = 0, idMeta = 0, idMetaTotal = 0, gapsBlocked = 0, gapsTotal = 0; const kinds = {};
  uris.forEach(u => {
    const f = T.FilterGenerator.filter(u);
    f.rules.forEach(r => { if (r.pass) tally[r.id]++; });
    if (!f.tree) return;
    try { if (T.serialize(T.parseURI(T.strictForm(u))).uri === u) strict++; } catch (e) {}
    if (f.tree.parsed.meta.length) { idMetaTotal++; try { if (T.identity(T.parseURI(T.withPulse(f.tree, 1, '2026-01-01T00:00:00.000Z', 300))) === T.identity(f.tree)) idMeta++; } catch (e) {} }
    try { const r = T.execute(f.tree); kinds[r.kind] = (kinds[r.kind] || 0) + 1; if (f.tree.gaps.length) { gapsTotal++; if (r.kind === 'halt') gapsBlocked++; } } catch (e) { kinds.error = (kinds.error || 0) + 1; }
  });
  const pill = (a, b) => a === b ? `<span class="pill ok">✓ ${a} / ${b}</span>` : `<span class="pill bad">✗ ${a} / ${b}</span>`;
  const rows = T.RULES.map(([id, name]) => `<tr><td>Rule: ${esc(name)}</td><td>${pill(tally[id], n)}</td></tr>`).join('') +
    `<tr><td>Strict percent-encoded form parses back to the same address</td><td>${pill(strict, n)}</td></tr>
     <tr><td>Identity ignores ~meta (addresses that carry meta)</td><td>${pill(idMeta, idMetaTotal)}</td></tr>
     <tr><td>A gap always halts</td><td>${pill(gapsBlocked, gapsTotal)}</td></tr>
     <tr><td>Outcomes</td><td>${Object.entries(kinds).map(([k, v]) => `<span class="pill mute">${esc(k)} ${v}</span>`).join(' ')}</td></tr>`;
  const samples = uris.slice(0, 8).map(u => `<li style="margin:4px 0"><button class="probe" data-uri="${esc(u)}">${esc(u)}</button></li>`).join('');
  $('#test-generator').innerHTML = `<table class="grid"><thead><tr><th>Check over ${n} generated addresses (seed ${seed})</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="padding:10px 14px;border-top:1px solid var(--line)"><div style="font-size:12px;color:var(--ink-3);margin-bottom:4px">First samples. Open one to inspect it in the workbench.</div><ul style="margin:0;padding-left:18px">${samples}</ul></div>`;
}
function openTests() { state.lastFocus = document.activeElement; $('#tests').hidden = false; runTests(); runGenerator(); $('#close-tests').focus(); document.body.style.overflow = 'hidden'; }
function closeTests() { $('#tests').hidden = true; document.body.style.overflow = ''; if (state.lastFocus) state.lastFocus.focus(); }

/* ----------------------------------------------------------- address bar */
function syncAddressBar() {
  if (!state.addressBar) return;
  const last = state.pulses[state.pulses.length - 1]; if (!last) return;
  try { history.replaceState(null, '', '#' + last.uri); } catch (e) { /* sandboxed frames may refuse */ }
}
function readHash() {
  let h = location.hash.slice(1);
  try { h = decodeURI(h); } catch (e) {}
  return ['!tcxp:/', '@!tcxp:/', 'tcxp://', '@tcxp://'].some(p => h.startsWith(p)) ? h : null;
}

/* ------------------------------------------------------------------- chat */
function setupChat() {
  const form = $('#tcxp-chat-form'), input = $('#tcxp-chat-input'), thread = $('#tcxp-chat-thread');
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    const last = state.pulses[state.pulses.length - 1];
    const context = {uri: state.uri, pulse: last ? last.uri : null, queryId: state.queryId, gaps: state.tree ? state.tree.gaps : [], at: new Date().toISOString()};
    const empty = $('#tcxp-chat-empty'); if (empty) empty.remove();
    const m = document.createElement('div'); m.className = 'msg';
    m.innerHTML = `${esc(text)}<small>${last ? 'pulse #' + last.step : 'no pulse yet'}</small>`;
    thread.appendChild(m); thread.scrollTop = thread.scrollHeight;
    input.value = ''; grow();
    window.dispatchEvent(new CustomEvent('tcxp:chat-submit', {detail: {text, context}}));
    if (typeof window.tcxpOnChat === 'function') { try { window.tcxpOnChat(text, context); } catch (err) { console.error(err); } }
  });
}

/* ------------------------------------------------------------------- wire */
function copy(text, btn) {
  const done = () => { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = o; }, 1200); };
  try { navigator.clipboard.writeText(text).then(done, () => { btn.textContent = 'Copy blocked'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }); } catch (e) {}
}
function init() {
  renderExplorer(); setupChat(); renderPulses();
  let timer;
  $('#uri-input').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => update(e.target.value), 120); });
  $('#reset-uri').addEventListener('click', () => selectQuery(state.queryId, {noScroll: true}));
  $('#copy-uri').addEventListener('click', e => copy(state.uri, e.currentTarget));
  $('#copy-fiber').addEventListener('click', e => { const f = state.fibers[state.fiber]; if (f) copy(f.text, e.currentTarget); });
  $('#copy-jsonl').addEventListener('click', e => copy(state.pulses.map(p => JSON.stringify(Object.assign({step: p.step, at: p.at, debounce_ms: T.DEBOUNCE_MS, parent: p.parent}, p.undo ? {undo: p.undo} : {}, {identity: p.identity, uri: p.uri}))).join('\n'), e.currentTarget));
  $('#fiber-tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (!b) return; state.fiber = b.dataset.f; $('#fiber-tabs').querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', String(x === b))); $('#fiber-body').innerHTML = state.fibers[state.fiber].html; });
  $('#pulses').addEventListener('click', e => { const li = e.target.closest('.pulse'); if (!li) return; const p = state.pulses.find(x => x.step === +li.dataset.step); if (p) loadURI(p.uri); });
  $('#find-form').addEventListener('submit', e => e.preventDefault());
  $('#find-input').addEventListener('input', renderFind);
  $('#fit-tree').addEventListener('click', e => { state.fit = !state.fit; e.currentTarget.setAttribute('aria-pressed', String(state.fit)); e.currentTarget.textContent = state.fit ? 'Actual size' : 'Fit to width'; $('#tree-scroll').classList.toggle('fit', state.fit); });
  $('#addr-toggle').addEventListener('change', e => {
    state.addressBar = e.target.checked;
    if (state.addressBar) syncAddressBar();
    else { try { history.replaceState(null, '', location.pathname + location.search); } catch (err) {} }
  });
  window.addEventListener('hashchange', () => { const h = readHash(); if (h && h !== state.uri) loadURI(h); });
  $('#open-tests').addEventListener('click', openTests);
  $('#close-tests').addEventListener('click', closeTests);
  $('#rerun-tests').addEventListener('click', () => { runTests(); runGenerator(); });
  $('#gen-form').addEventListener('submit', e => { e.preventDefault(); runGenerator(); });
  $('#tests').addEventListener('click', e => { const b = e.target.closest('.probe'); if (b) { closeTests(); loadURI(b.dataset.uri); } });
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
  document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (!$('#tests').hidden) closeTests(); else if (!$('#sheet').hidden) closeSheet(); });
  const fromHash = readHash();
  if (fromHash) { state.addressBar = true; $('#addr-toggle').checked = true; loadURI(fromHash); }
  else selectQuery('equation-bound', {noScroll: true});
}
init();
})();
