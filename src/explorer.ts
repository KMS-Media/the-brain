import type { Memory } from "./core.js";
import { KNOWLEDGE_LABELS, type NodeLabel } from "./types.js";

/**
 * Visual Graph Explorer (PRD §21 V2).
 *
 * Exports the project's knowledge graph to a single self-contained HTML file
 * with an inline force-directed visualization — no external assets, so it
 * opens offline and satisfies a strict CSP. Knowledge nodes and components are
 * included by default; the (potentially huge) File/Directory/GitCommit
 * structure is opt-in.
 */

export interface GraphNode {
  id: string;
  label: NodeLabel;
  title: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

const REL_TYPES = [
  "CONTAINS",
  "USES",
  "CALLS",
  "DEPENDS_ON",
  "AFFECTS",
  "REPLACES",
  "IMPLEMENTS",
  "VIOLATES",
  "SOLVES",
  "RELATES_TO",
  "MODIFIES",
  "FIXES",
];

function titleOf(label: NodeLabel, p: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const raw =
    s(p.title) || s(p.name) || s(p.rule) || s(p.problem) || s(p.path) || s(p.hash) || s(p.id);
  return raw.replace(/\s+/g, " ").slice(0, 80);
}

export interface ExportOptions {
  includeStructure?: boolean;
  perLabelLimit?: number;
}

/** Pull nodes + edges from the graph into a plain, serializable structure. */
export async function exportGraph(memory: Memory, opts: ExportOptions = {}): Promise<GraphData> {
  const perLabelLimit = opts.perLabelLimit ?? 200;
  const labels: NodeLabel[] = [...KNOWLEDGE_LABELS, "Project"];
  if (opts.includeStructure) labels.push("Directory", "File", "GitCommit");

  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  let truncated = false;

  for (const label of labels) {
    const rows = await memory.db.query(`MATCH (n:${label}) RETURN n LIMIT ${perLabelLimit + 1};`);
    if (rows.length > perLabelLimit) truncated = true;
    for (const row of rows.slice(0, perLabelLimit)) {
      const n = row.n as Record<string, unknown>;
      const id = String(n.id);
      if (ids.has(id)) continue;
      ids.add(id);
      nodes.push({ id, label, title: titleOf(label, n) });
    }
  }

  const edges: GraphEdge[] = [];
  for (const type of REL_TYPES) {
    const rows = await memory.db.query(`MATCH (a)-[:${type}]->(b) RETURN a.id AS f, b.id AS t;`);
    for (const row of rows) {
      const from = String(row.f);
      const to = String(row.t);
      if (ids.has(from) && ids.has(to)) edges.push({ from, to, type });
    }
  }

  return { nodes, edges, truncated };
}

const LABEL_COLORS: Record<string, string> = {
  ReviewFinding: "#ef4444",
  CodingStandard: "#f59e0b",
  Decision: "#8b5cf6",
  Component: "#10b981",
  Experience: "#06b6d4",
  Knowledge: "#3b82f6",
  Problem: "#ec4899",
  Project: "#64748b",
  Directory: "#94a3b8",
  File: "#cbd5e1",
  GitCommit: "#a3a3a3",
};

/** Render the graph data as a standalone interactive HTML document. */
export function renderHtml(data: GraphData, projectName: string): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const colors = JSON.stringify(LABEL_COLORS);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>🧠 the_brain — ${escapeHtml(projectName)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b1020; color: #e2e8f0; overflow: hidden; }
  #hud { position: fixed; top: 12px; left: 12px; z-index: 10; background: rgba(15,23,42,.85); border: 1px solid #1e293b; border-radius: 10px; padding: 12px 14px; max-width: 280px; backdrop-filter: blur(4px); }
  #hud h1 { font-size: 14px; margin: 0 0 6px; }
  #hud .meta { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
  #legend { display: flex; flex-direction: column; gap: 4px; font-size: 12px; max-height: 40vh; overflow: auto; }
  .lg { display: flex; align-items: center; gap: 6px; cursor: pointer; opacity: .9; }
  .lg .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .lg.off { opacity: .35; text-decoration: line-through; }
  #tip { position: fixed; pointer-events: none; z-index: 20; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 4px 8px; font-size: 12px; display: none; max-width: 320px; }
  #empty { position: fixed; inset: 0; display: grid; place-items: center; color: #64748b; font-size: 14px; }
  canvas { display: block; }
</style>
</head>
<body>
<div id="hud">
  <h1>🧠 ${escapeHtml(projectName)}</h1>
  <div class="meta" id="meta"></div>
  <div id="legend"></div>
</div>
<div id="tip"></div>
<canvas id="c"></canvas>
<script>
const DATA = ${json};
const COLORS = ${colors};
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const tip = document.getElementById('tip');
let W, H, dpr;
function resize(){ dpr = window.devicePixelRatio||1; W=cv.clientWidth=innerWidth; H=cv.clientHeight=innerHeight; cv.width=W*dpr; cv.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
addEventListener('resize', resize); resize();

const hidden = new Set();
const nodes = DATA.nodes.map((n,i)=>({ ...n, x: W/2 + Math.cos(i)*200*Math.random()+ (Math.random()-.5)*W*0.6, y: H/2 + Math.sin(i)*200*Math.random()+(Math.random()-.5)*H*0.6, vx:0, vy:0 }));
const byId = new Map(nodes.map(n=>[n.id,n]));
const edges = DATA.edges.filter(e=>byId.has(e.from)&&byId.has(e.to)).map(e=>({a:byId.get(e.from), b:byId.get(e.to), type:e.type}));
nodes.forEach(n=>n.deg = edges.reduce((s,e)=>s+(e.a===n||e.b===n?1:0),0));

document.getElementById('meta').textContent = nodes.length + ' nodes · ' + edges.length + ' edges' + (DATA.truncated?' (truncated)':'');

// view transform (pan/zoom)
let scale=1, ox=0, oy=0;
let view = () => ({scale, ox, oy});
const toWorld = (sx,sy)=>({x:(sx-ox)/scale, y:(sy-oy)/scale});

// legend with toggles
const labels = [...new Set(nodes.map(n=>n.label))];
const legend = document.getElementById('legend');
for(const l of labels){
  const row = document.createElement('div'); row.className='lg';
  row.innerHTML = '<span class="dot" style="background:'+(COLORS[l]||'#888')+'"></span>'+l+' ('+nodes.filter(n=>n.label===l).length+')';
  row.onclick = ()=>{ if(hidden.has(l)){hidden.delete(l);row.classList.remove('off');}else{hidden.add(l);row.classList.add('off');} };
  legend.appendChild(row);
}
const visible = n => !hidden.has(n.label);

// physics
function step(){
  const k = 0.02;
  for(let i=0;i<nodes.length;i++){
    const a=nodes[i]; if(!visible(a))continue;
    for(let j=i+1;j<nodes.length;j++){
      const b=nodes[j]; if(!visible(b))continue;
      let dx=a.x-b.x, dy=a.y-b.y, d2=dx*dx+dy*dy+0.01, d=Math.sqrt(d2);
      const rep = 1400/d2; const fx=dx/d*rep, fy=dy/d*rep;
      a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy;
    }
    a.vx += (W/2 - a.x)*0.0008; a.vy += (H/2 - a.y)*0.0008; // gravity
  }
  for(const e of edges){ if(!visible(e.a)||!visible(e.b))continue;
    let dx=e.b.x-e.a.x, dy=e.b.y-e.a.y, d=Math.hypot(dx,dy)+0.01;
    const f=(d-90)*k; const fx=dx/d*f, fy=dy/d*f;
    e.a.vx+=fx; e.a.vy+=fy; e.b.vx-=fx; e.b.vy-=fy;
  }
  for(const n of nodes){ if(n===drag)continue; n.vx*=0.85; n.vy*=0.85; n.x+=n.vx; n.y+=n.vy; }
}
function radius(n){ return 4 + Math.min(10, n.deg*1.2); }
function draw(){
  ctx.clearRect(0,0,W,H);
  ctx.save(); ctx.translate(ox,oy); ctx.scale(scale,scale);
  ctx.lineWidth = 1/scale; ctx.strokeStyle='rgba(148,163,184,.18)';
  for(const e of edges){ if(!visible(e.a)||!visible(e.b))continue; ctx.beginPath(); ctx.moveTo(e.a.x,e.a.y); ctx.lineTo(e.b.x,e.b.y); ctx.stroke(); }
  for(const n of nodes){ if(!visible(n))continue;
    const r=radius(n); ctx.beginPath(); ctx.arc(n.x,n.y,r,0,7); ctx.fillStyle=COLORS[n.label]||'#888'; ctx.fill();
    if(scale>0.9){ ctx.fillStyle='#cbd5e1'; ctx.font=(11)+'px sans-serif'; ctx.fillText(n.title, n.x+r+2, n.y+3); }
  }
  ctx.restore();
}
function loop(){ step(); draw(); requestAnimationFrame(loop); }
loop();

// interaction: drag nodes, pan, zoom, hover tooltip
let drag=null, panning=false, lastX, lastY;
function pick(sx,sy){ const w=toWorld(sx,sy); let best=null,bd=1e9; for(const n of nodes){ if(!visible(n))continue; const d=Math.hypot(n.x-w.x,n.y-w.y); if(d<radius(n)+4 && d<bd){bd=d;best=n;} } return best; }
cv.addEventListener('mousedown', e=>{ const n=pick(e.clientX,e.clientY); if(n){drag=n;} else {panning=true; lastX=e.clientX; lastY=e.clientY;} });
addEventListener('mousemove', e=>{
  if(drag){ const w=toWorld(e.clientX,e.clientY); drag.x=w.x; drag.y=w.y; drag.vx=drag.vy=0; }
  else if(panning){ ox+=e.clientX-lastX; oy+=e.clientY-lastY; lastX=e.clientX; lastY=e.clientY; }
  else { const n=pick(e.clientX,e.clientY); if(n){ tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px'; tip.textContent=n.label+': '+n.title; } else tip.style.display='none'; }
});
addEventListener('mouseup', ()=>{ drag=null; panning=false; });
cv.addEventListener('wheel', e=>{ e.preventDefault(); const f=e.deltaY<0?1.1:0.9; const mx=e.clientX, my=e.clientY; ox=mx-(mx-ox)*f; oy=my-(my-oy)*f; scale*=f; }, {passive:false});
if(nodes.length===0){ document.body.insertAdjacentHTML('beforeend','<div id="empty">No nodes yet — add knowledge or run <code>brain ingest</code>.</div>'); }
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
