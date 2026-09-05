import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, parse } from './compile.ts';
import { wrapText } from './metrics.ts';
import type { Orientation } from './types.ts';
const esc = (s:string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function detailSheet(directory:string, orientation:Orientation, version='dev') {
  const detail = JSON.parse(readFileSync(join(directory,'detail.json'),'utf8'));
  if (!detail.complete) throw new Error(`Incomplete source coverage: ${JSON.stringify(detail.missing)}`);
  let y=0, width=0;
  const parts:string[]=[];
  const diagnostics=[];
  for (const [i,view] of detail.views.entries()) {
    const source=readFileSync(join(directory,view.file),'utf8');
    const ir=parse(source).ir;
    for (const e of view.edges) if (!ir.edges.some(edge=>edge.kind==='seq' && edge.from===e.fromId && edge.to===e.toId && (!e.label || edge.label===e.label))) throw new Error(`Scope connection missing: ${view.id} ${JSON.stringify(e)}`);
    const r=compile(source,{strict:true,orientation,version});
    diagnostics.push(...r.diagnostics);
    width=Math.max(width,r.geometry.width);
    const parent=detail.views.find((v:{id:string})=>v.id===view.parent);
    const heading=i ? `${view.label} — inside ${parent?.label ?? 'Whole process'}` : 'Whole process';
    parts.push(`<text x="24" y="${y+24}" font-size="16">${esc(heading)}</text>`);
    // Retain independent scope geometry; compose one SVG without cross-scope sequence edges.
    const inner=r.svg.replace('<svg ',`<svg x="0" y="${y+36}" `).replace(/(?<=\s)id="([^"]+)"/g,`id="scope${i}-$1"`);
    parts.push(inner); y+=r.geometry.height+64;
  }
  for (const item of detail.metadata) {
    const title=`${item.label} — ${item.kind==='attribute' ? item.name.replace(/^.*}/,'')+' = '+item.value : 'Extension details'}`;
    const content=(item.lines ?? []).join('\n');
    for (const line of [...wrapText(title,850,14),...content.split('\n').flatMap((line:string)=>wrapText(line,850,14))]) {
      parts.push(`<text x="24" y="${y+24}" font-size="14">${esc(line)}</text>`); y+=22;
    }
    y+=24; width=Math.max(width,920);
  }
  return {svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y}" viewBox="0 0 ${width} ${y}" font-family="sans-serif"><metadata>${esc(JSON.stringify(detail))}</metadata><rect width="100%" height="100%" fill="white"/>${parts.join('\n')}</svg>`, diagnostics, width, height:y};
}
