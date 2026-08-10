/* =====================================================================
 * Docsmith · 信息图本地图标
 * ---------------------------------------------------------------------
 * AntV Infographic 会把裸 icon 关键词交给在线图标搜索服务。Docsmith 是离线优先
 * 的浏览器扩展，所以在适配层截住这些关键词，返回自带 SVG；未知名字也用通用
 * 图标兜底，绝不因为断网让信息图缺一块。
 *
 * 这些图标为 Docsmith 自绘的 24×24 线性图标，不引入额外图标库或许可证。
 * ===================================================================== */

const ICONS = {
  'rocket-launch': '<path d="M14.5 4.2c2.2-1.4 4.3-1.5 5.3-1.3.2 1 .1 3.1-1.3 5.3l-4.2 4.2-4.5-4.5 4.2-4.2Z"/><path d="m10 7.8-4.3.8-2.5 2.5 5.4.7M16.2 14l-.8 4.3-2.5 2.5-1-5.4"/><circle cx="16" cy="7" r="1.5"/><path d="M7.5 15.5c-2.8.4-3.4 1-3.8 3.8 2.8-.4 3.4-1 3.8-3.8Z"/>',
  'progress-check': '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.2 2.6 2.6 5.7-6"/><path d="M12 1.8v2.1M12 20.1v2.1M1.8 12h2.1M20.1 12h2.1"/>',
  'account-sync': '<circle cx="9" cy="8" r="3"/><path d="M3.8 17.5c.5-3 2.1-4.5 5.2-4.5 1.2 0 2.2.2 3 .7"/><path d="M15 13.5a4.8 4.8 0 0 1 5.3.8l1.2 1.1M21.5 12.7v2.7h-2.7M20.2 18.1a4.8 4.8 0 0 1-5.3.8l-1.2-1.1M13.7 19.5v-2.7h2.7"/>',
  'account-group': '<circle cx="9" cy="8" r="2.8"/><circle cx="17" cy="9" r="2.2"/><path d="M3.5 18c.4-3.3 2.1-5 5.5-5s5.1 1.7 5.5 5M14.5 14c.7-.7 1.6-1 2.8-1 2.3 0 3.6 1.3 3.9 3.8"/>',
  default: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8M12 8v8"/>',
};

function iconName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^mdi[/:]/, '');
}

export function iconSvg(value) {
  const body = ICONS[iconName(value)] || ICONS.default;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

export function installInfographicIcons(api) {
  if (!api || typeof api.registerResourceLoader !== 'function' || typeof api.loadSVGResource !== 'function') return false;
  api.registerResourceLoader((config) => api.loadSVGResource(iconSvg(config?.data)));
  return true;
}
