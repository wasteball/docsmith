/* =====================================================================
 * Docsmith · 外壳
 * ---------------------------------------------------------------------
 * 左边一列能力，右边一块画布。外壳负责：
 *   · 按用户排好的顺序渲染菜单
 *   · 把能力挂到画布上，切换时只是换个显示，不重新加载
 *   · 在能力之间传话（跳转、下载代执行、剪贴板代写）
 *   · 设置：外观、菜单管理、添加能力、备份
 *
 * 挂载分两条路（见下面 inlineMount / mount）：
 *   · 内置能力  → 内容直接注入外壳文档，没有 iframe 边界，
 *                 主题和设置天然共享一份
 *   · 自建能力  → 外部网页，仍然是 sandbox iframe，必须隔权限
 * 两条路对上层是同一套 API，消息统一走 core/bus.js。
 * ===================================================================== */
import { BRAND, CAPABILITIES, ORDER_VERSION, KEYS, ACCENTS } from '../core/config.js';
import { read, write, patch, exportAll, importAll, restoreIfEmpty } from '../core/store.js';
import * as appearance from '../core/appearance.js';
import { on, reply, toFrame } from '../core/bus.js';
import * as cloud from '../storage/index.js';
import { report as vendorReport } from '../core/vendor.js';
import * as prefs from '../core/prefs.js';
import { createSettingsPanel } from '../core/settings-panel.js';
import { forgetUsage } from '../core/prefs.js';
import { fieldOf } from '../core/settings.js';
import { SHORTCUT_GROUPS, fmtKey } from '../core/shortcuts.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

await restoreIfEmpty(Object.values(KEYS)).catch(() => {});

/* ===================================================== 能力表 */

function shell() {
  const s = read(KEYS.shell, {});
  // 内置顺序调整过 → 作废一次用户存的旧顺序，否则新顺序永远生效不了
  if (s.orderV !== ORDER_VERSION) { s.order = null; s.orderV = ORDER_VERSION; }
  return s;
}

function saveShell(part) { return patch(KEYS.shell, part); }

/** 内置 + 用户自定义，按用户排好的顺序。 */
function allCaps() {
  const s = shell();
  const custom = Array.isArray(s.custom) ? s.custom : [];
  const hidden = new Set(Array.isArray(s.hidden) ? s.hidden : []);
  const pool = [...CAPABILITIES, ...custom];
  const order = Array.isArray(s.order) ? s.order : [];

  const byId = new Map(pool.map((c) => [c.id, c]));
  const sorted = [];
  for (const id of order) if (byId.has(id)) { sorted.push(byId.get(id)); byId.delete(id); }
  for (const c of pool) if (byId.has(c.id)) sorted.push(c);

  return sorted.map((c) => ({ ...c, hidden: hidden.has(c.id) }));
}

const visibleCaps = () => allCaps().filter((c) => !c.hidden);
const capById = (id) => allCaps().find((c) => c.id === id);

/* ===================================================== 能力挂载

   两种挂法，按 cap.builtin 分流：

   · 内置能力 → 直接把它的 DOM 注入外壳文档里的一个容器（inlineMount）。
     没有 iframe 边界，数据、样式、事件全在一个文档里。容器上标
     data-ds-host="<id>"，能力页据此找到自己的根（见 workspace.js 的 ROOT、
     library.js 的 libRoot）—— 状态、id 查找、快捷键都被关在容器内。

   · 用户自建能力 → 仍然是 sandbox iframe。那是外部网页，必须隔权限，
     这一条没有商量余地。所以两条路径都得留着，代码比纯 iframe 时代更长
     而不是更短。

   为什么不再用 iframe 装内置能力：iframe 边界会把同源的三个能力割开，
   于是「主题」「设置」这类全局东西每个页面都得自带一份、再靠 postMessage
   对齐（历史上就是这么做的，改一处另两处不同步）。合并之后它们天然共享。 */

const stage = $('#stage');
const frames = {};        // id -> iframe 或容器 div
const frameReady = {};    // id -> bool
const frameQueue = {};    // id -> 待投递的消息
const pendingFocus = {};  // id -> 待定位的记录
let activeId = null;

function srcOf(cap) {
  return cap.builtin ? chrome.runtime.getURL(cap.url) : cap.url;
}

/* 把一个内置能力页的内容搬进容器里。

   要点三条，缺一条就出错：
   ① <link> 去重 —— 三个能力共用 tokens.css / buttons.css 等，重复插入会
      让同一份规则出现多次，后面那份可能盖掉前面已被覆写的值。
   ② 脚本必须重建 <script> 元素才会执行 —— innerHTML 塞进来的 <script>
      浏览器一律不执行（HTML 规范如此）。而且要按原顺序、保持 defer/module
      语义：classic 脚本之间有依赖（prefs.js → library.js），乱序即报错。
   ③ 同一个 src 只加载一次 —— vendor 库（marked/purify/docx）两个能力都引，
      重复加载会把已经打过补丁的全局对象覆盖回原始状态。 */
const loadedAssets = new Set();   // 已插入过的 css/js 绝对地址

/* 把能力页里的相对地址解析成绝对地址。

   base 必须是绝对 URL。真实环境里 srcOf() 走 chrome.runtime.getURL()，
   给的就是 chrome-extension://…／绝对地址，没问题。但如果 base 是相对的，
   new URL(ref, base) 会**抛异常** —— 早先这里是 `catch { return ref }`，
   于是静默返回未解析的路径，所有 <script> 全部 404，而页面只是空着、
   不报错（挂载流程照常走完，因为 onerror 里只 console.error）。
   宁可显式兜到 location 上，也不要悄悄给出一个错的地址。 */
function absUrl(base, ref) {
  try { return new URL(ref, base).href; }
  catch (e) {
    try { return new URL(ref, new URL(base, location.href)).href; }
    catch (e2) { return ref; }
  }
}

/* 把一份样式表限定到某个能力容器内。

   为什么必须做这件事：两个能力页的 CSS 有 14 个同名类（.modal、.brand、
   .status、.toast、.dropzone、.empty-state、.icon-btn…）。各占一个 iframe
   时互不相干；合并进同一个文档后就开始互相覆盖，而且症状出在不相干的地方：
     · workspace.css 的 `.modal{display:none}`（它自己的分享弹窗，靠 .open 打开）
       把文件库的 `.modal`（重命名弹窗的**内容卡片**）也一起藏了 ——
       用户看到的是「出现一个蒙版，但操作不了」，因为只剩 .modal-backdrop。
     · 反过来 library.css 的 .dropzone 也会影响工作台的拖放区。

   做法：给每条选择器前面加上 `[data-ds-host="<id>"] ` 前缀。这样
   workspace.css 只作用于 markdown 容器，library.css 只作用于 files 容器。
   一次改动覆盖全部撞名，以后新增的同名类也不会再打架。

   几处必须小心（都试错过）：
   · @media / @supports 这类分组规则要递归进去处理内部的选择器，不能整块加前缀
   · @keyframes / @font-face / @property 里面不是选择器，一个字都不能动
   · :root 换成容器本身（变量得挂在容器上，子元素才继承得到）
   · html / body 也换成容器 —— 页面原来写给 body 的整页布局，现在归容器
   · 已经带 [data-ds-root] 或 [data-ds-host] 的选择器不再加前缀，避免叠两层 */
function scopeCss(css, hostId) {
  const H = `[data-ds-host="${hostId}"]`;

  /* 先把注释整体剥掉。
     不剥的话，「注释紧贴在选择器前面」这种很常见的写法会被拼成
       [data-ds-host="files"] /* 说明 *​/ .brand
     —— 前缀跑到注释前面去了，整条选择器非法，浏览器直接丢掉这条规则。
     实测就是这么发现的：doc.css 少 1 条、library.css 少 2 条，
     丢的正是注释后面那几条（html[data-embed] …、.history-actions-row）。
     注释对运行时没有意义，剥了最省事，也不必在分块器里到处躲它。 */
  const clean = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');

  function scopeSelector(sel) {
    return sel.split(',').map((part) => {
      const s = part.trim();
      if (!s) return null;                    // 空片段直接丢掉，别留个孤零零的逗号
      // 已经限定过的、或本来就是给容器自己写的，原样保留
      if (s.includes('data-ds-host') || s.includes('data-ds-root')) return s;

      // 光秃秃的 :root / html / body：就是「这一页整体」，直接换成容器本身。
      // 必须排在下面的祖先判断**之前** —— 否则 `:root{--x:1}` 会被当成
      // 「祖先 :root + 空后代」，变成 `:root [data-ds-host]`（要求容器是
      // :root 的后代且另有一层），变量就挂不上去了。
      if (/^(:root|html|body)$/.test(s)) return H;

      /* ⚠ 带条件的祖先必须留在前缀**外面**。

         主题和强调色写在 <html> 上（data-theme / data-accent，见
         core/appearance-global.js），而 <html> 是容器的**祖先**。
         所以 `:root[data-theme="light"] .toast` 不能变成
             [data-ds-host="files"] :root[data-theme="light"] .toast
         —— 那要求 :root 是容器的后代，永远匹配不上，整条规则等于没写。
         library.css 有 19 条这种写法（几乎就是它的整个亮色主题），
         结果就是：外壳是亮色，文件库还是暗色 —— 用户截图里那个样子。

         正确形态是把前缀插到祖先条件**后面**：
             :root[data-theme="light"] [data-ds-host="files"] .toast
         祖先照旧在外层判断，限定只管容器内部。

         html[data-embed] 那几条同理（外壳挂载时会给 <html> 打这个标记）。 */
      const anc = s.match(/^((?::root|html)(?:\[[^\]]*\])+|\[data-(?:theme|accent|embed)[^\]]*\])(\s+|$)/);
      if (anc) {
        const rest = s.slice(anc[0].length).trim();
        // 祖先条件本身就是被设置的目标（如 :root[data-theme=light]{--x:1}）
        // → 变量得挂在容器上，子元素才继承得到
        if (!rest) return `${anc[1]} ${H}`;
        // body 在合并后就是容器本身，别再往下找一层
        if (/^body\b/.test(rest)) return `${anc[1]} ${H}${rest.replace(/^body/, '')}`;
        return `${anc[1]} ${H} ${rest}`;
      }

      // html / body 后面直接跟别的（如 body.dropping）：容器就是那个 body
      if (/^(html|body)\b/.test(s)) return H + s.replace(/^(html|body)/, '');
      // 其余一律限定在容器内
      return `${H} ${s}`;
    }).filter(Boolean).join(', ');
  }

  /* 手写一个极小的分块器：按顶层 { } 配对切开，只碰选择器那一段。
     用正则整体替换是不行的 —— 选择器里可能有 {}（属性选择器带引号）、
     @media 里还嵌着一层规则。 */
  function walk(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      // 找下一个 { 或 } 或 ;（@import 这类单行 at 规则）
      const open = text.indexOf('{', i);
      if (open < 0) { out += text.slice(i); break; }

      const head = text.slice(i, open);
      const at = head.trim().match(/^@([\w-]+)/);

      // 找到与这个 { 配对的 }
      let depth = 0, j = open;
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (!depth) break; }
      }
      const body = text.slice(open + 1, j);

      if (at) {
        const name = at[1].toLowerCase();
        if (name === 'media' || name === 'supports' || name === 'layer' || name === 'container') {
          // 条件分组规则：条件不动，内部递归
          out += head + '{' + walk(body) + '}';
        } else {
          // keyframes / font-face / property / page …：内部不是选择器，原样保留
          out += head + '{' + body + '}';
        }
      } else {
        out += scopeSelector(head) + '{' + body + '}';
      }
      i = j + 1;
    }
    return out;
  }

  return walk(clean);
}

/* 哪些样式表需要限定。
   tokens.css / buttons.css / diagrams.css / hljs / katex 是**共享**的：
   它们本来就设计成全应用一套，限定了反而会让每个能力各拿一份变量，
   而且 katex 里有大量 @font-face 和特殊选择器，动它风险大于收益。
   真正会打架的是两个能力各自的「页面级」样式表。 */
const SCOPED_CSS = /\/(workspace|library|revision|doc|cards)\.css(\?|$)/;

async function injectScopedCss(href, hostId) {
  const css = await fetch(href).then((r) => (r.ok ? r.text() : ''), () => '');
  if (!css) return false;
  const st = document.createElement('style');
  st.dataset.for = hostId;
  st.dataset.src = href.split('/').pop();
  /* url(...) 里的相对地址是相对样式表自己的位置的，搬进 <style> 后基准会变成
     文档 —— 所以把它们先补成绝对地址。doc.css 里有 @font-face 的 local()
     不受影响，workspace.css 目前没有 url()，这一步是给以后兜底。 */
  const fixed = css.replace(/url\((['"]?)(?!data:|https?:|\/)([^'")]+)\1\)/g,
    (m, q, u) => `url(${q}${absUrl(href, u)}${q})`);
  st.textContent = scopeCss(fixed, hostId);
  document.head.appendChild(st);
  return true;
}

async function inlineMount(cap, container) {
  const pageUrl = srcOf(cap);
  const html = await fetch(pageUrl).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  });

  /* 用 DOMParser 而不是往容器里直接 innerHTML：
     解析阶段不会执行任何脚本、不会发起 <img> 请求，我们能先挑干净再放进去。 */
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // ① 样式：搬到外壳 <head>。页面级样式表要限定作用域，共享的直接引。
  for (const l of doc.querySelectorAll('link[rel="stylesheet"]')) {
    const href = absUrl(pageUrl, l.getAttribute('href'));
    if (SCOPED_CSS.test(href)) {
      // 每个能力各注入一份限定过的副本，所以不能按 href 去重
      const key = href + '#' + cap.id;
      if (loadedAssets.has(key)) continue;
      loadedAssets.add(key);
      await injectScopedCss(href, cap.id);
      continue;
    }
    if (loadedAssets.has(href)) continue;
    loadedAssets.add(href);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    if (l.id) link.id = l.id;          // hljs-light / hljs-dark 靠 id 切换
    document.head.appendChild(link);
  }
  // 页面内嵌的 <style> 一并搬过去（也要限定）
  doc.querySelectorAll('head style').forEach((s) => {
    const st = document.createElement('style');
    st.dataset.for = cap.id;
    st.textContent = scopeCss(s.textContent, cap.id);
    document.head.appendChild(st);
  });

  /* ② DOM：body 的内容（去掉 script，下一步单独处理）

     ⚠ 脚本要连 <head> 里那些一起收，而且 head 的排在前面。
     能力页 <head> 第一行就是 core/appearance-global.js（它必须在首帧前跑，
     所以刻意不是 module）—— 只扫 body 的话它被漏掉，于是 workspace.js 和
     library.js 里的 Appearance.xxx 全部抛 ReferenceError，主题也不生效。
     （实测就是这么发现的：控制台两条 "Appearance is not defined"。） */
  const headScripts = Array.from(doc.head.querySelectorAll('script'));
  const bodyScripts = Array.from(doc.body.querySelectorAll('script'));
  const scripts = [...headScripts, ...bodyScripts];
  scripts.forEach((s) => s.remove());
  container.innerHTML = doc.body.innerHTML;
  /* 能力页原来写在 <body> 上的属性要转到容器上 —— markdown 页的
     data-ds-root 就在那儿，丢了整页布局就没了。 */
  Array.from(doc.body.attributes).forEach((a) => {
    if (a.name === 'class') container.className += ' ' + a.value;
    else container.setAttribute(a.name, a.value);
  });
  container.setAttribute('data-ds-host', cap.id);
  /* 能力页把自己的身份写在 <html data-view-id="…"> 上，view-boot.js 靠它
     报到、也靠它找自己的容器。合并后 <html> 是外壳的，那个属性搬不过来
     （三个能力会互相覆盖），所以在容器上留一份，并让 view-boot 优先读它。 */
  container.setAttribute('data-view-id', doc.documentElement.dataset.viewId || cap.id);

  // ③ 脚本：按原顺序逐个重建并等它就位
  /* 告诉即将执行的脚本「你是哪个能力」。view-boot.js 读它来定身份和容器，
     也用它判断「我是被嵌着的」（合并后 window.self===window.top，
     光看这个判断不出来）。注入完就清掉，免得后挂的能力读到上一个的值。 */
  window.__dsMounting = cap.id;
  const failed = [];
  try {
    for (const s of scripts) {
      const src = s.getAttribute('src');
      if (src) {
        const abs = absUrl(pageUrl, src);
        if (loadedAssets.has(abs)) continue;      // vendor 只加载一次
        loadedAssets.add(abs);
        await new Promise((resolve) => {
          const el = document.createElement('script');
          el.src = abs;
          if (s.type) el.type = s.type;
          /* 顺序靠 await 保证，所以显式关掉 async；module 天然 defer，
             但 onload 一样会来，等它即可。 */
          el.async = false;
          el.onload = resolve;
          el.onerror = () => {
            /* 记下来，挂载结束后一起抛 —— 只 console.error 的话，页面会
               安安静静地空着：DOM 在、脚本没跑，看不出哪里错了。
               别在这里 reject：剩下的脚本还得按顺序走完，否则一个 404
               会连带后面全部不加载，报错信息也就只剩第一条。 */
            loadedAssets.delete(abs);              // 允许重试
            failed.push(src);
            resolve();
          };
          document.body.appendChild(el);
        });
      } else if (s.textContent.trim()) {
        const el = document.createElement('script');
        if (s.type) el.type = s.type;
        el.textContent = s.textContent;
        document.body.appendChild(el);
      }
    }
  } finally {
    delete window.__dsMounting;
  }

  if (failed.length) {
    throw new Error(`有 ${failed.length} 个组件没加载成功：${failed.slice(0, 3).join('、')}${failed.length > 3 ? ' 等' : ''}`);
  }

  /* view-boot.js 是 ES module，一个文档里只执行一次 —— 后挂的能力那份
     压根不会运行（实测过：重复注入同一个 module src，第二次不执行；
     classic script 才会重复执行）。所以「报到 + 按 data-needs 藏按钮」
     这些 per-capability 的动作改由外壳显式触发。
     ⚠ 要放在 __dsMounting 清掉之后、并显式传 id —— 别让它去猜。 */
  window.DSViewBoot?.init?.(cap.id);
}

function mount(cap) {
  if (frames[cap.id]) return frames[cap.id];

  const loader = document.createElement('div');
  loader.className = 'frame-load';
  loader.dataset.for = cap.id;
  loader.innerHTML = '<span class="spinner"></span>';
  stage.appendChild(loader);

  /* 内置能力：一个普通容器，内容直接注入 */
  if (cap.builtin) {
    const host = document.createElement('div');
    host.className = 'frame';
    host.dataset.id = cap.id;
    stage.appendChild(host);
    frames[cap.id] = host;

    inlineMount(cap, host).then(() => {
      loader.remove();
      frameReady[cap.id] = true;
      flush(cap.id);
    }).catch((err) => {
      loader.innerHTML = `<p class="frame-err">「${esc(cap.name)}」没能打开。<br>${esc(err.message || '')}</p>`;
    });
    return host;
  }

  /* 用户自建能力：外部网页，继续用 sandbox iframe 隔权限 */
  const f = document.createElement('iframe');
  f.className = 'frame';
  f.dataset.id = cap.id;
  f.title = cap.name;
  f.src = srcOf(cap);
  // 能跑脚本、能提交表单，但不许拿本扩展的权限
  f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin allow-downloads');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.addEventListener('load', () => {
    loader.remove();
    frameReady[cap.id] = true;
    flush(cap.id);
  });
  f.addEventListener('error', () => {
    loader.innerHTML = `<p class="frame-err">「${esc(cap.name)}」没能打开。<br>检查一下网址是否正确、网络是否通畅。</p>`;
  });
  stage.appendChild(f);
  frames[cap.id] = f;
  return f;
}

function flush(id) {
  const q = frameQueue[id];
  if (!q) return;
  delete frameQueue[id];
  for (const msg of q) toFrame(frames[id], msg.type, msg);
  if (pendingFocus[id]) {
    toFrame(frames[id], 'focusFile', { id: pendingFocus[id] });
    delete pendingFocus[id];
  }
}

/** 目标能力可能还没挂载：先挂上，就绪后再投递。 */
function postWhenReady(id, type, payload) {
  const cap = capById(id);
  if (!cap) return false;
  mount(cap);
  if (frameReady[id]) toFrame(frames[id], type, payload);
  else (frameQueue[id] = frameQueue[id] || []).push({ type, ...payload });
  return true;
}

function activate(id, opts) {
  const caps = visibleCaps();
  let cap = caps.find((c) => c.id === id);
  if (!cap) {
    if (!caps.length) { activeId = null; renderNav(); return; }
    cap = caps[0]; id = cap.id;
  }
  mount(cap);
  activeId = id;
  Object.entries(frames).forEach(([fid, f]) => f.classList.toggle('active', fid === id));
  $$('.frame-load').forEach((l) => { l.hidden = l.dataset.for !== id; });
  saveShell({ activeId: id });
  renderNav();

  if (opts?.file) {
    if (frameReady[id]) toFrame(frames[id], 'focusFile', { id: opts.file });
    else pendingFocus[id] = opts.file;
  }
}

/* ===================================================== 侧栏 */

const nav = $('#nav');
const indicator = $('#indicator');

function renderNav() {
  const caps = visibleCaps();
  $$('.cap', nav).forEach((el) => el.remove());
  $('#emptyState').hidden = caps.length > 0;

  caps.forEach((cap, i) => {
    const b = document.createElement('button');
    b.className = `cap${cap.id === activeId ? ' active' : ''}`;
    b.dataset.id = cap.id;
    const ico = cap.builtin
      ? `<span class="cap-ico"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${cap.icon}</svg></span>`
      : `<span class="cap-ico"><span class="cap-emoji">${esc(cap.emoji || '🔧')}</span></span>`;
    b.innerHTML = `<span class="cap-idx">${String(i + 1).padStart(2, '0')}</span>${ico}`
      + `<span class="cap-body"><span class="cap-name">${esc(cap.name)}</span>`
      + `<span class="cap-desc">${esc(cap.desc || '')}</span></span>`;
    b.title = `${cap.name} · 按 ${i + 1} 快速切换`;
    b.addEventListener('click', () => activate(cap.id));
    nav.appendChild(b);
  });
  moveIndicator();
}

function moveIndicator() {
  const el = $('.cap.active', nav);
  if (!el) { indicator.style.opacity = '0'; return; }
  indicator.style.opacity = '1';
  indicator.style.height = `${el.offsetHeight - 16}px`;
  indicator.style.transform = `translateY(${el.offsetTop + 8}px)`;
}

/* 外壳自己的侧栏。用 .shell > 限定，不用裸 #sidebar ——
   Markdown 工作台也有一个 id="sidebar" 的 <aside>（它的文件/大纲栏），
   合并后同一个文档里有两个同名 id，document.querySelector('#sidebar')
   返回**先出现的那一个**。现在恰好是外壳的（它在 DOM 里更靠前），
   但那是运气，不是保证：以后调一下挂载顺序就悄悄换人了。 */
const sidebar = $('.shell > #sidebar') || $('#sidebar');
function setPinned(open) {
  sidebar.classList.toggle('open', open);
  saveShell({ pinned: open });
  setTimeout(moveIndicator, 240);
}
$('#collapseBtn').addEventListener('click', () => setPinned(!sidebar.classList.contains('open')));

/* ===================================================== 设置面板 */


/* 全应用只有这一个设置面板。任何地方（外壳按钮、能力页里的齿轮、
   命令面板、⌘,）都打开它，不再各自维护一套。 */
const settingsPanel = createSettingsPanel({
  accents: ACCENTS,
  slots: {
    'storage-form': (el) => mountStorageForm(el),
    'menu-editor': (el) => mountMenuEditor(el),
    'components': (el) => { el.innerHTML = '<div class="vendor-list" id="vendorList"></div>'; renderVendorList(); },
    'memory': (el) => mountMemoryPanel(el),
    'shortcuts': (el) => mountShortcutsPanel(el),
  },
  actions: {
    __export__: () => doExport(),
    __import__: () => $('#importFile').click(),
    __forgetUsage__: () => { forgetUsage(); toast('使用统计已清除'); },
    __clearHistory__: () => clearHistory(),
  },
  onChange: (key, value) => {
    // 设置变了要立刻通知各个能力页（它们同源，直接广播即可）
    broadcast('setting', { key, value });
  },
});

function openSettings(section) {
  settingsPanel.open(section);
}

function closeSettings() {
  settingsPanel.close();
}

$('#settingsBtn').addEventListener('click', () => openSettings());
$('#emptyOpenSettings').addEventListener('click', () => openSettings());

/* --- 外观 ---------------------------------------------------------
   主题和强调色现在只在设置面板里（外观分区）。侧栏底部原本还有一个
   明暗切换按钮 —— 同一件事两个入口，而且那个按钮切的是"暗/亮"，
   设置里是"暗/亮/跟随系统"，两边表达能力还不一样。删掉按钮，
   统一走设置。 */
appearance.onChange(() => { broadcastAppearance(); settingsPanel.refresh(); syncThemeBtn(); });

/* --- 主题按钮（侧栏底部，一键可达） ---
   三态循环：亮 → 暗 → 跟随系统 → 亮。写的是同一份 appearance 数据，
   设置面板里的那组按钮会自动跟着刷新（上面的 onChange 里调了 refresh）。 */
const THEME_CYCLE = ['light', 'dark', 'auto'];
const THEME_META = {
  light: { label: '亮色', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6"/></svg>' },
  dark: { label: '暗色', icon: '<svg viewBox="0 0 24 24"><path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.8 6.8 0 0 0 10.8 10.8z"/></svg>' },
  auto: { label: '跟随系统', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7"/><path d="M12 4.5v12.5"/></svg>' },
};

const themeBtn = $('#themeBtn');

function syncThemeBtn() {
  if (!themeBtn) return;
  const t = appearance.read().theme;
  const m = THEME_META[t] || THEME_META.light;
  themeBtn.innerHTML = m.icon;
  themeBtn.title = `主题：${m.label}（点击切换）`;
  themeBtn.dataset.theme = t;
}

themeBtn?.addEventListener('click', () => {
  const cur = appearance.read().theme;
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length];
  appearance.set({ theme: next });
  syncThemeBtn();
  toast(`主题：${THEME_META[next].label}`);
});

syncThemeBtn();

function broadcastAppearance() {
  const a = appearance.read();
  Object.values(frames).forEach((f) => toFrame(f, 'appearance', a));
}

/* 把一条消息发给所有已挂载的能力页。设置改了、上传记录清了，都靠它通知
   各页刷新。之前这个函数被调用了（onChange 里、clearHistory 里）却从来
   没定义过 —— 改任何一项设置都会抛 ReferenceError，把回调链打断。 */
function broadcast(type, payload = {}) {
  Object.values(frames).forEach((f) => toFrame(f, type, payload));
}

/* --- 菜单管理：排序、显示/隐藏、添加能力 ----------------------------
   这一块之前是坏的，而且坏得很安静：

   `const menuList = $('#menuList')` 写在模块顶层，可 #menuList 是设置面板
   打开「菜单」分区那一刻才被创建的 —— 顶层取到的永远是 null，
   renderMenuList() 第一行就抛 TypeError，整个分区一片空白。用户看到的是
   "顺序没法调"。

   「添加能力」更直接：#addName / #addUrl / #addSave 这些节点在任何一个
   HTML 文件里都不存在，代码里全是 ?. 保护，所以点了不报错、也不做事。
   界面从来没被写出来过。

   现在两样都在挂载时现建、现绑，节点和代码在同一处产生，不会再走散。 */

let dragId = null;

function mountMenuEditor(host) {
  host.innerHTML = `
    <div class="menu-list" id="menuList"></div>

    <div class="add-cap" id="addCap">
      <div class="add-cap-head">
        <b>添加能力</b>
        <span>把任何一个网页收进这个面板 —— 公司内部系统、常用在线工具都行。</span>
      </div>
      <div class="add-cap-form">
        <label class="add-field">
          <span>名称</span>
          <input type="text" id="addName" placeholder="例如：内部工单系统" maxlength="24">
        </label>
        <label class="add-field add-field--wide">
          <span>网址</span>
          <input type="url" id="addUrl" placeholder="https://…" spellcheck="false">
        </label>
        <label class="add-field add-field--tiny">
          <span>图标</span>
          <input type="text" id="addEmoji" placeholder="🔧" maxlength="4">
        </label>
        <button class="btn btn--primary" id="addSave" type="button">加入菜单</button>
      </div>
      <p class="add-cap-note" id="addNote">网址要以 http:// 或 https:// 开头。有些网站禁止被嵌入，加进来会显示空白 —— 那是对方的限制，不是这里的问题。</p>
    </div>`;

  renderMenuList();

  const nameEl = host.querySelector('#addName');
  const urlEl = host.querySelector('#addUrl');
  const emojiEl = host.querySelector('#addEmoji');
  const note = host.querySelector('#addNote');

  const say = (msg, bad) => {
    note.textContent = msg;
    note.classList.toggle('bad', !!bad);
  };

  function addCapability() {
    const name = (nameEl.value || '').trim();
    const url = (urlEl.value || '').trim();
    const emoji = (emojiEl.value || '').trim() || '🔧';

    if (!name) { say('先给它起个名字。', true); nameEl.focus(); return; }
    if (!/^https?:\/\//i.test(url)) { say('网址要以 http:// 或 https:// 开头。', true); urlEl.focus(); return; }

    const s = shell();
    const custom = Array.isArray(s.custom) ? [...s.custom] : [];
    const id = `cap_${Date.now().toString(36)}`;
    custom.push({
      id, name, url, emoji, builtin: false,
      desc: url.replace(/^https?:\/\//i, '').slice(0, 42),
    });
    const order = [...allCaps().map((c) => c.id), id];
    saveShell({ custom, order, orderV: ORDER_VERSION });

    nameEl.value = ''; urlEl.value = ''; emojiEl.value = '';
    renderMenuList();
    renderNav();
    say(`「${name}」已加入菜单。`);
    toast(`「${name}」已加入菜单`);
  }

  host.querySelector('#addSave').addEventListener('click', addCapability);
  [nameEl, urlEl, emojiEl].forEach((el) => {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCapability(); } });
  });
}

function renderMenuList() {
  // 每次现取 —— 面板是按需渲染的，缓存下来的引用一定是过期的
  const menuList = $('#menuList');
  if (!menuList) return;

  const caps = allCaps();
  menuList.innerHTML = '';
  caps.forEach((cap, i) => {
    const row = document.createElement('div');
    row.className = `menu-row${cap.hidden ? ' is-hidden' : ''}`;
    row.draggable = true;
    row.dataset.id = cap.id;
    const ico = cap.builtin
      ? `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${cap.icon}</svg>`
      : `<span class="cap-emoji">${esc(cap.emoji || '🔧')}</span>`;
    row.innerHTML = `
      <span class="mr-grip" title="按住拖动调整顺序">⋮⋮</span>
      <span class="mr-ico">${ico}</span>
      <span class="mr-body">
        <span class="mr-name">${esc(cap.name)}</span>
        <span class="mr-url">${esc(cap.builtin ? '内置能力' : cap.url)}</span>
      </span>
      <span class="mr-acts">
        <button class="mr-btn" data-act="up" ${i === 0 ? 'disabled' : ''} title="上移" aria-label="上移">↑</button>
        <button class="mr-btn" data-act="down" ${i === caps.length - 1 ? 'disabled' : ''} title="下移" aria-label="下移">↓</button>
        <button class="mr-btn" data-act="toggle" title="${cap.hidden ? '在侧栏显示' : '从侧栏隐藏'}">${cap.hidden ? '显示' : '隐藏'}</button>
        ${cap.builtin ? '' : '<button class="mr-btn danger" data-act="del" title="从菜单移除">移除</button>'}
      </span>`;

    $$('.mr-btn', row).forEach((btn) => {
      btn.addEventListener('click', () => menuAction(cap, allCaps(), btn.dataset.act));
    });

    row.addEventListener('dragstart', (e) => {
      dragId = cap.id;
      row.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', cap.id); } catch (err) {}
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      row.classList.remove('dragging');
      $$('.menu-row', menuList).forEach((r) => r.classList.remove('drop-target'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      if (dragId && dragId !== cap.id) row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      let moving = dragId;
      if (!moving) { try { moving = e.dataTransfer.getData('text/plain'); } catch (err) {} }
      if (!moving || moving === cap.id) return;
      const order = allCaps().map((c) => c.id);
      const from = order.indexOf(moving);
      if (from < 0) return;
      order.splice(from, 1);
      order.splice(order.indexOf(cap.id), 0, moving);
      saveShell({ order, orderV: ORDER_VERSION });
      renderMenuList(); renderNav();
    });

    menuList.appendChild(row);
  });
}

function menuAction(cap, caps, act) {
  const s = shell();
  let order = caps.map((c) => c.id);
  let hidden = Array.isArray(s.hidden) ? [...s.hidden] : [];
  let custom = Array.isArray(s.custom) ? [...s.custom] : [];
  const i = order.indexOf(cap.id);

  if (act === 'up' && i > 0) [order[i - 1], order[i]] = [order[i], order[i - 1]];
  else if (act === 'down' && i < order.length - 1) [order[i + 1], order[i]] = [order[i], order[i + 1]];
  else if (act === 'toggle') {
    const h = hidden.indexOf(cap.id);
    if (h === -1) hidden.push(cap.id); else hidden.splice(h, 1);
  } else if (act === 'del') {
    if (!confirm(`把「${cap.name}」从菜单里移除？\n只是从这里去掉，那个网页本身不受影响。`)) return;
    custom = custom.filter((c) => c.id !== cap.id);
    order = order.filter((x) => x !== cap.id);
    hidden = hidden.filter((x) => x !== cap.id);
    frames[cap.id]?.remove();
    delete frames[cap.id];
  } else return;

  saveShell({ order, hidden, custom, orderV: ORDER_VERSION });
  renderMenuList();
  renderNav();
  if (activeId && !visibleCaps().some((c) => c.id === activeId)) {
    const v = visibleCaps();
    activate(v.length ? v[0].id : null);
  }
  toast(act === 'del' ? '已从菜单移除' : '菜单已更新');
}

/* --- 云存储配置：以前在文件库的抽屉里，现在提升到唯一设置面板 --- */
async function mountStorageForm(el) {
  el.innerHTML = `
    <div class="set-field">
      <span class="set-label">云存储服务</span>
      <select id="cfg-provider"></select>
      <p class="set-help" id="provider-summary"></p>
    </div>
    <div id="provider-fields"></div>
    <div class="cfg-status" id="provider-status"></div>
    <button class="btn" id="btn-test-storage" type="button">测试一下能不能上传</button>`;
  const mod = await import('../views/files/storage-form.js');
  mod.render();
  mod.bindTestButton();
}

function doExport() {
  const payload = exportAll(Object.values(KEYS), { secretPaths: cloud.secretPaths() });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `docsmith-配置-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('配置已导出。密钥没有写进这个文件。');
}

function clearHistory() {
  const st = read(KEYS.library, {});
  const n = (st.history || []).length;
  if (!n) { toast('还没有上传记录'); return; }
  if (!confirm(`确定清空这 ${n} 条上传记录吗？\n\n只清本地列表 —— 云上的文件不会删，之前发出去的链接照样能打开。`)) return;
  st.history = [];
  write(KEYS.library, st);
  broadcast('history-cleared', {});
  toast('记录已清空，云上的文件没有动');
}

/* --- 记住了我什么 -------------------------------------------------
   把「Docsmith 悄悄替你记下的东西」摊开给用户看，每一项旁边给个「忘掉」。
   用户选择记忆的是三类：阅读/编辑偏好、导出/下载默认、上次停在哪。
   前两类是长期偏好，逐项列出可清；「上次停在哪」只在插件开着、文件正加载
   在插件里时放在内存里，关掉就忘、不写进浏览器，这里说明一句即可。 */

const MEMORY_GROUPS = [
  {
    title: '阅读与编辑偏好',
    note: '打开文档时的样子，你改过一次就一直记着。',
    items: [
      { key: 'theme', store: 'appearance', name: '主题' },
      { key: 'accent', store: 'appearance', name: '强调色' },
      { key: 'reading.font', name: '正文字体' },
      { key: 'reading.size', name: '字号' },
      { key: 'reading.width', name: '每行宽度' },
      { key: 'reading.customCss', name: '自定义样式' },
    ],
  },
  {
    title: '导出与下载默认',
    note: '记住你最常用的那种，下次自动排在最前。',
    items: [
      { key: 'export.lastFormat', usage: 'export', name: '导出格式' },
      { key: 'share.lastKind', usage: 'share', name: '分享类型' },
      { key: 'share.format', name: '分享文案格式' },
      { key: 'files.dlMarkdown', name: '下载 Markdown 时转成' },
      { key: 'files.dlPptx', name: '下载 PPT 时转成' },
    ],
  },
  {
    /* 图文卡片只记**样式参数**，不记你写的内容、也不记上传的背景图/logo。
       内容不记是刻意的（和「不给浏览器记最近文档」同一个取向）；
       图片不记是因为要转 base64 才能进 localStorage，一张几百 KB，
       很快就把配额撑满 —— 项目为此栽过一次（9.6MB 的 recent 缓存）。
       这一段的每个 key 都必须在 core/prefs.js 的 DEFAULTS 里登记过，
       否则 memValue() 拿不到默认值，「忘掉」也无从判断。 */
    title: '图文卡片的样式',
    note: '你调好的比例、背景、水印这些，下次打开还是这样。你写的文字不会被记住。',
    items: [
      { key: 'cards.mode', name: '默认模式' },
      { key: 'cards.ratio', name: '长宽比' },
      { key: 'cards.scale', name: '清晰度' },
      { key: 'cards.background', name: '背景' },
      { key: 'cards.fontScale', name: '字号' },
      { key: 'cards.blur', name: '背景模糊' },
      { key: 'cards.wmText', name: '水印文字' },
      { key: 'cards.wmPos', name: '水印位置' },
      { key: 'cards.wmOpacity', name: '水印透明度' },
      { key: 'cards.pageNo', name: '显示页码' },
      { key: 'cards.cover', name: '多做一张封面' },
    ],
  },
];

/** 把一项记忆算成 { text 展示文字, set 是否偏离了默认（值得给「忘掉」） }。 */
function memValue(item) {
  if (item.store === 'appearance') {
    const a = appearance.read();
    const def = fieldOf(item.key)?.default;
    if (item.key === 'theme') {
      const map = { light: '亮色', dark: '暗色', auto: '跟随系统' };
      return { text: map[a.theme] || a.theme, set: a.theme !== def };
    }
    const ac = ACCENTS.find((x) => x.id === a.accent);
    return { text: ac ? ac.label : a.accent, set: a.accent !== def };
  }

  const v = prefs.get(item.key);
  const explicit = prefs.isExplicit(item.key);
  const f = fieldOf(item.key);

  if (f && f.type === 'slider') return { text: `${v}${f.unit || ''}`, set: explicit };
  if (f && (f.type === 'segment' || f.type === 'select')) {
    const o = (f.options || []).find((x) => String(x.value) === String(v));
    return { text: o ? o.label : String(v || '—'), set: explicit };
  }
  if (item.key === 'reading.customCss') return { text: v ? '已自定义' : '未设置', set: !!v };
  if (item.key === 'export.lastFormat') {
    const map = { html: '网页', docx: 'Word', pdf: 'PDF', md: 'Markdown' };
    if (v) return { text: map[v] || v, set: true };
    const guess = prefs.suggested('export', '');
    return guess
      ? { text: `${map[guess] || guess}（按你的习惯推断）`, set: true }
      : { text: '还没有偏好', set: false };
  }
  if (item.key === 'share.lastKind') {
    const map = { html: '网页', md: '源文件' };
    return { text: map[v] || v || '—', set: explicit };
  }
  /* 图文卡片那几项不在设置面板的 SECTIONS 里（它们是能力页自己的控件），
     所以 fieldOf() 拿不到，得在这里自己翻译成人话。
     不翻译的话面板上会显示 'br'、'true'、'0.55' 这种原始值 —— 那等于没说，
     用户看不懂也就无从判断要不要「忘掉」。 */
  if (item.key.startsWith('cards.')) {
    const CARD_LABELS = {
      'cards.mode': { auto: '自动分页', manual: '逐页编辑' },
      'cards.ratio': { '3:4': '3:4（小红书竖版）', '1:1': '1:1（方图）', '9:16': '9:16（抖音）', '4:3': '4:3（横版）' },
      'cards.scale': { 1: '标准', 2: '高清 2×' },
      'cards.wmPos': { tl: '左上', tr: '右上', bl: '左下', br: '右下' }
    };
    const map = CARD_LABELS[item.key];
    if (map) return { text: map[v] != null ? map[v] : String(v), set: explicit };
    if (item.key === 'cards.fontScale') return { text: Math.round((v || 1) * 100) + '%', set: explicit };
    if (item.key === 'cards.wmOpacity') return { text: Math.round((v || 0) * 100) + '%', set: explicit };
    if (item.key === 'cards.blur') return { text: v + ' px', set: explicit };
    if (item.key === 'cards.wmText') return { text: v ? String(v) : '没设', set: !!v };
    if (typeof v === 'boolean') return { text: v ? '开' : '关', set: explicit };
    return { text: String(v ?? '—'), set: explicit };
  }

  return { text: String(v ?? '—'), set: explicit };
}

function mountMemoryPanel(host) {
  const rows = MEMORY_GROUPS.map((g) => {
    const items = g.items.map((item) => {
      const { text, set } = memValue(item);
      return `
        <div class="mem-row">
          <div class="mem-main">
            <span class="mem-name">${esc(item.name)}</span>
            <span class="mem-val${set ? '' : ' is-default'}">${esc(text)}</span>
          </div>
          ${set ? `<button type="button" class="mem-forget" data-forget="${esc(item.key)}">忘掉</button>` : ''}
        </div>`;
    }).join('');
    return `
      <div class="mem-group">
        <div class="mem-group-head">
          <b>${esc(g.title)}</b>
          <span>${esc(g.note)}</span>
        </div>
        ${items}
      </div>`;
  }).join('');

  host.innerHTML = `
    ${rows}
    <div class="mem-group mem-note">
      <div class="mem-group-head"><b>上次停在哪</b></div>
      <p class="mem-hint">只在插件开着、而且这份文件正加载在插件里的时候记着 ——
        关掉插件就忘了，不会写进浏览器。所以这里没什么可清的。</p>
    </div>`;

  host.querySelectorAll('[data-forget]').forEach((btn) => {
    btn.addEventListener('click', () => forgetMem(btn.dataset.forget));
  });
}

/* ===================================================== 快捷键一览

   清单在 core/shortcuts.js（那里也写了「改绑定要回来改说明」的提醒）。
   这里只负责画：一行一个键，右边是键帽，左边是这个键干什么。
   键位按当前系统翻译 —— Windows 显示 Ctrl，Mac 显示 ⌘。 */

function mountShortcutsPanel(host) {
  const groups = SHORTCUT_GROUPS.map((g) => {
    const rows = g.items.map((it) => `
      <div class="sc-row">
        <div class="sc-main">
          <span class="sc-name">${esc(it.name)}</span>
          ${it.desc ? `<span class="sc-desc">${esc(it.desc)}</span>` : ''}
        </div>
        <div class="sc-keys">
          ${fmtKey(it.keys).map((k) => `<kbd>${esc(k)}</kbd>`).join('')}
        </div>
      </div>`).join('');
    return `
      <div class="sc-group">
        <div class="sc-group-head">
          <b>${esc(g.title)}</b>
          <span>${esc(g.note)}</span>
        </div>
        ${rows}
      </div>`;
  }).join('');

  host.innerHTML = `
    <p class="sc-lead">记不住也没关系 —— 在 Markdown 工作台里按
      <kbd>${esc(fmtKey('Mod')[0])}</kbd><kbd>K</kbd> 打开命令面板，
      所有功能都能在里面搜到，每条后面就写着它的快捷键。</p>
    ${groups}`;
}

function forgetMem(key) {  const item = MEMORY_GROUPS.flatMap((g) => g.items).find((x) => x.key === key);
  if (!item) return;

  if (item.store === 'appearance') {
    const def = fieldOf(key)?.default;
    // appearance.onChange 会顺带刷新设置面板和主题按钮，不必手动再来一遍
    appearance.set(key === 'theme' ? { theme: def } : { accent: def });
  } else {
    prefs.reset(key);
    if (item.usage) forgetUsage(item.usage);
    broadcast('setting', { key, value: prefs.get(key) });
    settingsPanel.refresh();
  }
  toast('已忘掉，回到默认');
}

/* --- 云存储概览 --- */
function renderStorageSummary() {
  const d = cloud.describe();
  const sumEl = $('#storageSummary');
  if (sumEl) sumEl.innerHTML = d.ready
    ? `<span class="dot ok"></span>已连接 · ${esc(d.providerName)}${d.detail ? ` · ${esc(d.detail)}` : ''}`
    : `<span class="dot warn"></span>${esc(d.problem || '还没连接')}`;
}
$('#gotoStorageCfg')?.addEventListener('click', () => {
  openSettings('storage');
});
cloud.onConfigChange(renderStorageSummary);

/* --- 组件状态 --- */
function renderVendorList() {
  const rows = vendorReport();
  const builtinCount = rows.filter((r) => r.builtin).length;
  const missing = rows.filter((r) => !r.ok);

  let banner = '';
  if (!builtinCount && !missing.length) {
    banner = '<div class="vd-banner ok">全部组件齐备</div>';
  } else {
    /* 这一段是给普通用户看的，不是给开发者看的。
       不提 npm、不提 Releases、不提"让维护者做点什么" ——
       只说：现在什么能用、什么不能用、不能用的那件事怎么绕过去。 */
    banner = `
      <div class="vd-banner">
        <b>下面这些功能现在就能用</b>
        <p>阅读、编辑、表格、流程图、改动审阅、文件库，
        以及导出成网页 / Markdown / PDF（走「打印 → 另存为 PDF」）。
        装好插件就是全的，不需要你再安装任何东西。</p>
        ${missing.length ? '<p class="vd-how">下面标灰的几项体积太大，没有随包附带。用不到就当它不存在；真要用，每一项后面都写了替代办法。</p>' : ''}
      </div>`;
  }

  $('#vendorList').innerHTML = banner + rows.map((r) => {
    const state = r.builtin ? 'warn' : (r.ok ? 'ok' : (r.required ? 'err' : 'warn'));
    const note = r.builtin ? '自带的简化版，够用' : (r.ok ? '完整版' : r.note);
    return `
      <div class="vd-row">
        <span class="dot ${state}"></span>
        <span class="vd-name">${esc(r.label)}</span>
        <span class="vd-note">${esc(note)}</span>
      </div>`;
  }).join('');
}

/* --- 备份：导入。导出在 doExport() 里 --- */
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const n = importAll(JSON.parse(await file.text()));
    toast(`已恢复 ${n} 项设置。正在重新加载…`);
    setTimeout(() => location.reload(), 800);
  } catch (err) {
    toast(err.message);
  }
  e.target.value = '';
});

/* ===================================================== 消息路由 */

const uploadReq = new Map();

on('ready', (d, meta) => {
  // 能力页起来了，把当前外观发过去
  const src = meta.source;
  if (src) { try { src.postMessage({ ns: 'docsmith', type: 'appearance', ...appearance.read() }, '*'); } catch (e) {} }
});

on('appearance', (d) => {
  const cur = appearance.read();
  if (d.theme === cur.theme && d.accent === cur.accent) return;  // 值没变就不写，免得来回回声
  appearance.set({ theme: d.theme, accent: d.accent });
});

on('switch', (d) => activate(d.tab, d.file ? { file: d.file } : null));

/* 任何能力页点齿轮 / 「配置云存储」，都打开外壳这唯一的设置面板。
   曾经 storage 分区要先切到文件库、再把消息投回它自己的抽屉里 —— 那是
   文件库还带独立抽屉时的做法。抽屉早删了，云存储配置现在就长在这个面板
   的「云存储」分区里。继续往文件库投递只会绕回来：文件库收到后又点一次
   齿轮、再投回外壳，两边来回弹，消息队列被打满，页面就卡死了。直接开
   本面板，环就断了。 */
on('open-settings', (d) => {
  openSettings(d.section);
});

/* 能力页在 iframe 里下载常被浏览器拦，由外壳代劳 */
on('saveBlob', (d, meta) => {
  try {
    const blob = d.blob instanceof Blob ? d.blob : new Blob([d.blob], { type: d.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = d.name || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
    if (meta.source && d.id) meta.source.postMessage({ ns: 'docsmith', type: 'saveBlobAck', id: d.id }, '*');
  } catch (e) {
    toast('下载没能开始，换个格式再试试。');
  }
});

/* 「导出 PDF」：能力页把「所见即所得那份网页」发过来，外壳在真标签页里打开它。
   那份网页里带了一小段 window.print()，用户在系统对话框里选「另存为 PDF」。

   为什么不在能力页里直接 window.print()：能力页是个 iframe，在侧边栏里这条路
   本来就不通，而且排版会按外壳这一层算 —— @media print 写在能力页自己的样式表
   里，管不到外面。详见 workspace.js 的 exportPdf()。

   blob: URL 必须在**外壳**这一侧创建：iframe 造的 blob URL 生命周期挂在 iframe
   上，标签页还没读完就可能被回收，用户看到一张白纸。
   开标签页分三级降级，从最可靠的往下退：
     1) service worker（一定有 chrome.tabs）
     2) 本页的 chrome.tabs（侧边栏里不保证可用）
     3) window.open（常被当弹窗拦掉）
   三级都失败就说一句人话，指向一条走得通的路。 */
on('printHtml', async (d, meta) => {
  const ack = (ok) => {
    if (meta.source && d.id) meta.source.postMessage({ ns: 'docsmith', type: 'printHtmlAck', id: d.id, ok }, '*');
  };
  let url = null;
  try {
    const blob = d.html instanceof Blob ? d.html : new Blob([d.html || ''], { type: 'text/html' });
    url = URL.createObjectURL(blob);

    let opened = false;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'docsmith:open-url', url });
      opened = !!(r && r.ok);
    } catch (e) { /* 退到下一级 */ }
    if (!opened) {
      try { await chrome.tabs.create({ url, active: true }); opened = true; } catch (e) { /* 再退 */ }
    }
    if (!opened) {
      try { opened = !!window.open(url, '_blank'); } catch (e) {}
    }
    if (!opened) toast('浏览器拦住了新标签页。允许弹出窗口后再试，或先「导出 → 网页」再自己打印。');
    ack(opened);
  } catch (e) {
    toast('没能打开打印页面，改用「导出 → 网页」再自己打印。');
    ack(false);
  } finally {
    // 打印预览还要读它，别撤太早
    if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 120000);
  }
});

/* 子框架没焦点时写不了图片剪贴板，顶层文档可以 */
on('copyImage', async (d, meta) => {
  const done = (ok) => {
    if (meta.source && d.id) meta.source.postMessage({ ns: 'docsmith', type: 'copyImageResult', id: d.id, ok }, '*');
  };
  try {
    const blob = d.blob instanceof Blob ? d.blob : new Blob([d.blob], { type: d.mime || 'image/png' });
    if (!navigator.clipboard?.write || !window.ClipboardItem) { done(false); return; }
    window.focus();
    await navigator.clipboard.write([new ClipboardItem({ [d.mime || 'image/png']: blob })]);
    done(true);
  } catch (e) { done(false); }
});

/* 富文本复制（「复制文档」按钮）。和上面 copyImage 同一个道理：
   能力页嵌在外壳里时常常不被认为"有焦点"，clipboard.write 会被拒 ——
   顶层文档可以，所以由外壳代写。
   关键是必须写 **text/html** 这个 flavour，飞书 / WPS / Word 才会认作富文本；
   只写 text/plain 的话粘出来是一堆尖括号。 */
on('copyRich', async (d, meta) => {
  const done = (ok) => {
    if (meta.source && d.id) meta.source.postMessage({ ns: 'docsmith', type: 'copyRichResult', id: d.id, ok }, '*');
  };
  try {
    if (!navigator.clipboard?.write || !window.ClipboardItem) { done(false); return; }
    window.focus();
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([d.html || ''], { type: 'text/html' }),
      'text/plain': new Blob([d.plain || ''], { type: 'text/plain' })
    })]);
    done(true);
  } catch (e) { done(false); }
});

/* ============================================ 整页 / 侧边栏 */

/* 在侧边栏里才需要"展开"这个动作；已经是整页了就把按钮收起来 */
const isPanel = !location.search.includes('full=1') && window.innerWidth < 700;
const expandBtn = $('#expandBtn');

function syncExpandBtn() {
  // 侧边栏很窄，整页很宽 —— 用宽度判断比猜环境可靠
  expandBtn.hidden = window.innerWidth >= 700;
}
syncExpandBtn();
window.addEventListener('resize', syncExpandBtn);

expandBtn.addEventListener('click', () => {
  try {
    chrome.runtime.sendMessage({ type: 'docsmith:open-tab' });
  } catch (e) {
    window.open(chrome.runtime.getURL('src/app/index.html?full=1'), '_blank');
  }
});

const openSeg = $('#openModeSeg');
openSeg?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  prefs.set('ui.openMode', b.dataset.mode);
  syncOpenMode();
  toast(b.dataset.mode === 'tab' ? '以后点图标会直接开整页' : '以后点图标会开侧边栏');
});

function syncOpenMode() {
  const mode = prefs.get('ui.openMode') || 'panel';
  $$('#openModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

/* ===================================================== 杂项 */

/* 外壳自己的 toast 容器。文件库也有一个 id="toasts"（它的上传进度条），
   所以这里限定成「body 的直接子元素」—— 外壳那个就挂在 body 上，
   能力页那个在容器里面。裸 #toasts 拿到的是先出现的那一个，靠运气。 */
const toasts = $('body > #toasts') || $('#toasts');
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  toasts.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity .3s';
    setTimeout(() => t.remove(), 300);
  }, 2400);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
  /* 数字键 1–9 跳到第 n 个能力。
     排除条件不能只看 input/textarea/select —— Markdown 工作台的「在排好版
     的界面上直接改字」用的是 contentEditable 的块，标签名是 P / LI / TD。
     iframe 时代这一条监听够不到那些块，所以从没暴露过；能力页一旦和外壳
     同处一个文档，用户在正文里打一个「1」就会被弹到另一个能力去。
     也放过带修饰键的组合：⌘1 之类留给浏览器切标签页。 */
  if (!/^[1-9]$/.test(e.key)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /input|textarea|select/i.test(t.tagName || ''))) return;
  const v = visibleCaps();
  const c = v[Number(e.key) - 1];
  if (c) activate(c.id);
});
window.addEventListener('resize', moveIndicator);

/* ===================================================== 启动 */

$('#brandName').textContent = BRAND.name;
$('#brandTag').textContent = BRAND.tagline;
$('#brandMark').textContent = BRAND.mark;
{ const _e = $('#repoLink'); if (_e) _e.href = BRAND.repo; }
const aboutEl = $('#aboutText');
if (aboutEl) aboutEl.textContent =
  `${BRAND.name}（${BRAND.nameZh}）是一个开源项目。你的文件存在你自己的云上，`
  + '配置存在这台电脑上，Docsmith 没有服务器，也不收集任何东西。';

const s0 = shell();
setPinned(s0.pinned !== false);
renderNav();

let start = s0.activeId;
const vis = visibleCaps();
if (!vis.some((c) => c.id === start)) start = vis.length ? vis[0].id : null;
if (start) activate(start);

requestAnimationFrame(moveIndicator);
if (document.fonts?.ready) document.fonts.ready.then(moveIndicator);
