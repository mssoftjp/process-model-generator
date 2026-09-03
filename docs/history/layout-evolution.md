# Layout Evolution, L1–L20

Status: historical design record. This condensed timeline preserves the evidence and rejected approaches that shaped the current engine. It is not a release changelog or a current behavior specification; use [the style specification](../architecture/style-spec.md) and tests for current contracts.

Each loop followed the same pattern: inspect real output, name the structural problem, test one rule across the corpus and fuzz cases, keep it only when legality remained intact, and record rejected alternatives.

## L1 — Disambiguate crossings (2026-08-28)

Orthogonal crossings were legal but visually ambiguous. Channel tracks were nested to remove avoidable crossings, and the renderer added deterministic semicircular hops for remaining crossings. Waypoints stayed orthogonal, so hops remained presentation only.

Outcome: introduced C-43 and the crossing-hop diagnostic.

## L2 — Model document input and output (2026-08-28)

Added document nodes and data associations. Testing established that a document is state rather than a time-advancing activity, so only its own column is constrained. The same causal-edge predicate must be used by cycle selection, layering, and chain placement.

External labels were also separated from port paths, and common writer/document/reader patterns received dedicated placement rules.

Outcome: C-63 through C-66; zero oracle violations in fuzz and corpus checks.

## L3 — Minimize hops structurally (2026-08-29)

An attempted “extend the outgoing stub to the gutter with the fewest crossings” rule failed immediately: baseline protection relies on both ends terminating at nodes. A long gutter-ending baseline stub violated O-6.

The accepted rule used only safe freedom:

- shorter gutter intervals sit closer to ports;
- channel runs are ordered by how many other entrances their interval contains; and
- hop count is reported as a readability proxy.

Corpus hops fell from 33 to 22 without weakening legality.

## L4 — Expand the example corpus (2026-08-29)

Added expense reimbursement, hiring, incident escalation, order-to-cash, and fan-out cases. The corpus exposed missing inline endpoint declarations and poor placement for reader-only documents.

Outcome: inline labeled entities became supported with provenance diagnostics, and a document without a writer moved immediately before its first reader without pushing task columns.

## L5 — Treat connection positions as controlled freedom (2026-08-29)

Dedicated port roles prevent collisions, but an otherwise unused port can be opened safely. A gateway may accept a south entry when static analysis proves there is no competing downward exit, a lower channel exists, and the cell below is clear.

Fuzzing supplied the final empty-cell condition. The accepted result removed unnecessary hooks from parallel joins.

## L6 — Inventory visual discomfort (2026-08-29)

Visual inspection identified several issues not captured by legality:

- gateway names competed with condition labels, so gateway names moved upper-left;
- external labels gained white halos;
- lane-heading length began contributing to minimum band height;
- overlapping arrowheads at convergence remained a known limitation;
- return lines kept BPMN sequence styling rather than receiving decorative exception styling; and
- synthetic joins remained full gateways to preserve explicit meaning.

## L7 — Establish a reproduction corpus (2026-08-29)

The first attempt relied on remembered public examples and incorrectly claimed complete reproduction. Comparing against actual BPMN XML exposed invented documents, label drift, lane-name drift, and missed task types.

The corpus was rebuilt from retrieved source BPMN files and mechanical conversion. Coverage, grammar conformance, and visual similarity became separate measurements. See [the reproduction corpus](../validation/reproduction-corpus.md).

## L8 — Separate coverage from appearance (2026-08-29)

Element coverage did not measure density, join noise, or subtype markers. The engine reduced task and gutter dimensions, added BPMN activity/event markers, and briefly hid synthetic joins.

The hidden-join experiment was later reverted in L14 because shared lines resembled misleading T-junctions.

## L9 — Add pools and message flows (2026-08-29)

Pools grouped lane bands; message flows received long-dash styling and semantic validation; intermediate events gained double rings and markers. Sequence flows remained inside pools and messages crossed pools.

The implementation reused existing corridor planning rather than creating a separate router.

## L10 — Complete the initial source-element denominator (2026-08-29)

Added black-box pools whose borders act as message ports, event-based and inclusive gateways, data stores, and annotations. Fuzzing found a missed downward message when deciding whether a south port was free; pool endpoints were added to that static analysis.

Outcome: all elements in the five-example corpus were representable. This did not imply identical layout or universal BPMN support.

## L11 — Separate exits for different flow kinds (2026-08-29)

Sequence and message flows sharing a visible exit looked like a business branch. Message exits therefore moved to top or bottom when statically safe, with right-side fallback only when necessary.

Vertical column-center runs gained a reservation registry. Fuzzing required checking the cell immediately beyond a terminal channel as well as interval overlap.

## L12 — Use per-pool time axes and tighter tasks (2026-08-29)

Messages had been advancing one global time axis across all participants, creating very wide diagrams. Layering changed to use sequence flows within each pool; messages became bridges between independently layered participants.

Task text width moved to 96 px with approximately 80–128 px outer widths. Example widths fell substantially while semantic coverage remained unchanged.

## L13 — Make branch ownership visible (2026-08-29)

An upward message fallback could still share a sequence exit, and conditions on distinct branches could appear attached to one shared stub. Upward messages gained a top-channel detour, while non-main condition labels moved to the first unique branch segment.

## L14 — Separate ports and joins structurally (2026-08-29)

The engine stopped removing synthetic XOR joins. Inputs now enter distinct join ports and one edge exits the gateway, avoiding the appearance that one branch connects midway into another edge.

An oracle also rejected any task that shared a sequence-flow exit and message-flow exit.

## L15 — Use distinct gateway vertices for branches (2026-08-29)

Source-port selection moved ahead of target-entry rules. At a two-way gateway, the main path exits east and the lower alternative exits south even when the route must detour through a gutter.

## L16 — Move communication trunks outside participants (2026-08-29)

Adjacent pools gained communication corridors sized by reserved track demand. Message routes moved their long horizontal components into these corridors, and send/receive endpoints were separated. Events using a lower communication port moved their labels above.

A direct-connection shortcut was rejected because local checks could not protect later edges.

## L17 — Nest inter-pool tracks by endpoint order (2026-08-29)

Declaration-order first-fit routing inverted request/reply tracks. Track precedence was derived from endpoint containment, and related intervals stopped reusing track numbers.

Outcome: message-to-message crossings in the restaurant example fell from two to zero. A proposed annotation relocation was rejected after it changed causal placement and failed fuzzing.

## L18 — Remove meaningless bends near ports (2026-08-29)

Adjacent-pool messages changed to dedicated points on gutter-facing node sides, removing immediate 10–14 px elbows. Send and receive offsets remained distinct and were clipped to real shape boundaries.

Uniform offsets were rejected because fuzzing found coincident request/reply approaches.

## L19 — Reach zero crossings in five reference examples (2026-08-29)

Remaining crossings came from a single global main path, gateways serving as both joins and splits, one-sided return routing, and overly conservative gateway entry ports.

The accepted rules:

- elect a main path per pool;
- split multi-input/multi-output gateways into join and split nodes;
- compare baseline and perimeter route candidates with whole-diagram lexicographic scoring; and
- open safe south entries based on actual port use.

Always choosing the perimeter route failed 17 of 500 fuzz cases, so the legal baseline remained available and an improved candidate was accepted only when all oracles passed.

Outcome at that time: zero crossing hops and zero oracle violations for Invoice, Dispatch, Recourse, Credit Scoring, and Restaurant. This is historical evidence, not a guarantee for every current input.

## L20 — Add the missing one-bend shapes (2026-09-03)

A bend audit over 28 diagrams (513 edges, 534 bends) measured each edge against the minimum bend count implied by its port pair. 87% of the excess sat in one pattern: channel approaches that climbed to the channel above the target and came back down into its vertex. The orthogonal one-bend shape comes in two orientations, column-first (`drop`) and row-first, and the engine had only the first. The row-first shape was impossible because S-36 protected baseline runs only through node occupancy at both ends, which forbade a run ending at a column center; earlier cycles had already concluded that only explicit reservation could lift that restriction.

The accepted rules, in the order they were verified:

- a per-row reservation registry for baseline horizontals (`rowRuns`, the counterpart of the S-58 column registry), introduced first and confirmed to leave all 28 diagrams byte-identical;
- the `row-column` pattern (S-44) for cross-row entries into gateways and events and for document-to-task associations, with converging edges sharing one vertical; and
- the Z shape for adjacent-pool messages (S-57), leaving and entering through the facing vertices and crossing the corridor once.

Fuzzing found one new hole in the Z: two verticals arriving at the same column from opposite sides of the corridor touch in the discrete model but overlap inside the corridor band once tracks are assigned. Extending each reservation half a position across the corridor closed it, the same remedy as the channel-terminal cell condition of L11.

Outcome: bends 534 → 437, crossing hops 72 → 64, no diagram worse on any metric, and the 2,000-seed fuzz violation set identical to the previous release. O-10 was relaxed to admit the same-column single vertical, and the S-57 test now checks for the absence of a short stub rather than for a horizontal exit.

## Open items retained from the loops

- **C-66** Repeated glyphs for widely read documents remain unsupported.
- **C-68** Conditional port opening is implemented only where static safety is proven.
- **C-71** Density improved but still requires visual evaluation at delivery scale.
- Pagination, phase bands, expanded subprocesses, and universal optimality remain outside the core contract.
