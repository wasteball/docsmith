/* =====================================================================
 * Docsmith · 页面之间说话
 * ---------------------------------------------------------------------
 * 侧栏（外壳）和能力页之间要互相喊话：
 *   「跳到文件库，定位到这个文件」
 *   「帮我下载这个文件，我在 iframe 里下不动」
 *   「用户在我这里换了主题，通知一下别人」
 *
 * 内置能力和外壳同源，本可以直接调函数；但自定义能力（用户自己加的网页）
 * 是跨域的，只能用 postMessage。为了不写两套逻辑，统一走这一层。
 *
 * ---------------------------------------------------------------------
 * 两种挂载方式，同一套 API
 *
 * 内置能力现在直接挂在外壳文档里（不再各占一个 iframe），用户自建能力仍然
 * 是 sandbox iframe。于是这一层要同时应付两种情形：
 *
 *   · iframe 里的能力  → toShell 走 postMessage，跨 window
 *   · 合并进来的能力    → 和外壳同一个 window，postMessage 给 window.parent
 *                        就是发给自己；而且 bus.js 是 ES module，整个文档
 *                        只有一份 handlers 表 —— 发出去的消息会被自己收到。
 *
 * 后者带来一个真实的坑：open-settings 既由能力页发出、也曾由能力页监听，
 * 合并后就是自激（main.js 里记着这个坑，曾经把消息队列打满、页面卡死）。
 * 所以合并模式下 toShell 不发 postMessage，而是直接分派给本页监听者，
 * 并且给 meta 打上 fromCapability 标记，让外壳能区分「这是能力发来的」。
 * ===================================================================== */

export const NS = 'docsmith';

const handlers = new Map();   // type -> Set<fn(payload, meta)>

/** 注册一个消息处理器。返回取消函数。 */
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
}

/** 发给父窗口（能力页 → 外壳）。
    合并模式（没有父窗口）下改为就地分派 —— 外壳的 on() 和能力的 on() 都在
    这同一份表里，所以外壳照样收得到，不需要跨 window。 */
export function toShell(type, payload = {}) {
  if (window.parent === window) {
    /* 同一个文档：直接分派。meta.fromCapability 让接收方知道来源，
       避免「能力发出 → 能力自己又收到 → 再发一轮」这类环。 */
    dispatch(type, { ns: NS, type, ...payload }, { source: null, local: true, fromCapability: true });
    return true;
  }
  try {
    window.parent.postMessage({ ns: NS, type, ...payload }, '*');
    return true;
  } catch (e) { return false; }
}

/** 发给某个能力（外壳 → 能力页）。
    frame 可以是 <iframe>（用户自建能力，跨域，走 postMessage），
    也可以是普通元素容器（内置能力，已合并，就地分派）。 */
export function toFrame(frame, type, payload = {}) {
  if (!frame) return false;
  if (frame.contentWindow) {
    try {
      frame.contentWindow.postMessage({ ns: NS, type, ...payload }, '*');
      return true;
    } catch (e) { return false; }
  }
  /* 不是 iframe → 内置能力的容器。同一个文档，直接分派。
     带上 host 让接收方能判断「这条是不是发给我的」—— 三个内置能力共用
     一份 handlers 表，不分辨的话切换文件时两个能力都会去定位。 */
  dispatch(type, { ns: NS, type, ...payload }, { source: null, local: true, host: frame });
  return true;
}

/** 发给本页自己的监听者（同页模块之间）。 */
export function local(type, payload = {}) {
  dispatch(type, payload, { source: null, local: true });
}

function dispatch(type, payload, meta) {
  handlers.get(type)?.forEach((fn) => {
    try { fn(payload, meta); } catch (e) { console.error('[docsmith] 处理消息出错', type, e); }
  });
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.ns !== NS || !d.type) return;
  dispatch(d.type, d, { source: e.source, origin: e.origin, local: false });
});

/* ------------------------------------------------------------ 请求应答 *
 * 有些事情能力页做不了，得请外壳代劳（比如在 iframe 里写图片剪贴板会被
 * 浏览器拒绝）。这里包一层「发出去 → 等回执」的模式。
 * ------------------------------------------------------------------ */
let seq = 0;
const pending = new Map();

/** 向外壳发一个请求，等它回结果。超时后 reject。 */
export function request(type, payload = {}, timeout = 60000) {
  return new Promise((resolve, reject) => {
    /* 合并模式下 window.parent === window，但外壳就在同一个文档里、
       监听器也在同一份 handlers 表里 —— 照样能应答，不该在这里就拒掉。
       （原来这一句是 `if (window.parent === window) reject(...)`，
        合并后会让「请外壳代劳」的功能全部报「需要在 Docsmith 面板里进行」。）
       真正没有外壳接手的情况由下面的超时兜住。 */
    const reqId = `${Date.now().toString(36)}_${(seq += 1)}`;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error('等待响应超时，请重试。'));
    }, timeout);
    pending.set(reqId, { resolve, reject, timer });
    toShell(type, { ...payload, reqId });
  });
}

/** 外壳用它把结果送回请求方。
    source 为空说明请求来自同文档的内置能力（toShell 就地分派时不带 source），
    这时直接分派回去即可 —— pending 表也在同一份模块实例里。 */
export function reply(source, type, reqId, payload = {}) {
  if (!source) {
    dispatch(type, { ns: NS, type, reqId, ...payload }, { source: null, local: true });
    return;
  }
  try { source.postMessage({ ns: NS, type, reqId, ...payload }, '*'); } catch (e) {}
}

/** 请求方登记一个「结果类型」，收到就 resolve 对应的 promise。 */
export function settleOn(resultType) {
  on(resultType, (d) => {
    const p = pending.get(d.reqId);
    if (!p) return;
    pending.delete(d.reqId);
    clearTimeout(p.timer);
    if (d.ok === false) p.reject(new Error(d.error || '操作没有完成。'));
    else p.resolve(d);
  });
}
