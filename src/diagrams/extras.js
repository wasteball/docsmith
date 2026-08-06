/* =====================================================================
 * Docsmith · 思维导图 / 四象限 / 时序图 / 饼图
 * ---------------------------------------------------------------------
 * 这几种图各自的结构差别很大，但都不复杂，放在一个文件里，省得为了几十行
 * 代码各开一个模块。
 * ===================================================================== */
import {
  indentedLines, cleanLines, esc, cleanLabel, wrap, textWidth,
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

export function renderSequence(src) {
  const lines = cleanLines(src).slice(1);
  const actors = [];
  const actorSet = new Map();
  const steps = [];

  const addActor = (name) => {
    const key = name.trim();
    if (!actorSet.has(key)) {
      actorSet.set(key, actors.length);
      actors.push({ name: cleanLabel(key) });
    }
    return actorSet.get(key);
  };

  for (const raw of lines) {
    const ln = raw.trim();
    let m;
    if ((m = /^(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(ln))) {
      const i = addActor(m[1]);
      if (m[2]) actors[i].name = cleanLabel(m[2]);
      continue;
    }
    if (/^(autonumber|loop|end|alt|else|opt|par|and|rect|activate|deactivate|note)\b/i.test(ln)) continue;

    m = /^(.+?)\s*(-?->>?|--?\)|-?-x)\s*(.+?)\s*:\s*(.*)$/.exec(ln);
    if (!m) continue;
    steps.push({
      from: addActor(m[1]),
      to: addActor(m[3]),
      dashed: /^--/.test(m[2]),
      label: cleanLabel(m[4]),
    });
  }
  if (!actors.length || !steps.length) throw new Error('时序图里没有可画的消息');

  const COL = Math.max(150, Math.min(230,
    Math.max(...steps.map((s) => textWidth(s.label, 11.5))) + 60));
  const ROW = 44;
  const TOP = 60;
  const PAD = 24;
  const W = PAD * 2 + actors.length * COL;
  const H = TOP + steps.length * ROW + 60;

  const cx = (i) => PAD + i * COL + COL / 2;
  const id = uid('sq');
  const out = [svgOpen(W, H, 'dg-sequence'), arrowDefs(id), inlineStyle()];

  actors.forEach((a, i) => {
    const w = Math.min(COL - 20, textWidth(a.name, 12.5) + 26);
    out.push(rect(cx(i) - w / 2, 16, w, 32, 7, 'dg-actor'));
    out.push(text(cx(i), 36, a.name, 'dg-text'));
    out.push(line(cx(i), 48, cx(i), H - 40, 'dg-lifeline'));
    // 底部再放一个，长图不用回头找是谁
    out.push(rect(cx(i) - w / 2, H - 38, w, 30, 7, 'dg-actor'));
    out.push(text(cx(i), H - 18, a.name, 'dg-text'));
  });

  steps.forEach((s, i) => {
    const y = TOP + i * ROW + 20;
    const x1 = cx(s.from);
    const x2 = cx(s.to);
    if (s.from === s.to) {
      out.push(path(`M${round(x1)} ${round(y)} C${round(x1 + 46)} ${round(y)}, ${round(x1 + 46)} ${round(y + 22)}, ${round(x1 + 6)} ${round(y + 22)}`,
        `dg-edge${s.dashed ? ' dashed' : ''}`, ` marker-end="url(#${id}-arrow)"`));
      out.push(text(x1 + 54, y + 4, s.label, 'dg-seq-label', 'start'));
    } else {
      const dirSign = x2 > x1 ? -1 : 1;
      out.push(line(x1, y, x2 + dirSign * 6, y, `dg-edge${s.dashed ? ' dashed' : ''}`,
        ` marker-end="url(#${id}-arrow)"`));
      out.push(text((x1 + x2) / 2, y - 8, s.label, 'dg-seq-label'));
    }
  });

  out.push('</svg>');
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
