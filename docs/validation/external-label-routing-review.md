# External label and connected routing review

The review against `1bec788` identified four real document-name penetrations that the previous edge-label checks did not measure. The compiler now shares external node-label geometry across rendering, label placement, route obstacles, and an all-edge inspection. `W-436` reports the edge, node, segment, and collision coordinates, including routes leaving their own document. This measures text occupancy rectangles, not glyph pixels.

## Changes

- Data routes first try small port shifts that avoid their own text, then use the existing visibility-grid search when necessary.
- Connected routing compares distinct faces and ports for two to four mixed sequence/data inputs and for two-output gateways with shared segments. It retains a small set of alternatives and uses the existing bounded component search. At most three connected groups are considered per placement, with a beam width of 48. Multi-output gateway optimization beyond two branches is outside this change.
- At most two local placement alternatives swap same-column siblings or paired documents in the same responsibility lane. Selection uses graph geometry, not business-label vocabulary. Each alternative regenerates reservations, coordinates, ports, routes, and labels. `optimizePlacement: false` supports fixed-placement comparisons.
- Candidate selection measures raw geometric intersections separately from rendered hops, external text penetration, and shared gateway length. Connected and sequence candidates reject new shape violations, sharing, label collisions, and label-ownership ambiguity. Placement acceptance requires fewer intersections across the whole diagram, no increase in sharing or label problems, and at most 15% area growth per accepted step.
- `N-437` and `N-438` disclose connected-routing and placement adoption. The skill adds the three reviewed visual checks and requires reporting unresolved locations.

## Same-source results

The original expense fixture and business connections are unchanged.

| Vertical fixture | Before | Fixed placement | Local placement |
| --- | ---: | ---: | ---: |
| External text penetrations | 4 | 0 | 0 |
| Raw intersections | 6 | 4 | 1 |
| Rendered hops | 6 | 4 | 1 |
| Bends | 45 | 46 | 44 |
| Reviewed AND shared length | 43 | 0 | 0 |
| Canvas | 2140 x 2528 | 2140 x 2528 | 2148 x 2504 |

The horizontal fixture also reaches 44 bends and one raw intersection/hop, with no external text penetration, edge-label collision, ownership ambiguity, or reviewed AND sharing. Its final canvas is 3748 x 1424, versus 3708 x 1416 with fixed placement. Both orientations pass the shape oracle. The extra fixed-placement bend over the old result pays for text avoidance and clear split ports; the old 45-bend bound alone would prefer unsafe wiring.

The remaining crossing is between `e24_register_payment_execute_transfer` and `e27_mail_originals_receive_originals`: vertical `(1278, 1892)`, horizontal `(2760, 914)`. The supervisor return branches, mixed review inputs, and paired document routes are clear. This is a bounded improvement, not a claim of globally optimal or universally crossing-free layout.

## Verification and limits

`npm test` passes 21 files and 285 tests, including 500 horizontal and 500 vertical generated cases. The fuzz batch now yields to the event loop every ten cases so the test worker can flush progress; case counts and the 60-second per-orientation limit are unchanged. Dedicated fixtures cover unlabeled sequence/data/message lines crossing their own document text, mixed input face changes with reversed geometry declaration order, distinct gateway exits, Japanese multiline and shifted event labels, and crossings suppressed by hop rendering. The existing fixed-placement checks remain separate from placement acceptance.

The final vertical and horizontal SVGs were rendered with librsvg and visually inspected. Browser opening was blocked by URL policy, so browser-specific rendering remains unverified. Local comparison artifacts and exact metrics are under `outputs/review-external-labels/`.

The supplied completion condition remains unresolved; its AND join is preserved for a reproducible compiler regression and is not business approval. `E-520` still rejects the unresolved in-scope ledger. Existing interview/release work is preserved. No commit, push, or release is part of this review response.
