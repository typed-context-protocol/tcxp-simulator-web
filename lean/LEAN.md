# Lean proof strategy for tcxp

## What is already proved

`Tcxp.lean` checks with Lean 4.19.0 using only the core library (`lean Tcxp.lean`). It contains no `sorry`.

| Theorem | Plain statement |
|---|---|
| `roundtrip`, `parse_ser`, `parseN_serList` | Serializing any expression tree to tokens and parsing the tokens back gives the same tree, with nothing left over. Lossless by proof, not by test. |
| `gap_blocks`, `gap_blocks_list` | If a variable occurs in the tree and has no binding, evaluation returns nothing, for *any* interpretation of the operators. A gap cannot be silently filled. |
| `identity_withPulse`, `identity_withMeta`, `same_state_same_identity` | Adding a pulse or any meta entry never changes an address's identity, so two snapshots of one state compare equal. |
| `bitsOf_lt`, `bitsOf_inj`, `bits_eq_iff` | A spike's state is a number 0–7, and two spikes have the same number exactly when the same facets are lit. Comparing spikes is one exact equality check. |
| `gap_blocks_write` | A write whose value expression mentions an unbound variable produces no table at all, for any interpretation of the operators. Gaps block writes. |
| `delete_after_insert`, `update_after_update` | On a table modeled as a list of rows keyed by id: inserting a row with a fresh key and then deleting that key, or updating a key and then updating it back to the old value, gives back the original table exactly. `apply(inverse(w), apply(w, db)) = db`. |
| `insert_after_delete` | Deleting the one row with a key and then inserting it back gives the same rows, possibly in a different order (a permutation). SQL tables have no row order, so this is the inverse law for delete. |
| Worked example | `2x + 3 = 9`: round-trips; with x unbound it is blocked; with x = 3 it evaluates to true. |

## The layers still to prove, in order

1. **Characters ↔ tokens.** Model the address string, including percent-decoding and the key classes (`$`, `~`, plain), and prove `tokenize (render ts) = ts`. Composed with `roundtrip`, this gives string-level losslessness: `parseURI (serialize t) = t`. This is the main remaining step for the "Lossless" claim. The fuzz tests (2,500 generated addresses, 0 failures) are the current evidence.
2. **Canonical form is a fixed point.** `serialize (parseURI u) = u` for every `u` in canonical form. This follows from layer 1 plus a definition of canonical ordering (clause order, binding order by first occurrence, meta last).
3. **Meta-last rule.** A parser that rejects any data key after a `~` key, and a proof that `withPulse` and `withMeta` preserve the rule.
4. **Type inference for variables.** A typing relation on trees, and a proof that a variable compared with a typed reference receives that type (what the workbench shows as "type from enrolled_on").
5. **SQL semantics.** Give a formal semantics for the v0.1 SQL subset (selection, projection, joins with NULL padding, grouping, three-valued logic, ordering). Then prove that the tree evaluator and the SQL fiber's meaning agree. Existing work to build on: formal SQL semantics in Coq (for example HoTTSQL and SQLCert). Today this is tested, not proved: 49 fixed cases and 1,918 generated cases against PostgreSQL 18.3.
6. **Rules about rules.** State the protocol's invariants (meta last, gaps block, identity ignores meta) as properties of *any* handler. A new profile then only has to prove its own round-trip and strictness lemmas to inherit them all.
7. **Writes, beyond the keyed-table model.** The v0.2 theorems model one table of `(key, value)` rows and single-row writes. Next: rows with several typed columns, multi-row writes (an insert of n rows inverted by one `in(...)` delete), and constraints as preconditions, so that "a write the engine accepts satisfies NOT NULL, UNIQUE and foreign keys afterwards" is a theorem. The PostgreSQL comparison (13 fixed write cases and 1,000 generated writes, all matching, including 216 matching failures) is the current evidence.
8. **Edits and the JSON fiber.** `fromJSON (toJSON t)` has the same identity as `t` (tested on 533 addresses), and every `edit` result satisfies the filter rules (tested on 1,558 random edits). In the token model both should follow from `roundtrip` once `edit` is modeled as a function on trees: an edit is a tree rewrite followed by `ser`.
9. **Parent chain.** Model a pulse row as a structure with `step`, `at`, `debounce_ms` and `parent : Option String`, and a commit function that stamps each new address with the identity of the last committed one. Prove that in every chain it produces, the first pulse has `parent = none` and every other pulse's parent equals the identity of an earlier pulse (in fact the one immediately before it). `identity_withPulse` already covers the rest: the model treats the pulse as an opaque value, so adding `parent` cannot change identity. Today the chain property is tested in the workbench's test suite, not proved.

## How to keep the code and the proofs in sync

- The token model in `Tcxp.lean` mirrors `serialize` and `parseURI` in `tcxp.js`. When the grammar changes, change both.
- `FilterGenerator` in `tcxp.js` produces random addresses from a seed. Use its output as test vectors for an extracted or reimplemented Lean parser, so the proved model and the shipped code are checked against the same inputs.
- Running Mathlib is not required for layers 1–4. Layer 5 will be easier with Mathlib's finite-set and multiset libraries.
