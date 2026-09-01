# Advanced Process Model Generator DSL

Read this reference only when the source requires constructs beyond the common subset in `SKILL.md`, when converting BPMN XML, or when a detailed diagnostic must be interpreted.

## Nodes and markers

- Additional nodes are `mid`, `catch`, `throw`, `boundary`, `or`, `complex`, `note`, and `group`. `group` is a backward-compatible point annotation, not a conforming BPMN Group enclosure.
- Parentheses carry comma-separated typed markers, for example `task(user,loop)`, `mid(message,throw)`, and `boundary(timer,nonint) t[deadline] @review`. Unknown tokens are diagnosed and are never drawn as a fake standard icon.
- Events are `start`, `mid` (catch unless `throw` or none), `throw`, `end`, and `boundary(...) @activityId`. Catch markers are outlines; throw markers are filled. Non-interrupting boundary events and Event Sub-Process starts use a dashed circle, distinct from the amber provisional dash (`?`).
- Legal BPMN 2.0.2 trigger × position combinations are validated. An illegal pair such as `end(timer)` fails closed: warning in lax, error under `--strict`. Do not rewrite it into a nearby legal type.
- Gateways are `xor`, `and`, `xor(or)` / `or`, `xor(event)`, `and(event)`, and `xor(complex)` / `complex`. Preserve an existing subtype.
- Activity markers are `loop`, `parallel`, `sequential`, `compensation`, and `adhoc`; loop and multi-instance cannot coexist. Use `task(sub)` for a collapsed Sub-Process, `task(call)` for a Call Activity of a Process, `task(call,global,user)` (or `manual`, `script`, `rule`) for a typed Global Task, `task(transaction)` for a Transaction, and `task(eventSub,message)` for a collapsed Event Sub-Process. Expanded Sub-Process is unsupported.

## Edges and coverage

- In addition to the common operators, use `-.-` for an undirected association, `..>` for a directed association, and `<..>` for a bidirectional association. A condition label on an Activity source is a conditional sequence flow.
- A default flow (`->/`) and a main-path hint (`=>`) are different concepts. Do not convert one into the other.
- A return hint (`->>`) marks which sequence on a cycle is the layout feedback edge. It does not reverse the edge, change connectivity, or replace `=>`, `->/`, or `->?`. Unmarked cycles still use DFS back edges.
- This compiler covers Process / Collaboration notation; it does not claim BPMN Process Modeling Conformance. Unsupported constructs include expanded Sub-Process nesting, BPMN Group containment, Choreography, Conversation, and message flows that land on a non-black-box pool border.

## BPMN XML conversion

Use `scripts/bpmn2flow.py` rather than transcribing XML by eye. Keep the original source and provenance when reproducing a diagram.

The converter preserves catch versus throw, boundary `attachedToRef` / `cancelActivity`, condition expressions, default flow as `->/`, Association direction, collapsed Event Sub-Process starts, and `callActivity.calledElement` resolution to Process versus typed Global Task when the target is present in the same file. Expanded Sub-Processes are not flattened.

Use `--json-stats` to report unconvertible elements by kind, id, name, and reason. Element presence is not semantic coverage: never count an element as supported when conversion dropped its meaning.

## Diagnostics

- Treat semantic warnings as review findings, not permission to invent intent.
- `W-207` reports a message whose endpoint is a gateway or data-like artifact instead of a sending/receiving activity or event. `--strict` promotes it to `E-207`.
- `W-208` reports a data association whose endpoint is a gateway. Attach it to the activity that reads or writes the data instead. `W-209` reports a Data Object associated across participant pools; keep the payload on Message Flow and declare the receiving participant's controlled document separately. Both remain review warnings because ownership cannot be repaired automatically.
- `W-220` / `W-221` report synthetic start/end events added because a pool declared none. They remain warnings under `--strict` for compatibility and require an author review before delivery.
- `W-223` / `W-224` report an additional sequence source/sink in a pool that already has an explicit start/end. Under `--strict` they become `E-223` / `E-224`, because the isolated entry or unfinished exit otherwise looks like a complete process.
- `W-225` reports sequence flow entering a Start Event or leaving an End Event. `--strict` promotes it to `E-225`.
- `W-234` reports a synthetic plain Start Event added before a node whose only incoming communication is a message. It asks the author to distinguish a `start(message)` from an in-process `catch(message)` or Receive Task, but remains a warning under `--strict`.
- `W-105` reports a `doc` or `store` whose declaration lane contains none of its associated activities. It is an ownership-review heuristic, remains a warning under `--strict`, and never moves the artifact automatically. `W-107` reports a likely phase-suffixed duplicate of another role lane and likewise requires review rather than automatic movement.
- `W-310`–`W-316` cover illegal event position, unknown subtype, activity-marker conflict, unknown gateway subtype, missing boundary host, expanded Sub-Process, and default-plus-conditional conflicts. `--strict` promotes them to `E-310`–`E-316`.
- `W-432` reports a residual edge-label overlap with a node after deterministic label placement. `N-432` reports residual label intersections with another edge or label. These identify where visual inspection or additional corridor capacity is still required; do not hand-edit generated coordinates.
- `W-440` reports that a 1600×900 presentation would make the generated SVG unsuitable as the only delivered view, including a time axis longer than two screens when fitting would shrink the text. Keep the complete `.flow`, but deliver an end-to-end overview and the necessary Level 2 diagrams.
- `W-441` reports that the lane axis would become physically unreadable at that scale. Under `--strict` it becomes `E-441` and compilation stops before writing an SVG. The diagnostic is based on generated dimensions and orientation, never node count.
- `O-*` diagnostics and `W-252` indicate engine failures rather than source-model ambiguity. If they appear while using an unchanged compiler, report them separately and do not hand-edit the SVG to hide them.

## Delivery evaluation

After placing all `.flow`, regenerated `.svg`, and review rows in one delivery directory, run:

```bash
node scripts/process-model-generator.mjs eval --dir outputs/delivery --report outputs/delivery/review.md --parent overview-flow-id
```

Add `--consulting` for the source-bearing ledger defined in the consulting workflow. Treat a nonzero result as incomplete; do not replace failed checks with prose.

For audit-sensitive delivery, report each view's entry, exits, unresolved items, intentionally omitted evidence, one-way messages flagged by `W-236`, and the `N-440` fit, lane, time, and crossing figures.

Write each ordinary view row as `view-index | view | flow-id:* | modeled | entry=id,...; exits=id,...`. Add a `diagnostic` row addressed to `flow-id:W-nnn` for every warning, and a row addressed to `flow-id:node-id` or `flow-id:from->to` for every provisional `?`. A child normally matches a parent `task(sub)` ID. A separately triggered or time-discontinuous child instead needs an `independent-trigger | view` row and `view-plan boundary=trigger` or `time`; do not use that exception to bypass a missing parent reference.

`W-440` requires an end-to-end overview plus the Level 2 views justified by a supported business boundary; otherwise `eval` reports `E-517`. Keep overview tasks at phase or subprocess level, use matching parent and child flow IDs, and apply the same rule recursively when a detail view is also oversized. Never auto-split by node count or deliver one unreadable SVG merely because lax compilation succeeded.
