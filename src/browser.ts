// ブラウザ向けエントリ。window.processModelGenerator に compile を公開する。
import { compile } from './compile.ts';

declare global {
  interface Window {
    processModelGenerator: { compile: typeof compile };
  }
}

window.processModelGenerator = { compile };
