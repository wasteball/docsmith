/* =====================================================================
 * Docsmith · 能力页启动
 * ---------------------------------------------------------------------
 * 每个能力页都要做的几件小事，集中在这里：
 *   · 告诉外壳「我起来了」，好让它把待办消息投递过来
 *   · 标记自己嵌在面板里（CSS 会据此收掉一些重复的边框）
 *   · 组件缺失时把对应按钮藏起来
 *   · 恢复被误清的数据
 *
 * ---------------------------------------------------------------------
 * ⚠ 这是个 ES module，而 module 在一个文档里**只执行一次**（实测过：
 *   重复注入同一个 module src，第二次不再运行；classic script 才会重复执行）。
 *
 *   iframe 时代每个能力各自一个文档，所以"每页执行一次"自然成立。
 *   内置能力合并进外壳后只有一个文档 —— 先挂的那个能力把这个模块跑掉，
 *   后挂的那个**一行都不会执行**：不报到、收不到 focusFile。
 *
 *   所以这里改成「模块只跑一次，但把 per-capability 的活儿做成可以被外壳
 *   反复调用的函数」：挂载完成后外壳调 window.DSViewBoot.init(id)。
 *   独立打开这一页时没人调，就由文件末尾自己调一次。
 * ===================================================================== */
import { toShell, on } from '../../core/bus.js';
import { applyGating, coreReady } from '../../core/vendor.js';
import { restoreIfEmpty } from '../../core/store.js';
import { KEYS } from '../../core/config.js';

/* ---- 只做一次的部分 ---- */

/* 嵌在面板里 → 页面自己的标题栏可以省一层。
   判断不能只看 window.self !== window.top：内置能力合并进外壳后两者相等，
   但它**确实**是嵌着的。window.__dsMounting 由外壳在注入前设好。 */
try {
  if (window.__dsMounting || window.self !== window.top) {
    document.documentElement.dataset.embed = '1';
  }
} catch (e) {
  document.documentElement.dataset.embed = '1';
}

restoreIfEmpty(Object.values(KEYS)).catch(() => {});

/* focusFile 的监听也只注册一次 —— handlers 表是模块级的，注册两遍等于
   同一条消息处理两次。要区分"发给谁"，靠 meta.host 和登记表。 */
const hosts = new Map();      // viewId -> 容器元素（合并模式才有）

on('focusFile', (d, meta) => {
  /* 事件派到**容器**上而不是 window 上。
     合并后三个能力共用一个 window，往 window 上派等于同时通知所有人 ——
     切到文件库定位某个文件时，Markdown 工作台也会收到并试着定位。
     派到容器上再让它冒泡，只有那个能力自己的监听器会响应。
     （监听方相应地要 listen 在自己容器上，见 files/wire-up.js。）

     meta.host 是外壳投递时带的目标容器（见 core/bus.js 的 toFrame）。
     没带 host = iframe 那条 postMessage 路径或独立打开，此时文档里只有
     一个能力，派到 window 上即可。 */
  const ev = () => new CustomEvent('docsmith:focus-file', { detail: d.id, bubbles: true });
  if (meta?.host) { meta.host.dispatchEvent(ev()); return; }
  const only = hosts.size === 1 ? hosts.values().next().value : null;
  (only && only !== document.body ? only : window).dispatchEvent(ev());
});

/* 这里**故意不再**监听 open-settings。
   原来有一段把它转成 CustomEvent('docsmith:open-settings') 的转发 ——
   但全项目没有任何地方监听那个事件，是文件库还带独立设置抽屉时的遗留，
   抽屉删掉后就成了死代码。

   而且它不只是没用，是有害的：open-settings 既由能力页**发出**
   （齿轮、「配置云存储」），也曾由能力页**监听**。iframe 时代两者分处
   不同 window，还能靠边界隔开；一旦内置能力和外壳同处一个文档，
   bus.js 只有一份 handlers 表 —— 能力页自己发的消息会被自己收到，
   再转发一轮，形成自激。main.js 里那段注释记着同样的坑
   （「两边来回弹，消息队列被打满，页面就卡死了」）。
   设置面板全应用只有一个、就在外壳里，能力页没有任何理由监听这个消息。 */

/* ---- 每个能力各做一次的部分 ---- */

function init(viewId) {
  const id = viewId
    || window.__dsMounting
    || document.documentElement.dataset.viewId
    || '';
  const host = id ? document.querySelector(`[data-ds-host="${id}"]`) : null;
  if (id) hosts.set(id, host || document.body);

  /* 按 data-needs 藏掉缺组件的按钮。这一步是针对 DOM 的，每个能力的 DOM
     各挂一次，所以必须每次都跑 —— 限定在自己的容器里，别去动别人的。 */
  applyGating(host || document);

  // 报到。外壳收到后会把排队的消息发过来。
  toShell('ready', { tab: id });
}

window.DSViewBoot = { init };

/* 独立打开这一页（不是被外壳挂进来的）→ 自己启动一次。
   合并模式下由外壳在脚本注入完毕后调 init(id)，因为那时才能确定身份。 */
if (!window.__dsMounting) {
  if (document.readyState === 'complete') init();
  else window.addEventListener('load', () => init());
}
