# Design Rationale

Status: architectural rationale. This document explains why Process Model Generator uses a staged deterministic compiler. It summarizes the root causes behind the [`C-*` problem inventory](problem-inventory.md); normative rules live in [the style specification](style-spec.md).

## Summary

| Root cause | Problem | Architectural response |
|---|---|---|
| R1 | Good process-diagram grammar existed as tacit practice rather than testable rules | Maintain a versioned style specification and legality oracles |
| R2 | Free graph optimization was the wrong formulation for a lane-and-column diagram | Compile into a table and reserve typed routing corridors before coordinates |
| R3 | Missing semantic information cannot be recovered by geometry | Separate meaning, rhetoric, and geometry; keep uncertain choices visible in text |
| R4 | Stateless regeneration conflicts with review continuity | Require stable IDs, determinism, and structurally local change |
| R5 | Host-dependent font measurement destabilizes geometry | Own measurement and wrapping in the engine and quantize dimensions to a grid |

The common failure is not insufficient optimization power. It is uncontrolled freedom. The architecture removes or assigns each degree of freedom before detailed routing.

## R1 — Make visual grammar explicit

Mechanical legality does not guarantee professional readability. Practical diagrams follow recurring conventions: main paths are visually stable, exceptions are subordinate, lane handoffs use recognizable corridors, and ports communicate direction and role.

The compiler therefore uses three distinct quality layers:

1. **Legality invariants** are hard regression properties.
2. **Versioned style rules** define deterministic visual grammar.
3. **Readability evidence** combines quantitative proxies and human inspection without pretending to be a complete SLA.

Improvements are made by revising the grammar and reviewing corpus-wide differences, not by silently changing an opaque objective function.

## R2 — Compile a table instead of optimizing a free graph

A swimlane process diagram already has two constrained axes: responsibility and causal order. It is better represented as a lane/row/column table with reserved corridors than as arbitrary coordinates optimized for generic edge length.

The compiler runs in one direction:

```text
P0 normalize
  → P1 measure
  → P2 place in lane/row/column cells
  → P3 plan ports, corridors, and track demand
  → P4 assign coordinates from measured content and reserved capacity
  → P5 emit detailed orthogonal routes
  → P6 validate legality and presentation diagnostics
```

The governing rule is: **a later phase must not invalidate an earlier decision**. When it does, the earlier phase failed to reserve capacity.

Consequences:

- Routing congestion is counted before spacing is finalized.
- Long edges reserve channel and gutter tracks instead of acquiring lane-owned dummy nodes.
- Ports are discrete route decisions, not clipping performed after layout.
- Grid alignment follows from integer grid dimensions rather than post-processing.
- Baseline and alternative whole-diagram routes can be compared lexicographically without greedily damaging neighboring edges.

This construction gives up some hand-tuned local optimum in exchange for deterministic structure, understandable failures, and global consistency.

## R3 — Assign every choice to meaning, rhetoric, or geometry

Use this classification:

- A choice is **meaning** when changing it changes who does what, in what order, or under what condition.
- A choice is **rhetoric** when changing it alters emphasis but preserves the business claim.
- A choice is **geometry** when it changes neither meaning nor emphasis.

Ownership follows directly:

- Meaning belongs in the IR. AI may propose it, but unsupported choices remain marked as uncertain.
- Rhetoric uses documented defaults plus narrow optional hints such as `=>` and `->>`.
- Geometry belongs exclusively to the deterministic engine.

Meaning-preserving normalization is reported. Meaning-changing rewrites require evidence and cannot be introduced merely to simplify routing.

The AI boundary is therefore deliberate: natural language → proposed semantic IR. The AI does not generate waypoints or decide hidden business facts.

## R4 — Preserve continuity without a second source of truth

Users need stable diagrams for review, but storing hand-edited coordinates alongside the IR would create two authorities. Continuity instead comes from three properties:

1. **Stable IDs** survive label, type, and lane changes.
2. **Deterministic tie-breaking** uses declaration order and stable IDs rather than randomness.
3. **Local structure** means a new column mainly shifts later columns and a new row mainly shifts lower rows.

The IR remains authoritative and generated SVG remains reproducible. If explicit geometry overrides are ever required, they should be text patches keyed by stable IDs, with stale patches reported during compilation—not edits merged into generated SVG.

## R5 — Own text measurement

Node size affects every later phase, so measurement cannot be delegated to an arbitrary browser, font installation, or SVG viewer.

The engine:

- uses its own glyph-advance model;
- performs line breaking explicitly;
- emits one SVG `tspan` per line with controlled width;
- draws arrowheads as paths instead of accepting marker shortening;
- quantizes all dimensions to the shared grid; and
- reserves space for external labels instead of repairing overlaps afterward.

This turns environment-dependent continuous noise into a small set of deterministic dimensions.

## Combined architecture

```text
Natural language
  → AI proposal with explicit uncertainty
  → editable .flow text with stable IDs
  → semantic IR and rhetorical hints
  → deterministic compiler phases P0–P6
  → SVG plus diagnostics and review evidence
```

Dependency order among the root causes is:

```text
R3 semantic ownership
  → R1 explicit grammar
  → R5 deterministic measurement
  → R2 staged compilation
  → R4 continuity as a property
```

## Decisions and non-goals

- The IR is authoritative; generated coordinates are not.
- The engine produces explanatory diagrams, not executable BPMN deployments.
- Sequence, message, and association semantics constrain routing.
- Return edges are selected from actual cycles, not declaration order.
- Expanded subprocess layout, automatic repeated glyphs, pagination, and phase bands remain outside the current core unless their contracts become explicit.
- Human organizational modeling and unresolved business meaning remain outside the layout engine.

## Lessons from implementation

Property testing corrected several early assumptions:

- Declaration order cannot identify return edges because declarations are grouped by lane; DFS cycle structure is required.
- Sharing north ports for both return entry and exit creates overlaps; port roles must remain distinct unless static analysis proves otherwise.
- Every phase that depends on causal edges must use the same edge predicate. Divergent layering, cycle, and chain graphs create rightward “return” edges and cell conflicts.
- Extending a baseline stub into a gutter breaks the node-at-both-ends protection that makes baseline overlap checks safe.
- A local route improvement can introduce a global overlap; the existing legal route must remain a baseline candidate and alternatives must pass whole-diagram oracles.

These findings reinforce the architecture: deterministic construction plus legality oracles is easier to correct than ad hoc coordinate tuning.
