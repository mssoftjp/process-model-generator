// Process Model Generator の型定義。
// IR は入力意味と配置・配線の責務を分離する:
//   意味 = 必須フィールド / 修辞 = 既定＋任意ヒント / 幾何 = ここに存在しない。

export type NodeKind =
  | 'task' | 'start' | 'end' | 'xor' | 'and' | 'doc' | 'mid' | 'store' | 'note'
  | 'boundary' | 'group';
// mid = 中間イベント(C-69) / store = データストア(円筒) / note = 注釈(C-70)
// boundary = 境界イベント / group = 後方互換の点状注釈（BPMN Group 包含ではない）

// 図の向き。意味ではなく修辞（=> と同格）: トポロジ・本流・戻り辺の決定を変えてはならない。
// horizontal = レーンは横帯、時間は左→右 / vertical = レーンは縦帯、時間は上→下。
export type Orientation = 'horizontal' | 'vertical';

/** BPMN イベントトリガ。none はマーカーなし */
export type EventTrigger =
  | 'none' | 'message' | 'timer' | 'error' | 'escalation' | 'cancel'
  | 'compensation' | 'conditional' | 'link' | 'signal' | 'terminate'
  | 'multiple' | 'parallelMultiple';

/** Activity 下部の繰り返しマーカー。loop と multi-instance は排他 */
export type ActivityLoop = 'loop' | 'parallel' | 'sequential';

/** 関連の種別。データ関連と Association を混同しない */
export type AssocKind = 'data' | 'undirected' | 'directed' | 'both';

/** 文書類(状態ノード)。時間軸の列を進めず、シーケンスを繋げない */
export const isDocLike = (k: NodeKind): boolean =>
  k === 'doc' || k === 'store' || k === 'note' || k === 'group';

export type EdgeKind = 'seq' | 'assoc' | 'msg'; // シーケンス / 関連(点線) / メッセージフロー(C-60。プール間のみ)

export interface IrLane {
  id: string; // 内部参照 ID。表示名が重なる場合も一意
  label: string;
  pool?: string; // 所属プール(C-03)。未指定は暗黙の単一プール
  blackbox?: boolean; // 黒箱プールの帯(レーン無しプール。枠そのものがポート。C-51)
  declIndex: number;
}

export interface IrPool {
  id: string;
  label: string;
  declIndex: number;
}

export interface IrNode {
  id: string; // 安定 ID（C-12）。DSL で明示必須
  kind: NodeKind; // 意味フィールド（C-13）
  // 第一種別。task: user/service/rule/script/send/receive/manual/call/sub/transaction/eventSub
  // start/end/mid/boundary: EventTrigger。xor: event/or/complex。and: event（並列イベント）。
  // doc: input/output/message
  subtype?: string;
  label: string;
  lane: string; // 意味フィールド。所属レーン
  declIndex: number;
  provisional: boolean; // 出所印「?」。AI 推定・自動補完で true
  synthetic: boolean; // P0 正規化が補ったノード（正規化レポートに載る）
  eventThrow?: boolean; // 中間イベントの throw。start は常に catch、end は常に throw
  interrupting?: boolean; // 境界 / Event Sub-Process 開始。省略時は割込み
  attachedTo?: string; // 境界イベントの対象 Activity
  callProcess?: boolean; // Call Activity: true=Process 呼出し(+付き) / false=Global Task
  callTaskType?: 'user' | 'manual' | 'script' | 'rule'; // Global Task 呼出しの標準タスクマーカー
  eventSubTrigger?: EventTrigger; // collapsed Event Sub-Process の Start Event
  eventSubInterrupting?: boolean;
  loop?: ActivityLoop;
  compensation?: boolean;
  adhoc?: boolean;
  collection?: boolean; // Data Object / Input / Output の集合マーカー
}

export interface IrEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  label?: string; // 条件ラベル
  mainHint: boolean; // 「=>」修辞ヒント: 本流の選挙で優先。Default Flow とは別概念
  returnHint?: boolean; // 「->>」修辞ヒント: 戻り辺の選挙で優先。DFS 既定とは別。向きと接続は変えない
  isDefault?: boolean; // BPMN Default Sequence Flow（斜線マーカー）。=> とは独立
  isConditional?: boolean; // Activity 起点の条件付きシーケンス（ミニ菱形）
  assocKind?: AssocKind; // kind==='assoc' のとき。省略時は data
  // 黒箱プール参照(C-51): 端点がノードでなくプール帯そのもの。from/to にはプール id が入る
  fromPool?: string;
  toPool?: string;
  declIndex: number;
  provisional: boolean;
  synthetic: boolean;
}

export interface Ir {
  id?: string; // flow id[label] の安定 ID。従来の表示名だけの形では未定義
  title?: string;
  orientation?: Orientation; // DSL の orientation 宣言。未宣言は CompileOptions か既定(horizontal)
  pools: IrPool[];
  lanes: IrLane[];
  nodes: IrNode[];
  edges: IrEdge[];
}

// ---- 診断 ----

export type DiagLevel = 'error' | 'warning' | 'info';

export interface Diagnostic {
  level: DiagLevel;
  code: string; // E-xxx / W-xxx / N-xxx（N = 正規化レポート）
  message: string;
  line?: number;
}

// ---- P0 正規化後グラフ ----

export interface NormNode extends IrNode {
  onSpine: boolean; // 本流の選挙結果（C-22）
}

export interface NormEdge extends IrEdge {
  isReturn: boolean; // 戻り辺の選挙結果（C-25）
  onSpine: boolean;
}

export interface NormGraph {
  id?: string;
  title?: string;
  orientation?: Orientation;
  pools: IrPool[];
  lanes: IrLane[];
  nodes: NormNode[];
  edges: NormEdge[];
  report: Diagnostic[]; // 正規化で行った書き換えの可視化（C-21 の -E 相当）
}

// ---- P1 計測 ----

export interface NodeCell {
  id: string;
  shapeW: number;
  shapeH: number;
  // 図形中心からセル外縁までの張り出し（外置きラベル込み）。行の基線合わせに使う
  topExt: number;
  bottomExt: number;
  leftExt: number;
  rightExt: number;
  labelLines: string[]; // 図形内（task）または外置き（それ以外）
  labelW: number;
  labelH: number;
  // イベント外置きラベルの実配置面。テキストは回転しないので向きごとに空き面が違う:
  // 横図はポートが左右 → ラベルは下(既定)/上、縦図はポートが上下 → ラベルは右(既定)/左
  labelSide?: 'top' | 'bottom' | 'left' | 'right';
}

// ---- P2 表配置 ----

export interface Placement {
  col: Map<string, number>; // nodeId -> 列
  row: Map<string, number>; // nodeId -> レーン内の行
  laneRows: Map<string, number>; // laneId -> 行数
  maxCol: number;
  // レーンごと行ごとの占有区間 [c0, c1]（チェーンが列範囲を予約する。C-33 対応の実体）
  reserved: Map<string, Array<{ row: number; c0: number; c1: number }>>;
}

// ---- P3 経路計画（回廊モデル） ----

// 辺の経路は記号座標の折れ線。数値座標は一切含まない（数値化は P4/P5）。
// 記号 x: ノードのポート x / 列溝 g のトラック / ノード中心 x
// 記号 y: ノードのポート y / 行チャネルのトラック / 行の基線
//
// 軸の契約: P2/P3 の x・y と left/right/top/bottom は**論理軸**である。
//   論理 x = 主軸(時間: right が下流) / 論理 y = 交差軸(レーン: bottom が交差+側)
// 横図では論理軸=実軸。縦図では P4/P5 が (x,y) を転置して実座標へ写す
// （論理 right→実 bottom、論理 bottom→実 right）。
// 向きの入り口は二つだけ: P1(計測)は回転しないテキストを実空間の面で測るため
// 向きを受け取り、P4/P5 が転置する。P0・P2・P3 は向きを知らない。
export type PortSide = 'left' | 'right' | 'top' | 'bottom';

// 列溝のトラックは「出」(左ブロック)と「入り」(右ブロック)に分割する。
// 出スタブは自トラックより左しか横切らず、入りアプローチは自トラックより右しか
// 横切らないので、基線上の平行重なりが構築上起きない(VLSI のチャネル配線と同型)。
export type GutterSide = 'exit' | 'entry';

export type SymX =
  | { t: 'portX'; id: string; side: PortSide }
  | { t: 'gutter'; g: number; side: GutterSide; run: number } // 列溝 g = 列 g の左側の溝。run は走行識別子
  | { t: 'nodeCX'; id: string; offset?: number };

export type SymY =
  | { t: 'portY'; id: string; side: PortSide }
  | { t: 'nodeCY'; id: string; offset?: number }
  | { t: 'portStubY'; id: string; side: 'top' | 'bottom'; offset: number }
  | { t: 'channel'; lane: string; row: number; run: number } // 行 row の上側チャネル。run はチャネル走行の識別子
  | { t: 'poolChannel'; gap: number; run: number } // 隣接プール間のメッセージ専用回廊
  | { t: 'rowMid'; lane: string; row: number }
  | { t: 'laneEdge'; lane: string; edge: 'top' | 'bottom' }; // 黒箱プール帯の縁(枠=ポート。C-51)

export interface SymPt {
  x: SymX;
  y: SymY;
}

export interface EdgePlan {
  edgeId: string;
  fromSide: PortSide;
  toSide: PortSide;
  points: SymPt[];
  pattern: 'direct' | 'drop' | 'row-column' | 'row-approach' | 'channel-approach' | 'return';
}

export interface RoutePlan {
  plans: EdgePlan[];
  gutterTracks: Map<number, { exit: number; entry: number }>; // 列溝 g -> 必要トラック数(側別)
  channelTracks: Map<string, number>; // `${lane}:${row}` -> 必要トラック数
  channelRunTrack: Map<number, number>; // チャネル run -> 入れ子順で決めたトラック番号
  poolGapTracks: Map<number, number>; // 上から gap 番目のプール間回廊 -> 必要トラック数
  poolGapRunTrack: Map<number, number>; // プール間 run -> トラック番号
  gutterRunTrack: Map<number, number>; // 列溝 run -> 入れ子順で決めたトラック番号(側内)
  gutterLabelNeed: Map<number, number>; // 列溝 g -> ラベル算入幅（C-62）
  poolExteriorGutter?: number; // 非隣接プール通信をプール枠外で縦走させる右外周溝
}

// ---- P4/P5 幾何 ----

export interface Pt {
  x: number;
  y: number;
}

export interface NodeGeom {
  id: string;
  kind: NodeKind;
  subtype?: string;
  label: string;
  labelLines: string[];
  lane: string;
  x: number; // 図形の外接箱
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  onSpine: boolean;
  provisional: boolean;
  synthetic: boolean;
  labelSide?: 'top' | 'bottom' | 'left' | 'right';
  eventThrow?: boolean;
  interrupting?: boolean;
  attachedTo?: string;
  callProcess?: boolean;
  callTaskType?: 'user' | 'manual' | 'script' | 'rule';
  eventSubTrigger?: EventTrigger;
  eventSubInterrupting?: boolean;
  loop?: ActivityLoop;
  compensation?: boolean;
  adhoc?: boolean;
  collection?: boolean;
}

export interface EdgeGeom {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  fromPool?: string;
  toPool?: string;
  label?: string;
  points: Pt[]; // 折れ線。全区間が水平か垂直
  labelPos?: Pt; // ラベル左上
  onSpine: boolean;
  isReturn: boolean;
  provisional: boolean;
  mainHint?: boolean;
  returnHint?: boolean;
  isDefault?: boolean;
  isConditional?: boolean;
  assocKind?: AssocKind;
  // 交差の飛び越し(ホップ)。幾何(points)には含めない描画糖衣。
  // BPMN DI に交差表現は無いため、ウェイポイントを汚さず描画時にだけ足す。
  hops?: Array<{ seg: number; x: number; y: number }>;
}

// レーン・プールは実座標の完全な矩形で持つ（横図=横帯、縦図=縦帯）
export interface LaneGeom {
  id: string;
  label: string;
  blackbox?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PoolGeom {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Geometry {
  title?: string;
  orientation: Orientation;
  width: number;
  height: number;
  headerW: number; // 見出し帯の厚み（横図=左の幅 / 縦図=上の高さ）
  bandRight: number; // プール／レーン帯の右端。横図ではこれより右が外周回廊
  bandBottom: number; // プール／レーン帯の下端。縦図ではこれより下が外周回廊
  pools: PoolGeom[]; // プールが無ければ空
  lanes: LaneGeom[];
  nodes: NodeGeom[];
  edges: EdgeGeom[];
}

// ---- 公開 API ----

export interface CompileOptions {
  strict?: boolean; // true: 警告水準の補完を許さない（C-15 の strict）
  // 未宣言ファイル向けの向きの既定値。DSL の orientation 宣言を正式な情報源として優先する。
  // 未指定は horizontal。
  orientation?: Orientation;
  // 配布 CLI が SVG に刻む生成元版。ライブラリ利用時の既定は dev。
  version?: string;
}

export interface CompileResult {
  svg: string;
  geometry: Geometry;
  normalized: NormGraph;
  diagnostics: Diagnostic[];
}
