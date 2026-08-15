/* =====================================================================
 * Docsmith · 图表运行时桥接
 * ---------------------------------------------------------------------
 * Mermaid 负责所有 `mermaid` 围栏；Docsmith 自研引擎负责 Infographic，
 * 并在第三方 Mermaid 运行时缺席时为既有图种兜底。
 * 工作台只依赖 window.DocsmithDiagrams，不需要知道最后是哪套引擎画的。
 * ===================================================================== */
import { install, renderDiagram } from '../../diagrams/index.js';

let renderSequence = 0;

const officialMermaid = window.mermaid && !window.mermaid.__docsmith
  ? window.mermaid
  : null;

/* install() 发现官方 Mermaid 时不会覆盖它，但始终把统一入口装到
   window.DocsmithDiagrams。没有官方包时，window.mermaid 就是自研兜底。 */
install(window);

const diagrams = window.DocsmithDiagrams;
if (diagrams) {
  diagrams.officialMermaid = officialMermaid;
  diagrams.hasOfficialMermaid = Boolean(officialMermaid);

  /* `mermaid` 围栏的契约只有一个：官方运行时存在时，所有 Mermaid 语法
     都交给官方 Mermaid。不能再按图的大小或复杂度偷偷换成自研 SVG，否则同一份
     源码在 Mermaid Live Editor 与工作台里会得到两种结果。自研引擎只在官方包
     缺席时兜底；Infographic 仍由自己的围栏和渲染器负责。 */
  diagrams.renderMermaid = function renderMermaid(source, options = {}) {
    const src = String(source || '');
    if (!officialMermaid) return renderDiagram(src, options);
    renderSequence += 1;
    return officialMermaid.render(options.renderId || `docsmith-mermaid-${renderSequence}`, src);
  };
}
