# Process Model Generator engine maintenance contract

Read this file only when changing parser, normalization, measurement, placement, routing, or SVG generation code. It is not required for ordinary `.flow` authoring.

## Editable SVG contract S-66

Emit the background and title first, followed by exactly three top-level groups in `layer-band`, `layer-edges`, `layer-nodes` order.

Group each semantic editing unit with all of its visible parts:

- node: shape parts, markers, and name;
- edge: line, arrowhead, and condition label;
- lane: band, header, and label;
- pool: frame, header, and nested lane groups.

Derive stable `node-*`, `edge-*`, `lane-*`, and `pool-*` group IDs from geometry IDs using NCName-safe normalization, and separate normalization collisions deterministically. Grouping and layer order must not change rendered pixels.

## Semantic owners

- `normalize`: topology-preserving rewrites and implicit structures;
- `measure`: text and shape dimensions;
- `place`: lane, row, and column assignment;
- `route`: ports, corridors, and edge geometry;
- `page-budget`: generated-dimension readability and delivery diagnostics;
- `svg`: grouped editable output.

Fix recurring defects in their semantic owner. Do not patch generated SVG coordinates.

Treat `O-*` diagnostics and `W-252` as engine failures. Keep source-model ambiguity, DSL legality, rendering correctness, and editable-output structure as separate evidence.

Run `npm test` after engine or contract changes. The suite must retain public-tree validation, notation and pipeline tests, BPMN conversion tests, and horizontal and vertical fuzz-oracle coverage.
