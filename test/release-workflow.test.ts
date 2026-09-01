import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

describe('release workflow security boundary', () => {
  it('pins every action to a full commit SHA', () => {
    const refs = [...workflow.matchAll(/^\s*uses:\s+\S+@(\S+)/gm)].map((match) => match[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('keeps write authority in the artifact-only publish job', () => {
    expect(workflow.match(/contents: write/g)).toEqual(['contents: write']);
    expect(workflow).toMatch(/\n  build:\n[\s\S]*?\n    permissions:\n      contents: read/);
    expect(workflow).toMatch(/\n  publish:\n[\s\S]*?\n    permissions:\n      contents: write/);
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('artifact-ids: ${{ needs.build.outputs.release-artifact-id }}');
  });
});
