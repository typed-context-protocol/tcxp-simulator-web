# Lean proof strategy for tcxp

## What is already proved

`Tcxp.lean` checks with Lean 4.19.0 using only the core library (`lean Tcxp.lean`). It contains no `sorry`.

| Theorem | Plain statement |
|---|---|
| `roundtrip`, `parse_ser`, `parseN_serList` | Serializing any expression tree to tokens and parsing the tokens back gives the same tree, with nothing left over. Lossless by proof, not by test. |
| `gap_blocks`, `gap_blocks_list` | If a variable occurs in the tree and has no binding, evaluation returns nothing (the engine's `halt`), for *any* interpretation of the operators. A gap cannot be silently filled. |
| `identity_withContext`, `identity_withPulse`, `same_state_same_identity` | A full address is its data plus one context of exactly five arrays (`intent`, `observe`, `reason`, `decide`, `trace`; each entry a row or a bare reference). Any context, and any pulse stamped into `trace`, leaves the identity unchanged, so two snapshots of one state compare equal. |
| `parse_serAddress` | The canonical token stream of a full address (data, then the five context keys in their fixed order, each followed by its entries) parses back to exactly that address. |
| `missing_context_rejected`, `wrong_first_key_rejected` | A stream with no context, or whose context starts with any key but `intent`, is rejected. |
| `bitsOf_lt`, `bitsOf_inj`, `bits_eq_iff` | A spike's state is a number 0–7, and two spikes have the same number exactly when the same facets are lit. Comparing spikes is one exact equality check. |
| `gap_blocks_write` | A write whose value expression mentions an unbound variable produces no table at all, for any interpretation of the operators. A gap halts writes too. |
| `delete_after_insert`, `update_after_update` | On a table modeled as a list of rows keyed by id: inserting a row with a fresh key and then deleting that key, or updating a key and then updating it back to the old value, gives back the original table exactly. `apply(inverse(w), apply(w, db)) = db`. |
| `insert_after_delete` | Deleting the one row with a key and then inserting it back gives the same rows, possibly in a different order (a permutation). SQL tables have no row order, so this is the inverse law for delete. |
| Worked example | `2x + 3 = 9`: round-trips; with x unbound it is blocked; with x = 3 it evaluates to true. |

## The layers still to prove, in order

1. **Characters ↔ tokens.** Model the address string, including percent-decoding and the key classes (`$`, `~`, plain), and prove `tokenize (render ts) = ts`. Composed with `roundtrip`, this gives string-level losslessness: `parseURI (serialize t) = t`. This is the main remaining step for the "Lossless" claim. The fuzz tests (2,500 generated addresses, 0 failures) are the current evidence.
2. **Canonical form is a fixed point.** `serialize (parseURI u) = u` for every `u` in canonical form. This follows from layer 1 plus a definition of canonical ordering (clause order, binding order by first occurrence, `~context` last and compact). `parse_serAddress` already proves it at the token level for the data/context split.
3. **Key order.** A parser that rejects a data key after a `$variable` and anything after `~context`, and the general form of `wrong_first_key_rejected`: any missing, extra or out-of-order context key is rejected.
4. **Type inference for variables.** A typing relation on trees, and a proof that a variable compared with a typed reference receives that type (what the workbench shows as "type from enrolled_on").
5. **SQL semantics.** Give a formal semantics for the SQL subset (selection, projection, joins with NULL padding, grouping, three-valued logic, ordering). Then prove that the tree evaluator and the SQL fiber's meaning agree. Existing work to build on: formal SQL semantics in Coq (for example HoTTSQL and SQLCert). Today this is tested, not proved: 68 fixed cases and 1,541 generated reads against PostgreSQL 18.3.
6. **Rules about rules.** State the protocol's invariants (context last, an unbound variable halts, identity ignores the context) as properties of *any* handler. A new profile then only has to prove its own round-trip and strictness lemmas to inherit them all.
7. **Writes, beyond the keyed-table model.** The v0.2 theorems model one table of `(key, value)` rows and single-row writes. Next: rows with several typed columns, multi-row writes (an insert of n rows inverted by one `in(...)` delete), and constraints as preconditions, so that "a write the engine accepts satisfies NOT NULL, UNIQUE and foreign keys afterwards" is a theorem. The PostgreSQL comparison (13 fixed write cases and 1,000 generated writes, all matching, including 216 matching failures) is the current evidence.
8. **Edits and the JSON fiber.** `fromJSON (toJSON t)` gives back `t` (tested on 536 addresses), and every `edit` result satisfies the filter rules (tested on about 1,600 random edits). In the token model both should follow from `roundtrip` once `edit` is modeled as a function on trees: an edit is a tree rewrite followed by `ser`.
9. **Parent chain.** Model the registry's stored addresses as a map from fingerprints to full addresses (fingerprints as an injective function on the canonical stream, standing in for SHA-256), and a commit function that stores the previous address and stamps the new pulse row with its fingerprint. Prove that following parents through the store from any committed address returns every earlier step exactly and ends at the first (parent `none`). `identity_withPulse` already covers the rest: stamping a pulse cannot change identity. Today the chain is tested (workbench suite, `test/context.mjs`, `test/api.mjs`), not proved.

## How to keep the code and the proofs in sync

- The token model in `Tcxp.lean` mirrors `serialize` and `parseURI` in `tcxp.js`. When the grammar changes, change both.
- `FilterGenerator` in `tcxp.js` produces random addresses from a seed. Use its output as test vectors for an extracted or reimplemented Lean parser, so the proved model and the shipped code are checked against the same inputs.
- Running Mathlib is not required for layers 1–4. Layer 5 will be easier with Mathlib's finite-set and multiset libraries.
