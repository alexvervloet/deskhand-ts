# Lessons

Things that did not go the way the plan said, written down while they were
still fresh. The plan for this port assumed it was mostly transliteration. Most
of it was. These are the parts that were not.

## 1. The interesting code was the code the previous port had deleted

The plan opened by counting how much of the runtime already existed in
TypeScript. An earlier port of this project onto a hosted durable-execution
platform had moved the loop, the consent gate, the bounds, the fence and the
tool registry across — roughly 2,200 lines, already tested. The estimate said
most of the work was done.

What that port had deliberately deleted was the lease, the transcript rebuild,
and the re-derive-the-next-action-from-rows structure of the loop, because the
platform paid for all three. Its own writeup says so and argues the point well.

A standalone service has no platform. So the first real work of this port was
writing back the exact machinery the previous port had been able to throw away
— and that machinery is the whole subject of the project. The head start was
real but it was a head start on the *least* interesting half.

**What to do differently:** when reusing a port, read what it deleted before
counting what it kept. The deletions are the shape of the assumption it made,
and if you do not share that assumption they are your work list.

## 2. The most dangerous line in the Python loop is one that is not there

The Python loop reads `conn.commit()` between iterations and says nothing else
about transactions. The easy misreading is "the loop commits each step".

It is doing more than that. `psycopg` opens a transaction implicitly on the
first statement after a commit, so each of those calls is also the *start* of
the next unit of work. `pg` has no implicit transaction: the same code
translated literally runs in autocommit, and the tool's effect and the ledger
row that remembers it stop being written together — which is the single fact
the entire exactly-once guarantee rests on.

The part worth recording is how quietly that would have failed. The crash tests
kill a worker *between* turns, so they would all still have passed. The
property would have been gone and the suite would have been green.

[src/db.ts](src/db.ts) therefore hands out an explicit client and the loop
writes its own `begin`/`commit` per iteration, so the boundary is in the source
rather than in a library's defaults.

**What to do differently:** when a port crosses database libraries, write down
where each transaction begins and ends in the *original* before writing any of
the new one. An implicit boundary does not survive translation and does not
announce that it has gone — and the tests most likely to notice are exactly the
ones that do not.

## 3. Freezing an object is not freezing a type

`ToolDef` is a frozen dataclass in Python, and the test asserting a tool's risk
class cannot be reassigned expects `FrozenInstanceError`. I ported the registry
with `Object.freeze`, which is the runtime half, and wrote the test with
`@ts-expect-error` over the assignment.

The typechecker then reported the `@ts-expect-error` as *unused* — because my
`ToolDef` interface had a mutable `risk`, so `refund.risk = RiskClass.READ` was
perfectly legal TypeScript that happened to throw at runtime.

That is a weaker guarantee than the Python one, in the one place the project
least wants a weaker guarantee. The registry now stores and returns
`Readonly<ToolDef>`, so reassigning a risk class fails to compile *and* throws.

**What to do differently:** `Object.freeze` and `readonly` are different
claims — one about the value, one about the code that can see it. A security
property wants both, and an unused `@ts-expect-error` is the typechecker
telling you that you only wrote one.

## 4. Literal control bytes in source are not reliably literal

The garbage fault payload and `sanitise` both need a real NUL byte, because the
property being tested is that Postgres `text` cannot store one. Written as
literal bytes in the source file they survived being written, but `grep` then
classified the files as binary and refused to search them, and every tool in
the chain after that treated them as opaque.

They are now `\u0000` escapes. Same bytes at runtime, greppable source, and no
chance of an editor or a diff viewer quietly eating them.

**What to do differently:** if a test's subject is a byte that breaks tools,
write it as an escape. The literal buys nothing and costs every tool that has
to read the file afterwards.

## 5. `sort_keys=True` is a one-word feature and a twenty-line one

`argsHash` is the binding that makes an approval mean "this refund, this
amount, this order". Python builds it with
`json.dumps(..., sort_keys=True, separators=(",", ":"))` — one keyword
argument.

`JSON.stringify` has no equivalent and preserves insertion order, so a literal
translation hashes two *equal* objects differently depending on how each was
constructed. The failure that produces is an approval intermittently not
matching the call it was granted for, which is the worst available behaviour
for this particular function. Getting the same property back means recursively
sorting keys at every depth first.

Since both sides then claim to produce "the canonical JSON of this call", I
compared them rather than assuming: same SHA-256, byte for byte, so an approval
recorded by either runtime binds the same arguments. Worth an actual comparison
rather than a comment, and it took one command.

One caveat that comparison surfaced: Python's `json.dumps` escapes non-ASCII by
default and `JSON.stringify` does not, so the two agree only for ASCII
arguments. Every argument in this system is ASCII today. It is written down
here because the day one is not, the disagreement will be silent.


## 6. Node's single thread does not weaken a concurrency test

The Python concurrency suite uses real threads, and the plan had a note asking
whether Node could test the same claims at all.

It can, and the reason is that none of these races are between threads. They
are between *database transactions*: two workers claiming one run, two callers
inserting one idempotency key, four callers flipping one item to `reverted`.
Concurrent promises on separate connections produce exactly that contention,
because the serialisation point is Postgres either way.

What does need care is that the racers hold separate *connections*. Run both
halves through the shared pool and it can hand them the same client, which
queues the second behind the first and produces a concurrency test that cannot
fail. Both race tests here open their own `pg.Client` for that reason, and the
barrier that releases them is there to make the overlap deliberate rather than
incidental.

**What to do differently:** ask what the race is actually between before
deciding a runtime cannot express it. Then check the test can still fail,
because the easiest way to make a concurrency test green is to accidentally
serialise it.

## 7. The frontend needed two words changed

The React UI copied across unmodified apart from two comments that named
FastAPI. Every response shape matched, because they were ported from the same
Pydantic models the UI was written against.

Worth recording as the counterexample to the rest of this file: when a boundary
is genuinely just JSON, crossing a language costs nothing. All the expensive
parts of this port were where a library had been doing something on the
original's behalf.
