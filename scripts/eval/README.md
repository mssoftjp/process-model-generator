# Evaluation scripts

Development tools for judging layout changes on a corpus of `.flow` files. They are not part of the published package. All of them run with `npx tsx` and compile with the TypeScript sources directly, so `--src` can point at `src/` of another checkout (for example a `git archive` of an earlier commit) to compare two points in history on the same inputs.

| Script | Purpose |
|---|---|
| `snapshot.mts <outDir> <corpus.txt or dir> [--vertical] [--src <srcRoot>]` | Compile every figure of the corpus, write one SVG per figure and `metrics.json` (bends, crossings, detours, excess bends, oracle violations, line length, area, pattern counts). |
| `compare.mts <before/metrics.json> <after/metrics.json> [--changed]` | Print the per-figure differences between two snapshots and the totals. |
| `timeline.mts <out.html> <label=dir[:verticalDir]> ...` | Build a single HTML page that overlays the same figure from several snapshots (tinted overlay, wipe, or stacked), for judging appearance rather than numbers. |
| `fuzz.mts [N] [--src <srcRoot>] [--dump <seed>]` | Run the fuzz generator of `test/fuzz.test.ts` for N seeds in both orientations and list every seed whose oracle fires. `--dump` prints one generated input. |

Typical loop for a layout change:

```bash
git archive main src | tar -x -C /tmp/base
npx tsx scripts/eval/snapshot.mts /tmp/snap/base corpus.txt --src /tmp/base/src
npx tsx scripts/eval/snapshot.mts /tmp/snap/new corpus.txt
npx tsx scripts/eval/compare.mts /tmp/snap/base/metrics.json /tmp/snap/new/metrics.json --changed
npx tsx scripts/eval/timeline.mts /tmp/snap/timeline.html base=/tmp/snap/base new=/tmp/snap/new
npx tsx scripts/eval/fuzz.mts 2000
```

The corpus itself (`inputs/`) is local and not tracked; `corpus.txt` is a plain list of `.flow` paths.

## Semantic and external-source benchmark

Run `npm run eval:benchmark` for the source-pinned contract corpus in
`test/fixtures/benchmark/manifest.json`. It produces `outputs/benchmark/results.json`
and a native-size scrollable `index.html` with both orientations, diagnostics,
source links, partial conversion details and mutation checks. It runs offline;
refresh upstream inputs deliberately with a new pinned revision and hashes.

```bash
npm run eval:benchmark -- outputs/benchmark --reviews test/fixtures/benchmark/visual-review.json --require-ready
```

This stronger gate includes current visual observations and rejects missing/stale
reviews, failed readability and incomplete source coverage. The detailed-sheet compiler retains nested scopes and extension metadata in a single SVG; a single-scope partial conversion can pass delivery only when the complete sheet covers the omitted content and its sequence connections. Passing regression tests must not replace actual visual inspection. `npm test` exercises the benchmark contract.

Use the layers in order: source provenance and scope; semantic assertions and
wrong-model mutations; conversion loss disclosure; strict rendering in both
orientations; actual readability review. Do not combine them into a weighted score.
See the fixture README for the source coverage matrix and explicit uncovered topics.
The existing delivery `eval` remains responsible for evidence ledgers and parent/child
business models; this benchmark tests the implementation itself.

`snapshot.mts` now uses strict compilation and returns nonzero for any failed figure
or an empty corpus. Its totals only describe successfully compiled figures: inspect
`failed` and the error rows before comparing totals. These geometry metrics are
supporting evidence, never a replacement for the benchmark or visual review.

## Fixed-evaluator historical comparisons

`snapshot.mts` measures every compiler's returned geometry with the **current**
`crossing-causes.ts` and `visual-metrics.mts`, without rerouting old results.
Both orientations are forced (horizontal by default, `--vertical` for vertical),
so an orientation declaration inside a fixture cannot silently duplicate a view.
Archive `src` **and** `package.json` inside this repository's ignored output tree
so historical modules retain their module type and resolve installed dependencies.

For the 2026-09-05 review, freeze all 20 local `inputs/flow/*.flow` files plus
`test/fixtures/benchmark/scenarios/invoice.flow` renamed to `invoice-send.flow`.
The latter is a separate regression cohort, excluded from the legacy totals.
Run snapshots at `cff50af`, `9c66f5a`, `e942239`, `720a652`, `4c7aa79`,
`4a50eca` and the current working tree, in both orientations. Use `timeline.mts`
with all seven horizontal/vertical directory pairs. Record full commit IDs,
input/evaluator SHA-256 hashes and the working-tree source patch alongside the
snapshots; generated local evidence lives in `outputs/layout-history/`.
Never compare success-only totals if any version has failed cases.

The new per-edge `visual` diagnostics include direction-change bends (ignoring
redundant collinear waypoints), Manhattan route length / endpoint distance, and
maximum excursion outside the endpoint rectangle in pixels. Coincident endpoints
have a null ratio. Summaries separate sequence, message and association edges from
intentional return edges. Ratio 1 and excursion 0 mean monotone routing, **not**
proof of an optimal route or readable layout; necessary obstacle avoidance may
increase either. The timeline exposes association ratio/excursion alongside the
existing bend and hop counts. Hops are display jumps, not all geometric crossings;
`crossings` in metrics.json counts proper segment intersections separately.

These diagnostics complement the independent oracle and actual rendered review.
[bpmn-io's quality evaluation](https://github.com/bpmn-io/bpmn-auto-layout/blob/main/test/README.md)
likewise separates structural defects from bend/length/compactness signals.
[User-created graph drawing research](https://pubmed.ncbi.nlm.nih.gov/21173454/)
supports attention to crossings and alignment; it does not validate a weighted
score or a numeric perceptual acceptance threshold for this corpus.
