/* =====================================================================
 * Docsmith · 把样式焊进 SVG 里
 * ---------------------------------------------------------------------
 * 为什么需要这个文件：
 *
 * 图表的颜色本来都写在外部样式表里（`.dg-shape { fill: var(--surface-2) }`），
 * 在页面上显示得好好的。但只要 SVG 离开这个页面 —— 复制成图片、导出成
 * 独立网页、塞进 Word —— 外部样式就跟不过去了，出来的是一张没有颜色的图，
 * 甚至全黑。
 *
 * 序列化出去的 SVG 必须是**自给自足**的。所以渲染时把当前主题的颜色解析成
 * 具体色值，生成一段 <style> 焊在 SVG 内部。
 *
 * 页面上仍然可以用外部样式覆盖（内部 style 优先级低于外部同名选择器的
 * 后来者？—— 不，这里靠的是：内部样式只写"兜底值"，外部样式表里带
 * `.dg` 前缀的规则特异性更高，会赢）。两边不打架。
 * ===================================================================== */

/* 亮色和暗色两套具体色值。不用 var()，因为 var 在脱离文档后同样失效。 */
const PALETTE = {
  light: {
    bg: '#ffffff',
    surface: '#f6f9fc',
    border: '#e3e8ee',
    borderStrong: '#d3dce6',
    text: '#0d253d',
    textDim: '#425466',
    textMute: '#64748d',
    accent: '#533afd',
    onAccent: '#ffffff',
    danger: '#ea2261',
    series: ['#533afd', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#0284c7', '#65a30d'],
  },
  dark: {
    bg: '#0a1929',
    surface: '#16304a',
    border: '#1f3c58',
    borderStrong: '#2b5074',
    text: '#eaf1f8',
    textDim: '#a9bdd1',
    textMute: '#7591ad',
    accent: '#7d6bff',
    onAccent: '#ffffff',
    danger: '#f96b8f',
    series: ['#8b7bff', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#60a5fa', '#a3e635'],
  },
};

/** 半透明混色。SVG 里不能用 color-mix，所以自己算。 */
function mix(hex, pct, onto) {
  const h = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [r1, g1, b1] = h(hex);
  const [r2, g2, b2] = h(onto);
  const f = pct / 100;
  const m = (a, b) => Math.round(a * f + b * (1 - f));
  return `#${[m(r1, r2), m(g1, g2), m(b1, b2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 当前该用哪套色。脱离浏览器（比如测试里）默认亮色。 */
export function currentScheme() {
  try {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

/**
 * 生成焊进 SVG 的样式段。
 * @param {'light'|'dark'} scheme
 */
export function inlineStyle(scheme = currentScheme()) {
  const c = PALETTE[scheme] || PALETTE.light;
  const s = c.series;
  const seriesRules = s.map((col, i) => `
.dg-s${i} .dg-bar,.dg-bar.dg-s${i},.dg-slice.dg-s${i},.dg-point.dg-s${i}{fill:${col}}
.dg-mm-link.dg-s${i}{stroke:${col}}
.dg-mm-branch.dg-s${i}{fill:${mix(col, 14, c.bg)};stroke:${col}}`).join('');

  return `<style>
.dg{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}
.dg-shape{fill:${c.surface};stroke:${c.accent};stroke-width:1.4}
.dg-text{fill:${c.text};font-size:13px}
.dg-text-strong{font-weight:700}
.dg-title{fill:${c.text};font-size:15px;font-weight:500}
.dg-axis{fill:${c.textMute};font-size:11px}
.dg-legend{fill:${c.textDim};font-size:12px}
.dg-edge{stroke:${c.textMute};stroke-width:1.35;fill:none;opacity:.72}
.dg-edge.dashed{stroke-dasharray:5 4}
.dg-edge.thick{stroke-width:2.4;opacity:.82}
.dg-arrow{fill:${c.textMute};opacity:.78}
.dg-grid{stroke:${c.border};stroke-width:1}
.dg-chip-bg{fill:${c.bg};stroke:${c.border};stroke-width:1}
.dg-chip-text{fill:${c.textDim};font-size:11.5px}
.dg-group{fill:${mix(c.accent, 5, c.bg)};stroke:${c.borderStrong};stroke-width:1}
.dg-group-title{fill:${c.textDim};font-size:12px;font-weight:600}
.dg-terminal{fill:${c.text}}
.dg-bar{opacity:.85}
.dg-bar.done{opacity:.42}
.dg-bar.crit{fill:${c.danger};opacity:.9}
.dg-bar-text{fill:#fff;font-size:10.5px}
.dg-gantt-label{fill:${c.textDim};font-size:12px}
.dg-gantt-section{fill:${c.text};font-size:12px;font-weight:600}
.dg-milestone{fill:${c.accent}}
.dg-mm-root{fill:${c.accent}}
.dg-mm-root-text{fill:${c.onAccent};font-size:14.5px;font-weight:500}
.dg-mm-leaf{fill:${c.surface};stroke:${c.borderStrong};stroke-width:1}
.dg-mm-link{stroke-width:1.5;opacity:.55;fill:none}
.dg-mm-branch{stroke-width:1.4}
.dg-quad{stroke:none}
.dg-q1{fill:${mix(c.accent, 9, c.bg)}}
.dg-q2{fill:${mix(c.accent, 5, c.bg)}}
.dg-q3{fill:${c.bg}}
.dg-q4{fill:${mix(c.accent, 3, c.bg)}}
.dg-quad-frame{fill:none;stroke:${c.borderStrong};stroke-width:1.2}
.dg-quad-title{fill:${c.textMute};font-size:11.5px;font-weight:500}
.dg-point{stroke:${c.bg};stroke-width:1.8}
.dg-point-label{fill:${c.textDim};font-size:11.5px}
.dg-actor{fill:${c.surface};stroke:${c.accent};stroke-width:1.3}
.dg-lifeline{stroke:${c.borderStrong};stroke-width:1;stroke-dasharray:4 4}
.dg-seq-label{fill:${c.textDim};font-size:11.5px}
.dg-slice{stroke:${c.bg};stroke-width:1.5}
${seriesRules}
</style>`;
}

/** 画布底色。转 PNG 时要先铺一层，不然透明区在某些应用里显示成黑色。 */
export function backgroundOf(scheme = currentScheme()) {
  return (PALETTE[scheme] || PALETTE.light).bg;
}
