import os
d=os.path.dirname(os.path.abspath(__file__))
r=lambda f: open(os.path.join(d,f)).read()
out = ("/* tcxp.js: Typed Context Protocol reference engine, v0.2.\n   Plain script: defines globalThis.TCXP in browsers and module.exports in Node. */\n"
  "(function (root) {\n'use strict';\n" + r('_school.js') + r('data_tail.js') + r('engine.js') + r('data_csv.js') + r('data_resolvable.js') +
  "\nconst api = {REGISTRIES, QUERIES, GROUPS, OPS, CLAUSES, CLAUSE_ORDER, COVERAGE, FACETS, SCHEME, DEBOUNCE_MS,\n"
  "  parseURI, serialize, identity, strictForm, resolvePointer, toSQL, toMath, toJSON, execute, withPulse,\n"
  "  newStore, resetData, dataChanged, tableRows, WRITE_CLAUSES, WRITE_ORDER,\n"
  "  edit, query, fromJSON, registerCSV, exprText,\n"
  "  RESOLVABLE, registerResolvable, listResolvable, resolve,\n"
  "  CONTEXT_KEYS, fullAddress, fingerprint, storeAddress, lookupAddress,\n"
  "  fullDDL, tableDDL, tableInserts, TcxpError, baseType, findSlot, FilterGenerator, RULES};\n"
  "root.TCXP = api;\nif (typeof module !== 'undefined') module.exports = api;\n})(typeof globalThis !== 'undefined' ? globalThis : this);\n")
open(os.path.join(d,'..','tcxp.js'),'w').write(out)
print(len(out))
