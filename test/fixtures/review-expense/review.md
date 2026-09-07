| claim | kind | source | view:id | status | reason |
|---|---|---|---|---|---|
| view-index | view | generated:flow | expense_settlement:* | modeled | entry=expense_occurs; exits=settlement_complete,withdrawn |
| 経費発生後、申請内容を作成し領収書をPDF化して申請する | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:expense_occurs->prepare_application | modeled | 画像上部の申請者レーンから判読 |
| 申請準備から証憑PDF化へ進む | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:prepare_application->scan_receipt | modeled | 画像内の縦接続 |
| 証憑PDF化後に申請を送信する | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:scan_receipt->submit_application | modeled | 画像内の上長への申請送信 |
| 上長が申請内容と証憑を確認する | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:review_supervisor | modeled | 画像の直属上長レーン |
| 上長承認なら金額判定へ進む | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:supervisor_approval->amount_threshold | modeled | 承認枝を判読 |
| 上長の否認・差戻しでは理由を通知する | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:supervisor_approval->notify_supervisor_return | modeled | 否認枝と理由通知を判読 |
| 申請者は修正または取下げを選ぶ | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:handle_return->revise_application | modeled | 対応判定の修正再申請枝 |
| 取下げ時は終了する | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:handle_return->withdrawn | modeled | 対応判定の取下げ枝 |
| 修正後は再申請する | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:revise_application->submit_application | modeled | 再申請ループ |
| 10万円以上は部長の追加承認審査に進む | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:amount_threshold->review_additional | modeled | 画像の閾値分岐 |
| 10万円未満は追加審査を経ず経理へ進む | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:amount_threshold->receive_approval_notice | modeled | 画像の閾値分岐 |
| 部長承認なら経理へ進む | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:department_approval->receive_approval_notice | modeled | 部長承認枝 |
| 部長否認・差戻しでは理由を通知する | assume | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:department_approval->notify_department_return | modeled | 線形関係は見えるが小文字のため役割を補完 |
| 部長差戻し後は申請者の対応判定へ戻る | assume | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:notify_department_return->handle_return | modeled | 上長差戻しと同じ戻り先と想定 |
| 経理は承認通知を受信後、申請内容と領収書を確認する | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:receive_approval_notice->inspect_evidence | modeled | 経理レーンの連続タスク |
| 不備があれば申請者へ修正を依頼する | fact | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:evidence_defect->request_correction | modeled | 画像の不備あり枝 |
| 不備がなければ精算処理へ進む | assume | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:evidence_defect->parallel_processing | modeled | 画像下部切れを補完 |
| 修正依頼後は申請者の対応判定へ戻る | assume | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:request_correction->handle_return | modeled | 画像の戻り線から想定 |
| 精算処理と原本管理を並行する | assume | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:parallel_processing->register_payment | modeled | 画像右注記「原本郵送は精算と並行」を根拠に補完 |
| 原本郵送も並行して開始する | assume | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:parallel_processing->mail_originals | modeled | 同上 |
| 振込完了後に申請者が入金確認する | assume | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:notify_transfer->confirm_payment | modeled | 画像下部の入金確認タスクと一般的な接続を採用 |
| 原本を総務が受領・保管する | assume | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:receive_originals->file_originals | modeled | 総務レーンと原本関連注記から補完 |
| 入金確認と原本保管の双方で完了とする | unknown-topology | image:2bb59ae1-4c9e-4abe-87fc-66ee250aa2b1.png | expense_settlement:settlement_complete | unresolved | asked=unavailable:image-bottom-cropped; 原本到着を精算完了条件とするかは画像注記でも未確定 |
| W-440 | diagnostic | compiler:W-440 | expense_settlement:W-440 | modeled | 2140x2528の縦長詳細図のため、全体縮小せずスクロール・拡大して閲覧する |
| delivery-review | view | review:codex-svg-inspection | expense_settlement:* | modeled | semantic=pass; visual=pass; svg-sha256=c4e0e9b2a2a6951823a5fcfb54f2a874e47ebf93bbe2e42cb8559e04bd217c7a; observations=5レーンの責任配置、全分岐ラベル、差戻しループ、並行分岐とAND合流、線の連続性を確認。日本語はSVGテキストとして保持し原寸閲覧を前提とする |
