# Source-pinned BPMN benchmark

This is a regression corpus, not a BPMN conformance suite or an executable process engine.
`manifest.json` pins every input with SHA-256. The four XML files are unmodified files
from bpmn-io/bpmn-js-examples commit `8be0b2b279531332346f29c0b5e0b219c54cda0b`,
retrieved 2026-09-05. Each manifest source links to the exact upstream file.
Upstream declares **MIT (unless noted otherwise)** in its root README; these four
examples have no contrary license notice. Attribution: bpmn.io contributors.
See https://github.com/bpmn-io/bpmn-js-examples/tree/8be0b2b279531332346f29c0b5e0b219c54cda0b.
The original copyright and license statements, where present in files, are retained.

The `.flow` scenarios are newly authored reduced tests, not transcriptions of
Camunda diagrams. Monthly billing tests independent triggers; approvals tests
synchronization only. Its lanes do not reproduce Camunda's engine/approver pools
and do not prove distinct user identities or authorization enforcement. Invoice
is the user's hypothetical write-then-send example, not a Camunda example.

## Interpretation

- `contract=PASS`: explicit fixture expectations, source hashes, mutation detection,
  and horizontal/vertical semantic identity passed. This is not business validity.
- `conversion=partial`: supported outer notation is drawable but source meaning
  remains unconverted. Expected loss disclosure passes the regression contract;
  it alone never makes the readiness gate pass. The complete-sheet path must actually render all omitted scopes and metadata, with original connection checks.
- Visual records require the exact SVG SHA-256, PASS/FAIL, and observations for
  traceability, readability and emphasis. Missing/stale records stay PENDING.
  Records here are an agent's actual raster inspection, not a human study.
- `--require-ready` returns 2 on pending/failed visual review or incomplete detailed-sheet coverage;
  contract failures return 1. Ordinary regression runs test expected behavior,
  including honest partial-conversion reporting, and return 0 when it matches.

The starter source has a counterintuitive Yes retry / No continuation. Preserve
it for conversion fidelity; do not treat upstream demo semantics as business truth.

## Coverage against the requested sources

| Source topic | Current evidence | Remaining boundary |
|---|---|---|
| Camunda monthly invoicing | independent message/timer starts; mutation merges pools | no billing arithmetic or instance correlation |
| Camunda four eyes | AND synchronization; XOR mutation rejected | distinct identities and execution enforcement require an engine |
| Camunda business rules | review criterion: keep decisions separate from control flow | dedicated rule/data fixture not yet present |
| Camunda dependent instances | independent trigger case only | signal broadcast vs targeted correlation not tested |
| Camunda additional information | user invoice example covers an explicit send | optional request/response alternatives not yet represented |
| Camunda batch orders | no dedicated fixture | multi-instance cardinality/runtime not covered |
| Camunda reassignment | nested XML has an attached error event | message reassignment semantics not covered |
| Camunda two-step escalation | Pizza has timer retry and receipt competition | second escalation stage not covered |
| Camunda crossing, naming, symmetry, equal sizes | three required visual questions; both orientations | recommendations are not universal hard BPMN rules; no human usability study |
| bpmn-js starter | pinned XML labels, branch directions, retry and render | no bpmn-js runtime import/export round trip |
| bpmn-js pizza collaboration | pools, event gateway, timer, messages, terminate | correlated runtime delivery not tested |
| bpmn-js custom meta model | extension attributes/elements disclosed as loss | attributes/comments rendered and retained in SVG metadata; executable round trip unsupported |
| bpmn-js deep linking | omitted nested content disclosed as loss | nested scopes now rendered in the same detailed sheet; no executable round trip |
| bpmn-js UI integration examples | outside this compiler's product surface | overlays, editing, properties panels and minimaps are not compiler requirements |

Source: https://camunda.com/bpmn/examples/ (read 2026-09-05).
Coverage gaps remain explicit rather than inflating a percentage based on easy cases.
Before expanding scope, add the missing scenario's independent expected semantics
and a plausible wrong variant. Do not accept a new case merely because it compiles.
