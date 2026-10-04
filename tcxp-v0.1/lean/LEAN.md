# Lean proof strategy for tcxp

## What is already proved

`Tcxp.lean` checks with Lean 4.19.0 using only the core library (`lean Tcxp.lean`). It contains no `sorry`.

| Theorem | Plain statement |
|---|---|
| `roundtrip`, `parse_ser`, `parseN_serList` | Serializing any expression tree to tokens and parsing the tokens back gives the same tree, with nothing left over. Lossless by proof, not by test. |
| `gap_blocks`, `gap_blocks_list` | If a variable occurs in the tree and has no binding, evaluation returns nothing, for *any* interpretation of the operators. A gap cannot be silently filled. |
| `identity_withPulse`, `identity_withMeta`, `same_state_same_identity` | Adding a pulse or any meta entry never changes an address's identity, so two snapshots of one state compare equal. |
| `bitsOf_lt`, `bitsOf_inj`, `bits_eq_iff` | A spike's state is a number 0–7, and two spikes have the same number exactly when the same facets are lit. Comparing spikes is one exact equality check. |
| Worked example | `2x + 3 = 9`: round-trips; with x unbound it is blocked; with x = 3 it evaluates to true. |

## The layers still to prove, in order

1. **Characters ↔ tokens.** Model the address string, including percent-decoding and the key classes (`$`, `~`, plain), and prove `tokenize (render ts) = ts`. Composed with `roundtrip`, this gives string-level losslessness: `parseURI (serialize t) = t`. This is the main remaining step for the "Lossless" claim. The fuzz tests (2,500 generated addresses, 0 failures) are the current evidence.
2. **Canonical form is a fixed point.** `serialize (parseURI u) = u` for every `u` in canonical form. This follows from layer 1 plus a definition of canonical ordering (clause order, binding order by first occurrence, meta last).
3. **Meta-last rule.** A parser that rejects any data key after a `~` key, and a proof that `withPulse` and `withMeta` preserve the rule.
4. **Type inference for variables.** A typing relation on trees, and a proof that a variable compared with a typed reference receives that type (what the workbench shows as "type from enrolled_on").
5. **SQL semantics.** Give a formal semantics for the v0.1 SQL subset (selection, projection, joins with NULL padding, grouping, three-valued logic, ordering). Then prove that the tree evaluator and the SQL fiber's meaning agree. Existing work to build on: formal SQL semantics in Coq (for example HoTTSQL and SQLCert). Today this is tested, not proved: 49 fixed cases and 1,918 generated cases against PostgreSQL 18.3.
6. **Rules about rules.** State the protocol's invariants (meta last, gaps block, identity ignores meta) as properties of *any* handler. A new profile then only has to prove its own round-trip and strictness lemmas to inherit them all.

## How to keep the code and the proofs in sync

- The token model in `Tcxp.lean` mirrors `serialize` and `parseURI` in `tcxp.js`. When the grammar changes, change both.
- `FilterGenerator` in `tcxp.js` produces random addresses from a seed. Use its output as test vectors for an extracted or reimplemented Lean parser, so the proved model and the shipped code are checked against the same inputs.
- Running Mathlib is not required for layers 1–4. Layer 5 will be easier with Mathlib's finite-set and multiset libraries.
