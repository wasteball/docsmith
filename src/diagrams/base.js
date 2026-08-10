/* =====================================================================
 * Docsmith · 图表基座
 * ---------------------------------------------------------------------
 * 各种图都要做的那几件事，集中在这里，别每个渲染器各写一遍：
 *   · 估算一段文字有多宽（浏览器里没渲染之前只能估）
 *   · 长文字怎么折行（中日韩按字断，拉丁按词断）
 *   · 生成 SVG 元素、转义、箭头标记
 *   · 一套统一的配色变量名，让图跟着主题走
 *
 * 所有颜色都用 CSS 变量输出，不写死色值 —— 这样暗色模式下图不用重画。
 * ===================================================================== */

export const NS = 'http://www.w3.org/2000/svg';

const CJK = /[\u2e80-\u9fff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/;

/** 一个字符占多少「半宽单位」。中日韩算 2，其余算 1。 */
export function unitsOf(str) {
  let n = 0;
  for (const ch of String(str)) n += CJK.test(ch) ? 2 : 1;
  return n;
}

/** 估算像素宽度。半宽字符按 7.2px，全宽按 14px。 */
export function textWidth(str, fontSize = 13) {
  const k = fontSize / 13;
  let w = 0;
  for (const ch of String(str)) w += (CJK.test(ch) ? 14 : 7.2) * k;
  return w;
}

/**
 * 折行。中日韩逐字断，拉丁按词断，已有的换行保留。
 * @param maxUnits 一行最多多少半宽单位（26 ≈ 13 个汉字）
 */
export function wrap(text, maxUnits = 26) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    if (!para) { out.push(''); continue; }
    const tokens = para.match(/[\u2e80-\u9fff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]|[^\s\u2e80-\u9fff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]+|\s+/g) || [para];
    let cur = '';
    let n = 0;
    for (const tk of tokens) {
      const w = /^\s+$/.test(tk) ? 1 : unitsOf(tk);
      if (n + w > maxUnits && cur.trim()) {
        out.push(cur.trim());
        cur = /^\s+$/.test(tk) ? '' : tk;
        n = /^\s+$/.test(tk) ? 0 : w;
      } else {
        cur += tk;
        n += w;
      }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.length ? out : [''];
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Mermaid 标签允许少量 HTML。只保留我们会安全渲染的加粗语义。 */
export function cleanLabel(s) {
  return String(s ?? '')
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(b|strong)>/gi, '**')
    .replace(/<\/(b|strong)>/gi, '**')
    .replace(/<[^>]*>/g, '')
    /* Mermaid 文档经常用 &#123; / &#91; 避开节点定界符。数字实体要在
       &amp; 之前解码，否则真正写成 &amp;#123; 的正文会被误解两次。 */
    .replace(/&#(\d+);/g, (_, code) => decodeEntityCode(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => decodeEntityCode(code, 16))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function decodeEntityCode(code, radix) {
  const point = parseInt(code, radix);
  try { return Number.isFinite(point) ? String.fromCodePoint(point) : ''; }
  catch (e) { return ''; }
}

/** 去掉内部加粗标记，供宽度估算和纯文本场景使用。 */
export function plainLabel(s) {
  return String(s ?? '').replace(/\*\*/g, '');
}

/* ============================================== SVG 片段 */

export function svgOpen(w, h, cls = 'dg') {
  return `<svg xmlns="${NS}" class="dg ${cls}" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" `
    + `width="${Math.ceil(w)}" height="${Math.ceil(h)}" role="img">`;
}

export function arrowDefs(uid, cls = 'dg-arrow') {
  return `<defs>
    <marker id="${uid}-arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" class="${cls}"/>
    </marker>
    <marker id="${uid}-open" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10" fill="none" stroke="currentColor" stroke-width="1.4" class="${cls}"/>
    </marker>
  </defs>`;
}

export function text(x, y, str, cls = 'dg-text', anchor = 'middle', extra = '') {
  return `<text x="${round(x)}" y="${round(y)}" class="${cls}" text-anchor="${anchor}" ${extra}>${esc(str)}</text>`;
}

/** 一行标签，支持 cleanLabel 生成的 **加粗** 片段。 */
function richLine(x, y, value, cls, anchor, extra = '') {
  const parts = String(value ?? '').split('**');
  if (parts.length === 1) return text(x, y, value, cls, anchor, extra);
  const spans = parts.map((part, i) => `<tspan${i % 2 ? ' class="dg-text-strong"' : ''}>${esc(part)}</tspan>`).join('');
  return `<text x="${round(x)}" y="${round(y)}" class="${cls}" text-anchor="${anchor}" ${extra}>${spans}</text>`;
}

/** 多行文字，围绕中心垂直居中；行内可用 <b>/<strong>（已转换为 **）。 */
export function textBlock(cx, cy, lines, cls = 'dg-text', lh = 18, extra = '') {
  const top = cy - ((lines.length - 1) * lh) / 2;
  return lines.map((l, i) => richLine(cx, top + i * lh + 4.5, l, cls, 'middle', extra)).join('');
}

export function rect(x, y, w, h, r = 6, cls = 'dg-shape', extra = '') {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${r}" class="${cls}" ${extra}/>`;
}

export function line(x1, y1, x2, y2, cls = 'dg-edge', extra = '') {
  return `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" class="${cls}" ${extra}/>`;
}

export function path(d, cls = 'dg-edge', extra = '') {
  return `<path d="${d}" class="${cls}" fill="none" ${extra}/>`;
}

/* 连线统一画成三次贝塞尔曲线。
   以前流程图用直线、思维导图用曲线，同一份文档里两种画风并存，看着像
   两个工具拼出来的。统一成曲线之后：正上下 / 正左右的边，控制点与端点
   共线，画出来仍是笔直的一条 —— 该直的地方还是直，斜着走的地方才弯，
   不会为了"统一"把简单的图搞花哨。 */
export function curveD(x1, y1, x2, y2, horizontal) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const vertical = horizontal == null ? ady >= adx : !horizontal;
  let c1x; let c1y; let c2x; let c2y;
  if (vertical) {
    const k = Math.max(16, ady * 0.45);
    c1x = x1; c1y = y1 + Math.sign(dy || 1) * k;
    c2x = x2; c2y = y2 - Math.sign(dy || 1) * k;
  } else {
    const k = Math.max(16, adx * 0.45);
    c1x = x1 + Math.sign(dx || 1) * k; c1y = y1;
    c2x = x2 - Math.sign(dx || 1) * k; c2y = y2;
  }
  return {
    d: `M${round(x1)} ${round(y1)} C${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(x2)} ${round(y2)}`,
    /* 曲线中点（t=0.5）：标签要挂在线上，不是挂在两端连线的中点上 */
    mx: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
    my: (y1 + 3 * c1y + 3 * c2y + y2) / 8,
  };
}

export function polygon(points, cls = 'dg-shape', extra = '') {
  return `<polygon points="${points.map((p) => `${round(p[0])},${round(p[1])}`).join(' ')}" class="${cls}" ${extra}/>`;
}

export function round(n) {
  return Math.round(Number(n) * 10) / 10;
}

export function uid(prefix = 'dg') {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

/** 多行边标签的实际尺寸。ELK 也用它预留空间，绘制时必须保持一致。 */
export function chipSize(label) {
  const lines = String(label ?? '').split('\n');
  const w = Math.max(...lines.map((line) => textWidth(plainLabel(line), 11.5))) + 18;
  return { lines, w: Math.max(30, w), h: Math.max(22, lines.length * 16 + 8) };
}

/** 一段带底色的标注文字，用在连线中间；支持换行和加粗。 */
export function chip(cx, cy, label, cls = 'dg-chip') {
  const size = chipSize(label);
  return rect(cx - size.w / 2, cy - size.h / 2, size.w, size.h, 5, `${cls}-bg`)
    + textBlock(cx, cy, size.lines, `${cls}-text`, 16);
}

/**
 * 系列色只使用固定的八个身份槽，不循环复用：第九项折叠到最后的兜底槽，
 * 避免两项看起来像同一个系列。数据型图表在此之外还应显示直接标签或图例。
 */
export function seriesClass(i) {
  const slot = Math.max(0, Math.min(7, Number.isFinite(Number(i)) ? Math.floor(Number(i)) : 0));
  return `dg-s${slot}`;
}

/**
 * 把用户写进图表的 CSS 类名变成只含安全字符的内部类名。
 * 加 dg-user- 前缀，避免 entry / text 之类名字撞到 Docsmith 自己的样式。
 */
export function userClass(name) {
  const safe = String(name ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return safe ? `dg-user-${safe}` : '';
}

/* ============================================== 错误 */

export class UnsupportedDiagram extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'UnsupportedDiagram';
    this.unsupportedKind = kind;
  }
}

export class DiagramSyntaxError extends Error {
  constructor(msg, line) {
    super(msg);
    this.name = 'DiagramSyntaxError';
    this.diagramLine = line;
  }
}

/** 去注释、去空行、trim。所有解析器的第一步都一样。 */
export function cleanLines(src) {
  return String(src ?? '')
    .split('\n')
    .map((l) => l.replace(/%%.*$/, '').replace(/\s+$/, ''))
    .filter((l) => l.trim());
}

/** 保留缩进的版本 —— mindmap 之类靠缩进表达层级 */
export function indentedLines(src) {
  return String(src ?? '')
    .split('\n')
    .map((l) => l.replace(/%%.*$/, '').replace(/\t/g, '    ').replace(/\s+$/, ''))
    .filter((l) => l.trim());
}
