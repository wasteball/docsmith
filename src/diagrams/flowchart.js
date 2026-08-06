/* =====================================================================
 * Docsmith · 流程图 / 状态图
 * ---------------------------------------------------------------------
 * 这两种图共用同一套解析和布局 —— 它们都是「节点 + 有向边」，区别只在
 * 语法糖和画法：
 *   flowchart  A[方框] --> B{菱形}
 *   stateDiagram  [*] --> 状态  /  状态 --> 状态: 条件
 *
 * 状态图里的 [*] 是起止点，画成实心圆点，这是它唯一需要特殊处理的地方。
 * ===================================================================== */
import {
  wrap, textWidth, esc, cleanLabel, cleanLines,
  svgOpen, arrowDefs, textBlock, rect, line, path, polygon, chip, uid, round, curveD,
} from './base.js';
import { layered, tree, isTree, anchors, selfLoop } from './layout.js';
import { inlineStyle } from './theme.js';

/* ============================================== 形状 */

const SHAPES = [
  [/^\[\[(.*)\]\]$/s, 'subroutine'],
  [/^\[\((.*)\)\]$/s, 'cylinder'],
  [/^\(\((.*)\)\)$/s, 'circle'],
  [/^\{\{(.*)\}\}$/s, 'hexagon'],
  [/^\[\/(.*)\/\]$/s, 'parallelogram'],
  [/^\[\\(.*)\\\]$/s, 'parallelogram'],
  [/^\{(.*)\}$/s, 'diamond'],
  [/^\[(.*)\]$/s, 'rect'],
  [/^\((.*)\)$/s, 'round'],
  [/^>(.*)\]$/s, 'flag'],
];

function nodeSize(label, shape) {
  const lines = wrap(label, shape === 'diamond' ? 18 : 26);
  const textW = lines.reduce((a, l) => Math.max(a, textWidth(l)), 0);
  let w = Math.max(66, textW + 34);
  let h = Math.max(40, lines.length * 19 + 20);
  if (shape === 'diamond') { w += 24; h += 12; }
  if (shape === 'circle') { w = h = Math.max(w, h); }
  return { w, h, lines };
}

function drawShape(shape, p, cls = 'dg-shape') {
  const { x, y, w, h } = p;
  switch (shape) {
    case 'diamond':
      return polygon([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], cls);
    case 'circle':
      return `<ellipse cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" rx="${round(w / 2)}" ry="${round(h / 2)}" class="${cls}"/>`;
    case 'round':
      return rect(x, y, w, h, h / 2, cls);
    case 'cylinder':
      return rect(x, y, w, h, 10, cls)
        + path(`M${round(x)} ${round(y + 9)} a${round(w / 2)} 9 0 0 0 ${round(w)} 0`, 'dg-edge');
    case 'hexagon':
      return polygon([[x + 15, y], [x + w - 15, y], [x + w, y + h / 2],
        [x + w - 15, y + h], [x + 15, y + h], [x, y + h / 2]], cls);
    case 'parallelogram':
      return polygon([[x + 15, y], [x + w, y], [x + w - 15, y + h], [x, y + h]], cls);
    case 'flag':
      return polygon([[x, y], [x + w - 14, y], [x + w, y + h / 2], [x + w - 14, y + h], [x, y + h]], cls);
    case 'subroutine':
      return rect(x, y, w, h, 4, cls)
        + line(x + 7, y, x + 7, y + h) + line(x + w - 7, y, x + w - 7, y + h);
    case 'terminal':   // 状态图的 [*]
      return `<circle cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" r="${round(Math.min(w, h) / 2)}" class="dg-terminal"/>`;
    default:
      return rect(x, y, w, h, 7, cls);
  }
}

/* ============================================== 解析 */

const LINK = /\s*(-{2,}>|-{3,}|-\.-+>|-\.-+|={2,}>|={3,}|--o|--x|<-->)\s*(?:\|([^|]*)\||"([^"]*)")?\s*/;

function parseNodeToken(tok, isState) {
  const t = tok.trim();
  if (!t) return null;

  if (isState && (t === '[*]' || t === '[ * ]')) {
    return { id: '__start__', label: '', shape: 'terminal' };
  }

  const m = /^([A-Za-z0-9_\u4e00-\u9fff\u3040-\u30ff.·-]+)\s*([\s\S]*)$/.exec(t);
  if (!m) return null;
  const id = m[1];
  const rest = (m[2] || '').trim();
  if (!rest) return { id, label: id, shape: 'rect' };
  for (const [re, shape] of SHAPES) {
    const sm = re.exec(rest);
    if (sm) return { id, label: cleanLabel(sm[1]), shape };
  }
  return { id, label: id, shape: 'rect' };
}

export function parse(src, kind) {
  const isState = kind === 'state';
  const lines = cleanLines(src);
  const header = lines[0] || '';
  let dir = 'TD';

  const dm = /^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)/i.exec(header);
  if (dm) dir = dm[1].toUpperCase() === 'TB' ? 'TD' : dm[1].toUpperCase();
  const sd = /^\s*direction\s+(TD|TB|BT|LR|RL)/i;

  const nodes = new Map();
  const order = [];
  const edges = [];
  const groups = [];
  const stack = [];
  let terminalSeq = 0;

  const ensure = (def) => {
    if (!def) return null;
    // 状态图的 [*] 每次出现都是独立的端点
    if (def.shape === 'terminal') {
      const id = `__t${terminalSeq++}`;
      const n = { id, label: '', shape: 'terminal', w: 20, h: 20, lines: [] };
      nodes.set(id, n);
      order.push(id);
      return n;
    }
    if (!nodes.has(def.id)) {
      const sz = nodeSize(def.label, def.shape);
      nodes.set(def.id, { id: def.id, label: def.label, shape: def.shape, ...sz });
      order.push(def.id);
    } else if (def.label !== def.id) {
      const cur = nodes.get(def.id);
      if (cur.label === def.id) {
        Object.assign(cur, { label: def.label, shape: def.shape }, nodeSize(def.label, def.shape));
      }
    }
    if (stack.length) stack[stack.length - 1].nodes.push(def.id);
    return nodes.get(def.id);
  };

  for (let i = 1; i < lines.length; i += 1) {
    let ln = lines[i].trim().replace(/;$/, '');

    const dd = sd.exec(ln);
    if (dd) { dir = dd[1].toUpperCase() === 'TB' ? 'TD' : dd[1].toUpperCase(); continue; }

    const sg = /^subgraph\s+(.*)$/i.exec(ln);
    if (sg) {
      const raw = sg[1].trim();
      const titled = /^[A-Za-z0-9_]+\s*\[(.*)\]$/.exec(raw);
      const g = { title: cleanLabel(titled ? titled[1] : raw), nodes: [] };
      groups.push(g);
      stack.push(g);
      continue;
    }
    if (/^end$/i.test(ln)) { stack.pop(); continue; }
    if (/^(classDef|class|style|linkStyle|click|note|state\s+\w+\s*\{)/i.test(ln)) continue;

    // 状态图的 `A --> B : 条件`
    let tailLabel = '';
    if (isState) {
      const cm = /^(.*?)\s*:\s*(.+)$/.exec(ln);
      if (cm && LINK.test(cm[1])) { ln = cm[1]; tailLabel = cleanLabel(cm[2]); }
    }

    if (!LINK.test(ln)) { ensure(parseNodeToken(ln, isState)); continue; }

    const parts = [];
    let rest = ln;
    let guard = 0;
    while (rest && guard++ < 200) {
      const m = LINK.exec(rest);
      if (!m) { parts.push({ node: rest }); break; }
      parts.push({ node: rest.slice(0, m.index) });
      parts.push({ link: m[1], label: cleanLabel(m[2] || m[3] || '') });
      rest = rest.slice(m.index + m[0].length);
    }

    let prev = null;
    for (let k = 0; k < parts.length; k += 1) {
      if (parts[k].node == null) continue;
      const n = ensure(parseNodeToken(parts[k].node, isState));
      if (!n) { prev = null; continue; }
      const link = parts[k - 1];
      if (prev && link && link.link) {
        edges.push({
          from: prev.id,
          to: n.id,
          label: link.label || tailLabel,
          dashed: /\./.test(link.link),
          thick: /=/.test(link.link),
          arrow: />$/.test(link.link) || link.link === '<-->',
          both: link.link === '<-->',
        });
      }
      prev = n;
    }
  }

  if (!order.length) throw new Error('没有识别出任何节点');
  return { dir, nodes, order, edges, groups };
}

/* ============================================== 绘制 */

export function render(src, kind = 'flow') {
  const g = parse(src, kind);

  /* 树用树的画法：父节点居中在子树上方，一眼看清从属关系。
     分层布局会把所有叶子平铺成一排，又长又看不出层级 —— 那是给一般
     有向图用的，套在树上就是错的。 */
  const useTree = !g.groups.length && isTree(g.order, g.edges);
  let L = useTree
    ? tree(g.nodes, g.order, g.edges, { dir: g.dir })
    : layered(g.nodes, g.order, g.edges, { dir: g.dir });

  /* 连线的切线方向必须跟着**实际用上的**摆法，不能跟着源码里写的方向。
     下面那段「太宽就改横着摆」会把 TD 换成 LR，但边的控制点一直是按 g.dir
     算的 —— 于是一棵从左往右长的树，每根线的控制点都朝上下拽，画出来是一堆
     S 形的扭麻花（用户原话：「连接线都是什么歪七扭八的」）。
     用 usedDir 记住真相：谁改了摆法，谁就得同时改这里。 */
  let usedDir = g.dir;

  /* 又宽又浅的树（叶子多、层数少）横着摆会拉到两千像素，塞进面板要缩到
     0.3 倍，字就没法看了。改成竖着长的缩进树 —— 每个叶子占一行，高度可以
     往下滚，宽度不行。内容一模一样，只是摆法换了。

     只在真的太宽时才换，作者写 TD 通常有他的道理，不该无条件推翻。 */
  const WIDTH_BUDGET = 1080;
  if (useTree && L.width > WIDTH_BUDGET && (g.dir === 'TD' || g.dir === 'BT')) {
    const alt = tree(g.nodes, g.order, g.edges, { dir: 'LR', gapSibling: 12, gapLevel: 44 });
    if (alt.width < L.width) { L = alt; usedDir = 'LR'; }
  }

  /* 子图外框先算出来。

     ⚠ 必须在 svgOpen() **之前**算，因为外框比它包住的节点更大：
     左右各外扩 14、上方外扩 30（标题要有地方写）。而 L.width / L.height 只统计
     节点，画布按它开出来的话，最上面那个子图的边框和标题就跑到 viewBox 外面
     —— 实测 y=-16 的框、y=2 的标题，屏幕上是「子图标题被裁掉一半」。
     所以先量出所有外框的实际范围，再决定画布多大、要不要整体下移。 */
  const frames = [];
  for (const grp of g.groups) {
    const ps = grp.nodes.map((n) => L.pos.get(n)).filter(Boolean);
    if (!ps.length) continue;
    frames.push({
      title: grp.title,
      x0: Math.min(...ps.map((p) => p.x)) - 14,
      y0: Math.min(...ps.map((p) => p.y)) - 30,
      x1: Math.max(...ps.map((p) => p.x + p.w)) + 14,
      y1: Math.max(...ps.map((p) => p.y + p.h)) + 14,
    });
  }
  /* 外框越界多少就把整张图平移多少，并把画布相应放大。
     只往正方向补（shift 恒 >= 0），已经在画布内的图一点不动。 */
  const shiftX = Math.max(0, ...frames.map((f) => -f.x0));
  const shiftY = Math.max(0, ...frames.map((f) => -f.y0));
  if (shiftX || shiftY) {
    L.pos.forEach((p) => { p.x += shiftX; p.y += shiftY; });
    frames.forEach((f) => { f.x0 += shiftX; f.x1 += shiftX; f.y0 += shiftY; f.y1 += shiftY; });
  }
  const W = Math.max(L.width + shiftX, ...frames.map((f) => f.x1 + 14));
  const H = Math.max(L.height + shiftY, ...frames.map((f) => f.y1 + 14));

  const id = uid('fc');
  const out = [
    svgOpen(W, H, kind === 'state' ? 'dg-state' : 'dg-flow'),
    inlineStyle(),        // 样式焊进 SVG，复制成图片、导出网页时才不会掉色
    arrowDefs(id),
  ];

  /* 子图外框压在最底下 */
  for (const f of frames) {
    out.push(rect(f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0, 10, 'dg-group'));
    out.push(`<text x="${round(f.x0 + 12)}" y="${round(f.y0 + 18)}" class="dg-group-title" text-anchor="start">${esc(f.title)}</text>`);
  }

  /* 连线在节点之下，免得盖住方框。

     标签（chip）单独收集起来最后再画，而且要**躲开彼此**：
     同一对节点之间可能有两条边（`J -->|高意向| L` 和 `J -->|转正向| L`），
     它们的曲线完全重合，两个 chip 就压在同一个点上 —— 屏幕上只看得见一个，
     另一个被盖住了（用户截图里「高意向」就这么消失的）。
     所以记下已经占用的矩形，撞上了就沿着垂直方向挪开一点再放。 */
  const chips = [];
  const placed = [];
  function placeChip(cx, cy, label) {
    const w = textWidth(label, 11.5) + 12;
    const h = 19;
    /* 先原地试，撞了就上下各让 22px 一档地找，最多找 6 档。
       交替往两边找，视觉上更均衡；实在找不着就用原位（宁可叠一次，
       也不要把标签甩到离它的线很远的地方）。 */
    const hit = (y) => placed.some((p) => Math.abs(p.cx - cx) < (p.w + w) / 2 + 2
      && Math.abs(p.cy - y) < h + 3);
    let y = cy;
    if (hit(y)) {
      for (let step = 1; step <= 6; step += 1) {
        const up = cy - step * 22;
        const down = cy + step * 22;
        if (!hit(up)) { y = up; break; }
        if (!hit(down)) { y = down; break; }
      }
    }
    placed.push({ cx, cy: y, w, h });
    chips.push(chip(cx, y, label));
  }

  for (const e of g.edges) {
    const a = L.pos.get(e.from);
    const b = L.pos.get(e.to);
    if (!a || !b) continue;

    let cls = 'dg-edge';
    if (e.dashed) cls += ' dashed';
    if (e.thick) cls += ' thick';
    const marker = e.arrow ? ` marker-end="url(#${id}-arrow)"` : '';

    if (e.from === e.to) {
      out.push(path(selfLoop(a), cls, marker));
      if (e.label) placeChip(a.x + a.w + 30, a.y + a.h * 0.3 + 6, e.label);
      continue;
    }

    const horizontal = usedDir === 'LR' || usedDir === 'RL';
    /* 锚点也要知道方向：竖排就从底面出、顶面进（见 anchors 里的说明）。
       以前只把方向传给 curveD，锚点还在用几何交点 —— 线从侧面斜着钻出来，
       控制点却朝上下拽，结果是一堆 S 形扭线。 */
    const pt = anchors(a, b, !horizontal);
    const cv = curveD(pt.x1, pt.y1, pt.x2, pt.y2, horizontal);
    out.push(path(cv.d, cls,
      marker + (e.both ? ` marker-start="url(#${id}-arrow)"` : '')));
    if (e.label) placeChip(cv.mx, cv.my, e.label);
  }
  /* chip 压在线上面、节点下面：盖住线没关系（它本来就在标注那条线），
     盖住节点里的字就不行了。 */
  out.push(...chips);

  /* 节点 */
  for (const nid of g.order) {
    const p = L.pos.get(nid);
    const n = g.nodes.get(nid);
    if (!p || !n) continue;
    out.push(drawShape(n.shape, p));
    if (n.lines?.length && n.shape !== 'terminal') {
      out.push(textBlock(p.x + p.w / 2, p.y + p.h / 2, n.lines));
    }
  }

  out.push('</svg>');
  return out.join('');
}
