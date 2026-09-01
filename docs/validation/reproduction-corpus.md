# BPMN Reproduction Corpus

Status: historical validation record. This document records how public BPMN examples were used to test semantic coverage. The local source corpus and generated comparisons are development evidence and are not bundled with the Plugin or Skill.

## Why the corpus was rebuilt

The first corpus transcribed well-known examples from memory and incorrectly claimed 100% reproduction. Comparison with the actual `invoice.v2.bpmn` source revealed several kinds of drift:

- an invented `Invoice` data object where the source used a `Financial Accounting System` data store;
- `approved/rejected` branch labels where the source used `yes/no`;
- `Accounting` instead of the source lane name `Accountant`;
- `Assign approver` instead of `Assign Approver Group`; and
- omitted `businessRuleTask`, `serviceTask`, and `callActivity` types.

The resulting rule is strict: **a case enters the reproduction ledger only when its original BPMN XML is available, and translation is performed mechanically rather than from memory.**

## Method

1. Retrieve BPMN XML with DI coordinates from a public repository and record its source URL.
2. Convert it with `skills/process-model-generator/scripts/bpmn2flow.py`. Preserve source reading order where possible and collect supported/unsupported element counts mechanically.
3. Render the original through bpmn-js using its supplied DI and compare it beside the generated SVG.
4. Keep semantic approximations visibly provisional and exclude them from the represented-element numerator.
5. Evaluate element coverage, semantic correspondence, and visual appearance as separate dimensions.

## Historical ledger

The following results describe the corpus at the end of layout loop L10. They are historical measurements, not a statement of universal BPMN conformance or a substitute for current tests.

| Case | Original source | Represented elements | Unsupported elements in that source |
|---|---|---:|---|
| Invoice Receipt | `camunda/camunda-bpm-platform`, `examples/invoice/invoice.v2.bpmn` | 26/26 | None |
| Dispatch of Goods | `camunda/bpmn-for-research`, exercise 01 official solution | 36/36 | None |
| Recourse | `camunda/bpmn-for-research`, exercise 02 official solution | 42/42 | None |
| Credit Scoring (synchronous) | `camunda/bpmn-for-research`, exercise 03 official solution | 44/44 | None |
| Self-service Restaurant | `camunda/bpmn-for-research`, exercise 04 official solution | 76/76 | None |

Coverage evolved from 96/94/90/77/73% in the first mechanically checked baseline to 96/94/98/91/96% after pools, messages, and intermediate events, then to complete representation of the elements present in these five files after black-box pools, event/inclusive gateways, data stores, and annotations were added.

This denominator did not include every BPMN feature. Complete coverage of these five cases therefore did not imply support for expanded subprocesses, all boundary-event patterns, choreography, execution semantics, or future cases.

## Coverage is not appearance

Representing every source element means that no source element type was dropped. It does not establish equivalent layout or perfect readability.

Visual comparison separately considered:

- topology, labels, and lane order;
- main-path continuity;
- branch and merge grouping;
- message-flow crossings;
- diagram width and display scale; and
- the product's deliberate house style, including main-path emphasis and return routing.

Historical density changes reduced example widths from 3008 to 1460 px for Credit Scoring, 4587 to 1908 px for Restaurant, 2705 to 1884 px for Recourse, and 2078 to 1452 px for Invoice. These numbers are useful evidence of the specific change, but they are not sufficient conditions for readability.

## Maintenance rules

- Add a case only when the original source can be retained or retrieved reproducibly.
- Record the exact source URL and conversion version.
- Keep unsupported elements in the denominator; they identify future work.
- Record any manual change as a separate, reviewable delta rather than silently altering conversion output.
- Compare regenerated SVGs visually as well as mechanically.
- Do not count memory-based practice examples as reproduction evidence.

The historical Invoice fixture explicitly marked `n6 ->> n2: no` as the return-layout hint while preserving the original graph connection. This prevented the rejection/review cycle from being layered as a forward success path; the exception was recorded in the fixture provenance rather than hidden in the converter.
