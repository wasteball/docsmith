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
import { renderInfographic } from './infographic.js';

/*
 * 图表不是写死在一个 if/else 里的功能，而是注册表：每种图只声明自己的 id、名称、
 * 识别规则、标准化器和渲染函数。以后加新图时不需要碰 Markdown 工作台，也不会把
 * 某一种图的兼容补丁塞进通用调用链。
 */
const RENDERERS = new Map();

function firstMeaningfulLine(src) {
  return String(src ?? '').split('\n')
    .map((line) => line.replace(/%%.*$/, '').trim())
    .find(Boolean) || '';
}

function validateRenderer(renderer) {
  if (!renderer || typeof renderer.id !== 'string' || !renderer.id.trim()) throw new TypeError('图表渲染器缺少 id');
  if (typeof renderer.name !== 'string' || !renderer.name.trim()) throw new TypeError(`图表渲染器 ${renderer.id} 缺少名称`);
  if (!(renderer.match instanceof RegExp) && typeof renderer.match !== 'function') {
    throw new TypeError(`图表渲染器 ${renderer.id} 缺少识别规则`);
  }
  if (typeof renderer.render !== 'function') throw new TypeError(`图表渲染器 ${renderer.id} 缺少 render`);
}

/**
 * 注册一种图表。返回注销函数，测试或可选扩展可以干净地撤销。
 * @param {{id:string,name:string,fences?:string[],match:RegExp|Function,normalize?:Function,render:Function}} renderer
 */
export function registerRenderer(renderer) {
  validateRenderer(renderer);
  const fences = (renderer.fences || ['mermaid']).map((fence) => String(fence).trim().toLowerCase()).filter(Boolean);
  if (!fences.length) throw new TypeError(`图表渲染器 ${renderer.id} 缺少围栏语言`);
  const item = Object.freeze({
    normalize: (src) => String(src ?? ''),
    ...renderer,
    id: renderer.id.trim(),
    fences: Object.freeze(Array.from(new Set(fences))),
  });
  if (RENDERERS.has(item.id)) throw new Error(`图表渲染器已存在：${item.id}`);
  RENDERERS.set(item.id, item);
  return () => { if (RENDERERS.get(item.id) === item) RENDERERS.delete(item.id); };
}

function matches(renderer, header, src) {
  if (typeof renderer.match === 'function') return Boolean(renderer.match(header, src));
  renderer.match.lastIndex = 0;
  return renderer.match.test(header);
}

/** 这段源码是哪种图？认不出来返回 null。 */
export function detect(src) {
  const source = String(src ?? '');
  const header = firstMeaningfulLine(source);
  return Array.from(RENDERERS.values()).find((renderer) => matches(renderer, header, source)) || null;
}

/** 支持哪些图种，界面上要列出来告诉用户。 */
export function supported() {
  return Array.from(RENDERERS.values()).map(({ id, name, fences }) => ({ id, name, fences: [...fences] }));
}

/** 这个 Markdown 围栏是否应当按图表处理。 */
export function supportsFence(language) {
  const lang = String(language ?? '').trim().toLowerCase();
  return Array.from(RENDERERS.values()).some(({ fences }) => fences.includes(lang));
}

/** 按围栏语言画图，避免把 Infographic 冒充成 Mermaid。 */
export function renderFencedDiagram(language, src, options = {}) {
  const lang = String(language ?? '').trim().toLowerCase();
  const renderer = detect(src);
  if (!renderer || !renderer.fences.includes(lang)) {
    throw new UnsupportedDiagram(lang || '未知');
  }
  const context = { id: renderer.id, name: renderer.name, fence: lang, ...options };
  const normalized = renderer.normalize(String(src ?? ''), context);
  return renderer.render(normalized, context);
}

[
  { id: 'flowchart', name: '流程图', match: /^(graph|flowchart)\b/i, render: (src, context) => renderFlow(src, 'flow', context) },
  { id: 'state', name: '状态图', match: /^stateDiagram(-v2)?\b/i, render: (src) => renderFlow(src, 'state') },
  { id: 'sequence', name: '时序图', match: /^sequenceDiagram\b/i, render: renderSequence },
  { id: 'gantt', name: '甘特图', match: /^gantt\b/i, render: renderGantt },
  { id: 'mindmap', name: '思维导图', match: /^mindmap\b/i, render: renderMindmap },
  { id: 'quadrant', name: '四象限图', match: /^quadrantChart\b/i, render: renderQuadrant },
  { id: 'pie', name: '饼图', match: /^pie\b/i, render: renderPie },
  { id: 'infographic', name: '信息图', fences: ['infographic'], match: /^infographic\b/i, render: renderInfographic },
].forEach(registerRenderer);

/**
 * 画一张图。
 * @returns {string|Promise<string>} SVG；复杂流程图由 ELK 异步布局
 * @throws {UnsupportedDiagram} 图种不认识
 */
export function renderDiagram(src, options = {}) {
  const renderer = detect(src);
  if (!renderer) {
    const kind = (firstMeaningfulLine(src).split(/\s/)[0] || '未知').slice(0, 24);
    throw new UnsupportedDiagram(kind);
  }
  const context = { id: renderer.id, name: renderer.name, ...options };
  const normalized = renderer.normalize(String(src ?? ''), context);
  return renderer.render(normalized, context);
}

function asPromise(value) {
  return value && typeof value.then === 'function' ? value : Promise.resolve(value);
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
      try { return asPromise(renderDiagram(src)).then((svg) => ({ svg })); }
      catch (e) { return Promise.reject(e); }
    },
    parse(src) {
      try { return asPromise(renderDiagram(src)).then(() => true); }
      catch (e) { return Promise.reject(e); }
    },
    detect,
    supported,
  };
  win.mermaid = api;
  win.DocsmithDiagrams = {
    renderDiagram, renderFencedDiagram, detect, supported, supportsFence,
    registerRenderer, background: backgroundOf,
  };
  return api;
}

export { UnsupportedDiagram };
