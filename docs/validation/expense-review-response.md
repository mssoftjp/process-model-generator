# Expense fixture review response

The supplied review is evidence and a proposed backlog, not an instruction to adopt every architectural proposal. The current checkout reproduced 49 bends and 9 hops before these changes, matching the supplied v0.2.21 case. Existing 0.3.0 interview/release work was preserved.

## Changes

- Delivery evaluation now rejects an unresolved, in-scope `unknown-topology` claim with `E-520`. A matching SVG hash and a recorded semantic pass cannot override that finding. This includes references to joins, end nodes, edges, and the whole view. An unknown outside a supported closed fragment uses `view:*`, `scope=outside`, and an explanation. This is a structural contract, not an automated interpretation of free prose or independent proof of the scope declaration.
- Edge display labels no longer infer conditional sequence flow. `[if condition] Display name` declares the condition explicitly; JSON-quoted conditions support embedded brackets and quotes. The converter emits explicit conditions from BPMN `conditionExpression`, including when a separate flow name exists. `N-208` explains migration of legacy activity labels. Actual conditions must be migrated deliberately; routine names must not acquire invented conditions.
- The routing stage generates same-target port exchanges and short orthogonal candidates using existing corridor coordinates. Node geometry and semantic edge fields are retained. Candidates must pass the full oracle, cannot add shared segments or label collisions, and must improve the existing whole-diagram score. Four bounded sweeps permit independent changes to accumulate. `N-435` records adoption.
- `N-222` identifies its path as a drawing backbone, gives branch selection reasons, and explicitly avoids claiming a normal or successful business outcome. No business outcome is inferred from task names.
- The skill distinguishes faithful reconstruction from requested hypothetical modeling, requires assumptions to be visible, and reports compilation, evidence, geometry, and visual inspection separately.

## Evidence and limits

The fixed vertical fixture reaches **45 bends and 6 hops**, retaining **2140 x 2528**, all node placements, and business connections. The horizontal counterpart also reaches 45 bends and 6 hops. The three crossings immediately before the return merge are removed. Both reviewed four-bend detours become two-bend routes. Geometry-oracle and label collision checks are clean.

The success-hint experiment still has 17 hops after local optimization (the review reported 20 before optimization). Therefore this change does not prescribe hints as a general layout fix or claim a globally optimal layout. Alternative placements, outcome typing, compact implicit merges, and a full semantic-claim schema remain design proposals; they are not necessary to correct the confirmed local defects and require separate evaluation.

The supplied business completion condition remains unresolved. The comparison SVG preserves its AND join for reproducible geometry testing and is **not an approved business deliverable**. Do not replace the join with XOR, invent bank behavior, or resolve rejection/resubmission policy from this review alone.

Visual inspection used local librsvg rendering. The browser URL policy blocked opening the local SVG; browser-specific rendering is unverified. The full rendered diagram was inspected for the corrected return merge, shorter payment routes, readable labels, and the absence of a conditional diamond on the resubmission label. Native-size scrolling remains appropriate.

`npm test`: 20 test files and 275 tests passed, including 500 horizontal and 500 vertical fuzz cases. `git diff --check` and the public-tree check passed.

Regression coverage includes both orientations of the submitted fixture, original contradictory ledger rejection, confirmed and outside-scope ledger cases, label/condition/return-hint separation, quoted conditions, and the existing BPMN conversion and horizontal/vertical fuzz suites. Generated comparison files are local under `outputs/review-expense/`; no release or publication was performed.
