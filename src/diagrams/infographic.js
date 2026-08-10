/* =====================================================================
 * Docsmith · AntV Infographic 适配器
 * ---------------------------------------------------------------------
 * 官方运行时负责解析模板语法和布局；这里负责 Docsmith 的边界：固定本地依赖、
 * 离线图标、主题跟随、等待资源、清理临时 DOM，并把结果收敛成图表引擎统一的
 * Promise<string SVG> 契约。
 * ===================================================================== */
import { installInfographicIcons } from './icons.js';

const LOAD_TIMEOUT = 8000;
const LOCAL_FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const REMOTE_FONT_NAMES = [
  'Alibaba PuHuiTi', 'Source Han Sans', 'Source Han Serif',
  'LXGW WenKai', '851tegakizatsu',
];
let resourcesInstalledFor = null;

function runtime() {
  try { return window.AntVInfographic; } catch (e) { return null; }
}

function adaptGenericItems(source) {
  const lines = String(source ?? '').split('\n');
  const header = lines.find((line) => /^\s*infographic\b/i.test(line)) || '';
  const template = /^\s*infographic\s+([^\s]+)/i.exec(header)?.[1] || '';
  const family = template.split('-')[0].toLowerCase();
  const dataKey = {
    list: 'lists',
    sequence: 'sequences',
    compare: 'compares',
    quadrant: 'compares',
    relation: 'nodes',
    chart: 'values',
  }[family];
  if (!dataKey) return lines.join('\n');

  const dataLine = lines.findIndex((line) => /^\s*data\s*$/i.test(line));
  if (dataLine < 0) return lines.join('\n');
  const dataIndent = /^\s*/.exec(lines[dataLine])?.[0].length || 0;
  for (let i = dataLine + 1; i < lines.length; i += 1) {
    const match = /^(\s*)items\s*$/i.exec(lines[i]);
    const indent = /^\s*/.exec(lines[i])?.[0].length || 0;
    if (lines[i].trim() && indent <= dataIndent) break;
    if (match && indent > dataIndent) {
      lines[i] = `${match[1]}${dataKey}`;
      break;
    }
  }
  return lines.join('\n');
}

function ensureTheme(source) {
  const text = adaptGenericItems(source);
  if (/^\s*theme(?:\s|$)/mi.test(text)) return text;
  let dark = false;
  try { dark = document.documentElement.dataset.theme === 'dark'; } catch (e) {}
  if (!dark) return text;
  const lines = text.split('\n');
  const header = lines.findIndex((line) => /^\s*infographic\b/i.test(line));
  if (header < 0) return text;
  lines.splice(header + 1, 0, 'theme dark');
  return lines.join('\n');
}

function installLocalResources(api) {
  installInfographicIcons(api);
  if (typeof api.registerFont === 'function') {
    const local = { fontFamily: LOCAL_FONT, baseUrl: '', fontWeight: {} };
    REMOTE_FONT_NAMES.forEach((fontFamily) => api.registerFont({ ...local, fontFamily }));
    api.registerFont(local);
  }
  if (typeof api.setDefaultFont === 'function') api.setDefaultFont(LOCAL_FONT);
}

function makeHost() {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1200px;height:900px;visibility:hidden;pointer-events:none;';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  return host;
}

function addValues(svg, source) {
  let parsed;
  try { parsed = runtime()?.parseSyntax?.(adaptGenericItems(source))?.options; } catch (e) { return; }
  const items = parsed?.data?.lists || parsed?.data?.items || [];
  const groups = svg.querySelectorAll('[data-element-type="items-group"] > g');
  Array.from(groups).forEach((group, index) => {
    const value = items[index]?.value;
    if (value == null || value === '') return;
    const label = group.querySelector('[data-element-type="item-label"]');
    if (!label) return;
    const text = label.querySelector('span') || label;
    const current = text.textContent?.trim() || items[index]?.label || '';
    text.textContent = `${current} · ${value}`;
    label.setAttribute('data-docsmith-item-value', String(index));
  });
}

function serialize(svg, source) {
  if (!svg || String(svg.tagName).toLowerCase() !== 'svg') throw new Error('信息图没有生成 SVG');
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  addValues(clone, source);
  clone.querySelectorAll('script,style').forEach((node) => node.remove());
  clone.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes || []).forEach((attr) => {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      if ((attr.name === 'href' || attr.name === 'xlink:href') && /^https?:/i.test(attr.value)) node.removeAttribute(attr.name);
    });
  });
  return new XMLSerializer().serializeToString(clone);
}

export function renderInfographic(source) {
  const api = runtime();
  if (!api || typeof api.Infographic !== 'function') {
    return Promise.reject(new Error('信息图组件没有加载成功'));
  }
  if (resourcesInstalledFor !== api) {
    installLocalResources(api);
    resourcesInstalledFor = api;
  }

  const host = makeHost();
  let instance;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (error) reject(error);
        else resolve(serialize(host.querySelector('svg'), source));
      } catch (caught) { reject(caught); }
      finally {
        try { instance?.destroy(); } catch (e) {}
        host.remove();
      }
    };
    const timer = setTimeout(() => finish(new Error('信息图渲染超时')), LOAD_TIMEOUT);
    try {
      instance = new api.Infographic({ container: host, width: '100%', height: '100%', editable: false });
      instance.on('loaded', () => finish());
      instance.on('error', (error) => finish(error instanceof Error ? error : new Error('信息图语法有问题')));
      const ok = instance.render(ensureTheme(source));
      if (ok === false) finish(new Error('信息图内容不完整'));
      /* loaded 在模板布局和异步 SVG 资源都落定后触发。不要按动画帧抢跑：
         图标加载稍慢时，提前序列化会把空的 <use> 固化进导出结果。 */
    } catch (error) { finish(error); }
  });
}
