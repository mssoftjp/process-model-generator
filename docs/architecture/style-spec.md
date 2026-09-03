# Style Specification v1.3 — Process Diagram Grammar

This document defines testable rules for readable process diagrams instead of making an ambiguous promise that diagrams will merely “look readable.” Each rule is expressed as a predicate over discrete diagram features. Changes to these rules require a version increment and review as a snapshot difference.

The specification and engine implementation must remain aligned. If either contradicts the other, fix one and increment the specification version.

## S-1x Table grammar (P2)

- **S-10** Lanes are horizontal bands rendered in declaration order. Every node is contained by the band of its owning lane (Oracle O-4).
- **S-11** Columns form the time and causality axis. They are determined by longest-path layering of the DAG after return edges are removed. Distance and label width do not affect column assignment.
- **S-12** The elected main path in each pool occupies the **spine row (row 0)** of each lane. Main-path transitions across lanes form a staircase. Do not serialize a collaboration diagram into one global main path.
- **S-13** Non-main-path nodes are packed below the spine in ascending row order by chain: a sequence of single-in/single-out nodes in one lane. Each chain reserves its column interval, so a straight edge in the same row cannot pass through another node. A document-like node with no writer is placed immediately before its first reader. A document connected only to one writer and one reader is also moved immediately before the reader when the reader occurs sufficiently later. Do not move documents with multiple relationships, cycles, or process edges. Document placement must not push task columns or share the reader's column.
- **S-14** Empty lanes are still rendered as bands; organizational absence is information.
- **S-15** A pool (C-03) is a heavy bordered band containing its lanes. The pool heading appears to the left of lane headings. Reserve a communication corridor between adjacent pools; never push the horizontal trunk of a message flow into a participant. Include the required corridor-track height before coordinates are assigned. Omit a lane label when a pool contains one lane with the same name. All pools share column dimensions, but process order is determined independently for each pool's sequence flows. Message flows bridge participants and do not advance a pool's time column.
- **S-16** A black-box pool (C-51) is a slim closed band without lanes and with a centered horizontal label. The border itself is the port: messages land perpendicular to the band edge, directly when aligned and through a gutter otherwise. Oracle O-2 evaluates the band edge.

## S-2x Normalization grammar (P0)

- **S-20** Tasks and events are rendered as single-input/single-output nodes. Multiple incoming edges are promoted to an XOR join to preserve meaning. Multiple outgoing edges require an explicit gateway in strict mode or a provisional XOR with a provenance mark in lax mode.
- **S-21** Add start or end events only when none of that kind exists.
- **S-22** A return edge is an edge that creates a cycle, identified as a DFS back edge. An explicit `->>` fixes that edge as the return; remaining cycles use the same DFS rule. Direction and connectivity do not change. Merges are drawn forward.
- **S-23** Every normalization rewrite is reported with an `N-` diagnostic.
- **S-24** A meaning-preserving synthetic junction (`x_j`) is rendered as an explicit join (C-72). Removing it and attaching multiple incoming edges to one shared line creates a misleading T-junction that appears to join another path midway. A gateway with both multiple inputs and outputs is split into a join and a split (N-211). The merge side of an event-based gateway normally becomes an XOR merge. Every incoming and outgoing edge uses a distinct port.

## S-3x Corridor grammar (P3; implementation of the C-40 three-layer model)

Wires avoid node cells and use only these corridors:

| Corridor | Position | Permitted use |
|---|---|---|
| Baseline | Centerline of each row | Straight edges and final row-approach segments, subject to occupied-cell checks |
| Row channel | Above each row and, only when required, below the final row | Return perimeters, cross-row merges, and detoured branches |
| Column gutter | Between adjacent columns | Vertical travel, split into an outgoing block on the left and an incoming block on the right |
| Own column | Directly below a gateway | Vertical descent for a downward branch, only when the column is clear |
| Inter-pool corridor | Gap between adjacent pools | Horizontal message-flow trunks |

- **S-30** Count corridor congestion as track demand before assigning coordinates and include it in dimensions. A later phase must not invalidate an earlier phase.
- **S-31** Split each column gutter into outgoing and incoming tracks. An outgoing stub crosses only tracks to its left; an incoming approach crosses only tracks to its right. This structurally prevents overlapping parallel baseline segments, equivalent to VLSI channel routing.
- **S-32** Edges with the same source may share a trunk segment. Edges with the same target may converge on one incoming port. Any other parallel overlap violates Oracle O-6.
- **S-33** Route a return edge around the perimeter on the side opposite its target, not through the loop interior. A same-row loop prefers the lower side. A cross-row or cross-lane loop considers the source-side perimeter and enters or exits directly through an available north or south port. Fall back to the legacy channel above the target when a perimeter candidate is illegal or worsens the whole-diagram score. In the baseline route, a same-row reverse channel exits vertically north when S-56 leaves the top port available directly above the source. Cross-row returns keep the right gutter.
- **S-34** Order channel and gutter tracks by nesting. Runs that contain fewer other run entrances sit closer to the port. For merges sharing the right endpoint this corresponds to descending entrance x; for returns sharing the left endpoint it corresponds to ascending entrance x. Within each gutter side, shorter intervals sit closer to the port. Incoming verticals and outgoing stubs must not cross other runs.
- **S-35** Render remaining orthogonal crossings with semicircular hops. The main path never hops. Bundle drawing segments by intersection; if one bundle contains the main path, the other bundle hops, otherwise the horizontal bundle hops. Contacts within 12 px of a port are connections, while bent elbows remain crossings. Each intersection has one hopper. Hops are rendering syntax only; waypoints, equivalent to BPMN DI, remain orthogonal. Report hop count as a readability proxy (N-430).
- **S-36** Every horizontal run on a row baseline is registered in a per-row reservation registry (`rowRuns`, the horizontal counterpart of S-58) as a column-scale interval, and a pattern may claim a baseline interval only when the reservation succeeds. Sharing follows S-32: one source may share a trunk, one target may share a convergence, any other overlap is refused and the edge falls back to the next pattern. Before v1.3 baseline runs protected each other only through occupied-node checks at both ends, which forbade any run ending at a column center; the registry replaces that invariant so that S-44 may end a baseline run at the target column. A long stub terminating at a gutter is still not introduced. A non-sequence horizontal segment entering a gutter uses the S-57 offset band instead, regardless of whether a sequence-flow exit exists.
- **S-37** Nest inter-pool tracks by endpoint containment. A line whose upper endpoint is contained by another interval sits above that line; a line whose lower endpoint is contained sits below. Do not reuse track numbers for intervals with an ordering relationship; reuse them only for independent intervals.
- **S-38** Build baseline and improved candidates for the whole diagram and choose by lexicographic score: oracle violations, shared exits from two-way gateways, crossing hops, bend count, total Manhattan length, then area (N-431). Do not greedily shorten individual edges.

## S-4x Route patterns (P3; deterministic and distance-independent)

Apply in this order: direct, row-column, drop, row approach, channel approach. The final pattern is always the legal fallback. The two one-bend shapes are mirror images: `drop` travels the column first, `row-column` travels the row first.

- **S-40 direct**: When source and target share a row with no intervening node, travel straight on the baseline.
- **S-41 drop**: For a downward gateway branch with a clear own column and target row, descend vertically, turn on the target row, and enter from the left.
- **S-42 row approach**: Move vertically through the gutter immediately right of the source, join the target-row baseline, and enter from the left. The departure-column cell must also be clear.
- **S-43 channel approach**: Use the channel above the target row. For a task, descend through the gutter immediately left of the target column, join the baseline, and enter from the left. For a gateway, descend to its north vertex.
- **S-44 row-column**: For a non-gateway source whose target is a gateway, event, or (for data associations) task in a later column and a different row, leave east, travel the source-row baseline to the target column, then travel the target column center and enter the target's south vertex from below or north vertex from above. Conditions are static: the source-row cells up to and including the target column are clear, the target column is clear between the two rows, the S-36 and S-58 reservations succeed, and the entered vertex is not used as an exit (the same predicates as S-56). Several edges converging on one target share the vertical (S-32, S-91), which draws a join bus. Gateway sources keep the S-50 vertex grammar and do not use this pattern. This is the natural shape of a cross-lane join entry and of a document feeding a task; it replaces the hook that S-43 produced by climbing to the channel above the target and coming back down.

## S-5x Port grammar (C-51)

- **S-50** Exits use the east side. At a two-way gateway, the main path exits east, the upper alternative exits north, and the lower alternative exits south. Preserve the distinct vertex when a direct drop is blocked; do not move it back to east.
- **S-51** Entries normally use the west side. Cross-row gateway entries and return edges normally use north. South entry is allowed when static analysis proves the port is unused, removing an unnecessary hook around the top.
- **S-52** Diamonds use only their east, west, north, and south vertices as normal ports. Circles and rectangles use edge midpoints. When S-57 offsets send and receive positions, clip endpoints back to the actual shape boundary.
- **S-53** The final segment meets the boundary perpendicularly (Oracle O-2), and its endpoint lies on that boundary.
- **S-54** Dedicated entry and exit ports structurally prevent incoming and outgoing edges from colliding at one point.
- **S-55** Data associations (C-63) enter non-document nodes through a vertex because the west port belongs to incoming sequence flows. A same-row straight data association uses a connection point 10 px above the baseline and never shares the sequence-flow boundary point. It exits east, or south for a target directly below. Prefer a straight bottom-to-top drop in document-flow patterns. A document is entered from the west because documents have no sequence flows.
- **S-56** A normally dedicated entry or exit side may be opened when static analysis proves it is unused (C-68). A vertex entry arriving from below enters the south vertex directly when the target has no downward non-return exit, a channel exists immediately below the target row, the cell below the target is clear, and the bottom port is not reserved for a mixed-flow communication exit.
- **S-57** Message flows (C-60) use distinct exits for distinct flow kinds. Between adjacent pools, the first candidate is the Z shape: leave through the vertex facing the other participant (south when the receiver is below, north when above), travel the sender's column center to the inter-pool corridor, cross the corridor horizontally, and travel the receiver's column center into its facing vertex; when both endpoints share a column the message is a single vertical segment. Column centers are reserved under S-58, extended half a position across the corridor so that a sender and a receiver arriving at the same column from opposite sides cannot overlap inside the corridor band. The Z is used only when the facing vertices are statically free (an event label moved by S-62 frees its south side; a gateway with other messages, a gateway with a downward branch, and a node whose column is blocked fall through). Otherwise they enter and leave through dedicated points on the gutter-facing vertical edges and travel gutter → inter-pool corridor → gutter. Do not create a meaningless small bend immediately outside a node or place a long horizontal component inside a participant. Offset a sender by ±8 px toward the communication direction and a receiver by ±12 or ±14 px in the opposite direction appropriate to its attachment side, so request and reply ports remain distinct. Treat these offsets as desired centerline positions and clip the final endpoint to the actual circle or diamond boundary. Move an event label above the event when a message connects to its lower half. Other messages use the standard target-row channel rule. Right-exit fallbacks for non-sequence flows use `cy + 10` (`+8` for messages) regardless of sequence exits, and never place a gutter-ending horizontal segment on the baseline (S-36). Reserve `cy - 10` for a same-row straight association under S-55.
- **S-58** Reserve vertical runs through column centers, including drops, straight descents, and vertical message exits, with `reserveColRun`. A shared source may share a trunk and a shared target may share a convergence; other overlaps are forbidden. Because the mutual protection from S-36 does not cover verticals ending in a channel, the cell immediately beyond the terminal channel must also be clear.
- **S-59** A message between non-adjacent pools exits through the nearest inter-pool corridor at each end and uses the outer-right corridor to pass intermediate pools. It must not cross the interior of an unrelated participant (O-10).

## S-6x Shapes and measurement (P1 / R5)

- **S-60** Every dimension is an integer multiple of the 8 px grid. Snapping is an identity, not a post-processing step.
- **S-61** A task is a rounded rectangle containing its label. A short task has a minimum width of 80 px. Text wraps under Japanese line-breaking rules within 96 px, producing an outer width of roughly 128 px including padding; height follows the wrapped text.
- **S-62** External labels contribute to row height and column width rather than overlapping content (C-62). Their positions leave used port paths clear (C-65): gateway names sit upper-left because upper-right belongs to branch-condition labels, document labels sit lower-right, and event labels normally sit below. Move an event label above when inter-pool communication attaches to its lower half. External labels have a white halo.
- **S-63** Place a condition label near its exit. A vertical exit places the label beside the line on the right. A horizontal exit places it above and near the start of the first horizontal segment. A non-main gateway condition belongs near the source end of its first unique segment, not on a shared exit stub, so it remains separate from the main-path condition. Stack multiple labels sharing one exit vertically in declaration order. Place a return-edge label on its reverse-running segment. A label must be at least 8 px closer to its own edge than to the nearest other edge.
- **S-64** Include condition-label width in the width of the exit gutter.
- **S-65** Measure glyph advances with the table bundled into the engine. SVG uses one `tspan` per line and `textLength` to enforce width. Draw arrowheads as paths without marker-induced line shortening.
- **S-66** Emit SVG in editable groups for PowerPoint-style post-editing. Each visually coherent unit is one `<g>`: a node with all rings, markers, and its name; an edge with line, arrowhead, and condition label; a lane with band, heading, and label; and a pool with border, heading, and nested lanes. Render fixed layers in this order: `layer-band`, `layer-edges`, `layer-nodes`. Grouping must preserve drawing order and therefore appearance. Normalize geometry IDs to NCName-compatible `node-*`, `edge-*`, `lane-*`, and `pool-*` IDs, disambiguating collisions with numeric suffixes.
- **S-67** Include the length of a vertical lane heading when calculating the lane's minimum height.

## S-7x Emphasis and notation

- **S-70** Render main-path edges and nodes with heavier strokes: 2 px and 1.6 px, versus 1.3 px and 1.25 px elsewhere.
- **S-71** Render provisional provenance marks in amber with dashed strokes; return to normal rendering when confirmed.
- **S-72** Use a thin ring for a start event and a heavy ring for an end event, following BPMN convention.
- **S-73** Render a data association as a `2 4` dotted line with an open arrowhead and a document as a folded-corner shape. A document represents state and does not advance the time axis, so layering constrains only its column (C-64). The column-constraint graph uses the same single predicate as main-path election and chain placement.
- **S-74** Activity markers (C-70) sit in the upper-left corner: user is a person, service a gear, rule a table, script ruled lines, send a filled envelope, and receive an outline envelope. A call activity has a heavy border and `[+]`; a subprocess has `[+]`. Event markers include an envelope for messages, filled at an end event to indicate throw, and a clock for timers. An event gateway uses a double ring and pentagon; an inclusive gateway uses a heavy circle. Marker padding contributes to dimensions rather than overlapping content.
- **S-75** Density (C-71): task text wraps at 96 px; outer task width is approximately 80–128 px after grid-quantized padding; base gutter width is 28 px; column padding is 20 px.
- **S-76** Render message flows with a `7 4` long dash, a small circle at the source, and an open arrowhead, following BPMN convention.
- **S-77** An intermediate event (C-69) uses a double ring. Message and timer markers follow S-74.
- **S-78** A data store is a cylinder and an annotation is an open bracket with unboxed text. Both follow document-like placement: they do not advance columns and connect through associations.

## S-8x Legality oracles (C-80; necessary but not sufficient)

- **O-1** Every segment is horizontal or vertical.
- **O-2** Endpoints lie on the actual boundary of each shape, not merely its bounding rectangle. The final segment approaches from outside the shape.
- **O-3** No edge crosses the interior of a node.
- **O-4** Every node is contained by its owning lane band.
- **O-5** Waypoints of an intra-lane edge remain inside that lane.
- **O-6** Parallel segments from distinct edges do not overlap except as allowed by S-32.
- **O-7** A sequence flow does not cross a pool boundary, and a message flow exists only between pools (C-60).
- **O-8** A task does not share one point between a sequence-flow exit and a message-flow exit.
- **O-9** The lower non-main branch of a gateway exits from its south vertex.
- **O-10** A message between adjacent pools has a horizontal run in the inter-pool corridor, or is a single vertical segment (the same-column Z of S-57, which has no trunk to misplace). A message between non-adjacent pools does not pass through an intermediate pool.
- **O-11** A message entry and message exit on the same node do not share one point.

An oracle violation is an engine defect. Regression fuzzing must remain silent for 500 fixed-seed cases and 1,000 cases during development.

## Degradation behavior

- **S-90** When a label exceeds its maximum width, wrap it under Japanese line-breaking rules. Permit overflow for an indivisible token that cannot wrap.
- **S-91** When multiple edges converge on the north vertex of a gateway, their final segments overlap and are read as convergence.
- **S-92** A shared trunk segment from one source appears as a single line and is read as a bus.
- **S-93** When a single-line label is explicitly truncated to a width, retain the longest prefix that fits together with one ellipsis character.
