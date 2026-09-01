// R5: 計測の所有権。
// 寸法は「環境が返す値」ではなく「エンジンが定義する入力」。
// - 文字送りはこの表で引く（レンダラに訊かない）
// - 改行はエンジンの禁則処理で行う（SVG には行ごとの tspan を明示する）
// - 全寸法は格子 GRID の整数倍に量子化する（C-52, C-54）
// SVG 側は textLength で描画幅を計測値に強制するため、表の誤差は絵に漏れない（C-83）。

export const GRID = 8;
export const FONT_SIZE = 14;
export const LINE_H = 20;
export const EDGE_FONT_SIZE = 11;
export const TITLE_FONT_SIZE = 16;

// 半角グリフの送り幅（em/1000, Helvetica 系近似）
const ASCII_W: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  '{': 334, '|': 260, '}': 334, '~': 584,
};
const NARROW = new Set('iljftrI.,;:!|\'"()[]');
const WIDE = new Set('mwMW@%&');

function charWidthEm(ch: string): number {
  const cp = ch.codePointAt(0)!;
  // 半角英数
  if (cp < 0x80) {
    if (ASCII_W[ch] !== undefined) return ASCII_W[ch] / 1000;
    if (cp >= 0x30 && cp <= 0x39) return 0.556; // digits
    if (NARROW.has(ch)) return 0.24;
    if (WIDE.has(ch)) return 0.85;
    if (ch >= 'A' && ch <= 'Z') return 0.68;
    return 0.53; // lowercase ほか
  }
  // 半角カナ
  if (cp >= 0xff61 && cp <= 0xff9f) return 0.5;
  // それ以外（CJK・全角記号・かな）は全角
  return 1.0;
}

export function measureText(text: string, fontSize = FONT_SIZE): number {
  let w = 0;
  for (const ch of text) w += charWidthEm(ch);
  return w * fontSize;
}

// 禁則: 行頭に置けない / 行末に置けない
const KINSOKU_HEAD = new Set(
  '、。，．）」』】〉》〕｝”’!?！？ゝゞ々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮーヵヶ・…‥:;：；,.)]}〟',
);
const KINSOKU_TAIL = new Set('（「『【〈《〔｛“‘([{〝');

function isCjk(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return cp >= 0x3000 && cp <= 0x9fff || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xff00 && cp <= 0xffef;
}

// 分割可能点: 位置 i（chars[i] の直前）で折ってよいか
function canBreakBefore(chars: string[], i: number): boolean {
  if (i <= 0 || i >= chars.length) return false;
  const prev = chars[i - 1]!;
  const next = chars[i]!;
  if (KINSOKU_HEAD.has(next)) return false;
  if (KINSOKU_TAIL.has(prev)) return false;
  if (prev === ' ') return true;
  // CJK が絡めばどこでも折れる。欧文単語の中間では折らない
  if (isCjk(prev) || isCjk(next)) return true;
  return false;
}

/** 貪欲折返し。maxWidth を超える直前の分割可能点で折る。分割可能点が無い塊は溢れを許す */
export function wrapText(text: string, maxWidth: number, fontSize = FONT_SIZE): string[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const lines: string[] = [];
  let lineStart = 0;
  let lineW = 0;
  let lastBreak = -1;
  for (let i = 0; i < chars.length; i++) {
    const w = charWidthEm(chars[i]!) * fontSize;
    if (canBreakBefore(chars, i)) lastBreak = i;
    if (lineW + w > maxWidth && lineW > 0 && lastBreak > lineStart) {
      lines.push(chars.slice(lineStart, lastBreak).join('').trimEnd());
      lineStart = lastBreak;
      lineW = 0;
      for (let j = lineStart; j <= i; j++) lineW += charWidthEm(chars[j]!) * fontSize;
      lastBreak = -1;
      continue;
    }
    lineW += w;
  }
  lines.push(chars.slice(lineStart).join('').trimEnd());
  return lines.map((l) => l.replace(/^ +/, ''));
}

/** 上方向への格子量子化 */
export function quant(v: number): number {
  return Math.ceil(v / GRID) * GRID;
}

/** Truncate with an ellipsis (docs/architecture/style-spec.md, S-93). */
export function truncate(text: string, maxWidth: number, fontSize = FONT_SIZE): string {
  if (measureText(text, fontSize) <= maxWidth) return text;
  const ell = '…';
  const ellW = charWidthEm(ell) * fontSize;
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = charWidthEm(ch) * fontSize;
    if (w + cw + ellW > maxWidth) break;
    out += ch;
    w += cw;
  }
  return out + ell;
}
