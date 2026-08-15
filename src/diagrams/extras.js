/* =====================================================================
 * Docsmith · 思维导图 / 四象限 / 时序图 / 饼图
 * ---------------------------------------------------------------------
 * 这几种图各自的结构差别很大，但都不复杂，放在一个文件里，省得为了几十行
 * 代码各开一个模块。
 * ===================================================================== */
import {
  indentedLines, cleanLines, esc, cleanLabel, wrap, wrapToWidth, textWidth, textBlockSize, unionBounds,
  svgOpen, arrowDefs, rect, line, path, text, textBlock, round, uid, seriesClass,
} from './base.js';
import { inlineStyle } from './theme.js';

/* ==================================================================== *
 * 思维导图
 * --------------------------------------------------------------------
 * 靠缩进表达层级。布局用「向右生长的树」而不是放射状 —— 放射状好看，
 * 但节点一多就互相挤，而且中文标签横排占的宽度差异大。向右生长的树
 * 每个叶子占固定一行，读起来像目录，扫得快。
 * ==================================================================== */

export function renderMindmap(src) {
  const lines = indentedLines(src).slice(1);
  if (!lines.length) throw new Error('思维导图是空的');

  const nodes = [];
  for (const ln of lines) {
    const indent = ln.match(/^ */)[0].length;
    let label = ln.trim();
    // root((文字)) / [文字] / (文字) 都只取里面的文字
    const m = /^(?:[A-Za-z0-9_]+)?(?:\(\((.*)\)\)|\[(.*)\]|\(\((.*)\)\)|\((.*)\))$/.exec(label);
    if (m) label = m[1] ?? m[2] ?? m[3] ?? m[4] ?? label;
    nodes.push({ indent, label: cleanLabel(label), children: [] });
  }

  // 按缩进折成树
  const root = { indent: -1, label: '', children: [] };
  const stack = [root];
  for (const n of nodes) {
    while (stack.length > 1 && n.indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].children.push(n);
    stack.push(n);
  }
  const top = root.children.length === 1 ? root.children[0] : { label: '', indent: -1, children: root.children };

  const ROW = 30;
  const GAP_X = 42;

  // 先量尺寸
  const measure = (n, depth) => {
    const fs = depth === 0 ? 14.5 : depth === 1 ? 13 : 12.5;
    n.w = textWidth(n.label, fs) + (depth === 0 ? 34 : 26);
    n.h = depth === 0 ? 38 : 26;
    n.depth = depth;
    n.fs = fs;
    n.children.forEach((c) => measure(c, depth + 1));
    n.leaves = n.children.length ? n.children.reduce((a, c) => a + c.leaves, 0) : 1;
  };
  measure(top, 0);

  // 再定坐标：每层向右一列，纵向按叶子数分配
  let maxX = 0;
  const place = (n, x, yTop) => {
    n.x = x;
    n.y = yTop + (n.leaves * ROW) / 2 - n.h / 2;
    maxX = Math.max(maxX, x + n.w);
    let cy = yTop;
    const colX = x + n.w + GAP_X;
    for (const c of n.children) {
      place(c, colX, cy);
      cy += c.leaves * ROW;
    }
  };
  place(top, 16, 16);

  const W = maxX + 20;
  const H = top.leaves * ROW + 32;
  const out = [svgOpen(W, H, 'dg-mindmap'), inlineStyle()];

  const draw = (n) => {
    for (const c of n.children) {
      // 贝塞尔连线，比直线柔和，层级关系也更清楚
      const x1 = n.x + n.w;
      const y1 = n.y + n.h / 2;
      const x2 = c.x;
      const y2 = c.y + c.h / 2;
      const mx = (x1 + x2) / 2;
      out.push(path(`M${round(x1)} ${round(y1)} C${round(mx)} ${round(y1)}, ${round(mx)} ${round(y2)}, ${round(x2)} ${round(y2)}`,
        `dg-mm-link ${seriesClass(c.depth === 1 ? branchIndex(top, c) : branchIndex(top, c))}`));
      draw(c);
    }
    const cls = n.depth === 0 ? 'dg-mm-root' : n.depth === 1 ? `dg-mm-branch ${seriesClass(branchIndex(top, n))}` : 'dg-mm-leaf';
    out.push(rect(n.x, n.y, n.w, n.h, n.h / 2, cls));
    out.push(text(n.x + n.w / 2, n.y + n.h / 2 + n.fs * 0.36, n.label,
      n.depth === 0 ? 'dg-mm-root-text' : 'dg-text'));
  };

  // 一级分支各给一个颜色，子孙沿用
  function branchIndex(rootNode, node) {
    let cur = node;
    while (cur && cur.depth > 1) cur = cur.parent;
    return rootNode.children.indexOf(cur || node);
  }
  const linkParents = (n) => n.children.forEach((c) => { c.parent = n; linkParents(c); });
  linkParents(top);

  draw(top);
  out.push('</svg>');
  return out.join('');
}

/* ==================================================================== *
 * 四象限
 * ==================================================================== */

export function renderQuadrant(src) {
  const lines = cleanLines(src).slice(1);
  let title = '';
  let xLo = '';
  let xHi = '';
  let yLo = '';
  let yHi = '';
  const quads = ['', '', '', ''];
  const points = [];

  for (const raw of lines) {
    const ln = raw.trim();
    let m;
    if ((m = /^title\s+(.+)$/i.exec(ln))) { title = cleanLabel(m[1]); continue; }
    if ((m = /^x-axis\s+(.+?)\s*-->\s*(.+)$/i.exec(ln))) { xLo = cleanLabel(m[1]); xHi = cleanLabel(m[2]); continue; }
    if ((m = /^y-axis\s+(.+?)\s*-->\s*(.+)$/i.exec(ln))) { yLo = cleanLabel(m[1]); yHi = cleanLabel(m[2]); continue; }
    if ((m = /^x-axis\s+(.+)$/i.exec(ln))) { xLo = cleanLabel(m[1]); continue; }
    if ((m = /^y-axis\s+(.+)$/i.exec(ln))) { yLo = cleanLabel(m[1]); continue; }
    if ((m = /^quadrant-([1-4])\s+(.+)$/i.exec(ln))) { quads[+m[1] - 1] = cleanLabel(m[2]); continue; }
    if ((m = /^(.+?)\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]$/.exec(ln))) {
      points.push({ label: cleanLabel(m[1]), x: +m[2], y: +m[3] });
    }
  }
  if (!points.length) throw new Error('四象限图里没有数据点');

  const S = 460;                       // 绘图区边长
  const PAD_L = 92;
  const PAD_T = title ? 56 : 30;
  const PAD_B = 52;
  const PAD_R = 40;
  const W = PAD_L + S + PAD_R;
  const H = PAD_T + S + PAD_B;

  const px = (v) => PAD_L + v * S;
  const py = (v) => PAD_T + (1 - v) * S;

  const out = [svgOpen(W, H, 'dg-quadrant'), inlineStyle()];
  if (title) out.push(text(W / 2, 28, title, 'dg-title'));

  // 四个象限底色：右上最重，左下最轻，暗示"价值/复杂度"递增
  const half = S / 2;
  const cells = [
    [PAD_L + half, PAD_T, 'q1'], [PAD_L, PAD_T, 'q2'],
    [PAD_L, PAD_T + half, 'q3'], [PAD_L + half, PAD_T + half, 'q4'],
  ];
  cells.forEach(([x, y, c]) => out.push(rect(x, y, half, half, 0, `dg-quad dg-${c}`)));

  // 象限名（mermaid 的编号：1 右上，2 左上，3 左下，4 右下）
  const qPos = [
    [PAD_L + half * 1.5, PAD_T + 24],
    [PAD_L + half * 0.5, PAD_T + 24],
    [PAD_L + half * 0.5, PAD_T + S - 14],
    [PAD_L + half * 1.5, PAD_T + S - 14],
  ];
  quads.forEach((q, i) => { if (q) out.push(text(qPos[i][0], qPos[i][1], q, 'dg-quad-title')); });

  out.push(rect(PAD_L, PAD_T, S, S, 8, 'dg-quad-frame'));
  out.push(line(PAD_L + half, PAD_T, PAD_L + half, PAD_T + S, 'dg-grid'));
  out.push(line(PAD_L, PAD_T + half, PAD_L + S, PAD_T + half, 'dg-grid'));

  // 轴标签
  out.push(text(PAD_L, PAD_T + S + 24, xLo, 'dg-axis', 'start'));
  out.push(text(PAD_L + S, PAD_T + S + 24, xHi, 'dg-axis', 'end'));
  out.push(`<text x="${round(PAD_L - 14)}" y="${round(PAD_T + S)}" class="dg-axis" text-anchor="start" transform="rotate(-90 ${round(PAD_L - 14)} ${round(PAD_T + S)})">${esc(yLo)}</text>`);
  out.push(`<text x="${round(PAD_L - 14)}" y="${round(PAD_T)}" class="dg-axis" text-anchor="end" transform="rotate(-90 ${round(PAD_L - 14)} ${round(PAD_T)})">${esc(yHi)}</text>`);

  points.forEach((p, i) => {
    const x = px(p.x);
    const y = py(p.y);
    out.push(`<circle cx="${round(x)}" cy="${round(y)}" r="6" class="dg-point ${seriesClass(i)}"/>`);
    // 靠右边的点把标签放左侧，免得出界
    const right = p.x > 0.72;
    out.push(text(x + (right ? -11 : 11), y + 4, p.label, 'dg-point-label', right ? 'end' : 'start'));
  });

  out.push('</svg>');
  return out.join('');
}

/* ==================================================================== *
 * 时序图
 * ==================================================================== */

export function parseSequence(src) {
  const actors = [];
  const actorById = new Map();
  const events = [];
  const warnings = [];
  const addActor = (rawId, label) => {
    const id = String(rawId || '').trim();
    if (!actorById.has(id)) {
      actorById.set(id, actors.length);
      actors.push({ id, label: cleanLabel(label || id), order: actors.length });
    } else if (label) actors[actorById.get(id)].label = cleanLabel(label);
    return actorById.get(id);
  };

  for (const raw of cleanLines(src).slice(1)) {
    const ln = raw.trim();
    let m;
    if ((m = /^(?:participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(ln))) {
      addActor(m[1], m[2]);
      continue;
    }
    if ((m = /^note\s+(left|right)\s+of\s+([^:]+)\s*:\s*(.*)$/i.exec(ln))) {
      events.push({ type: 'note', placement: m[1].toLowerCase(), actors: [addActor(m[2])], label: cleanLabel(m[3]) });
      continue;
    }
    if ((m = /^note\s+over\s+([^:]+)\s*:\s*(.*)$/i.exec(ln))) {
      events.push({ type: 'note', placement: 'over', actors: m[1].split(',').map((id) => addActor(id)), label: cleanLabel(m[2]) });
      continue;
    }
    m = /^(.+?)\s*(-?->>?|--?\)|-?-x)\s*(.+?)\s*:\s*(.*)$/.exec(ln);
    if (m) {
      events.push({ type: 'message', from: addActor(m[1]), to: addActor(m[3]), arrow: m[2],
        dashed: /^--/.test(m[2]), label: cleanLabel(m[4]) });
      continue;
    }
    if (/^(autonumber|loop|end|alt|else|opt|par|and|rect|activate|deactivate)\b/i.test(ln)) continue;
    warnings.push(ln);
  }
  if (!actors.length || !events.some((event) => event.type === 'message')) throw new Error('时序图里没有可画的消息');
  return { actors, events, warnings };
}

export function layoutSequence(model) {
  const PAD = 24; const ACTOR_GAP = 34; const FONT = 11.5; const LH = 17;
  const actors = model.actors.map((actor) => {
    const lines = wrapToWidth(actor.label, 180, 12.5);
    const size = textBlockSize(lines, 12.5, 18, 14, 8);
    return { ...actor, lines, w: Math.max(76, size.w), h: Math.max(36, size.h) };
  });
  const gaps = Array(Math.max(0, actors.length - 1)).fill(0).map((_, i) =>
    actors[i].w / 2 + actors[i + 1].w / 2 + ACTOR_GAP);
  const eventData = model.events.map((event) => {
    const maxWidth = event.type === 'note' ? 460 : 500;
    const lines = wrapToWidth(event.label, maxWidth, FONT);
    const size = textBlockSize(lines, FONT, LH, event.type === 'note' ? 14 : 0, event.type === 'note' ? 9 : 0);
    return { ...event, lines, textW: size.w, textH: size.h };
  });

  const requireSpan = (a, b, wanted) => {
    const left = Math.min(a, b); const right = Math.max(a, b);
    if (right <= left) return;
    const have = gaps.slice(left, right).reduce((sum, value) => sum + value, 0);
    if (have >= wanted) return;
    const extra = (wanted - have) / (right - left);
    for (let i = left; i < right; i += 1) gaps[i] += extra;
  };
  eventData.forEach((event) => {
    if (event.type === 'message' && event.from !== event.to) requireSpan(event.from, event.to, event.textW + 34);
    if (event.type === 'note' && event.placement === 'over' && event.actors.length > 1) {
      requireSpan(event.actors[0], event.actors[event.actors.length - 1], event.textW + 22);
    }
  });

  const centers = [0];
  for (let i = 0; i < gaps.length; i += 1) centers.push(centers[i] + gaps[i]);
  const topActorH = Math.max(...actors.map((actor) => actor.h));
  let y = PAD + topActorH + 24;
  let bounds = null;
  const placed = eventData.map((event) => {
    if (event.type === 'note') {
      const w = Math.max(90, event.textW); const h = Math.max(38, event.textH);
      let cx;
      if (event.placement === 'over') cx = event.actors.reduce((sum, index) => sum + centers[index], 0) / event.actors.length;
      else if (event.placement === 'left') cx = centers[event.actors[0]] - w / 2 - 20;
      else cx = centers[event.actors[0]] + w / 2 + 20;
      const item = { ...event, x: cx - w / 2, y, w, h, cx, cy: y + h / 2 };
      bounds = unionBounds(bounds, item); y += h + 18; return item;
    }
    const self = event.from === event.to;
    const rowH = Math.max(46, event.textH + (self ? 34 : 22));
    const arrowY = y + event.textH + 8;
    if (!self) {
      const x1 = centers[event.from]; const x2 = centers[event.to]; const cx = (x1 + x2) / 2;
      const item = { ...event, x1, x2, cx, labelY: y + event.textH / 2, arrowY, h: rowH };
      bounds = unionBounds(bounds, { x: cx - event.textW / 2, y, w: event.textW, h: event.textH });
      bounds = unionBounds(bounds, { x: Math.min(x1, x2) - 8, y: arrowY - 8, w: Math.abs(x2 - x1) + 16, h: 16 });
      y += rowH; return item;
    }
    const actor = event.from;
    const rightRoom = actor < actors.length - 1 ? gaps[actor] / 2 : 0;
    const leftRoom = actor > 0 ? gaps[actor - 1] / 2 : 0;
    const loopW = 48;
    let side = actor === actors.length - 1 ? -1 : actor === 0 ? 1 : (rightRoom >= leftRoom ? 1 : -1);
    const need = event.textW + loopW + 18;
    if (side > 0 && rightRoom < need && leftRoom > rightRoom) side = -1;
    if (side < 0 && leftRoom < need && rightRoom > leftRoom) side = 1;
    const anchor = centers[actor];
    const labelX = side > 0 ? anchor + loopW + 10 : anchor - loopW - 10;
    const item = { ...event, side, anchor, loopW, labelX, labelY: y + event.textH / 2,
      arrowY, h: rowH };
    bounds = unionBounds(bounds, { x: side > 0 ? labelX : labelX - event.textW, y, w: event.textW, h: event.textH });
    bounds = unionBounds(bounds, { x: side > 0 ? anchor - 8 : anchor - loopW - 8, y: arrowY - 8, w: loopW + 16, h: 38 });
    y += rowH; return item;
  });

  const bottomY = y + 12; const bottomActorH = topActorH;
  actors.forEach((actor, i) => {
    bounds = unionBounds(bounds, { x: centers[i] - actor.w / 2, y: PAD, w: actor.w, h: actor.h });
    bounds = unionBounds(bounds, { x: centers[i] - actor.w / 2, y: bottomY, w: actor.w, h: bottomActorH });
  });
  const content = bounds || { x0: 0, y0: 0, x1: 1, y1: 1 };
  const shiftX = PAD - content.x0;
  const width = content.x1 - content.x0 + PAD * 2;
  const height = bottomY + bottomActorH + PAD;
  return { actors, events: placed, centers, shiftX, width, height, topActorH, bottomY };
}

export function renderSequence(src) {
  const model = parseSequence(src);
  const layout = layoutSequence(model);
  const id = uid('sq');
  const out = [svgOpen(layout.width, layout.height, 'dg-sequence'), arrowDefs(id), inlineStyle(),
    `<g transform="translate(${round(layout.shiftX)} 0)">`];
  layout.actors.forEach((actor, i) => {
    const cx = layout.centers[i];
    out.push(rect(cx - actor.w / 2, 24, actor.w, actor.h, 7, 'dg-actor'));
    out.push(textBlock(cx, 24 + actor.h / 2, actor.lines, 'dg-text', 18));
    out.push(line(cx, 24 + actor.h, cx, layout.bottomY, 'dg-lifeline'));
    out.push(rect(cx - actor.w / 2, layout.bottomY, actor.w, actor.h, 7, 'dg-actor'));
    out.push(textBlock(cx, layout.bottomY + actor.h / 2, actor.lines, 'dg-text', 18));
  });
  layout.events.forEach((event) => {
    if (event.type === 'note') {
      out.push(rect(event.x, event.y, event.w, event.h, 5, 'dg-note'));
      out.push(textBlock(event.cx, event.cy, event.lines, 'dg-note-text', 17));
      return;
    }
    const cls = `dg-edge${event.dashed ? ' dashed' : ''}`;
    if (event.from !== event.to) {
      const end = event.x2 + (event.x2 > event.x1 ? -6 : 6);
      out.push(line(event.x1, event.arrowY, end, event.arrowY, cls, ` marker-end="url(#${id}-arrow)"`));
      out.push(textBlock(event.cx, event.labelY, event.lines, 'dg-seq-label', 17));
      return;
    }
    const side = event.side; const x = event.anchor; const outer = x + side * event.loopW; const end = x + side * 6;
    out.push(path(`M${round(x)} ${round(event.arrowY)} C${round(outer)} ${round(event.arrowY)}, ${round(outer)} ${round(event.arrowY + 24)}, ${round(end)} ${round(event.arrowY + 24)}`,
      cls, ` marker-end="url(#${id}-arrow)"`));
    const anchor = side > 0 ? 'start' : 'end';
    const top = event.labelY - ((event.lines.length - 1) * 17) / 2;
    event.lines.forEach((label, index) => out.push(text(event.labelX, top + index * 17 + 4.5, label, 'dg-seq-label', anchor)));
  });
  out.push('</g></svg>');
  return out.join('');
}

/* ==================================================================== *
 * 饼图
 * ==================================================================== */

export function renderPie(src) {
  const lines = cleanLines(src);
  let title = '';
  const slices = [];
  for (const raw of lines.slice(1)) {
    const ln = raw.trim();
    let m;
    if ((m = /^title\s+(.+)$/i.exec(ln))) { title = cleanLabel(m[1]); continue; }
    if (/^showData\b/i.test(ln)) continue;
    if ((m = /^"?(.+?)"?\s*:\s*([\d.]+)$/.exec(ln))) {
      slices.push({ label: cleanLabel(m[1]), value: +m[2] });
    }
  }
  if (!slices.length) throw new Error('饼图里没有数据');

  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const R = 120;
  const CX = 170;
  const TOP = title ? 52 : 24;
  /* 图例宽度按**真正要画的那行字**量：label + 两个空格 + 百分比。
     以前是 textWidth(label) + 96 —— 那个 96 是「色块 + 间距 + 百分比」的粗略
     估值，标签短的时候会多留出上百像素的空白，于是整张图看着往左偏
     （用户说的「图表没有居中」有一半是这个）。
     现在把百分比也算进去，只补色块和间距的实际占位，右侧留白就和左侧对齐了。 */
  const legendText = (s) => `${s.label}  ${((s.value / total) * 100).toFixed(1)}%`;
  const LEGEND_ICON = 34 + 12 + 8;          // 饼到色块的间距 + 色块宽 + 色块到文字
  const legendW = Math.max(...slices.map((s) => textWidth(legendText(s), 12))) + LEGEND_ICON;
  /* 右侧留白跟左侧（饼左缘到边框那 50px）取一致，两边就对称了 */
  const W = CX + R + LEGEND_ICON + (legendW - LEGEND_ICON) + (CX - R);
  const H = Math.max(TOP + R * 2 + 28, TOP + slices.length * 24 + 24);
  const CY = TOP + R;

  const out = [svgOpen(W, H, 'dg-pie'), inlineStyle()];
  if (title) out.push(text(W / 2, 30, title, 'dg-title'));

  let angle = -Math.PI / 2;
  slices.forEach((s, i) => {
    const frac = s.value / total;
    const a2 = angle + frac * Math.PI * 2;
    const big = frac > 0.5 ? 1 : 0;
    const x1 = CX + R * Math.cos(angle);
    const y1 = CY + R * Math.sin(angle);
    const x2 = CX + R * Math.cos(a2);
    const y2 = CY + R * Math.sin(a2);
    // 整块 100% 时画整圆，否则弧线闭合会退化成一条线
    out.push(slices.length === 1
      ? `<circle cx="${CX}" cy="${round(CY)}" r="${R}" class="dg-slice ${seriesClass(i)}"/>`
      : path(`M${CX} ${round(CY)} L${round(x1)} ${round(y1)} A${R} ${R} 0 ${big} 1 ${round(x2)} ${round(y2)} Z`,
        `dg-slice ${seriesClass(i)}`, ' fill-opacity="1"'));

    const ly = TOP + 14 + i * 24;
    const lx = CX + R + 34;
    out.push(rect(lx, ly - 9, 12, 12, 3, `dg-slice ${seriesClass(i)}`));
    out.push(text(lx + 20, ly + 1, `${s.label}  ${(frac * 100).toFixed(1)}%`, 'dg-legend', 'start'));
    angle = a2;
  });

  out.push('</svg>');
  return out.join('');
}
