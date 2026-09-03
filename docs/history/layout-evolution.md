# Layout Evolution, L1–L27

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

## L21 — Finish the one-bend family and measure the residue (2026-09-03)

After L20 the residual excess bends sat in four places: main-path edges leaving a gateway east into a join on another row, upward non-main gateway branches routed through the channel and gutter, cross-row returns climbing the right gutter, and request/reply message pairs refused by the column registry although slot separation would have kept them apart.

Accepted:

- `row-column` extended to main-path gateway sources (east exit is already the S-50 grammar);
- `rise`, the upward mirror of `drop`, in the improved candidate;
- a north exit for cross-row sequence returns in the improved candidate only, since L19-era evidence showed the baseline choosing a full-width reverse run when given this freedom;
- task-face sharing in the column registry for messages, with two-point straight runs marked exclusive after fuzzing found a request and a reply coinciding exactly; and
- `excessBends` and `detourEdges` in the crossing-cause report, the proxies used to find the residue.

Rejected after measurement:

- moving annotations off gateway columns in placement: it freed one gateway drop but pushed the annotation under its task, where it blocked the document bus into that task (hops +3, detours +6 for bends −3); and
- returning documents that have readers to their writer's column: fuzzing produced dozens of associations through node interiors because the row is not known when the column is decided.

Outcome: bends 437 → 414, detours 31 → 28, hops 64 → 65 (one figure trades two bends for one hop), no other figure worse, and the 2,000-seed fuzz violation set again identical to v0.2.19.

## L22 — Remove rule-only rejections (2026-09-03)

A blocker audit classified the remaining excess by what occupied the cells a one-bend shape would need. Eleven edges were blocked by no cell at all, only by rules. Accepted:

- a document directly below the task that reads it connects with a straight top-to-bottom line (S-55), guarded by the reading task's face and by the already-planned entry sides of the document's other writers;
- data associations may enter a document-like node from another row through its vertex under S-44;
- a gateway with exactly one incoming sequence flow from another row and no same-row predecessor keeps its west vertex for that entry (S-51), so a main path reaching a split gateway across lanes no longer hooks over its north vertex;
- non-gateway sequence returns may exit north in the baseline too (S-33); the gateway case stays improved-only because of the keihi regression recorded in cycle 1; and
- the half-position corridor extension of L20 was replaced by an explicit order test (S-57): two verticals reaching the corridor at one column from opposite sides are accepted when the S-37 nesting relation orders them consistently and refused for X-shaped pairs.

Outcome: bends 414 → 382, hops 65 → 61, detours 28 → 18, no diagram worse on any metric, label metrics unchanged, fuzz violation set identical to v0.2.19. The remaining excess is placement-bound: documents and annotations layered into the column of a join or gateway (7 edges), process nodes standing in the target column (8), and stores referenced from distant writers (C-66).

## L23 — Repeat distant document references (2026-09-03)

The last placement-bound class in L22 was a store or document referenced from far apart, such as an accounting system written near the top of a lane and again near the bottom, joined by a dotted line running the height of the diagram. BPMN's own answer is the reference: one data store, several data store references. The engine now repeats a document as reference glyphs in normalization (S-25) when its references, ordered by a provisional layering column, fall into clusters more than five columns or more than two lanes apart; every glyph is placed in the lane of its cluster's writer.

Two thresholds were corrected by the corpus: a one-lane distance repeated documents in keihi and ringi-docs whose readers were only two or three columns away, adding bends and a crossing, and a three-column gap split a document that an existing placement test expects to stay whole. Fuzzing also exposed a latent hazard in the same-column far-document rail (a 28 px offset run with no reservation), which now requires narrow intermediate cells, a task writer, and a quiet south face; and read-only document chains no longer take row 0 of a spine-less lane, where a same-row read can only enter through a hook.

Outcome: invoice-payment-review hops 17 → 10 with all other corpus diagrams unchanged, fuzz violation set identical to v0.2.19.

## L24 — Align message-triggered starts with their sender (2026-09-03)

Since L12 every pool started at column 0, so a supplier's process began at the left edge while the order that triggers it was sent from the middle of the customer's lane, and the message ran backwards in time. BPMN assigns no meaning to position, but collaboration diagrams conventionally place a message start event under the sending activity, and the reproduction originals do so. The engine now treats a message into a start event, or into the node right after a start, as a lower bound on the receiving pool's columns and shifts that pool right as a unit (S-15); mutually triggering pools are left alone. Other messages still do not move columns, which keeps the L12 result that round trips do not serialize into one wide sequence.

The shift exposed a latent routing hazard: a data association whose target lies to the left of its source could take the baseline patterns and cut through nodes between them. Direct and row-approach patterns now require a forward target.

Outcome: restaurant and credit-scoring start their second pools under the triggering activity, at the cost of wider bands; other diagrams are unchanged. Fuzz violation set identical to v0.2.19.

## L25 — Align every message with its sender (2026-09-03)

L24 aligned only the first message of a pool and did so by shifting the whole pool, which left later exchanges running backwards and made request/reply pairs cross where the slot order on a face disagreed with the track order in the corridor. Two changes replaced it. Messages became lower-bound constraints of weight 0 on the receiver, admitted one at a time in declaration order into the same relaxation as the sequence layering, so a receiver sits at or after its sender and a reply can share a column with its request; a constraint that cannot converge is dropped rather than reverting the whole alignment. Start events are pulled right to their successor afterwards. Corridor tracks are assigned before entry slots, and slots on one face are ordered by the ladder rule: the line that turns at the nearer track takes the slot on the side it travels toward. Two straight messages between the same two nodes are offset by six pixels each way.

The corpus then showed two placement effects. A document returned to a writer's column blocked the straight pair above it, so writers with a same-column partner keep their column free; and an annotation layered into a message corridor did the same, so write-only documents in a corridor move one column right. In invoice_reception the second of two stacked branches still cannot use its column on either side, and its detour adds crossings; that configuration needs a row-aware placement to resolve.

Outcome: restaurant matches the reference layout (bends 19 → 9, no crossings), corpus bends 380 → 366, one delivery diagram trades six crossings for a straight first message. Fuzz violation set identical to the previous release.

## L26 — Separate stacked message branches (2026-09-03)

After L25, a diagram with parallel branches on both sides of a pool boundary (an invoice sent either to accounting or to the requester, each received by its own event) aligned both messages into one column, where the second sender's vertical was blocked by the first sender's cell and the second receiver's by the first receiver's. The message fell back to a side route with several crossings. The rule: two messages between the same adjacent pools that share a column without sharing both endpoints always collide on a column center, so the later one, never a main-path sender, gets a lower bound one column right and the constraints are relaxed again (S-15). A first version bumped request/reply pairs, whose endpoints are tied by their own constraints, and chased them eight columns to the right; pairs are now recognised regardless of direction and a pair that stays aligned after one bump is not tried again. Fuzzing then exposed a latent hazard in the side exits of S-57: two neighbours on one row leaving toward the same gutter at the same offset overlapped inside the gutter, invisible to the discrete model because the intervals only touched. Side-exit stubs are now reserved per row and offset with touching counted as a collision, and a blocked endpoint uses the gutter on its other side.

Outcome: invoice_reception and delivery_acceptance draw the second branch one column right with a straight message (bends 21 → 17 and 21 → 13); no other diagram changed. Fuzz violation set identical.

## L27 — Self-review of L20–L26 (2026-09-03)

A review of the day's changes listed five behavioural gaps and seven inconsistencies; all were closed without changing any corpus diagram. A same-column message from a task lost its straight form whenever a second message left the same face, because a two-point line is never slotted; same-source messages may share a trunk (S-32) and same-target messages may converge (S-91), so those no longer count against the straight form, and a task now fans out as one trunk that splits in the corridor. The ladder order of entry slots was only a tiebreak behind the peer column and is now primary among corridor runs. A vertical message exit no longer coexists with a sequence return leaving the same face (which is never slotted). The right-exit stubs of the fallback patterns are registered alongside the S-57 side stubs, and corridor clearing runs after the document moves that could undo it. Read-only documents keep row 0 in lanes without process nodes, the stacked-branch separation may try every pair, the repetition distance uses the message-aligned provisional columns, and a start that itself sends a message is not pulled past its receiver. The specification moved to v1.4 and `repeatOf` to the normalized node type.

## Open items retained from the loops

- **C-66** Repeated glyphs are rule-based (S-25); a hint to force or forbid repetition per document is not yet exposed in the DSL.
- **C-68** Conditional port opening is implemented only where static safety is proven.
- **C-71** Density improved but still requires visual evaluation at delivery scale.
- Pagination, phase bands, expanded subprocesses, and universal optimality remain outside the core contract.
