/* Tax Intake demo — built only on the tcxp SDK (tcxp.js): parseURI, serialize, identity, execute, toSQL, REGISTRIES.
   Everything about the current state lives in one !tcxp:/ address. The page decides nothing on its own:
   if a required variable is missing, the address has a gap and the run halts. What the app does next
   (ask, block, notify) is the application's handler, shown in the chat. */
(function () {
'use strict';
const T = window.TCXP;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const enc = s => String(s).replace(/%/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23');
const lit = s => "'" + enc(String(s).replace(/'/g, "''")).replace(/=/g, '%3D') + "'";
const REG = 'client.upload', TABLE = 'client_hours';

const SAMPLE_CSV = `employee,worked_on,hours,work_country,project
Ana Ruiz,2024-02-12,5,US,P-ATLAS
Ana Ruiz,2024-03-11,8,US,P-ATLAS
Ana Ruiz,2024-05-20,6.5,US,P-ATLAS
Ben Carter,2024-06-03,7,US,P-ATLAS
Chen Wei,2024-06-10,8,CA,P-ATLAS
Divya Rao,2024-04-15,7.5,IN,P-ATLAS
Ana Ruiz,2024-08-05,8,US,P-BEACON
Ben Carter,2024-09-16,8,US,P-BEACON
Chen Wei,2024-10-07,6,US,P-BEACON
Erik Lund,2024-11-12,5,DE,P-BEACON
Fatima Noor,2024-12-02,7.25,US,P-BEACON
Fatima Noor,2024-12-30,3.5,US,P-BEACON
Ana Ruiz,2025-01-13,8,US,P-CEDAR
Ben Carter,2025-02-24,4,US,P-CEDAR
Divya Rao,2025-03-10,8,US,P-CEDAR
Fatima Noor,2025-04-21,6,US,P-CEDAR
Erik Lund,2025-05-05,8,DE,P-CEDAR
Chen Wei,2025-06-16,7,CA,P-CEDAR
Ana Ruiz,2025-07-14,8,US,P-DELTA
Ben Carter,2025-08-18,7.5,US,P-DELTA
Fatima Noor,2025-09-08,8,US,P-DELTA
Divya Rao,2025-09-22,6,IN,P-DELTA`;

const state = {
  csv: null, fileName: 'client_hours.csv',
  question: '', binds: {},
  rules: [{id: 'r1', text: 'Before submitting, the user must state the tax year they are referencing.', require: 'tax_year', triggers: 'tax year|tax period|for|in|during', if_empty: 'HALT', review: null}],
  uri: '', tree: null, pulses: [], step: 0, addressBar: false
};

/* ------------------------------------------------------------ CSV → registry */
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
function loadCSV(text, fileName) {
  const rows = parseCSV(text.trim());
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one data row.');
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '') || 'col');
  const body = rows.slice(1).map(r => header.map((_, i) => (r[i] === undefined ? '' : r[i].trim())));
  const types = header.map((_, i) => {
    const vals = body.map(r => r[i]).filter(v => v !== '');
    if (vals.length && vals.every(v => /^-?\d+(\.\d+)?$/.test(v))) return vals.every(v => /^-?\d+$/.test(v)) ? 'integer' : 'numeric';
    if (vals.length && vals.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'date';
    return 'text';
  });
  const seed = body.map(r => r.map((v, i) => v === '' ? null : types[i] === 'integer' || types[i] === 'numeric' ? Number(v) : v));
  T.REGISTRIES[REG] = {
    title: 'Client upload', description: 'The CSV the user attached.',
    db: {schema: {name: 'client', description: 'Uploaded client file ' + fileName, tables: [{name: TABLE, description: 'Rows from ' + fileName,
      columns: header.map((h, i) => [h, types[i], '', 'From the uploaded file'])}]}, seed: {[TABLE]: seed}},
    fns: {}, notes: {}
  };
  state.csv = {header, types, rows: seed.length, hash: fnv(text)};
  state.fileName = fileName;
}
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); }
const col = name => state.csv && state.csv.header.includes(name) ? name : null;

/* ---------------------------------------------- the placeholder reasoning fiber */
// Natural language → expression tree. Deterministic keyword sensing stands in for an LLM or a typed composer;
// replace window.tcxpCompose to plug in your own. It only proposes; the grammar decides whether anything runs.
function sense(rule, text) {
  if (rule.require === 'tax_year') {
    const m = text.match(/\b(?:tax\s*(?:year|period)\s*(?:of\s*)?|for\s+(?:tax\s+year\s+)?|in\s+|during\s+|fy\s*)?((?:19|20)\d\d)\b/i);
    return m ? {value: m[1], phrase: m[0]} : null;
  }
  const trig = rule.triggers.split('|').map(s => s.trim()).filter(Boolean);
  for (const t of trig) {
    const re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[:\\s]+([\\w.\\-]+(?:\\s[\\w.\\-]+)?)', 'i');
    const m = text.match(re);
    if (m) return {value: m[1], phrase: m[0]};
  }
  return null;
}
function composeDefault(question) {
  const where = [];
  if (col('work_country') && /\b(u\.?s\.?a?|united states|in the us|inside the us)\b/i.test(question)) where.push("eq(work_country,'US')");
  state.rules.forEach(r => { if (r.require === 'tax_year' && col('worked_on')) where.push('eq(year(worked_on),$tax_year)'); });
  const measure = col('hours') && /hour/i.test(question) ? 'as(sum(hours),total_hours)' : 'as(count(*),row_count)';
  const keys = ['cols=' + measure, 'from=' + TABLE];
  if (where.length === 1) keys.push('where=' + where[0]); else if (where.length > 1) keys.push('where=and(' + where.join(',') + ')');
  return keys;
}
window.tcxpCompose = window.tcxpCompose || composeDefault;

/* --------------------------------------------------------- build the address */
function buildAddress() {
  if (!state.question) return null;
  const keys = window.tcxpCompose(state.question, state.rules.slice());
  const binds = Object.entries(state.binds).map(([k, v]) => '$' + k + '=' + (/^-?\d+(\.\d+)?$/.test(v) ? v : lit(v)));
  state.rules.forEach(r => { T.REGISTRIES[REG].notes['rules/' + r.id] = r.text; });
  const intent = [{role: 'user', text: state.question}].concat(state.rules.map(r => ({role: 'manager', id: r.id, text: r.text, require: '$' + r.require, if_empty: r.if_empty})));
  const spikes = state.rules.map((r, i) => ({id: 's' + (i + 1), on: ['/$' + r.require], meaning: null, structure: '!tcxp:/' + REG + '/rules/' + r.id, environment: null}));
  const reviews = state.rules.filter(r => r.review).map(r => ({rule: r.id, verdict: r.review.verdict, at: r.review.at}));
  let base = '!tcxp:/' + REG + '/sql/select?' + keys.join('&');
  // bind only variables that appear in the tree (unknown variables would be "bound but never used")
  let probe; try { probe = T.parseURI(T.fullAddress(base)); } catch (e) { return {error: e.message, base}; }
  // bind variables the query uses, plus any variable a rule requires (a rule can require something the query never mentions)
  const required = state.rules.map(r => r.require);
  const used = binds.filter(b => { const k = b.slice(1, b.indexOf('=')); return probe.slots.includes(k) || required.includes(k); });
  if (used.length) base += '&' + used.join('&');
  // One ~context: intent rows; observe holds the spike rows and the manager's review rows; trace holds the pulse row
  // (its parent is the fingerprint of the previous full address, kept in the address store) and the source row.
  const context = {
    intent,
    observe: spikes.filter(s => probe.slots.includes(s.on[0].slice(2))).concat(reviews),
    reason: [], decide: [],
    trace: [{step: state.step + 1, at: new Date().toISOString(), debounce_ms: 300, parent: state.tree ? T.storeAddress(T.serialize(state.tree).uri) : null},
            {file: state.fileName, rows: state.csv.rows, fnv1a: state.csv.hash}]
  };
  try { const tree = T.parseURI(base + '&~context=' + enc(JSON.stringify(context))); return {tree, uri: T.serialize(tree).uri}; }
  catch (e) { return {error: e.message, base}; }
}

/* --------------------------------------------------------- evaluate the rules */
// These checklist rules are this app's own: a requirement is met only when its variable is bound, and an unmet one
// stops the run here. The protocol's only halt rule is that an unbound variable halts; asking the user for the
// value is this app's handler, not a protocol mode.
function evaluate(tree) {
  const reqs = state.rules.map(r => {
    const bound = r.require in tree.parsed.bindings;
    const inTree = tree.slots.includes(r.require);
    return {rule: r, met: bound, inTree, sensed: state.binds[r.require] !== undefined ? state.sensed[r.require] : null};
  });
  const unmet = reqs.filter(x => !x.met);
  let result = null, err = null;
  try { result = T.execute(tree); } catch (e) { err = e.message; }
  // The engine is the authority: an unmet requirement or any gap comes back as kind "halt".
  const halted = unmet.length > 0 || tree.gaps.length > 0 || (result && result.kind === 'halt');
  if (halted) result = null;
  return {reqs, unmet, halted, result, err};
}

/* ------------------------------------------------------------------ the loop */
// The address without its pulse row (the row in trace that has "step"), to tell a real change from a re-stamp.
function sansPulse(tree) {
  const c = tree.parsed.context;
  return T.identity(tree) + JSON.stringify(Object.assign({}, c, {trace: c.trace.filter(r => !(r && typeof r === 'object' && r.step !== undefined))}));
}
function commit(reason) {
  const built = buildAddress();
  if (!built) { renderAll(null); return null; }
  if (built.error) { renderAll(null, built.error); return null; }
  if (state.tree && sansPulse(state.tree) === sansPulse(built.tree)) return state.lastEval;
  state.step += 1;
  state.tree = built.tree; state.uri = built.uri;
  const ev = evaluate(built.tree); state.lastEval = ev;
  state.pulses.push({step: state.step, at: new Date().toISOString(), uri: built.uri, identity: T.identity(built.tree), reason, halted: ev.halted,
    parentStep: state.pulses.length ? state.pulses[state.pulses.length - 1].step : null});
  renderAll(ev); syncAddressBar();
  return ev;
}

/* ------------------------------------------------------------------- chat */
function say(role, html) {
  const el = document.createElement('div'); el.className = 'msg ' + role; el.innerHTML = html;
  $('#thread').appendChild(el); $('#thread').scrollTop = $('#thread').scrollHeight;
  const empty = $('#thread-empty'); if (empty) empty.remove();
}
function fmt(v) { return typeof v === 'number' ? (Math.round(v * 100) / 100).toLocaleString() : esc(v); }
// The application's handler. The protocol only says "halted, and why"; what to do about it is up to the app.
// This app's handler for a halt is to ask the user in the chat.
function respond(ev) {
  if (!ev) return;
  if (ev.halted) {
    const r = ev.unmet[0] ? ev.unmet[0].rule : null;
    if (r) say('bot', `I can't run this yet. ${esc(r.text)} <b>${r.require === 'tax_year' ? 'Which tax year is this for?' : 'What is the ' + esc(r.require.replace(/_/g, ' ')) + '?'}</b> <span class="tag halt">halted</span>`);
    else say('bot', `This can't run while <code>$${esc(ev.reqs.length ? '' : '')}${esc(state.tree.gaps.join(', $'))}</code> is missing. <span class="tag halt">halted</span>`);
    return;
  }
  if (ev.err) { say('bot', `Something went wrong running the query: ${esc(ev.err)}`); return; }
  const res = ev.result; const v = res.rows[0] ? res.rows[0][0] : null;
  const ty = state.binds.tax_year ? ' in tax year ' + esc(state.binds.tax_year) : '';
  const us = /eq\(work_country,'US'\)/.test(state.uri) ? 'worked in the US' : 'worked';
  const label = res.columns[0] === 'total_hours' ? `Hours ${us}${ty}: <b>${fmt(v)}</b>` : `Matching rows${ty}: <b>${fmt(v)}</b>`;
  say('bot', `${label} <span class="tag ok">ran</span><br><span class="note">From ${esc(state.fileName)} (${state.csv.rows} rows).</span>`);
}
function onUserMessage(text) {
  say('user', esc(text));
  const sensedNow = {};
  state.rules.forEach(r => { const s = sense(r, text); if (s) sensedNow[r.require] = s; });
  if (!state.question || !state.tree || !(state.lastEval && state.lastEval.halted)) {
    state.question = text; state.binds = {}; state.sensed = {};
  } else if (!Object.keys(sensedNow).length && !/^\s*(?:19|20)\d\d\s*$/.test(text)) {
    state.question = text; state.binds = {}; state.sensed = {};
  }
  if (/^\s*((?:19|20)\d\d)\s*$/.test(text) && state.rules.some(r => r.require === 'tax_year')) sensedNow.tax_year = {value: text.trim(), phrase: text.trim()};
  Object.entries(sensedNow).forEach(([k, s]) => { state.binds[k] = s.value; state.sensed[k] = s.phrase; });
  respond(commit('user message'));
}

/* --------------------------------------------------------------- render */
function renderRules() {
  const ev = state.lastEval;
  $('#rules').innerHTML = state.rules.map((r, i) => {
    const q = ev && ev.reqs.find(x => x.rule.id === r.id);
    const status = !ev ? '<span class="tag mute">waiting for a question</span>'
      : q.met ? `<span class="tag ok">met</span> <span class="note">sensed “${esc(state.sensed[r.require] || state.binds[r.require])}”</span>`
      : '<span class="tag halt">not met · halts</span>';
    return `<div class="rule" data-i="${i}">
      <div class="rule-top"><span class="rid">${esc(r.id)}</span>${status}<button class="x" data-act="del" aria-label="Remove rule ${esc(r.id)}">×</button></div>
      <label class="fl">Requirement, in plain language<textarea data-f="text" rows="2" id="rule-text-${i}">${esc(r.text)}</textarea></label>
      <div class="row2">
        <label class="fl">Variable<input data-f="require" id="rule-var-${i}" value="${esc(r.require)}"></label>
        <div class="fl">If missing<span class="mode" id="rule-mode-${i}">HALT</span></div>
      </div>
      <label class="fl">Trigger words (separated by |)<input data-f="triggers" id="rule-trig-${i}" value="${esc(r.triggers)}"></label>
      <div class="review"><span>Your check:</span>
        <button data-act="pass" class="rv${r.review && r.review.verdict === 'pass' ? ' on pass' : ''}">✓ Behaved correctly</button>
        <button data-act="fail" class="rv${r.review && r.review.verdict === 'fail' ? ' on fail' : ''}">✗ Wrong</button></div>
    </div>`;
  }).join('');
}
function kindOf(n) { return n.kind === 'slot' ? (n.children.length ? 'variable' : 'gap') : n.kind; }
function treeList(n, depth, out) {
  const k = kindOf(n);
  const label = n.kind === 'operator' ? n.label : n.kind === 'slot' ? '$' + n.name : n.kind === 'value' ? (n.type === 'text' ? `'${n.value}'` : String(n.value)) : n.name;
  const sub = n.kind === 'slot' ? (n.children.length ? 'variable' : 'GAP · ' + (n.type ? T.baseType(n.type) : '')) : n.type ? T.baseType(n.type) : n.role || '';
  out.push(`<div class="tn" style="padding-left:${depth * 16}px"><span class="node ${k}">${esc(label)}</span><span class="sub">${esc(sub)}</span></div>`);
  (n.children || []).forEach(c => treeList(c, depth + 1, out));
  return out;
}
function renderPanel(ev, error) {
  const st = $('#status');
  if (error) { st.className = 'status bad'; st.innerHTML = `<b>Invalid address</b><span>${esc(error)}</span>`; return; }
  if (!ev) { st.className = 'status idle'; st.innerHTML = '<b>No address yet</b><span>Ask a question in the chat to create one.</span>'; ['#addr', '#reqs', '#tree', '#sql', '#result'].forEach(s => { $(s).innerHTML = '<p class="empty">—</p>'; }); return; }
  const n = ev.unmet.length || state.tree.gaps.length;
  st.className = 'status ' + (ev.halted ? 'halt' : 'ok');
  st.innerHTML = ev.halted ? `<b>HALTED</b><span>${n} requirement${n === 1 ? '' : 's'} not met. Nothing ran.</span>` : `<b>RAN</b><span>Every requirement is met.</span>`;
  const ser = T.serialize(state.tree);
  const gapIds = new Set(); (function w(x) { if (x.kind === 'slot' && !x.children.length) gapIds.add(x._id); (x.children || []).forEach(w); })(state.tree.root);
  $('#addr').innerHTML = `<div class="anat">${ser.tokens.map(t => `<span class="t-${t.kind}${t.nodeId && gapIds.has(t.nodeId) ? ' t-gap' : ''}">${esc(t.text)}</span>`).join('')}</div>`;
  $('#reqs').innerHTML = `<table><thead><tr><th>Rule</th><th>Variable</th><th>In tree</th><th>Bound</th><th>If missing</th></tr></thead><tbody>${ev.reqs.map(x =>
    `<tr><td>${esc(x.rule.id)}</td><td><code>$${esc(x.rule.require)}</code></td><td>${x.inTree ? 'yes' : '<span class="note">no</span>'}</td><td>${x.met ? `<span class="tag ok">${esc(state.binds[x.rule.require])}</span>` : '<span class="tag halt">gap</span>'}</td><td>${esc(x.rule.if_empty)}</td></tr>`).join('')}</tbody></table>`;
  $('#tree').innerHTML = treeList(state.tree.root, 0, []).join('');
  const g = T.toSQL(state.tree);
  $('#sql').innerHTML = `<pre>${esc(g.sql)}</pre>${g.paramNames.length ? `<div class="note" style="padding:0 12px 10px">${g.paramNames.map((p, i) => `$${i + 1} = $${esc(p)} → ${p in state.tree.parsed.bindings ? esc(String(g.params[i])) : '<b>gap</b>'}`).join(' · ')}</div>` : ''}`;
  $('#result').innerHTML = ev.halted ? '<p class="empty">Not run. The address is halted.</p>' : ev.err ? `<p class="empty">${esc(ev.err)}</p>`
    : `<table><thead><tr>${ev.result.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${ev.result.rows.map(r => `<tr>${r.map(v => `<td>${fmt(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function renderPulses() {
  $('#pulses').innerHTML = state.pulses.length ? state.pulses.slice().reverse().map(p =>
    `<li data-step="${p.step}"><span class="pstep">#${p.step}</span><span class="pfrom">${p.parentStep ? 'from #' + p.parentStep : 'first'}</span><span class="pwhy">${esc(p.reason)}</span><span class="tag ${p.halted ? 'halt' : 'ok'}">${p.halted ? 'halted' : 'ran'}</span></li>`).join('')
    : '<li class="empty">No pulses yet.</li>';
}
function renderSource() {
  $('#source').innerHTML = state.csv ? `<b>${esc(state.fileName)}</b> · ${state.csv.rows} rows · ${state.csv.header.map((h, i) => `<code>${esc(h)}</code> <span class="note">${state.csv.types[i]}</span>`).join(', ')}` : 'No file loaded.';
}
function renderAll(ev, error) { renderRules(); renderPanel(ev, error); renderPulses(); renderSource(); }

function syncAddressBar() {
  if (!state.addressBar || !state.uri) return;
  try { history.replaceState(null, '', '#' + state.uri); } catch (e) {}
}

/* ------------------------------------------------------------------ wire */
function init() {
  loadCSV(SAMPLE_CSV, 'client_hours.csv');
  state.sensed = {};
  renderAll(null);
  $('#chat-form').addEventListener('submit', e => { e.preventDefault(); const v = $('#chat-input').value.trim(); if (!v) return; $('#chat-input').value = ''; onUserMessage(v); });
  $('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); } });
  document.querySelectorAll('.suggest').forEach(b => b.addEventListener('click', () => onUserMessage(b.dataset.q)));
  $('#csv-input').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { loadCSV(String(rd.result), f.name); say('sys', `Attached <b>${esc(f.name)}</b> (${state.csv.rows} rows).`); if (state.question) respond(commit('new file')); else renderAll(state.lastEval); }
      catch (err) { say('sys', esc(err.message)); }
    };
    rd.readAsText(f);
  });
  $('#use-sample').addEventListener('click', () => { loadCSV(SAMPLE_CSV, 'client_hours.csv'); say('sys', 'Using the sample file <b>client_hours.csv</b> (22 rows).'); if (state.question) respond(commit('new file')); else renderAll(state.lastEval); });
  $('#rules').addEventListener('input', e => {
    const card = e.target.closest('.rule'); if (!card || !e.target.dataset.f) return;
    const r = state.rules[+card.dataset.i]; const f = e.target.dataset.f;
    r[f] = f === 'require' ? e.target.value.replace(/^\$/, '').replace(/[^A-Za-z0-9_]/g, '_') : e.target.value;
    clearTimeout(state.ruleTimer);
    state.ruleTimer = setTimeout(() => { if (state.question) commit('rule edited'); }, 300);
  });
  $('#rules').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const i = +b.closest('.rule').dataset.i; const r = state.rules[i];
    if (b.dataset.act === 'del') { state.rules.splice(i, 1); commit('rule removed') || renderAll(state.lastEval); }
    if (b.dataset.act === 'pass' || b.dataset.act === 'fail') { r.review = {verdict: b.dataset.act, at: new Date().toISOString()}; commit('manual review') || renderAll(state.lastEval); }
  });
  $('#add-rule').addEventListener('click', () => {
    const n = state.rules.length + 1;
    state.rules.push({id: 'r' + (n + Math.floor(Math.random() * 90)), text: 'Before submitting, the user must name the client.', require: 'client_name', triggers: 'client|for client', if_empty: 'HALT', review: null});
    commit('rule added') || renderAll(state.lastEval);
  });
  $('#pulses').addEventListener('click', e => { const li = e.target.closest('li[data-step]'); if (!li) return; const p = state.pulses.find(x => x.step === +li.dataset.step); if (p) { $('#pulse-uri').textContent = p.uri; $('#pulse-uri').hidden = false; } });
  $('#addr-toggle').addEventListener('change', e => { state.addressBar = e.target.checked; if (state.addressBar) syncAddressBar(); else { try { history.replaceState(null, '', location.pathname + location.search); } catch (err) {} } });
  $('#copy-addr').addEventListener('click', e => { try { navigator.clipboard.writeText(state.uri).then(() => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1200); }); } catch (err) {} });
  $('#reset').addEventListener('click', () => { state.question = ''; state.binds = {}; state.sensed = {}; state.tree = null; state.uri = ''; state.lastEval = null; $('#thread').innerHTML = '<p class="empty" id="thread-empty">Ask a question about the attached file.</p>'; renderAll(null); });
}
init();
window.tcxpDemo = {state, commit, evaluate};
})();
