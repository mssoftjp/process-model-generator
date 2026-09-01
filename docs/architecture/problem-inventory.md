# Process Diagram Compiler Problem Inventory

Status: design rationale. This document explains the `C-*` problem identifiers used by older implementation notes. Normative behavior belongs in [the style specification](style-spec.md), source code, and tests.

The compiler turns a compact text representation, often drafted with AI assistance, into BPMN-style diagrams with lanes, orthogonal routing, and connections attached to actual shape boundaries. Three facts drive the design:

1. The rendered diagram requires choices that the input language may omit.
2. Some of those choices change business meaning and are not geometry.
3. Placement, measurement, and routing are mutually dependent unless capacity is reserved before coordinates are assigned.

## Product contract

### C-00 — Completion is not one predicate

A diagram can satisfy mechanical legality—orthogonal segments, boundary endpoints, lane containment, and valid pool crossings—while still looking awkward. The product therefore separates legality, deterministic style rules, and human visual review. “Readable” is not a sufficient machine-checkable SLA.

### C-01 — IR or diagram interchange as source of truth

The textual intermediate representation is authoritative. SVG and BPMN DI-style coordinates are generated artifacts. Stable IDs preserve continuity; maintaining a second coordinate truth would create an ongoing merge problem.

### C-02 — Drawing versus executable BPMN

The product generates explanatory diagrams. It does not claim executable BPMN conformance or deployment semantics. This boundary permits visual normalization while requiring any lossy semantic choice to remain visible.

### C-03 — Diagram scope

Processes, collaborations, and choreographies are different diagram families. The engine supports a documented Process/Collaboration subset. New BPMN elements are added only when their routing, ports, validation, and degradation behavior are specified.

### C-04 — Dedicated DSL

The DSL is intentionally small and text-friendly, but it is not Mermaid syntax. Mermaid does not carry the edge kinds, pools, ports, or deterministic geometry contract required here.

## Language and semantic decisions

### C-10 — Omitted text still requires visible choices

Even a simple handoff leaves port sides, lane order, column assignment, edge kind, label placement, and box dimensions unspecified. Those choices must be owned explicitly instead of leaking into incidental algorithm order.

### C-11 — IR granularity

The IR carries pools, lanes, stable node IDs and kinds, sequence/message/association edge kinds, conditions and defaults, and optional rhetorical hints. It does not carry ordinary geometry.

### C-12 — Stable identity

IDs must survive label, type, and lane edits. Renumbering nodes on every generation would make review, incremental behavior, and provenance impossible.

### C-13 — Branch semantics

Multiple outgoing edges do not reveal whether a branch is exclusive, inclusive, or parallel. The author or AI front end must make that semantic choice visible; layout must not guess it silently.

### C-14 — Hint boundary

Hints may express rhetoric such as the main path or a return edge. Pixel coordinates and ordinary port geometry remain engine-owned.

### C-15 — Incomplete input

Interactive and AI-authored text is often temporarily invalid. Lax mode produces deterministic diagnostics and a best-effort preview; strict mode rejects delivery-breaking errors.

### C-20 — Organizational slicing

Choosing lanes by department, role, system, or company is a modeling decision rather than a layout problem. The engine renders the chosen responsibility model; it does not decide the organization.

### C-21 — Graph normalization

Meaning-preserving rewrites such as explicit joins and missing boundary events may be deterministic and reported. Meaning-changing rewrites, such as turning a sequence flow into a message flow, require explicit evidence.

### C-22 — Main-path election

The BPMN metamodel does not define a “happy path.” Explicit `=>` hints take precedence; otherwise the engine uses documented deterministic rules per pool.

### C-23 — Placement communicates rhetoric

Lane order, exception direction, collapsed scope, and black-box participants affect how a reader interprets emphasis. These choices belong to a versioned style grammar, not an opaque optimization score.

### C-24 — AI boundary

AI proposes semantic IR and preserves uncertainty. The deterministic engine owns geometry. Asking an LLM to emit global coordinates would sacrifice reproducibility and testability.

### C-25 — Return edges

A return edge is an edge that participates in a cycle, selected deterministically as a DFS back edge unless `->>` explicitly identifies it. Declaration order alone cannot identify time direction because declarations are grouped by lane.

### C-26 — Repeated glyphs and link events

Showing one logical node more than once can shorten long returns but breaks the one-node/one-glyph invariant. This remains an explicit future feature rather than an automatic rewrite.

## Placement and routing

### C-30 — Time and responsibility are orthogonal axes

Columns represent causality; lane bands represent responsibility. A generic graph layout may reorder the secondary axis to reduce crossings, but a process diagram cannot reorder organizational ownership freely.

### C-31 — Placement, measurement, and routing form a cycle

Label wrapping determines node size, node size determines gaps, and route congestion determines how large those gaps must be. The compiler breaks the cycle by planning corridor demand before calculating coordinates.

### C-32 — A constraint solver does not remove the cycle

Constraints still need routing-space constants, and those constants are unknown until route demand is planned. The current staged compiler avoids this circular dependency directly.

### C-33 — Lane order versus layering

Rows and columns are solved as two dimensions of one table. Treating either as a later constraint causes unnecessary cross-lane edges or distorted causal order.

### C-34 — Phase bands

Phase bands are column groups rather than BPMN lanes. They can be modeled as column-range constraints, but they must not imply equal duration or simultaneity.

### C-40 — Routing uses typed corridors

Same-lane sequences, lane handoffs, and inter-pool messages use different corridors. A generic shortest orthogonal path does not know those permissions.

### C-41 — Long-edge dummy ownership

Assigning generic dummy nodes to a lane creates an artificial ownership problem. The compiler represents long edges as reservations in gutters and channels instead.

### C-42 — Shared trunks and nudging

Trunks may be shared only for a common source or convergence. Blind nudging separates lines from their ports; explicit gateways and reserved tracks provide a stable alternative.

### C-43 — Crossing disambiguation

Track nesting removes avoidable crossings. Remaining orthogonal crossings use deterministic hops in rendering while stored waypoints remain orthogonal.

## Ports, shapes, and labels

### C-50 — Boundary clipping is insufficient

Connecting centers and clipping afterward can produce non-perpendicular arrivals, overlapping endpoints, and incorrect circle or diamond geometry. Port selection is part of route planning.

### C-51 — Ports have roles

Tasks normally enter west and exit east; gateway branches use distinct vertices; boundary events occupy their parent's perimeter; a black-box pool uses its border as a port. Evenly distributing all edges would erase this visual grammar.

### C-52 — Text changes geometry

CJK and long labels make box size part of layout. Engine-owned measurement, wrapping, and grid quantization prevent browser or host-font differences from moving ports.

### C-53 — Boundary events

Boundary events compete for perimeter space with activity edges and must move with the measured activity shape. They require explicit perimeter reservations.

### C-54 — Grid quantization

All dimensions are grid multiples from the start. Post-layout snapping would break orthogonality or boundary attachment.

### C-60 — Edge kind changes legal routing

Sequence flows remain inside a pool, message flows cross pools, and associations consume space without controlling execution. Routing permissions follow these semantics.

### C-61 — Nested layout

Expanded subprocesses require bottom-up measurement and a separate internal coordinate system. They remain outside the current supported layout subset.

### C-62 — Label placement is its own constraint

External node labels and condition labels compete with nodes, ports, and edges. Their space is reserved during measurement rather than repaired after routing.

### C-63 to C-69 — Later modeling additions

- **C-63** Data objects and data associations.
- **C-64** Documents represent state and do not advance time columns.
- **C-65** External labels must leave port paths clear.
- **C-66** Repeating a widely read document remains unsupported.
- **C-67** A document without a writer sits immediately before its first reader.
- **C-68** A normally dedicated port may be opened when static analysis proves it unused.
- **C-69** Intermediate events and event-based gateways require their own markers and legality rules.

### C-70 to C-72 — Visual identity and continuity

- **C-70** BPMN subtype markers must remain visible and contribute to measured dimensions.
- **C-71** Density must be evaluated separately from element coverage.
- **C-72** Synthetic joins are shown explicitly so converging lines do not look like mid-edge attachments.

## Validation

### C-80 — Legality oracles

Regression checks cover orthogonality, real shape boundaries, node avoidance, lane containment, pool rules, port separation, and permitted overlap. These are necessary but not sufficient for a good-looking diagram.

### C-81 — Readability is not pixel identity

Snapshots detect unintended change. Human review and weak proxies—main-path continuity, bends, crossings, route length, and display fit—evaluate appearance.

### C-82 — Determinism

The same IR and version must produce the same diagram. Geometry contains no LLM call or unseeded randomness.

### C-83 — Text-engine differences

The engine owns glyph advances and line wrapping, emits explicit SVG text lines, and draws arrowheads as paths so browser behavior does not alter route geometry.

## Architectural decisions

The current architecture resolves the inventory as follows:

1. The textual IR is authoritative; SVG is generated.
2. The product is a deterministic drawing and review tool, not an execution engine.
3. AI proposes semantics; the engine owns geometry.
4. Layout is table compilation plus typed corridor reservation, not free graph optimization.
5. Legality, style conformance, quantitative proxies, and visual review remain separate gates.
