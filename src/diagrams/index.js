/* =====================================================================
 * Docsmith · 图表引擎
 * ---------------------------------------------------------------------
 * 一个入口，按第一行的关键字分发到对应渲染器。
 *
 * 对外还提供一个 mermaid 兼容的外观（render 返回 Promise，resolve 出
 * { svg }）。这个契约不能只对齐字段名 —— 调用方是按**返回值类型**分支的，
 * 返回普通对象会掉进"什么都不做"的分支，一张图都画不出来还不报错。
 * 这里踩过一次，写在这儿提醒后来的人。
 *
 * 加一种新图表：写个渲染器，在下面 RENDERERS 里登记一行。
 * ===================================================================== */
import { UnsupportedDiagram } from './base.js';
import { backgroundOf } from './theme.js';
import { render as renderFlow } from './flowchart.js';
import { render as renderGantt } from './gantt.js';
import { renderMindmap, renderQuadrant, renderSequence, renderPie } from './extras.js';

/* 关键字 → 渲染器。键要用小写比对，因为 mermaid 的写法大小写混杂。 */
const RENDERERS = [
  { match: /^(graph|flowchart)\b/i, name: '流程图', run: (s) => renderFlow(s, 'flow') },
  { match: /^stateDiagram(-v2)?\b/i, name: '状态图', run: (s) => renderFlow(s, 'state') },
  { match: /^sequenceDiagram\b/i, name: '时序图', run: renderSequence },
  { match: /^gantt\b/i, name: '甘特图', run: renderGantt },
  { match: /^mindmap\b/i, name: '思维导图', run: renderMindmap },
  { match: /^quadrantChart\b/i, name: '四象限图', run: renderQuadrant },
  { match: /^pie\b/i, name: '饼图', run: renderPie },
];

/** 这段源码是哪种图？认不出来返回 null。 */
export function detect(src) {
  const first = String(src ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  return RENDERERS.find((r) => r.match.test(first)) || null;
}

/** 支持哪些图种，界面上要列出来告诉用户。 */
export function supported() {
  return RENDERERS.map((r) => r.name);
}

/**
 * 画一张图。
 * @returns {string} SVG
 * @throws {UnsupportedDiagram} 图种不认识
 */
export function renderDiagram(src) {
  const r = detect(src);
  if (!r) {
    const kind = (String(src ?? '').trim().split(/[\s\n]/)[0] || '未知').slice(0, 24);
    throw new UnsupportedDiagram(kind);
  }
  return r.run(src);
}

/* ============================================== mermaid 兼容外观 */

export function install(win = window) {
  if (win.mermaid && !win.mermaid.__docsmith) return win.mermaid;

  const api = {
    __docsmith: true,
    __builtin: true,
    initialize() {},
    /* 必须返回 Promise —— 见文件头的说明 */
    render(id, src) {
      return new Promise((resolve, reject) => {
        try { resolve({ svg: renderDiagram(src) }); } catch (e) { reject(e); }
      });
    },
    parse(src) {
      return new Promise((resolve, reject) => {
        try { renderDiagram(src); resolve(true); } catch (e) { reject(e); }
      });
    },
    detect,
    supported,
  };
  win.mermaid = api;
  win.DocsmithDiagrams = { renderDiagram, detect, supported, background: backgroundOf };
  return api;
}

export { UnsupportedDiagram };
