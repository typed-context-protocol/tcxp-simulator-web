// Addresses that put JavaScript-special names (constructor, __proto__, toString, hasOwnProperty, valueOf)
// in every position a name can appear. Each must parse to a normal tree or fail with a plain TcxpError;
// never a JS TypeError, and never a silent success that reads an Object.prototype member.
export const NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'];
const S = '!tcxp:/school.demo/sql/select?';
export const nameCases = n => [
  ['registry', '!tcxp:/' + n + '/sql/select?cols=*&from=students'],
  ['call registry', '@!tcxp:/' + n + '/hello?do=x'],
  ['path', '!tcxp:/school.demo/' + n],
  ['call path', '@!tcxp:/registry/' + n + '?do=x'],
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
  ['meta key', S + 'cols=*&from=students&~' + n + '=1'],
  ['write table', '!tcxp:/school.demo/sql/delete?from=' + n + '&where=true'],
  ['write column', '!tcxp:/school.demo/sql/update?table=students&set=assign(' + n + ',1)&where=true'],
  ['insert column', '!tcxp:/school.demo/sql/insert?into=courses&cols=' + n + '&values=row(1)'],
  ['intent require', S + 'cols=*&from=students&~intent=' + encodeURIComponent(JSON.stringify([{role: 'manager', text: 'x', require: '$' + n, if_empty: 'HALT'}])).replace(/%2C/g, ',').replace(/%3A/g, ':')],
  ['pointer', S + 'cols=*&from=students&~spikes=' + JSON.stringify([{id: 's1', on: ['/' + n + '/0', '/$' + n], meaning: null, structure: null, environment: null}])]
];
