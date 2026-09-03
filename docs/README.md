# Documentation

This directory contains public developer documentation for Process Model Generator. It is not bundled into the Plugin or standalone Skill archives.

## Current contracts

- [Process diagram style specification](architecture/style-spec.md): normative routing, port, measurement, rendering, and legality rules implemented by the engine.

## Design rationale

- [Problem inventory](architecture/problem-inventory.md): the constraints that shaped the compiler architecture and the `C-*` identifiers used in historical comments.
- [Design rationale](architecture/design-rationale.md): the five root causes (`R1`–`R5`) and the resulting compiler pipeline.

These files explain why the implementation has its current shape. They are not user instructions and do not override the Skill.

## Validation history

- [Layout evolution](history/layout-evolution.md): a condensed record of the `L1`–`L32` design loops and rejected approaches.
- [Reproduction corpus](validation/reproduction-corpus.md): provenance and evaluation rules for BPMN source reproductions.

Historical results remain evidence about past decisions, not claims about the current release. Current behavior is established by source, tests, and generated artifacts.

## Reference artifacts

- `reference/bpmn-icon-catalog.flow`: an English-language source catalog for supported BPMN glyphs. Its disconnected symbols are intentional, so render it in lax mode rather than treating it as a deliverable process.
- `reference/bpmn-icon-catalog.svg`: the rendered catalog corresponding to that source.

## Skill documentation

Agent-facing instructions live under [`skills/process-model-generator/`](../skills/process-model-generator/). The Skill's `references/` directory is packaged with the Skill and is separate from these developer documents.
