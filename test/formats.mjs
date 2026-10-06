// The two address formats, spelled exactly; resolvable entries; resolve fetches only when called.
// No test touches the network: https locations are resolved through an injected fetcher, and fetch() is a spy
// that fails the test if anything calls it.   node test/formats.mjs
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const T = require('../tcxp.js');
const res = {}; let fail = 0;
const tally = (name, ok, msg) => { res[name] = res[name] || {pass: 0, total: 0}; res[name].total++; if (ok) res[name].pass++; else { fail++; console.log('FAIL', name, msg || ''); } };
const rejects = (uri, re) => { try { T.parseURI(uri); return false; } catch (e) { return e instanceof T.TcxpError && e.code === 'scheme' && (!re || re.test(e.message)); } };

// Spies: every way the engine could fetch. Parsing, reading, displaying and serializing must touch none.
const calls = {fetch: 0, readFile: 0, readFileSync: 0};
globalThis.fetch = async () => { calls.fetch++; throw new Error('network is off in tests'); };
const fsp = fs.promises.readFile; fs.promises.readFile = (...a) => { calls.readFile++; return fsp(...a); };
const fss = fs.readFileSync; fs.readFileSync = (...a) => { calls.readFileSync++; return fss(...a); };
const totalCalls = () => calls.fetch + calls.readFile + calls.readFileSync;

// 1. One rejection per aberration, each with an error that names the problem.
const V = '!tcxp:/registry/math/eval?expr=gt(2,1)', R = 'tcxp://firm.demo/rules/tax-year';
// A full address carries ~context; V and R above are bare references (as registry entries and bindings are written).
const F = (ref, ctx) => T.fullAddress(ref, ctx);
const ctxWith = parts => Object.assign({intent: [], observe: [], reason: [], decide: [], trace: []}, parts);
const aberrations = [
  ['!tcxp:// (virtual with two slashes)', '!tcxp://registry/math/eval?expr=gt(2,1)', /"!tcxp:\/\/" is not an address format/],
  ['@!tcxp:// (call, virtual with two slashes)', '@!tcxp://registry/hello?do=x', /"!tcxp:\/\/" is not an address format/],
  ['!tcxp:/// (empty segments after the scheme)', '!tcxp:///registry/math/eval?expr=gt(2,1)', /empty path segments/],
  ['tcxp:/ (one slash, no !)', 'tcxp:/registry/math/eval?expr=gt(2,1)', /"tcxp:\/" with one slash/],
  ['tcxp:/// (empty registry)', 'tcxp:///firm.demo/rules/tax-year', /empty registry/],
  ['// inside a virtual path', '!tcxp:/registry//math/eval?expr=gt(2,1)', /Empty path segment/],
  ['trailing / on a virtual path', '!tcxp:/registry/math/eval/?expr=gt(2,1)', /Empty path segment/],
  ['trailing / with no query', '!tcxp:/registry/notes/equation/', /Empty path segment/],
  ['// inside a resolvable path', 'tcxp://firm.demo//rules/tax-year', /Empty path segment/],
  ['trailing / on a resolvable path', 'tcxp://firm.demo/rules/tax-year/', /Empty path segment/],
  ['leading whitespace', ' ' + V, /whitespace/],
  ['trailing whitespace', V + ' ', /whitespace/],
  ['trailing newline', V + '\n', /whitespace/],
  ['leading whitespace (resolvable)', '\t' + R, /whitespace/],
  ['uppercase scheme', '!TCXP:/registry/math/eval?expr=gt(2,1)', /An address is exactly/],
  ['! after @ in the wrong order', '!@tcxp:/registry/hello?do=x', /An address is exactly/],
  ['double @', '@@!tcxp:/registry/hello?do=x', /An address is exactly/],
  ['! on the resolvable format', '!tcxp://firm.demo/rules/tax-year', /"!tcxp:\/\/" is not an address format/],
  ['another scheme', 'https://example.com/x', /An address is exactly/],
  ['empty string', '', /An address is exactly/]
];
for (const [name, uri, re] of aberrations) {
  tally('rejected: ' + name, rejects(uri, re), JSON.stringify(uri));
  tally('the filter fails it too', !T.FilterGenerator.filter(uri).ok, JSON.stringify(uri));
}
tally('missing registry', (() => { try { T.parseURI('!tcxp:/'); return false; } catch (e) { return e.where === 'registry'; } })());
tally('resolvable needs a path', rejects('tcxp://firm.demo?~context=' + encodeURIComponent(JSON.stringify(ctxWith({}))), /has no path/));

// 2. Both formats, and @ on both, parse and round-trip exactly (strict transport form too).
for (const uri of [F(V), F('@!tcxp:/registry/hello?do=world'), F(R), F('@' + R), F(R + '?any key=a=b&$v=3', ctxWith({intent: [{role: 'user', text: 'Which tax year?'}]}))]) {
  const t = T.parseURI(uri);
  tally('round-trips exactly', T.serialize(t).uri === uri && T.serialize(T.parseURI(T.strictForm(uri))).uri === uri && T.FilterGenerator.filter(uri).ok, uri);
  tally('fromJSON(toJSON) keeps the address', T.serialize(T.fromJSON(JSON.parse(JSON.stringify(T.toJSON(t))))).uri === uri, uri);
}
tally('a resolvable address keeps data keys as written, with no meaning', (() => {
  const t = T.parseURI(F('tcxp://firm.demo/rules/tax-year?x=1&any%20key=a%3Db'));
  const r = T.execute(t);
  return t.parsed.items.x[0].value === '1' && t.parsed.items['any key'][0].value === 'a=b' && r.registered && r.address === R && t.gaps.length === 0;
})());

// 3. tcxp://x and !tcxp:/x are different states, both on one registry.
for (const path of ['firm.demo/rules/tax-year', 'fleet.demo/env/sea-route']) {
  const r = T.parseURI(F('tcxp://' + path)), v = T.parseURI(F('!tcxp:/' + path));
  tally('tcxp://x and !tcxp:/x are different states', T.identity(r) !== T.identity(v) && T.fingerprint(T.serialize(r).uri) !== T.fingerprint(T.serialize(v).uri) && T.execute(v).kind === 'note' && T.execute(r).kind === 'resolvable', path);
}

// 4. Parsing, reading, displaying and serializing a tcxp:// address never fetches.
const before = totalCalls();
for (const uri of [F(R), F('tcxp://fleet.demo/env/sea-route'), F('tcxp://firm.demo/not/registered'), F(R + '?k=v', ctxWith({trace: [{step: 1}], observe: ['tcxp://fleet.demo/env/sea-route']}))]) {
  const t = T.parseURI(uri); T.serialize(t); T.identity(t); T.toJSON(t); T.query(t, 'references'); T.strictForm(uri);
  T.execute(t); T.FilterGenerator.filter(uri); T.edit(uri, [{op: 'context', key: 'observe', value: [{amount: 1, currency: 'USD'}]}]);
}
T.listResolvable(); T.listResolvable('firm.demo');
tally('parse, read, display, serialize: no fetch', totalCalls() === before, JSON.stringify(calls));
tally('reading shows the location', (() => { const r = T.execute(T.parseURI(F(R))); return r.kind === 'resolvable' && r.registered && r.location === 'file:fixtures/firm-tax-year.md'; })());
tally('reading an unregistered address says so, without fetching', (() => { const r = T.execute(T.parseURI(F('tcxp://firm.demo/not/registered'))); return r.kind === 'resolvable' && !r.registered && r.location === null; })());

// 5. resolve: fixture content; unregistered; failed fetch; virtual; @tcxp://.
const fixture = fs.readFileSync(new URL('../fixtures/firm-tax-year.md', import.meta.url), 'utf8');
const n0 = calls.readFile;
tally('resolve returns the fixture content', await T.resolve(R) === fixture);
tally('resolve is the call that reads it (exactly once)', calls.readFile === n0 + 1, JSON.stringify(calls));
const code = async (f) => { try { await f(); return 'none'; } catch (e) { return e instanceof T.TcxpError ? e.code : 'JS ' + e.message; } };
tally('unregistered address -> error', await code(() => T.resolve('tcxp://firm.demo/not/registered')) === 'not-registered');
tally('virtual address -> never resolved', await code(() => T.resolve('!tcxp:/firm.demo/rules/tax-year')) === 'not-resolvable');
tally('lookup uses the part before ?: a full address with data keys and context resolves the same entry', await T.resolve(F(R + '?k=v&$x=1', ctxWith({intent: [{role: 'user', text: 'x'}]}))) === fixture);
tally('a reference in the context is never resolved or fetched by reading', (() => { const n = totalCalls(); T.execute(T.parseURI(F(V, ctxWith({observe: [R]})))); return totalCalls() === n; })());
tally('a non-exact spelling is rejected, not looked up', await code(() => T.resolve(R + '/')) === 'scheme');
T.registerResolvable({address: 'tcxp://client.demo/missing', location: 'file:fixtures/does-not-exist.md'});
tally('failed fetch (missing file) -> error', await code(() => T.resolve('tcxp://client.demo/missing')) === 'fetch-failed');
T.registerResolvable({address: 'tcxp://client.demo/remote', location: 'https://example.com/remote.md'});
const nf = calls.fetch;
tally('failed fetch (network off) -> error', await code(() => T.resolve('tcxp://client.demo/remote')) === 'fetch-failed');
tally('an injected fetcher gets the location and its text is returned', await T.resolve('tcxp://client.demo/remote', {fetcher: async loc => 'remote text for ' + loc}) === 'remote text for https://example.com/remote.md');
tally('an injected fetcher that throws -> error', await code(() => T.resolve('tcxp://client.demo/remote', {fetcher: async () => { throw new Error('boom'); }})) === 'fetch-failed');
tally('no test reached the network (fetch spy only refused)', calls.fetch === nf + 1, JSON.stringify(calls));
tally('@tcxp:// parses as a call', (() => { const t = T.parseURI(F('@' + R)); return t.parsed.call && t.parsed.form === 'resolvable'; })());
tally('@tcxp:// -> not supported yet (execute)', await code(() => T.execute(T.parseURI(F('@' + R)))) === 'not-supported');
tally('@tcxp:// -> not supported yet (resolve)', await code(() => T.resolve('@' + R)) === 'not-supported');

// 6. Registration: duplicates, tcxp locations, virtual or non-exact addresses are errors.
const reg = e => { try { T.registerResolvable(e); return 'ok'; } catch (err) { return err instanceof T.TcxpError ? err.code : 'JS ' + err.message; } };
tally('duplicate registration -> error', reg({address: R, location: 'file:fixtures/other.md'}) === 'duplicate');
tally('a tcxp: location -> error (no chains)', reg({address: 'tcxp://client.demo/chain', location: 'tcxp://firm.demo/rules/tax-year'}) === 'location');
tally('a TCXP: location -> error (scheme is case-insensitive)', reg({address: 'tcxp://client.demo/chain2', location: 'TCXP://firm.demo/rules/tax-year'}) === 'location');
tally('a virtual location -> error', reg({address: 'tcxp://client.demo/chain3', location: '!tcxp:/firm.demo/rules/tax-year'}) === 'location');
tally('a location without a scheme -> error', reg({address: 'tcxp://client.demo/rel', location: 'fixtures/x.md'}) === 'location');
tally('a virtual address cannot be registered', reg({address: '!tcxp:/client.demo/x', location: 'https://example.com/x'}) === 'register');
tally('a non-exact address cannot be registered', reg({address: 'tcxp://client.demo//x', location: 'https://example.com/x'}) === 'register');
tally('an address with @ or a query cannot be registered (the entry is the part before ?)', reg({address: '@tcxp://client.demo/x', location: 'https://example.com/x'}) === 'register' && reg({address: 'tcxp://client.demo/x?~a=1', location: 'https://example.com/x'}) === 'register');
tally('entries list in registration order', JSON.stringify(T.listResolvable('client.demo').map(e => e.address)) === JSON.stringify(['tcxp://client.demo/missing', 'tcxp://client.demo/remote']));
tally('virtual addresses never appear in the list', T.listResolvable().every(e => e.address.startsWith('tcxp://')));
tally('registering under a registry that does not exist -> error', reg({address: 'tcxp://nope.demo/x', location: 'https://example.com/x'}) === 'unknown-registry' && !Object.hasOwn(T.REGISTRIES, 'nope.demo'));
tally('storing a full address under a registry that does not exist -> error', (() => { try { T.storeAddress(F('tcxp://nope.demo/x')); return false; } catch (e) { return e instanceof T.TcxpError && e.code === 'unknown-registry' && !Object.hasOwn(T.REGISTRIES, 'nope.demo'); } })());
delete T.REGISTRIES['client.demo'].resolvable;

console.log(Object.entries(res).map(([k, v]) => (v.pass === v.total ? 'ok  ' : 'FAIL') + ' ' + k + ': ' + v.pass + '/' + v.total).join('\n'));
console.log(JSON.stringify({formats: 'v0.2', checks: Object.values(res).reduce((a, v) => a + v.total, 0), failures: fail}));
process.exit(fail ? 1 : 0);
