#!/usr/bin/env node
// Process Model Generator CLI。
//   process-model-generator input.flow -o out.svg [--strict] [--vertical] [--emit-normalized]
// --vertical は未宣言ファイル向けの既定値。向きの正式な情報源である
// DSL の orientation 宣言があれば、そちらが優先される。

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { compile, CompileError } from './compile.ts';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detailSheet } from './detail-sheet.ts';
import { evaluateDelivery } from './eval.ts';

declare const __PROCESS_MODEL_GENERATOR_VERSION__: string;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;

function print(stream: NodeJS.WriteStream, value: string): void {
  const visible = stream.isTTY
    ? value.replace(CONTROL_CHARACTER, (character) => `\\x${character.codePointAt(0)!.toString(16).padStart(2, '0')}`)
    : value;
  (stream === process.stderr ? console.error : console.log)(visible);
}

if (process.stderr.isTTY) {
  process.on('uncaughtException', (error) => {
    print(process.stderr, error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}

const args = process.argv.slice(2);
if (args.includes('--version')) {
  print(process.stdout, __PROCESS_MODEL_GENERATOR_VERSION__);
  process.exit(0);
}
if (args[0] === 'eval') {
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const directory = valueAfter('--dir');
  const reportPath = valueAfter('--report');
  const parentId = valueAfter('--parent');
  const consulting = args.includes('--consulting');
  if (!directory || !reportPath) {
    print(process.stderr, 'usage: process-model-generator eval --dir <成果物dir> --report <review.md> [--parent <flow-id>] [--consulting]');
    process.exit(2);
  }
  const result = evaluateDelivery({
    directory,
    reportPath,
    parentId,
    consulting,
    version: __PROCESS_MODEL_GENERATOR_VERSION__,
  });
  for (const finding of result.findings) {
    const tag = finding.level === 'error' ? 'ERROR' : finding.level === 'warning' ? 'WARN ' : 'info ';
    print(process.stderr, `${tag} ${finding.code} ${finding.message}`);
  }
  const errors = result.findings.filter((finding) => finding.level === 'error').length;
  const warnings = result.findings.filter((finding) => finding.level === 'warning').length;
  print(process.stderr, `evaluated ${result.flowIds.length} views: ${errors} errors, ${warnings} warnings`);
  process.exit(errors > 0 ? 1 : 0);
}
const input = args.find((a) => !a.startsWith('-'));
const outIdx = args.indexOf('-o');
const output = outIdx >= 0 ? args[outIdx + 1] : undefined;
const strict = args.includes('--strict');
const emitNormalized = args.includes('--emit-normalized');
const verticalDefault = args.includes('--vertical');

if (!input) {
  print(process.stderr, 'usage: process-model-generator <input.flow|input.bpmn> [-o out.svg] [--strict] [--vertical] [--emit-normalized] | process-model-generator eval --dir <dir> --report <review.md> [--parent <flow-id>] [--consulting] | --version');
  process.exit(2);
}

try {
  if (input.endsWith('.bpmn')) {
    const directory=mkdtempSync(tmpdir()+'/bpmn-detail-');
    try {
      execFileSync('python3',[fileURLToPath(new URL('./bpmn-detail.py',import.meta.url)),input,directory,input]);
      const result=detailSheet(directory,verticalDefault ? 'vertical' : 'horizontal',__PROCESS_MODEL_GENERATOR_VERSION__);
      if (output) { mkdirSync(dirname(output),{recursive:true}); writeFileSync(output,result.svg); }
      else print(process.stdout,result.svg);
      if (emitNormalized) print(process.stderr,readFileSync(directory+'/detail.json','utf8'));
      print(process.stderr,`wrote complete detailed sheet (${result.width}x${result.height})`);
    } finally { rmSync(directory,{recursive:true,force:true}); }
    process.exit(0);
  }
  const source = readFileSync(input, 'utf8');
  const result = compile(source, {
    strict,
    orientation: verticalDefault ? 'vertical' : undefined,
    version: __PROCESS_MODEL_GENERATOR_VERSION__,
  });

  for (const d of result.diagnostics) {
    const tag = d.level === 'error' ? 'ERROR' : d.level === 'warning' ? 'WARN ' : 'info ';
    print(process.stderr, `${tag} ${d.code} ${d.message}${d.line !== undefined ? ` (line ${d.line})` : ''}`);
  }

  if (emitNormalized) {
    const n = result.normalized;
    print(process.stdout, '--- 正規化後 IR ---');
    for (const node of n.nodes) {
      print(process.stdout,
        `${node.kind}\t${node.id}\t[${node.label}]\tlane=${node.lane}` +
          `${node.onSpine ? '\tspine' : ''}${node.synthetic ? '\tsynthetic' : ''}${node.provisional ? '\t?' : ''}`,
      );
    }
    for (const e of n.edges) {
      print(process.stdout,
        `edge\t${e.kind}\t${e.from} -> ${e.to}${e.label ? `: ${e.label}` : ''}` +
          `${e.onSpine ? '\tspine' : ''}${e.isReturn ? '\treturn' : ''}${e.synthetic ? '\tsynthetic' : ''}`,
      );
    }
  }

  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, result.svg, 'utf8');
    print(process.stderr, `wrote ${output} (${result.geometry.width}x${result.geometry.height})`);
  } else {
    print(process.stdout, result.svg);
  }

  const hasError = result.diagnostics.some((d) => d.level === 'error');
  process.exit(hasError ? 1 : 0);
} catch (err) {
  if (err instanceof CompileError) {
    print(process.stderr, err.message);
    process.exit(1);
  }
  throw err;
}
