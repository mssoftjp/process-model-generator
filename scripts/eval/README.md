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
