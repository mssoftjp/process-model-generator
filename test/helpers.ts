// pipeline テストの共有入力とヘルパ。

import { expect } from 'vitest';
import { compile } from '../src/compile.ts';

export const BRANCH_FLOW = `flow review
pool internal[Internal]
lane requester
  start s[Start]
  task receive[Receive]
lane reviewer
  xor decision[Decision]
  task approve[Approve]
  task reject[Reject]
  end approved[Approved]
  end rejected[Rejected]
s -> receive
receive -> decision
decision => approve: yes
decision -> reject: no
approve -> approved
reject -> rejected`;

export const IMPLICIT_JOIN_FLOW = `flow implicit join
lane operations
  start s[Start]
  xor split[Choose]
  task B[Path B]
  task C[Path C]
  task D[Continue]
  end e[Done]
s -> split
split -> B
split -> C
B -> D
C -> D
D -> e`;

export const COLLABORATION_FLOW = `flow collaboration
pool p0[Requester]
lane requester
  start req_start[Start]
  task req_send[Send request]
  task req_review[Review reply]
  xor req_decide[Accept?]
  task req_revise[Revise request]
  end req_done[Done]
  doc record[Review record]
req_start -> req_send
req_send -> req_review
req_review -> req_decide
req_decide => req_done: yes
req_decide -> req_revise: no
req_revise -> req_send
req_review -.-> record

pool p1[Service]
lane service
  start(message) svc_start[Request received]
  task svc_receive[Validate request]
  task svc_process[Process]
  mid(message) svc_wait[Wait for confirmation]
  task svc_reply[Send reply]
  end(message) svc_end[Closed]
svc_start -> svc_receive
svc_receive -> svc_process
svc_process -> svc_wait
svc_wait -> svc_reply
svc_reply -> svc_end

req_send ~> svc_start
svc_reply ~> req_review
req_review ~> svc_reply`;

export const VERTICAL_MESSAGE_LABEL_FLOW = `orientation vertical
flow message label ownership
pool company[社内]
lane internal[社内]
  task A[A]
  task(sub) B[B]
  task X[X]
  task Y[Y]
  task Z[Z]
  task(sub) C[納品・検収]
pool supplier[取引先]
lane supplier[取引先]
  task(sub) S1[受注確認]
  task(sub) S2[納品・完了報告]
  task(sub) S3[請求]
A -> B
B -> X
X -> Y
Y -> Z
Z -> C
S1 -> S2: 受注可能
S2 -> S3
B ~> S1: 注文書PDF
S1 ~> B: 受注可否・変更納期
S2 ~> C: 商品・納品書・完了報告書
C ~> S2: 交換・追納依頼`;

export const SMOKE_FLOWS = [BRANCH_FLOW, IMPLICIT_JOIN_FLOW, COLLABORATION_FLOW];

export const noOracleViolations = (src: string) => {
  const r = compile(src);
  const oracle = r.diagnostics.filter((d) => d.code.startsWith('O-'));
  expect(oracle, oracle.map((d) => d.message).join('\n')).toEqual([]);
  return r;
};
