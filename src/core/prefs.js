/* =====================================================================
 * Docsmith · 记住用户的习惯
 * ---------------------------------------------------------------------
 * 好用的工具应该越用越顺手。这个模块负责记住那些"上次是怎么弄的"，
 * 让用户不必每次重新选一遍。
 *
 * 三类记忆，性质不同，分开处理：
 *
 *   1. 显式偏好  用户主动设过的（字号、主题、分享格式）
 *                → 一直记着，改了就存
 *
 *   2. 会话状态  上次停在哪儿（滚到第几行）
 *                → 只在插件开着、这份文件正加载在插件里的时候记着，
 *                  纯放在内存里。关掉插件就忘，绝不写进浏览器长期存储。
 *                  「最近文档」不做记忆 —— 正文动辄几百 KB，缓存十几篇
 *                  就是好几兆，占用浏览器空间不值当。
 *
 *   3. 自适应默认 用户没设过，但用行为能猜出来的（十次导出九次选 Word）
 *                → 统计使用频次，把最常用的那个变成默认选项
 *
 * 第 3 类是这里唯一"聪明"的部分，也刻意做得克制：只在用户没有明确
 * 设置过的时候才生效，且随时能被一次手动选择覆盖。工具可以贴心，
 * 但不能自作主张。
 * ===================================================================== */
import { KEYS } from './config.js';
import { read, write, patch, subscribe } from './store.js';

const PREFS_KEY = 'docsmith:prefs';

/* --------------------------------------------------------------- 注册表 *
 * 每一项都要在这里登记默认值。这样：
 *   · 读取时永远拿得到合法值，不用到处写 || 兜底
 *   · 想知道"这个工具记了我什么"，看这一张表就够了
 * ------------------------------------------------------------------ */
const DEFAULTS = {
  /* 阅读设置（字号、版心、字体）不在这张表里 ——
     它们由 views/shared/prefs.js 的 DSPrefs 以 md:* 命名空间保管，
     写在同一个 docsmith:prefs 里。工作台自己就会存，这里不重复接管，
     否则会出现两处都在写、以谁为准说不清的情况。 */

  /* --- 编辑与审阅 --- */
  'review.enabled': false,          // 审阅模式开着没
  'review.onlyChanges': false,      // 只看改动
  'review.autoBaseline': true,      // 打开文档时自动记下原始版本
  'editor.mode': 'read',            // read | edit | source
  'editor.wrapSource': true,        // 源码视图自动换行

  /* --- 导出与分享 --- */
  'export.lastFormat': '',          // 上次导出成什么（空则用自适应默认）
  'share.lastKind': 'html',         // 上次分享的是网页还是源文件
  'share.format': 'name_url',       // 分享文案排版

  /* --- 界面 --- */
  'ui.openMode': 'panel',           // panel | tab —— 点图标时开侧边栏还是整页
  'ui.sidebarPinned': true,
  'ui.lastCapability': '',
  'ui.tocOpen': true,
  'ui.filesOpen': true,

  /* --- 文件库 --- */
  'files.lastCategory': '__uncat__',
  'files.typeFilter': 'all',
  'files.autoCopy': true,
  'files.concurrency': 2,

  /* --- 提示 --- */
  'tips.dismissed': [],             // 用户点过"不再提示"的那些
};

function all() { return read(PREFS_KEY, {}); }

/** 读一项偏好。没设过就给默认值。 */
export function get(key) {
  const v = all()[key];
  return v === undefined ? DEFAULTS[key] : v;
}

/** 设一项偏好。 */
export function set(key, value) {
  patch(PREFS_KEY, { [key]: value });
  return value;
}

/** 一次设多项。 */
export function setMany(obj) { return patch(PREFS_KEY, obj); }

/** 用户明确设置过这一项吗？（区别于"正在用默认值"） */
export function isExplicit(key) { return all()[key] !== undefined; }

/** 恢复某项到出厂默认。 */
export function reset(key) {
  const cur = all();
  delete cur[key];
  write(PREFS_KEY, cur);
}

export function onChange(fn) { return subscribe(PREFS_KEY, fn); }

/* ==================================================== 自适应默认 */

const USAGE_KEY = 'docsmith:usage';

/**
 * 记一次使用。比如用户导出了 Word：tally('export', 'docx')
 * 只数次数，不记内容，也不记时间点。
 */
export function tally(bucket, choice) {
  if (!choice) return;
  const u = read(USAGE_KEY, {});
  u[bucket] = u[bucket] || {};
  u[bucket][choice] = (u[bucket][choice] || 0) + 1;
  write(USAGE_KEY, u);
}

/**
 * 猜一个默认值：这个桶里用得最多的那个选项。
 * 用得太少（少于 3 次）就不猜 —— 一两次不算习惯。
 */
export function suggested(bucket, fallback = '') {
  const counts = read(USAGE_KEY, {})[bucket];
  if (!counts) return fallback;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 3) return fallback;
  return ranked[0][0];
}

/**
 * 拿一个"该预选哪个"的答案，优先级：
 *   用户明确设过的  >  从习惯里猜的  >  出厂默认
 */
export function preferred(prefKey, usageBucket, fallback) {
  if (isExplicit(prefKey) && get(prefKey)) return get(prefKey);
  return suggested(usageBucket, fallback ?? DEFAULTS[prefKey]);
}

/** 清空使用统计（设置页里给个入口，让人心里踏实）。
    不带参数清全部；带上桶名（如 'export'）只清那一类。 */
export function forgetUsage(bucket) {
  if (!bucket) { write(USAGE_KEY, {}); return; }
  const u = read(USAGE_KEY, {});
  if (u[bucket] === undefined) return;
  delete u[bucket];
  write(USAGE_KEY, u);
}

/* ==================================================== 提示的一次性 */

export function tipDismissed(id) {
  return (get('tips.dismissed') || []).includes(id);
}

export function dismissTip(id) {
  const list = get('tips.dismissed') || [];
  if (!list.includes(id)) set('tips.dismissed', [...list, id]);
}

/* ==================================================== 滚动位置（只在内存里）
 *
 * 「上次停在哪」只在插件这次开着、而且这份文件此刻正加载在插件里的时候
 * 有意义。所以就放在一个普通的 Map 里 —— 关掉插件（页面卸载）它自然清空，
 * 一个字节都不会写进 localStorage / chrome.storage。
 *
 * 早先这里是把整篇正文连同滚动位置一起塞进 docsmith:recent 长期缓存的，
 * 十几篇文档能占好几兆浏览器空间。现在只留一个"第几像素"的数字在内存里，
 * 占用可以忽略不计。 */
const scrollPos = new Map();   // id -> 像素

/** 记住某篇文档滚到哪儿了（仅本次会话，不落盘）。 */
export function rememberScroll(id, top) {
  if (!id) return;
  scrollPos.set(id, Math.round(top));
}

/** 取回某篇文档上次滚到哪儿（没有就 0）。 */
export function recallScroll(id) {
  return scrollPos.get(id) || 0;
}

/* 老版本把最近文档的正文缓存在 docsmith:recent 里，十几篇能占好几兆。
   新版本不再做这个记忆，顺手把旧数据从本地和镜像里清掉，释放空间。
   removeItem / remove 对不存在的键是空操作，无脑清即可。 */
(function purgeLegacyRecent() {
  try { localStorage.removeItem('docsmith:recent'); } catch (e) { /* 存储不可用就算了 */ }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.remove) {
      chrome.storage.local.remove('docsmith:recent');
    }
  } catch (e) { /* 镜像清理失败无所谓，主数据已清 */ }
})();

export { KEYS, DEFAULTS };
