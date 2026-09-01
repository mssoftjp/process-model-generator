# Business-to-flow translation sources

This file records the provenance of the semantic translation policy in `SKILL.md`. It is maintenance evidence, not an additional checklist for ordinary workflow generation.

- [BPMN introduction](https://bpm-consortium.or.jp/bpmn/): distinguishes BPMN notation from readable Method-and-Style modeling and Level 1 from Level 2 usage.
- [Workflow and BPMN](https://bpm-consortium.or.jp/2023/03/12/workflow_bpmn/): supports retaining human work and enough operational detail to follow the process.
- [Data-object violations](https://bpm-consortium.or.jp/2024/04/21/violation1/): distinguishes process-instance artifacts from persistent stores and connects both through associations.
- [Message-flow violations](https://bpm-consortium.or.jp/2024/07/09/violation3/): limits message flow to communication across pools and uses sequence flow for same-pool lane handoffs.
- [Business handover](https://bpm-consortium.or.jp/2024/10/24/business-handover/): treats responsibility transfer as a useful task boundary while avoiding decorative request or receive steps.
- [Information sharing in non-routine work](https://bpm-consortium.or.jp/2026/07/20/non-routine-work/): distinguishes broadcast awareness from transfer of work ownership.
- [Standardization](https://bpm-consortium.or.jp/2025/05/12/standardization/): warns against flattening materially different departmental, product, or service variants into false uniformity.
- [Process hierarchy](https://bpm-consortium.or.jp/2024/12/18/bpm_process/): decomposes by semantic level and business scope rather than a fixed element count.

These sources inform translation and review judgment. They do not extend BPMN legality, Process Model Generator diagnostics, or `--strict` behavior.
