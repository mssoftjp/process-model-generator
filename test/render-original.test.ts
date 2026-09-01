import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const RENDERER = join(ROOT, 'tools', 'render-original.py');

function render(xml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'render-original-'));
  const input = join(dir, 'input.bpmn');
  const output = join(dir, 'output.html');
  try {
    writeFileSync(input, xml, 'utf8');
    execFileSync('python3', [RENDERER, input, output]);
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1">
  <bpmn:process id="Process_1">
    <bpmn:documentation><![CDATA[</ScRiPt ><script>globalThis.pwned = true</script>]]></bpmn:documentation>
    <bpmn:startEvent id="StartEvent_1" />
  </bpmn:process>
</bpmn:definitions>`;

describe('original BPMN renderer', () => {
  it('keeps mixed-case script terminators inside the XML string', () => {
    const html = render(BPMN);

    expect(html.match(/<\/script\s*>/gi)).toHaveLength(2);
    expect(html).not.toContain('</ScRiPt >');
    expect(html).toContain('\\u003c/ScRiPt >');
    const serialized = html.match(/const xml = (.*);\n/)?.[1] ?? '';
    expect(JSON.parse(serialized)).toBe(BPMN);
  });

  it('pins the CDN viewer and enforces the generated inline-script CSP hash', () => {
    const html = render(BPMN);
    const integrity = 'sha384-izUzsqBpTLenW0ylFgbiLMoW5T0/fTAi+oOM/yuwnzOZAc8OFynG1LHJGsCWEP4G';
    const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    const inlineScript = scripts.at(-1)?.[1] ?? '';
    const inlineHash = createHash('sha256').update(inlineScript).digest('base64');

    expect(html).toContain(`integrity="${integrity}"`);
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toContain(`script-src https://unpkg.com/bpmn-js@17.11.1/dist/bpmn-navigated-viewer.production.min.js 'sha256-${inlineHash}'`);
    expect(html).toContain("default-src 'none'");
  });
});
