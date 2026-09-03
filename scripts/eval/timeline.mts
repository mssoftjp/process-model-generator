// Build one HTML page that overlays the same figure from several snapshots.
//
//   npx tsx scripts/eval/timeline.mts <out.html> <label=dir[:verticalDir]> ...
//
// Each argument names a snapshot directory written by snapshot.mts (optionally with a second,
// vertical snapshot after a colon). The page lists every figure with its bends / crossings /
// area change between the first and last snapshot, and shows two chosen snapshots of one figure
// as a tinted overlay (A teal, B magenta, overlaps dark), a wipe, or stacked. Lines are drawn at
// natural size and aligned top-left, so growth shows as B running past A.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, ...specs] = process.argv.slice(2);
if (!out || specs.length < 2) {
  console.error('usage: timeline.mts <out.html> <label=dir[:verticalDir]> <label=dir[:verticalDir]> ...');
  process.exit(2);
}
const versions = specs.map((spec, i) => {
  const eq = spec.indexOf('=');
  const label = eq < 0 ? `v${i + 1}` : spec.slice(0, eq);
  const [dir, vdir] = (eq < 0 ? spec : spec.slice(eq + 1)).split(':');
  return { id: `v${i}`, label, dir: dir!, vdir };
});
const hasVertical = versions.every((v) => v.vdir);

const svgs: string[] = [];
const index = new Map<string, number>();
const intern = (s: string) => {
  let i = index.get(s);
  if (i === undefined) { i = svgs.length; svgs.push(s); index.set(s, i); }
  return i;
};
type Stat = { bends: number; hops: number; area: number };
const metricsOf = (dir: string) => {
  const m = JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8'));
  return new Map<string, Stat & { error?: string }>(m.rows.map((r: any) => [r.name, r]));
};
const names = readdirSync(versions[0]!.dir).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();
const metrics = new Map(versions.map((v) => [v.id, metricsOf(v.dir)]));
const vmetrics = hasVertical ? new Map(versions.map((v) => [v.id, metricsOf(v.vdir!)])) : undefined;
const figures = names.map((name) => {
  const byVersion: Record<string, number> = {};
  const vByVersion: Record<string, number> = {};
  const stats: Record<string, Stat> = {};
  const vstats: Record<string, Stat> = {};
  for (const v of versions) {
    byVersion[v.id] = intern(readFileSync(join(v.dir, name + '.svg'), 'utf8'));
    const r = metrics.get(v.id)!.get(name)!;
    stats[v.id] = { bends: r.bends, hops: r.hops, area: r.area };
    if (hasVertical) {
      vByVersion[v.id] = intern(readFileSync(join(v.vdir!, name + '.svg'), 'utf8'));
      const vr = vmetrics!.get(v.id)!.get(name)!;
      vstats[v.id] = { bends: vr.bends, hops: vr.hops, area: vr.area };
    }
  }
  const title = svgs[byVersion[versions[0]!.id]!]!.match(/<title>([^<]*)<\/title>/)?.[1] ?? name;
  return { name, title, byVersion, vByVersion, stats, vstats };
});
const first = versions[0]!.id;
const last = versions[versions.length - 1]!.id;
const payload = JSON.stringify({ versions, figures, svgs, hasVertical, first, last }).replace(/<\/script/gi, '<\\/script');

const html = `<title>Layout Timeline</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --ground:#F3F4F2; --panel:#FFFFFF; --ink:#1E2226; --muted:#667079; --line:#D8DCD9; --line-strong:#B9C0BC;
  --a:#0F766E; --a-soft:#D9EFEC; --b:#B4266B; --b-soft:#F6DCE8; --worse:#B4266B; --better:#0F766E; --focus:#2457D6;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --ground:#16191B; --panel:#1F2327; --ink:#E6E8E4; --muted:#98A1A8; --line:#333A3F; --line-strong:#4A535A;
    --a:#2DD4BF; --a-soft:#173B38; --b:#F472B6; --b-soft:#45213A; --worse:#F472B6; --better:#2DD4BF; --focus:#7AA2FF;
  }
}
:root[data-theme="dark"]{
  --ground:#16191B; --panel:#1F2327; --ink:#E6E8E4; --muted:#98A1A8; --line:#333A3F; --line-strong:#4A535A;
  --a:#2DD4BF; --a-soft:#173B38; --b:#F472B6; --b-soft:#45213A; --worse:#F472B6; --better:#2DD4BF; --focus:#7AA2FF;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:"IBM Plex Sans JP",system-ui,-apple-system,"Hiragino Sans",sans-serif;font-size:13px;line-height:1.5;height:100vh;display:grid;grid-template-columns:280px 1fr;grid-template-rows:auto 1fr;overflow:hidden}
.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
header{grid-column:1/3;display:flex;align-items:baseline;gap:16px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:15px;font-weight:600;margin:0}
header p{margin:0;color:var(--muted)}
aside{border-right:1px solid var(--line);background:var(--panel);overflow:auto}
aside .head{padding:10px 14px 6px;color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.fig{display:grid;grid-template-columns:1fr auto;gap:2px 10px;width:100%;text-align:left;padding:8px 14px;border:0;border-left:3px solid transparent;background:none;color:inherit;font:inherit;cursor:pointer}
.fig:hover{background:var(--ground)}
.fig[aria-current="true"]{border-left-color:var(--focus);background:var(--ground)}
.fig:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.fig .t{font-weight:500;grid-column:1/3}
.fig .d{color:var(--muted);font-size:11.5px}
.fig .d b{font-weight:500;color:var(--ink)}
.fig .d.worse b{color:var(--worse)} .fig .d.better b{color:var(--better)}
main{display:grid;grid-template-rows:auto auto 1fr;min-width:0;min-height:0}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
.group{display:flex;align-items:center;gap:6px}
.group>span.lbl{color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin-right:2px}
.chips{display:flex;gap:4px}
.chip{border:1px solid var(--line-strong);background:var(--panel);color:var(--ink);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
.chip:hover{background:var(--ground)}
.chip:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.chips[data-side="a"] .chip[aria-pressed="true"]{background:var(--a-soft);border-color:var(--a)}
.chips[data-side="b"] .chip[aria-pressed="true"]{background:var(--b-soft);border-color:var(--b)}
.swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:6px;overflow:hidden}
.seg button{border:0;background:var(--panel);color:var(--ink);font:inherit;font-size:12px;padding:4px 10px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line-strong)}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--panel)}
input[type=range]{accent-color:var(--focus);width:140px}
.stats{display:flex;flex-wrap:wrap;gap:18px;padding:8px 18px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;background:var(--panel)}
.stats b{color:var(--ink);font-weight:500}
.stats .worse b{color:var(--worse)} .stats .better b{color:var(--better)}
.stage{overflow:auto;position:relative;padding:18px;background:var(--ground)}
.canvas{position:relative;background:#fff;border:1px solid var(--line);width:max-content}
.layer{position:absolute;left:0;top:0;isolation:isolate}
.layer img{display:block}
.canvas.tint .layer.a{background:var(--a)} .canvas.tint .layer.b{background:var(--b)}
.canvas.tint .layer img{mix-blend-mode:screen}
.canvas.tint .layer.b{mix-blend-mode:multiply}
.canvas.mode-side{display:grid;gap:18px;background:transparent;border:0}
.canvas.mode-side .layer{position:static;background:#fff;border:1px solid var(--line)}
.canvas.mode-side .layer::before{content:attr(data-label);display:block;padding:4px 10px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--line)}
.legend{display:flex;gap:14px;align-items:center;color:var(--muted);font-size:12px}
@media (prefers-reduced-motion: no-preference){.layer{transition:opacity .12s linear}}
</style>
<header>
  <h1>Layout Timeline</h1>
  <p>The same figure from several snapshots, drawn at natural size and aligned top-left.</p>
</header>
<aside>
  <div class="head">Figures (first → last snapshot)</div>
  <div id="list"></div>
</aside>
<main>
  <div class="bar">
    <div class="group"><span class="lbl">A</span><div class="chips" data-side="a" id="chipsA"></div></div>
    <div class="group"><span class="lbl">B</span><div class="chips" data-side="b" id="chipsB"></div></div>
    <div class="group" id="orientGroup"><span class="lbl">Orientation</span>
      <div class="seg" id="orient">
        <button data-orient="h" aria-pressed="true">Horizontal</button>
        <button data-orient="v" aria-pressed="false">Vertical</button>
      </div>
    </div>
    <div class="group"><span class="lbl">View</span>
      <div class="seg" id="mode">
        <button data-mode="overlay" aria-pressed="true">Overlay</button>
        <button data-mode="wipe" aria-pressed="false">Wipe</button>
        <button data-mode="side" aria-pressed="false">Stacked</button>
      </div>
    </div>
    <div class="group" id="opacityGroup"><span class="lbl">B opacity</span><input type="range" id="opacity" min="0" max="100" value="100" aria-label="B opacity"></div>
    <div class="group" id="wipeGroup" hidden><span class="lbl">Wipe</span><input type="range" id="wipe" min="0" max="100" value="50" aria-label="Wipe position"></div>
    <div class="group"><span class="lbl">Zoom</span><input type="range" id="zoom" min="40" max="160" value="100" aria-label="Zoom"><span class="mono" id="zoomVal">100%</span></div>
    <div class="legend" id="legend"><span><i class="swatch" style="background:var(--a)"></i>A</span><span><i class="swatch" style="background:var(--b)"></i>B</span><span>overlap is dark</span></div>
  </div>
  <div class="stats" id="stats"></div>
  <div class="stage"><div class="canvas tint mode-overlay" id="canvas">
    <div class="layer a" id="layerA"><img alt="Snapshot A"></div>
    <div class="layer b" id="layerB"><img alt="Snapshot B"></div>
  </div></div>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  const url = (i) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data.svgs[i]);
  const state = { fig: 0, a: data.first, b: data.last, mode: 'overlay', opacity: 1, wipe: 0.5, zoom: 1, orient: 'h' };
  try { Object.assign(state, JSON.parse(localStorage.getItem('layout-timeline') || '{}')); } catch {}
  if (!data.versions.some((v) => v.id === state.a)) state.a = data.first;
  if (!data.versions.some((v) => v.id === state.b)) state.b = data.last;
  if (!data.hasVertical) state.orient = 'h';
  const save = () => { try { localStorage.setItem('layout-timeline', JSON.stringify(state)); } catch {} };
  const $ = (id) => document.getElementById(id);
  const vers = (f) => (state.orient === 'v' ? f.vByVersion : f.byVersion);
  const stat = (f) => (state.orient === 'v' ? f.vstats : f.stats);
  const vLabel = (id) => (data.versions.find((x) => x.id === id) || { label: id }).label;
  const fmt = (n) => n.toLocaleString();
  const changed = (f) => data.svgs[vers(f)[data.first]] !== data.svgs[vers(f)[data.last]];
  const list = $('list');
  function buildList() {
    list.innerHTML = '';
    const ordered = data.figures.map((f, i) => ({ f, i })).sort((x, y) => (changed(y.f) ? 1 : 0) - (changed(x.f) ? 1 : 0) || x.i - y.i);
    for (const { f, i } of ordered) {
      const b = document.createElement('button');
      b.className = 'fig'; b.type = 'button'; b.dataset.index = i;
      const st = stat(f);
      const [h0, h1] = [st[data.first].hops, st[data.last].hops];
      const [b0, b1] = [st[data.first].bends, st[data.last].bends];
      const ar = Math.round(100 * st[data.last].area / st[data.first].area - 100);
      const cls = (x, y) => (y > x ? 'd worse' : y < x ? 'd better' : 'd');
      b.innerHTML = '<span class="t">' + f.title + '</span>'
        + '<span class="' + cls(h0, h1) + '">crossings <b class="mono">' + h0 + '→' + h1 + '</b></span>'
        + '<span class="' + cls(b0, b1) + '">bends <b class="mono">' + b0 + '→' + b1 + '</b></span>'
        + '<span class="' + (ar > 0 ? 'd worse' : ar < 0 ? 'd better' : 'd') + '">area <b class="mono">' + (ar > 0 ? '+' : '') + ar + '%</b></span>'
        + '<span class="d">' + (changed(f) ? '' : 'unchanged') + '</span>';
      b.addEventListener('click', () => { state.fig = i; render(); });
      list.appendChild(b);
    }
  }
  const chips = (host, side) => {
    for (const v of data.versions) {
      const c = document.createElement('button');
      c.className = 'chip'; c.type = 'button'; c.textContent = v.label; c.title = v.dir; c.dataset.id = v.id;
      c.addEventListener('click', () => { state[side] = v.id; render(); });
      host.appendChild(c);
    }
  };
  chips($('chipsA'), 'a'); chips($('chipsB'), 'b');
  $('orientGroup').hidden = !data.hasVertical;
  for (const btn of $('orient').querySelectorAll('button')) btn.addEventListener('click', () => { state.orient = btn.dataset.orient; buildList(); render(); });
  for (const btn of $('mode').querySelectorAll('button')) btn.addEventListener('click', () => { state.mode = btn.dataset.mode; render(); });
  $('opacity').addEventListener('input', (e) => { state.opacity = e.target.value / 100; render(false); });
  $('wipe').addEventListener('input', (e) => { state.wipe = e.target.value / 100; render(false); });
  $('zoom').addEventListener('input', (e) => { state.zoom = e.target.value / 100; render(false); });
  const imgA = $('layerA').querySelector('img');
  const imgB = $('layerB').querySelector('img');
  const size = (svg) => {
    const m = svg.match(/<svg[^>]*\\bwidth="([\\d.]+)"[^>]*\\bheight="([\\d.]+)"/) || svg.match(/viewBox="0 0 ([\\d.]+) ([\\d.]+)"/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : [800, 400];
  };
  function render(full = true) {
    save();
    const f = data.figures[state.fig];
    for (const b of list.children) b.setAttribute('aria-current', String(Number(b.dataset.index) === state.fig));
    for (const c of $('chipsA').children) c.setAttribute('aria-pressed', String(c.dataset.id === state.a));
    for (const c of $('chipsB').children) c.setAttribute('aria-pressed', String(c.dataset.id === state.b));
    for (const btn of $('mode').querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode));
    for (const btn of $('orient').querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.orient === state.orient));
    $('opacityGroup').hidden = state.mode !== 'overlay';
    $('wipeGroup').hidden = state.mode !== 'wipe';
    $('legend').hidden = state.mode !== 'overlay';
    $('zoomVal').textContent = Math.round(state.zoom * 100) + '%';
    const canvas = $('canvas');
    canvas.className = 'canvas mode-' + state.mode + (state.mode === 'overlay' ? ' tint' : '');
    const fv = vers(f);
    const svgA = data.svgs[fv[state.a]], svgB = data.svgs[fv[state.b]];
    if (full) { imgA.src = url(fv[state.a]); imgB.src = url(fv[state.b]); }
    const [wa, ha] = size(svgA), [wb, hb] = size(svgB);
    const z = state.zoom;
    imgA.style.width = (wa * z) + 'px'; imgA.style.height = (ha * z) + 'px';
    imgB.style.width = (wb * z) + 'px'; imgB.style.height = (hb * z) + 'px';
    const la = $('layerA'), lb = $('layerB');
    la.dataset.label = 'A · ' + vLabel(state.a);
    lb.dataset.label = 'B · ' + vLabel(state.b);
    if (state.mode === 'side') {
      canvas.style.width = ''; canvas.style.height = '';
      la.style.opacity = lb.style.opacity = 1; lb.style.clipPath = '';
    } else {
      canvas.style.width = Math.max(wa, wb) * z + 'px'; canvas.style.height = Math.max(ha, hb) * z + 'px';
      la.style.opacity = 1;
      lb.style.opacity = state.mode === 'overlay' ? state.opacity : 1;
      lb.style.clipPath = state.mode === 'wipe' ? 'inset(0 0 0 ' + (state.wipe * 100) + '%)' : '';
    }
    const st = stat(f);
    const row = (label, key) => {
      const x = st[state.a][key], y = st[state.b][key];
      const cls = y > x ? 'worse' : y < x ? 'better' : '';
      return '<span class="' + cls + '">' + label + ' <b class="mono">' + fmt(x) + ' → ' + fmt(y) + '</b></span>';
    };
    const ar = Math.round(100 * st[state.b].area / st[state.a].area - 100);
    $('stats').innerHTML = '<span><b>' + f.title + '</b></span>'
      + '<span>A <b>' + vLabel(state.a) + '</b></span><span>B <b>' + vLabel(state.b) + '</b></span>'
      + row('crossings', 'hops') + row('bends', 'bends')
      + '<span class="' + (ar > 0 ? 'worse' : ar < 0 ? 'better' : '') + '">area <b class="mono">' + (ar > 0 ? '+' : '') + ar + '%</b></span>'
      + (svgA === svgB ? '<span>identical SVG</span>' : '');
  }
  buildList();
  render();
})();
</script>
`;
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024 / 1024).toFixed(2)} MB, ${svgs.length} distinct SVGs, ${figures.length} figures)`);
