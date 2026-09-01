# Audit-sensitive modeling patterns

Read this reference before translating interview evidence into a model whose responsibilities, approvals, or external exchanges will be audited. These rules constrain claims made by the topology; they do not authorize invented business facts.

## Participants and responsibility

- A pool is one participant. Put supplier, bank, customer, and the modeled organization in separate pools; do not combine unrelated external parties into a generic external pool. Use lanes for roles within one participant.
- A material segregation-of-duties claim needs visibly distinct responsible lanes. A task labeled "Reviewed by another person" inside the preparer's lane does not establish separation.
- Declare a `doc` or `store` in the lane accountable for creating, maintaining, or controlling it. Do not put all artifacts after the last `lane` declaration, and do not omit them merely to avoid deciding ownership. Run `--emit-normalized` and inspect each artifact's lane when ownership matters.
- Lanes represent business roles, not entry positions or layout columns. Do not split one role into pseudo-roles such as "Order placed" or "Result review" merely to move nodes.

## Request and response

- Message flow is communication, not a control dependency. If work may proceed only after an external reply, receive it with `catch(message)` or `task(receive)`, make that receive point the target of the returning `~>`, then continue by sequence flow. Do not encode the wait only as an edge label such as "After reply" or feed a decorative catch only by sequence flow.
- A handoff between lanes in one pool is sequence flow. Do not add a message catch to decorate that internal handoff.
- A message must connect a sending or receiving activity/event (or a black-box pool), not a gateway, document, store, or note. Decide on the received result after the receive point.
- Two incoming messages do not mean both prerequisites are satisfied. When an activity requires two independent results, represent both catches/tasks and synchronize their sequence paths with `and`; otherwise narrow the external participant to a black box and keep the internal prerequisite explicit.

```flow
pool company[Company]
lane Purchasing
  task(send) ask[Ask whether cancellation is possible]
  catch(message) answer[Receive cancellation response]
  xor possible[Can the order be cancelled?]
ask -> answer
answer -> possible

pool supplier[Supplier]
ask ~> supplier: Cancellation request
supplier ~> answer: Cancellation response
```

## Decisions, approvals, and variants

- Separate preparation, approval decision, and outcomes. Creating an exception request is not approval; add the actual decision and the rejected path when supported, or leave the approver and continuation unresolved.
- A note does not change topology. Words such as "may", "usually", or "after reply" must agree with the sequence and gateways; do not turn optional or uncertain work into a mandatory path.
- Put a decision in the decider's lane. If the actor or rule is unresolved, use `task? id[label]` in the best-supported lane or `->?` on the inferred dependency and add a note; use an unresolved end when the continuation itself is unknown. Do not silently choose a lane or create a decisive gateway with an invented rule.
- Threshold approvals are cumulative: a higher band passes through every lower approver unless the source says it skips one. Model successive decisions rather than one exclusive amount-band gateway that bypasses a required approver.
- A gateway whose labeled branches all lead directly to the same next node does not preserve a business variant. Use a note when the difference is descriptive, or model the distinct wait, activity, or outcome on each branch.
- Do not send messages simultaneously to destinations described as mutually exclusive variants. Model the supported decision first, or keep the variants in separate scoped models.
- Use `=>` only when the normal path is supported by evidence. It is a presentation hint, not a substitute for a default flow or an assertion that an uncertain branch is normal.

## Time and evidence

- A deferral such as next month, a batch date, or a deadline must either wait on an explicit timer/next-cycle event or end the current run with a named deferred outcome. Decide any exception that still runs in this cycle, such as emergency payment, on the late/deferred branch before that end; do not connect the deferred outcome directly to ordinary current-cycle work.
- For each audit control such as approval, matching, or payment execution, model the material evidence and system of record named by the source, or list the omitted artifact and reason in the report. A zero-artifact model is not made audit-ready by passing `W-105`.

## Decomposed views

- Keep participant boundaries, responsibility, entry condition, exit result, and material prerequisites consistent between an overview and each detail view.
- A child view may intentionally add detail, but it must not silently move a task or artifact to another role, replace a wait with narrative text, or change an external participant into an internal lane.
- Keep distinct child exits distinct in the parent. A child exception that rejoins the child's main path must rejoin in the parent; a parent end must correspond to a child end rather than hiding a return loop. Show cross-view returns at least as a parent gateway branch, and include separate-trigger views such as cancellation in the view index.
- The compiler validates one `.flow` at a time and does not infer cross-view meaning. Cross-view semantic consistency is AI-owned. Before delivering an overview and its children, return to the source materials for each parent `task(sub)` and child flow and compare six invariants: scope and trigger; participant and lane responsibility; entry and preconditions; each exit and the parent's continuation; exception, return, and time; artifact, system, and control.
- Record that review in `review.md` under its own heading, not as extra ledger columns or rows:

```markdown
| child | invariant | parent claim | child evidence | verdict | action |
|---|---|---|---|---|---|
```

Name the invariant `scope/trigger`, `participant/lane`, `entry/precondition`, `exit/continuation`, `exception/return/time`, or `artifact/system/control`. Every row must cite a parent `flow` or node/edge id, a child `flow` or node/edge id, and a source locator from the original materials. Verdict is `supported`, `mismatch`, or `unresolved`. `eval` does not parse or score this table. A `mismatch` or `unresolved` row is not a finished delivery; return it to Frame, Elicit, Architecture, or Synthesize.
