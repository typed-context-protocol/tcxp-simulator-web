/-
  Tcxp.lean — machine-checked core of the Typed Context Protocol (tcxp), v0.2.

  Checked with Lean 4.19.0, core library only (no Mathlib):
      lean Tcxp.lean

  This models the protocol at the level of tokens, not characters:
    * an expression tree of four node kinds (operator, value, variable, reference),
    * a serializer to a flat token list (prefix order, each operator carries its arity),
    * a parser back from tokens,
  and proves:
    1. parse_ser       — round-trip: parsing a serialized tree returns the same tree (lossless).
    2. gap_blocks      — any unbound variable (a gap) makes evaluation return nothing.
    3. context         — one ~context with five arrays in a fixed order: identity ignores it (identity_*),
                         its canonical stream round-trips (parse_serAddress), and a missing or out-of-order
                         key is rejected (missing_context_rejected, wrong_first_key_rejected).
    4. bits_eq_iff     — a spike's 3-bit state equals another's exactly when the same facets are lit.
    5. writes (v0.2)   — gap_blocks_write: a gap in a written value produces no table;
                         delete_after_insert, update_after_update: the inverse restores the table exactly;
                         insert_after_delete: the inverse restores the same rows (up to row order).

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

/-! ## 4. The context: one ~context, five arrays in a fixed order; identity ignores it

  A full address is its data (scheme, path, data keys and $variables, as tokens) followed by one ~context
  holding five arrays in this order: intent, observe, reason, decide, trace. An entry is a row (its fields are
  not defined by the protocol, so it is opaque text here) or a bare reference to another address (its tokens). -/

inductive Entry where
  | row (json : String)
  | ref (bare : List Tok)
  deriving Repr, DecidableEq

structure Context where
  intent  : List Entry
  observe : List Entry
  reason  : List Entry
  decide  : List Entry
  trace   : List Entry
  deriving Repr, DecidableEq

def Context.empty : Context := ⟨[], [], [], [], []⟩

structure Address where
  data    : List Tok
  context : Context
  deriving Repr, DecidableEq

/-- Identity: the address with ~context removed. -/
def identity (a : Address) : List Tok := a.data

def withContext (a : Address) (c : Context) : Address := { a with context := c }

/-- Stamp a pulse: the new pulse row goes first in trace and replaces earlier pulse rows (whatever `isPulse`
    recognises); every other trace entry is kept. -/
def withPulse (isPulse : Entry → Bool) (a : Address) (p : Entry) : Address :=
  withContext a { a.context with trace := p :: a.context.trace.filter (fun e => !isPulse e) }

/-- Nothing in the context changes identity: any context, any pulse. -/
theorem identity_withContext (a : Address) (c : Context) : identity (withContext a c) = identity a := rfl
theorem identity_withPulse (f : Entry → Bool) (a : Address) (p : Entry) : identity (withPulse f a p) = identity a := rfl

/-- Two snapshots of one state, with any two contexts, have the same identity. -/
theorem same_state_same_identity (a : Address) (c d : Context) :
    identity (withContext a c) = identity (withContext a d) := rfl

/-- Canonical token stream of a full address: the data, then each of the five keys in order, each followed by its
    entries. A key is its position: 0 intent, 1 observe, 2 reason, 3 decide, 4 trace. -/
inductive ATok where
  | data  (t : Tok)
  | key   (k : Nat)
  | entry (e : Entry)
  deriving Repr, DecidableEq

def serEntries (k : Nat) (es : List Entry) : List ATok := ATok.key k :: es.map ATok.entry

def serAddress (a : Address) : List ATok :=
  a.data.map ATok.data ++ (serEntries 0 a.context.intent ++ (serEntries 1 a.context.observe ++
    (serEntries 2 a.context.reason ++ (serEntries 3 a.context.decide ++ serEntries 4 a.context.trace))))

def takeData : List ATok → List Tok × List ATok
  | ATok.data t :: rest => ((takeData rest).1.cons t, (takeData rest).2)
  | rest => ([], rest)

def takeEntries : List ATok → List Entry × List ATok
  | ATok.entry e :: rest => ((takeEntries rest).1.cons e, (takeEntries rest).2)
  | rest => ([], rest)

/-- Expect key `k` next; anything else (a missing, extra or out-of-order key) is a rejection. -/
def expectKey (k : Nat) : List ATok → Option (List Entry × List ATok)
  | ATok.key j :: rest => if j = k then some (takeEntries rest) else none
  | _ => none

def parseAddress (ts : List ATok) : Option Address :=
  match expectKey 0 (takeData ts).2 with
  | none => none
  | some (i, r1) => match expectKey 1 r1 with
    | none => none
    | some (o, r2) => match expectKey 2 r2 with
      | none => none
      | some (re, r3) => match expectKey 3 r3 with
        | none => none
        | some (de, r4) => match expectKey 4 r4 with
          | none => none
          | some (tr, r5) => if r5 = [] then some ⟨(takeData ts).1, ⟨i, o, re, de, tr⟩⟩ else none

/-- A stream that starts with a key (or is empty) has no data or entries in front. -/
def startsAtKey : List ATok → Prop
  | [] => True
  | ATok.key _ :: _ => True
  | _ => False

theorem takeData_map (d : List Tok) (rest : List ATok) (h : startsAtKey rest) :
    takeData (d.map ATok.data ++ rest) = (d, rest) := by
  induction d with
  | nil =>
    match rest, h with
    | [], _ => rfl
    | ATok.key _ :: _, _ => rfl
  | cons t ts ih => simp [takeData, ih]

theorem takeEntries_map (es : List Entry) (rest : List ATok) (h : startsAtKey rest) :
    takeEntries (es.map ATok.entry ++ rest) = (es, rest) := by
  induction es with
  | nil =>
    match rest, h with
    | [], _ => rfl
    | ATok.key _ :: _, _ => rfl
  | cons e es ih => simp [takeEntries, ih]

theorem expectKey_ser (k : Nat) (es : List Entry) (rest : List ATok) (h : startsAtKey rest) :
    expectKey k (serEntries k es ++ rest) = some (es, rest) := by
  simp [serEntries, expectKey, takeEntries_map es rest h]

/-- Round trip: parsing the canonical stream of a full address gives back exactly that address. -/
theorem parse_serAddress (a : Address) : parseAddress (serAddress a) = some a := by
  obtain ⟨d, ⟨i, o, re, de, tr⟩⟩ := a
  have h4 : expectKey 4 (serEntries 4 tr) = some (tr, []) := by
    have := expectKey_ser 4 tr [] trivial; simpa using this
  have hd : takeData (serAddress ⟨d, ⟨i, o, re, de, tr⟩⟩) =
      (d, serEntries 0 i ++ (serEntries 1 o ++ (serEntries 2 re ++ (serEntries 3 de ++ serEntries 4 tr)))) :=
    takeData_map d _ trivial
  simp only [parseAddress, hd]
  rw [expectKey_ser 0 i (serEntries 1 o ++ (serEntries 2 re ++ (serEntries 3 de ++ serEntries 4 tr))) trivial]
  dsimp only
  rw [expectKey_ser 1 o (serEntries 2 re ++ (serEntries 3 de ++ serEntries 4 tr)) trivial]
  dsimp only
  rw [expectKey_ser 2 re (serEntries 3 de ++ serEntries 4 tr) trivial]
  dsimp only
  rw [expectKey_ser 3 de (serEntries 4 tr) trivial]
  dsimp only
  rw [h4]
  rfl

/-- The keys are fixed: a stream whose context starts with any key other than intent is rejected. -/
theorem wrong_first_key_rejected (d : List Tok) (k : Nat) (rest : List ATok) (hk : k ≠ 0) :
    parseAddress (d.map ATok.data ++ (ATok.key k :: rest)) = none := by
  simp [parseAddress, takeData_map d (ATok.key k :: rest) trivial, expectKey, hk]

/-- A full address must have a context: data alone is rejected. -/
theorem missing_context_rejected (d : List Tok) : parseAddress (d.map ATok.data) = none := by
  have := takeData_map d [] trivial
  simp at this
  simp [parseAddress, this, expectKey]

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

/-! ## 7. Writes: gaps block writes, and every write has an exact inverse

  A table is a list of rows, each with a key (the primary key) and a value. A write appends,
  removes or changes rows by key, as sql/insert, sql/delete and sql/update do in tcxp.js.
  The engine's inverse of a write is another write; these theorems say applying it restores
  the table: exactly for insert and update, and up to row order (a permutation) for delete,
  since a table in SQL has no row order. -/

structure Row where
  key : Nat
  val : Int
  deriving Repr, DecidableEq

abbrev Table := List Row

def keys (t : Table) : List Nat := t.map Row.key

/-- sql/insert appends the new row. -/
def insertRow (r : Row) (t : Table) : Table := t ++ [r]

/-- sql/delete where=eq(key, k). -/
def deleteKey (k : Nat) (t : Table) : Table := t.filter (fun r => r.key != k)

/-- sql/update set=assign(val, v) where=eq(key, k). -/
def updateKey (k : Nat) (v : Int) (t : Table) : Table :=
  t.map (fun r => if r.key = k then { r with val := v } else r)

/-- Insert, then its inverse (delete by the new key), gives back the table exactly,
    provided the key was not already taken (the primary key constraint). -/
theorem delete_after_insert (r : Row) (t : Table) (h : r.key ∉ keys t) :
    deleteKey r.key (insertRow r t) = t := by
  unfold deleteKey insertRow
  rw [List.filter_append]
  have hs : t.filter (fun x => x.key != r.key) = t := by
    apply List.filter_eq_self.mpr
    intro x hx
    have hne : x.key ≠ r.key := by
      intro he; apply h; unfold keys; rw [← he]; exact List.mem_map_of_mem hx
    simp [hne]
  simp [hs]

/-- Update, then its inverse (update back to the old value by key), gives back the table
    exactly, provided every row with that key held the old value (true when the key is unique). -/
theorem update_after_update (k : Nat) (old new : Int) (t : Table)
    (h : ∀ r ∈ t, r.key = k → r.val = old) :
    updateKey k old (updateKey k new t) = t := by
  unfold updateKey
  rw [List.map_map]
  conv => rhs; rw [← List.map_id t]
  apply List.map_congr_left
  intro r hr
  by_cases hk : r.key = k
  · have hv := h r hr hk
    cases r
    simp_all
  · simp [hk]

/-- Delete, then its inverse (insert the removed row back), gives back the same rows,
    possibly in a different order, provided exactly one row had that key. -/
theorem insert_after_delete (k : Nat) (r : Row) (t : Table)
    (h : t.filter (fun x => x.key == k) = [r]) :
    (insertRow r (deleteKey k t)).Perm t := by
  unfold insertRow deleteKey
  have hp := List.filter_append_perm (fun x : Row => x.key != k) t
  have hn : t.filter (fun x => !(x.key != k)) = [r] := by
    rw [← h]; congr 1; funext x; simp only [bne, Bool.not_not]
  rw [hn] at hp
  exact hp

/-- An insert whose value is an expression: it produces a new table only if the expression evaluates. -/
def insertExpr (env : String → Option Int) (apply : String → List Int → Option Int)
    (k : Nat) (e : Node) (t : Table) : Option Table :=
  (eval env apply e).map (fun v => insertRow ⟨k, v⟩ t)

/-- Gaps block writes: if the inserted value mentions a variable with no binding, the write
    produces no table at all, for any interpretation of the operators. -/
theorem gap_blocks_write (env : String → Option Int) (apply : String → List Int → Option Int)
    (x : String) (k : Nat) (e : Node) (t : Table) (hx : x ∈ vars e) (hg : env x = none) :
    insertExpr env apply k e t = none := by
  unfold insertExpr
  rw [gap_blocks env apply x e hx hg]
  rfl

example : deleteKey 3 (insertRow ⟨3, 7⟩ [⟨1, 5⟩, ⟨2, 6⟩]) = [⟨1, 5⟩, ⟨2, 6⟩] := by decide

end Tcxp
