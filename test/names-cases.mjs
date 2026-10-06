// Addresses that put JavaScript-special names (constructor, __proto__, toString, hasOwnProperty, valueOf)
// in every position a name can appear. Each must parse to a normal tree or fail with a plain TcxpError;
// never a JS TypeError, and never a silent success that reads an Object.prototype member.
export const NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'];
const S = '!tcxp:/school.demo/sql/select?';
const EMPTY = {intent: [], observe: [], reason: [], decide: [], trace: []};
const ctx = (parts) => '~context=' + encodeURIComponent(JSON.stringify(Object.assign({}, EMPTY, parts || {})));
// Every case is a full address: it ends with ~context (empty unless the case is about the context).
const full = uri => uri.includes('~context=') ? uri : uri + (uri.includes('?') ? '&' : '?') + ctx();
export const nameCases = n => [
  ['registry', '!tcxp:/' + n + '/sql/select?cols=*&from=students'],
  ['call registry', '@!tcxp:/' + n + '/hello?do=x'],
  ['path', '!tcxp:/school.demo/' + n],
  ['call path', '@!tcxp:/registry/' + n + '?do=x'],
  ['resolvable registry', 'tcxp://' + n + '/notes/x'],
  ['resolvable path', 'tcxp://firm.demo/rules/' + n],
  ['note path', '!tcxp:/registry/notes/' + n],
  ['select key', S + n + '=1&cols=*&from=students'],
  ['write key', '!tcxp:/school.demo/sql/delete?from=students&' + n + '=1'],
  ['math key', '!tcxp:/registry/math/eval?' + n + '=1'],
  ['fn param', '@!tcxp:/registry/hello?' + n + '=x'],
  ['table', S + 'cols=*&from=' + n],
  ['column', S + 'cols=' + n + '&from=students'],
  ['column in where', S + 'cols=*&from=students&where=eq(' + n + ',1)'],
  ['qualified column', S + 'cols=students.' + n + '&from=students'],
  ['operator', S + 'cols=' + n + '(gpa)&from=students'],
  ['math operator', '!tcxp:/registry/math/eval?expr=' + n + '(1,2)'],
  ['alias', S + 'cols=as(gpa,' + n + ')&from=students&order=asc(' + n + ')'],
  ['unbound variable', S + 'cols=*&from=students&where=eq(gpa,$' + n + ')'],
  ['bound variable', S + 'cols=*&from=students&where=eq(gpa,$' + n + ')&$' + n + '=3.5'],
  ['math variable', '!tcxp:/registry/math/eval?expr=gt($' + n + ',1)&$' + n + '=2'],
  ['unused binding', S + 'cols=*&from=students&$' + n + '=1'],
  ['~ key', S + 'cols=*&from=students&~' + n + '=1&' + ctx()],
  ['write table', '!tcxp:/school.demo/sql/delete?from=' + n + '&where=true'],
  ['write column', '!tcxp:/school.demo/sql/update?table=students&set=assign(' + n + ',1)&where=true'],
  ['insert column', '!tcxp:/school.demo/sql/insert?into=courses&cols=' + n + '&values=row(1)'],
  ['intent row field', S + 'cols=*&from=students&' + ctx({intent: [{role: 'manager', text: 'x', require: '$' + n}]})],
  ['pointer', S + 'cols=*&from=students&' + ctx({observe: [{id: 's1', on: ['/' + n + '/0', '/$' + n, '/~context/' + n + '/0'], meaning: null, structure: null, environment: null}]})],
  ['context key', S + 'cols=*&from=students&~context=' + encodeURIComponent('{"intent":[],"observe":[],"reason":[],"decide":[],"trace":[],"' + n + '":[]}')],
  ['context row field', S + 'cols=*&from=students&' + ctx({observe: [{[n]: 1}]})]
].map(([w, u]) => [w, full(u)]);
