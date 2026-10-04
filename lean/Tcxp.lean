/-
  Tcxp.lean — machine-checked core of the Typed Context Protocol (tcxp), v0.1.

  Checked with Lean 4.19.0, core library only (no Mathlib):
      lean Tcxp.lean

  This models the protocol at the level of tokens, not characters:
    * an expression tree of four node kinds (operator, value, variable, reference),
    * a serializer to a flat token list (prefix order, each operator carries its arity),
    * a parser back from tokens,
  and proves:
    1. parse_ser       — round-trip: parsing a serialized tree returns the same tree (lossless).
    2. gap_blocks      — any unbound variable (a gap) makes evaluation return nothing.
    3. identity_*      — the identity of an address ignores meta and pulses.
    4. bits_eq_iff     — a spike's 3-bit state equals another's exactly when the same facets are lit.

  Not yet proved here (see LEAN.md): the character-level layer (tokens <-> the address string with
  percent-encoding), and agreement between the tree evaluator and a formal SQL semantics.
-/

namespace Tcxp

/-! ## 1. Trees and tokens -/

/-- The four node kinds. `op` children are ordered. Values are integers in this model. -/
inductive Node where
  | op  (name : String) (args : List Node)
  | val (v : Int)
  | var (name : String)
  | ref (name : String)
  deriving Repr

/-- Flat tokens. An operator token records how many children follow. -/
inductive Tok where
  | op  (name : String) (arity : Nat)
  | val (v : Int)
  | var (name : String)
  | ref (name : String)
  deriving Repr, DecidableEq

mutual
/-- Serialize a tree to tokens, prefix order. -/
def ser : Node → List Tok
  | .op n args => .op n args.length :: serList args
  | .val v => [.val v]
  | .var x => [.var x]
  | .ref r => [.ref r]
def serList : List Node → List Tok
  | [] => []
  | a :: as => ser a ++ serList as
end

mutual
/-- Nesting depth; leaves have depth 1. Used as parser fuel. -/
def depth : Node → Nat
  | .op _ args => depthList args + 1
  | .val _ => 1
  | .var _ => 1
  | .ref _ => 1
def depthList : List Node → Nat
  | [] => 0
  | a :: as => max (depth a) (depthList as)
end

mutual
/-- Parse one tree from the front of a token list; returns the tree and the remaining tokens. -/
def parse : Nat → List Tok → Option (Node × List Tok)
  | 0, _ => none
  | _ + 1, [] => none
  | f + 1, .op n k :: rest =>
    match parseN f k rest with
    | some (args, r) => some (.op n args, r)
    | none => none
  | _ + 1, .val v :: rest => some (.val v, rest)
  | _ + 1, .var x :: rest => some (.var x, rest)
  | _ + 1, .ref r :: rest => some (.ref r, rest)
termination_by f _ => (f, 0)
/-- Parse exactly `k` trees in sequence. -/
def parseN : Nat → Nat → List Tok → Option (List Node × List Tok)
  | _, 0, ts => some ([], ts)
  | f, k + 1, ts =>
    match parse f ts with
    | some (a, r) =>
      match parseN f k r with
      | some (as, r') => some (a :: as, r')
      | none => none
    | none => none
termination_by f k _ => (f, k + 1)
end

/-! ## 2. Round-trip (lossless) -/

mutual
theorem parse_ser : ∀ (t : Node) (f : Nat) (rest : List Tok),
    depth t ≤ f → parse f (ser t ++ rest) = some (t, rest)
  | .op n args, f, rest, h => by
    cases f with
    | zero => simp [depth] at h
    | succ f =>
      have hf : depthList args ≤ f := by simp [depth] at h; omega
      have ih := parseN_serList args f rest hf
      simp [ser, parse, List.append_assoc, ih]
  | .val v, f, rest, h => by
    cases f with
    | zero => simp [depth] at h
    | succ f => simp [ser, parse]
  | .var x, f, rest, h => by
    cases f with
    | zero => simp [depth] at h
    | succ f => simp [ser, parse]
  | .ref r, f, rest, h => by
    cases f with
    | zero => simp [depth] at h
    | succ f => simp [ser, parse]

theorem parseN_serList : ∀ (ts : List Node) (f : Nat) (rest : List Tok),
    depthList ts ≤ f → parseN f ts.length (serList ts ++ rest) = some (ts, rest)
  | [], f, rest, _ => by simp [serList, parseN]
  | a :: as, f, rest, h => by
    have h1 : depth a ≤ f := by simp [depthList] at h; omega
    have h2 : depthList as ≤ f := by simp [depthList] at h; omega
    have ha := parse_ser a f (serList as ++ rest) h1
    have has := parseN_serList as f rest h2
    simp [serList, parseN, List.append_assoc, ha, has]
end

/-- Lossless: a tree serialized to tokens parses back to itself, with nothing left over. -/
theorem roundtrip (t : Node) : parse (depth t) (ser t) = some (t, []) := by
  simpa using parse_ser t (depth t) [] (Nat.le_refl _)

/-! ## 3. Gaps block execution -/

mutual
/-- Every variable occurrence in a tree. -/
def vars : Node → List String
  | .op _ args => varsList args
  | .var x => [x]
  | .val _ => []
  | .ref _ => []
def varsList : List Node → List String
  | [] => []
  | a :: as => vars a ++ varsList as
end

mutual
/-- Strict evaluation: an operator runs only when every child produced a value.
    `env` binds variables (none = a gap); `apply` interprets operator names. -/
def eval (env : String → Option Int) (apply : String → List Int → Option Int) : Node → Option Int
  | .op n args =>
    match evalList env apply args with
    | some vs => apply n vs
    | none => none
  | .val v => some v
  | .var x => env x
  | .ref _ => none
def evalList (env : String → Option Int) (apply : String → List Int → Option Int) : List Node → Option (List Int)
  | [] => some []
  | a :: as =>
    match eval env apply a, evalList env apply as with
    | some v, some vs => some (v :: vs)
    | _, _ => none
end

mutual
theorem gap_blocks (env : String → Option Int) (apply : String → List Int → Option Int) (x : String) :
    ∀ (t : Node), x ∈ vars t → env x = none → eval env apply t = none
  | .op n args, hx, hg => by
    have := gap_blocks_list env apply x args (by simpa [vars] using hx) hg
    simp [eval, this]
  | .var y, hx, hg => by
    simp [vars] at hx; subst hx; simp [eval, hg]
  | .val _, hx, _ => by simp [vars] at hx
  | .ref _, hx, _ => by simp [vars] at hx

theorem gap_blocks_list (env : String → Option Int) (apply : String → List Int → Option Int) (x : String) :
    ∀ (ts : List Node), x ∈ varsList ts → env x = none → evalList env apply ts = none
  | [], hx, _ => by simp [varsList] at hx
  | a :: as, hx, hg => by
    simp only [varsList, List.mem_append] at hx
    cases hx with
    | inl h =>
      have ha := gap_blocks env apply x a h hg
      simp [evalList, ha]
    | inr h =>
      have has := gap_blocks_list env apply x as h hg
      simp only [evalList, has]
      split <;> simp_all
end

/-! ## 4. Identity ignores meta and pulses -/

/-- An address: data tokens (the tree plus its bindings) and an ordered list of ~meta entries. -/
structure Address where
  data : List Tok
  meta : List (String × String)

/-- Identity: the address with all meta removed. -/
def identity (a : Address) : List Tok := a.data

/-- Stamp a pulse: replace any existing ~pulse and put the new one first. -/
def withPulse (a : Address) (pulse : String) : Address :=
  { a with meta := ("pulse", pulse) :: a.meta.filter (fun m => m.1 != "pulse") }

/-- Add any meta entry (an annotation, an outcome, an observation). -/
def withMeta (a : Address) (k v : String) : Address :=
  { a with meta := a.meta ++ [(k, v)] }

theorem identity_withPulse (a : Address) (p : String) : identity (withPulse a p) = identity a := rfl
theorem identity_withMeta (a : Address) (k v : String) : identity (withMeta a k v) = identity a := rfl

/-- Two snapshots of one state, stamped at different pulses, have the same identity. -/
theorem same_state_same_identity (a : Address) (p q : String) :
    identity (withPulse a p) = identity (withPulse a q) := rfl

/-! ## 5. Spike state: three facets, lit or dark -/

structure Spike where
  meaning     : Option String
  structure_  : Option String
  environment : Option String

/-- Which facets are lit. -/
def Spike.lit (s : Spike) : Bool × Bool × Bool :=
  (s.meaning.isSome, s.structure_.isSome, s.environment.isSome)

/-- The 3-bit state, 0–7: meaning = 4, structure = 2, environment = 1. -/
def bitsOf : Bool × Bool × Bool → Nat
  | (m, s, e) => (if m then 4 else 0) + (if s then 2 else 0) + (if e then 1 else 0)

def Spike.bits (s : Spike) : Nat := bitsOf s.lit

theorem bitsOf_lt (b : Bool × Bool × Bool) : bitsOf b < 8 := by
  obtain ⟨m, s, e⟩ := b
  cases m <;> cases s <;> cases e <;> decide

theorem bitsOf_inj (b c : Bool × Bool × Bool) : bitsOf b = bitsOf c ↔ b = c := by
  obtain ⟨m, s, e⟩ := b
  obtain ⟨m', s', e'⟩ := c
  cases m <;> cases s <;> cases e <;> cases m' <;> cases s' <;> cases e' <;> decide

/-- Comparing two spikes' states is a single number comparison, and it is exact. -/
theorem bits_eq_iff (s t : Spike) : s.bits = t.bits ↔ s.lit = t.lit := bitsOf_inj _ _

/-! ## 6. A worked example: 2x + 3 = 9 -/

def eq2x3 : Node := .op "eq" [.op "add" [.op "mul" [.val 2, .var "x"], .val 3], .val 9]

example : parse (depth eq2x3) (ser eq2x3) = some (eq2x3, []) := roundtrip eq2x3
example : "x" ∈ vars eq2x3 := by decide

/-- Integer arithmetic for the example; comparisons return 1 (true) or 0 (false). -/
def arith : String → List Int → Option Int
  | "add", [a, b] => some (a + b)
  | "mul", [a, b] => some (a * b)
  | "eq",  [a, b] => some (if a = b then 1 else 0)
  | _, _ => none

example : eval (fun _ => none) arith eq2x3 = none :=
  gap_blocks _ _ "x" eq2x3 (by decide) rfl
example : eval (fun v => if v = "x" then some 3 else none) arith eq2x3 = some 1 := by decide

end Tcxp
