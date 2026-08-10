
/* ==========================================================================
   Docsmith · Markdown 工作台 —— 应用逻辑（阅读界面就是编辑界面）
   Globals via CDN: marked, hljs, mermaid, katex, DOMPurify, docx
   ========================================================================== */
(function () {
  'use strict';

  /* ====================== 与外壳 / 云存储的接口 =======================
     上传、分享、写入文件库记录，全部走 window.DSCloud（views/shared/
     cloud-bridge.js）。这里不再出现任何具体的服务器地址或账号 ——
     那些是用户自己的配置，存在他本机。
     ==================================================================== */
  var BUS_NS = 'docsmith';

  /* ---------------------------------------------------------------- 状态宿主
     这个工作台用「在根元素上挂 data-* 和 class」来表达界面状态：
     data-mode=source、data-edit=on、.side-open、.empty、.has-chg …
     配套的 CSS 有 40 条 [data-ds-root][data-…] 选择器。

     以前根元素就是 document.body，因为这一页独占一个 iframe。现在要把内置
     能力直接放进外壳文档，body 就成了**外壳的** body —— 三个能力同时在线，
     谁都往 body 上写 data-mode，互相踩。

     所以引入 ROOT：状态写在这一页自己的根容器上。
       · 还在 iframe 里（或直接打开这个 html）→ ROOT 就是 document.body，
         行为和以前一字不差；
       · 被合并进外壳 → 外壳把能力容器标上 data-ds-host="markdown"，
         ROOT 指向它，状态和 CSS 都被关在容器内。

     注意：真正需要「贴在视口上」的东西（不可见的复制用 textarea、触发下载的
     <a>）继续用 document.body —— 它们和界面状态无关，插哪儿都一样，而且
     必须在文档里才生效。 */
  var ROOT = document.querySelector('[data-ds-host="markdown"]') || document.body;
  /* index.html 的 <body> 已经带了 data-ds-root（属性写在标签上，避免首帧
     没排版的闪动）。这里补一次是为了「外壳把我们挂进容器」那条路 ——
     那时容器不一定带这个属性。已经有了就等于什么都没做。 */
  if (!ROOT.hasAttribute('data-ds-root')) ROOT.setAttribute('data-ds-root', '');

  /* 取节点一律**从 ROOT 里面找**，不从整个 document 找。
     这是合并进外壳后不撞车的关键：markdown 页和外壳都有 #settingsBtn、
     #sidebar，文件库和外壳都有 #toasts。从 document 查，
     document.querySelector('#settingsBtn') 命中的是**先出现在 DOM 里的那个**
     —— 也就是外壳的那颗，于是「阅读设置」那颗按钮的事件绑到了外壳的齿轮上。
     从 ROOT 查，各自只看见自己那一份，同名也互不干扰。
     （独立打开这一页时 ROOT===body，等于原来的行为。） */
  var $ = function (s, r) { return (r || ROOT).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || ROOT).querySelectorAll(s)); };

  var preview = $('#preview'), previewPane = $('#previewPane'), editor = $('#editor');
  var tocBody = $('#tocBody'), filesBody = $('#filesBody'), statusEl = $('#status');
  var urlInput = $('#urlInput'), toastEl = $('#toast');
  var overlay = $('#overlay'), overlayBody = $('#overlayBody');
  var findPanel = $('#findPanel'), findInput = $('#findInput'), replaceInput = $('#replaceInput');

  /* 第三方组件可能没装全（安装时网络不好）。缺了就把对应功能藏起来，
     其余一切照常，绝不白屏。 */
  var HAS = {
    md: typeof window.marked !== 'undefined',
    purify: typeof window.DOMPurify !== 'undefined',
    hljs: typeof window.hljs !== 'undefined',
    katex: typeof window.katex !== 'undefined',
    mermaid: typeof window.mermaid !== 'undefined',
    docx: typeof window.docx !== 'undefined'
  };

  var mmCounter = 0, docs = [], currentId = null;
  var assetMap = {}, assetUrls = [];
  var currentFolderHandle = null;
  var currentUrl = '', refreshTimer = null, lastFetched = '';
  /* 「有没有外壳能替我干活」，不是「我是不是 iframe」。

     内置能力已经不在 iframe 里了 —— 它们直接注入外壳文档，
     window.self === window.top。所以老写法（只比 self/top）在合并模式下
     一律返回 false，凡是「请外壳代劳」的分支全部走不到：
       · exportPdf   → 不发 printHtml，改走 openPrintTab() 自己开标签页；
                       而 blob: URL 是在能力这一侧造的，且此处 window.open
                       在侧边栏里常被拦，PDF 那条路就时好时坏
       · download    → 不发 saveBlob，退回 <a download>
       · copyImage   → 不请外壳写剪贴板
     判据改成「同文档里有没有外壳挂的容器」，三种情形都对：
       合并模式 → 有 [data-ds-host] 容器；postMessage 给自己也收得到
                  （core/bus.js 里外壳对内置能力就是就地分派）
       仍是 iframe（用户自建能力）→ self !== top
       独立打开这一页 → 两者都不成立，保持原来的本地行为 */
  var IN_SHELL = (function () {
    try { if (window.self !== window.top) return true; } catch (e) { return true; }
    try { return !!document.querySelector('[data-ds-host="markdown"]'); } catch (e) { return false; }
  })();

  /* ---------------------------------------------------------------- 状态宿主
     ROOT 和 $ / $$ 都定义在文件开头（BUS_NS 下面）—— 必须在第一次 $() 调用
     之前就位，那几行 var preview = $('#preview') 紧跟其后。 */

  /* window/document 级快捷键的闸门：只在本能力正显示着时才响应。
     合并进外壳后三个能力共用一个 window，不设闸就会「一个键两处响应」。

     判断刻意放在**按键触发那一刻**，不是绑定那一刻 —— active.js 是 defer，
     万一它比这里晚一步就位，绑定时读到 undefined 会把闸门永久关掉：
     iframe 模式下看起来一切正常（本来就没有可抢的对象），合并之后才发现
     快捷键根本没隔离，而且不报任何错。每次现取，代价是一次属性查找。 */
  function keyGate(fn) {
    return function (e) {
      var A = window.DSActive;
      if (A && A.isActive && !A.isActive(ROOT)) return;
      return fn.call(this, e);
    };
  }

  /* 阅读偏好统一存进 DSPrefs：和扩展其他地方共用一套记忆，
     「导出配置」时能一起带走，换台电脑还是你习惯的样子。

     ⚠ 键名必须和设置面板用的**完全一致**，否则就是「改了不生效」。

     这里踩过一个真 bug：工作台原来用 `md:size` / `md:width`，而设置面板
     （core/settings.js 的 SECTIONS）用的是 `reading.size` / `reading.width`
     —— 同一个设置两个键名。表现是：拖动滑块时文档确实变了（面板广播
     'setting' → applyReadingSetting 直接改 DOM），但**存的是 md:***，
     面板下次打开时读 `reading.*` 读不到，于是显示回默认值，
     用户重开插件后一切复原 —— 也就是用户报的「字号、每行宽度记录失败」。

     现在统一走 `reading.*`。老用户的 `md:*` 只在 `reading.*` 不存在时读一次
     （见 legacyKey / get），读到就顺手写成新键名，下次不用再兜。
     值一律按字符串存取，保持和原来一致，免得到处改类型。 */
  var PREF_MAP = { font: 'reading.font', size: 'reading.size', width: 'reading.width', customCss: 'reading.customCss' };
  var store = {
    get: function (k, d) {
      var key = PREF_MAP[k] || ('md:' + k);
      if (window.DSPrefs) {
        var v = DSPrefs.get(key, undefined);
        if (v === undefined && PREF_MAP[k]) {
          /* 迁移：老版本存在 md:* 下。读到就搬到新键名，只做一次。 */
          var old = DSPrefs.get('md:' + k, undefined);
          if (old !== undefined) { DSPrefs.set(key, String(old)); return String(old); }
        }
        return v === undefined ? d : String(v);
      }
      try { var raw = localStorage.getItem('mdr:' + k); return raw === null ? d : raw; }
      catch (e) { return d; }
    },
    set: function (k, v) {
      var key = PREF_MAP[k] || ('md:' + k);
      if (window.DSPrefs) { DSPrefs.set(key, String(v)); return; }
      try { localStorage.setItem('mdr:' + k, String(v)); } catch (e) {}
    }
  };

  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function throttle(fn, wait) { var t = 0, id; return function () { var now = Date.now(), c = this, a = arguments, r = wait - (now - t); if (r <= 0) { t = now; fn.apply(c, a); } else { clearTimeout(id); id = setTimeout(function () { t = Date.now(); fn.apply(c, a); }, r); } }; }
  function debounce(fn, wait) { var id; return function () { var c = this, a = arguments; clearTimeout(id); id = setTimeout(function () { fn.apply(c, a); }, wait); }; }
  function toast(msg, kind) { toastEl.textContent = msg; toastEl.className = 'toast show' + (kind ? ' ' + kind : ''); clearTimeout(toast._t); toast._t = setTimeout(function () { toastEl.className = 'toast'; }, 3600); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function curDoc() { return docs.filter(function (x) { return x.id === currentId; })[0]; }
  function displayDocTitle(d) {
    var name = d && (d.name || d.relPath);
    return name ? name.replace(/\.(md|markdown|mkd|mdx)$/i, '') : '';
  }
  function updateWorkspaceTitle() {
    var el = $('#workspaceTitle'); if (!el) return;
    var title = displayDocTitle(curDoc());
    if (title) {
      el.textContent = title;
      el.title = title;
      el.setAttribute('aria-label', '当前文档：' + title);
    } else {
      el.innerHTML = 'Markdown<span class="dot">·</span>工作台';
      el.title = 'Markdown 工作台';
      el.setAttribute('aria-label', 'Markdown 工作台');
    }
  }
  function flashBtn(btn, label) { var o = btn.textContent; btn.textContent = label || '已复制'; btn.classList.add('ok'); setTimeout(function () { btn.textContent = o; btn.classList.remove('ok'); }, 1400); }

  /* ---------- emoji / slug / footnotes / abbr ------------------------ */
  var EMOJI = { smile:'😄',grin:'😁',joy:'😂',heart:'❤️',broken_heart:'💔','+1':'👍','-1':'👎',tada:'🎉',rocket:'🚀',fire:'🔥',star:'⭐',warning:'⚠️',bulb:'💡',check:'✅',white_check_mark:'✅',x:'❌',eyes:'👀',bug:'🐛',sparkles:'✨',ok_hand:'👌',wave:'👋',book:'📖',memo:'📝',zap:'⚡','100':'💯',thinking:'🤔',pray:'🙏',clap:'👏',coffee:'☕',sunny:'☀️',moon:'🌙',question:'❓',exclamation:'❗',rainbow:'🌈',muscle:'💪',tools:'🛠️',lock:'🔒',key:'🔑',hourglass:'⏳',bell:'🔔' };
  function emojify(src) { return src.replace(/:([a-z0-9_+\-]+):/gi, function (m, n) { return EMOJI[n.toLowerCase()] || m; }); }
  var usedIds = {};
  function resetIds() { usedIds = {}; }
  function slugify(text) { var s = String(text).replace(/<[^>]*>/g, '').trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-'); if (!s) s = 'section'; var b = s, i = 1; while (usedIds[s]) s = b + '-' + (i++); usedIds[s] = true; return s; }
  function processFootnotes(src) {
    var defs = {};
    src = src.replace(/^\[\^([^\]]+)\]:[ \t]*(.+)$/gm, function (m, id, b) { defs[id] = b.trim(); return ''; });
    var order = [];
    src = src.replace(/\[\^([^\]]+)\]/g, function (m, id) { if (!(id in defs)) return m; if (order.indexOf(id) < 0) order.push(id); return '<sup class="fn-ref" id="fnref-' + id + '"><a href="#fn-' + id + '">' + (order.indexOf(id) + 1) + '</a></sup>'; });
    return { src: src, defs: defs, order: order };
  }
  function footnotesHtml(defs, order) { if (!order.length) return ''; return '<section class="footnotes"><hr><ol>' + order.map(function (id) { return '<li id="fn-' + id + '">' + marked.parseInline(defs[id]) + ' <a class="fn-back" href="#fnref-' + id + '">↩︎</a></li>'; }).join('') + '</ol></section>'; }
  function processAbbr(src) { var defs = {}; src = src.replace(/^\*\[([^\]]+)\]:[ \t]*(.+)$/gm, function (m, k, v) { defs[k.trim()] = v.trim(); return ''; }); return { src: src, abbr: defs }; }
  function wrapAbbr(defs) {
    var keys = Object.keys(defs); if (!keys.length) return;
    keys.sort(function (a, b) { return b.length - a.length; });
    var pat = '(' + keys.map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')';
    var reTest = new RegExp(pat), reSplit = new RegExp(pat, 'g');
    var w = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { var p = n.parentNode; while (p && p !== preview) { var t = p.nodeName; if (t === 'CODE' || t === 'PRE' || t === 'A' || t === 'ABBR') return NodeFilter.FILTER_REJECT; p = p.parentNode; } return reTest.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } });
    var nodes = [], c; while ((c = w.nextNode())) nodes.push(c);
    nodes.forEach(function (node) { reSplit.lastIndex = 0; var s = node.nodeValue, frag = document.createDocumentFragment(), last = 0, m; while ((m = reSplit.exec(s))) { if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index))); var ab = document.createElement('abbr'); ab.title = defs[m[1]]; ab.textContent = m[1]; frag.appendChild(ab); last = m.index + m[1].length; } if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last))); node.parentNode.replaceChild(frag, node); });
  }

  /* ---------- marked extensions -------------------------------------- */
  var blockMath = { name: 'blockMath', level: 'block', start: function (s) { var i = s.indexOf('$$'); return i < 0 ? undefined : i; }, tokenizer: function (s) { var m = /^\$\$([\s\S]+?)\$\$/.exec(s); if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() }; }, renderer: function (t) { if (!window.katex) return escapeHtml(t.raw); try { return '<div class="math-block">' + katex.renderToString(t.text, { displayMode: true, throwOnError: false }) + '</div>'; } catch (e) { return '<div class="math-block math-err">' + escapeHtml(t.text) + '</div>'; } } };
  var inlineMath = { name: 'inlineMath', level: 'inline', start: function (s) { var i = s.indexOf('$'); return i < 0 ? undefined : i; }, tokenizer: function (s) { var m = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$/.exec(s); if (m) return { type: 'inlineMath', raw: m[0], text: m[1] }; }, renderer: function (t) { if (!window.katex) return escapeHtml(t.raw); try { return katex.renderToString(t.text, { throwOnError: false }); } catch (e) { return escapeHtml(t.raw); } } };
  function simpleInline(name, delim, tag) { var d = delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); var re = new RegExp('^' + d + '(?![' + d.slice(-2) + '\\s])([^\\n]+?)' + d); return { name: name, level: 'inline', start: function (s) { var i = s.indexOf(delim); return i < 0 ? undefined : i; }, tokenizer: function (s) { var m = re.exec(s); if (m) return { type: name, raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }; }, renderer: function (t) { return '<' + tag + '>' + this.parser.parseInline(t.tokens) + '</' + tag + '>'; } }; }
  var markExt = simpleInline('mdMark', '==', 'mark'), insExt = simpleInline('mdIns', '++', 'ins');
  var supExt = { name: 'mdSup', level: 'inline', start: function (s) { var i = s.indexOf('^'); return i < 0 ? undefined : i; }, tokenizer: function (s) { var m = /^\^([^\s^]+)\^/.exec(s); if (m) return { type: 'mdSup', raw: m[0], text: m[1] }; }, renderer: function (t) { return '<sup>' + escapeHtml(t.text) + '</sup>'; } };
  var subExt = { name: 'mdSub', level: 'inline', start: function (s) { var i = s.indexOf('~'); return i < 0 ? undefined : i; }, tokenizer: function (s) { var m = /^~(?!~)([^\s~]+)~(?!~)/.exec(s); if (m) return { type: 'mdSub', raw: m[0], text: m[1] }; }, renderer: function (t) { return '<sub>' + escapeHtml(t.text) + '</sub>'; } };

  /* ---- CJK-aware emphasis (bold / italic / strikethrough) ------------
     marked 4.x follows CommonMark's left/right-flanking rules, which were
     written for ASCII word boundaries. When a delimiter run sits against a
     Chinese character or full-width punctuation — e.g. 而是**"…"**。 or
     一种**自我强化的正反馈循环**： — those rules refuse to open/close the
     emphasis, so the raw ** * ~~ leak through as literal text. That is the
     "加粗不渲染" bug.
     These extensions match the delimiters directly and only insist the run
     isn't padded by spaces, so emphasis renders next to any neighbour while
     genuine literals like "2 ** 3" are still left alone (the space guard).
     Inner text is re-tokenised, so nesting, links and inline code keep
     working. Extensions run before marked's native inline rules, and the
     order below (*** → ** → *) resolves the longer delimiter first. */
  function flankInline(name, hint, re, open, close) {
    return {
      name: name, level: 'inline',
      start: function (s) { var i = s.indexOf(hint); return i < 0 ? undefined : i; },
      tokenizer: function (s) { var m = re.exec(s); if (m) return { type: name, raw: m[0], tokens: this.lexer.inlineTokens(m[1]) }; },
      renderer: function (t) { return open + this.parser.parseInline(t.tokens) + close; }
    };
  }
  var strongEmExt = flankInline('cjkStrongEm', '*',  /^\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/,      '<strong><em>', '</em></strong>');
  var strongExt   = flankInline('cjkStrong',   '*',  /^\*\*(?![\s*])([\s\S]*?\S)\*\*/,       '<strong>',     '</strong>');
  var emExt       = flankInline('cjkEm',       '*',  /^\*(?![\s*])([\s\S]*?\S)\*/,           '<em>',         '</em>');
  var delExt      = flankInline('cjkDel',      '~~', /^~~(?=\S)([\s\S]*?\S)~~/,              '<del>',        '</del>');
  var tocMarker = { name: 'tocMarker', level: 'block', start: function (s) { var m = s.match(/^\[\[?TOC\]\]?/mi); return m ? m.index : undefined; }, tokenizer: function (s) { var m = /^\[\[?TOC\]\]?[ \t]*(?:\n+|$)/i.exec(s); if (m) return { type: 'tocMarker', raw: m[0] }; }, renderer: function () { return '<div class="toc-inline" data-toc></div>'; } };

  /* 图表块头上的按钮刻意用英文 —— 用户明确要求，界面其余部分仍是中文。

     **只有两颗**，不是三颗。原来是 View source / Copy PNG / Copy code 并排：
     三颗里有两颗是"复制"，用户得先分辨 PNG 和 code 指的是哪个，而屏幕上
     明明只显示着其中一种东西。用户的话是「看的是图，复制的就是图；看的源码，
     复制的就是源码」—— 复制什么应该跟着**当前在看什么**走，不该是个选择题。

     所以：
       · 左边那颗切换视图：View source ⇄ View diagram
       · 右边那颗永远只做一件事 —— 复制你正在看的东西，标签随视图改：
         图表视图 → Copy image；源码视图 → Copy code

     标签必须四处一致：这里（含 data-* 上的两套文案）、下面的切换处理、
     mmError()、以及 EXPORT_JS（导出网页里内嵌的那份）。
     把两套文案写在 data-diagram-label / data-source-label 上，切换时直接读，
     省得同样的字符串在 JS 里再抄一遍 —— 以前就是抄漏了才出现「页面上写
     看源码、导出的网页里写 View diagram」这种两副面孔。 */
  function diagramBlock(code, language) {
    var lang = String(language || '').toLowerCase();
    return '<div class="diagram-block" data-view="diagram" data-diagram-language="' + escapeHtml(lang) + '"><div class="cb-head"><span class="cb-lang">' + escapeHtml(lang) + '</span><span class="cb-actions">' +
      '<button class="mm-toggle" type="button" data-diagram-label="View source" data-source-label="View diagram">View source</button>' +
      '<button class="mm-copy" type="button" data-diagram-label="Copy image" data-source-label="Copy code">Copy image</button></span></div>' +
      '<div class="diagram-render"><div class="mm-loading">正在画图…</div></div>' +
      '<pre class="diagram-source"><code class="language-' + escapeHtml(lang) + '">' + escapeHtml(code) + '</code></pre></div>';
  }
  function codeBlock(code, infostring) {
    var lang = (infostring || '').trim().split(/\s+/)[0].toLowerCase();
    if (window.DocsmithDiagrams && DocsmithDiagrams.supportsFence(lang)) return diagramBlock(code, lang);
    var hi, shown = lang || 'text';
    if (window.hljs) { try { if (lang && hljs.getLanguage(lang)) hi = hljs.highlight(code, { language: lang }).value; else { var r = hljs.highlightAuto(code); hi = r.value; shown = lang || r.language || 'text'; } } catch (e) { hi = escapeHtml(code); } } else hi = escapeHtml(code);
    return '<div class="code-block"><div class="cb-head"><span class="cb-lang">' + escapeHtml(shown) + '</span><button class="copy-btn" type="button">Copy</button></div><pre><code class="hljs language-' + escapeHtml(lang || '') + '">' + hi + '</code></pre></div>';
  }
  marked.use({ gfm: true, breaks: false, headerIds: false, mangle: false, extensions: [strongEmExt, strongExt, emExt, delExt, blockMath, inlineMath, tocMarker, markExt, insExt, supExt, subExt], renderer: { code: function (code, i) { return codeBlock(code, i); }, heading: function (text, level) { var id = slugify(text); return '<h' + level + ' id="' + id + '"><a class="h-anchor" href="#' + id + '" aria-hidden="true">#</a>' + text + '</h' + level + '>'; } } });

  /* ---------- render -------------------------------------------------- */
  function safe(label, fn) { try { fn(); } catch (e) { console.error('[mdr] ' + label + ' failed:', e); return e; } }
  function renderError(msg) {
    var d = document.createElement('div');
    d.className = 'render-error';
    d.textContent = 'Rendering hit a problem (' + msg + '). Showing the raw Markdown below so nothing is lost.';
    preview.insertBefore(d, preview.firstChild);
  }
  /* ---------- block map: rendered element  <->  Markdown source range ----
     The document is lexed into top-level blocks ONCE, and every block is
     rendered inside <div class="blk" data-blk="i">. Because each wrapper knows
     the exact [start,end) offsets of its own Markdown, clicking a paragraph in
     the reading view can open exactly that paragraph's source, and writing it
     back is a string splice — no diffing, no second pane, no drift.
     Blocks are rendered one at a time from the ORIGINAL source (not from a
     pre-processed copy), which is what keeps the offsets trustworthy. Document
     level things (footnote defs, abbreviation defs, link reference defs) are
     collected up-front and applied per block. */
  var docBlocks = [];
  var FN_DEF_RE = /^\[\^([^\]]+)\]:[ \t]*(.+)$/gm;
  var ABBR_DEF_RE = /^\*\[([^\]]+)\]:[ \t]*(.+)$/gm;
  function collectLinkDefs(src) {
    var re = /^ {0,3}\[([^\]\n^][^\]\n]*)\]:[ \t]*\S+.*$/gm, out = [], m;
    while ((m = re.exec(src))) out.push(m[0]);
    return out.join('\n');
  }
  /* marked emits a block-level <details> container as several tokens:
     opening HTML, Markdown children, then closing HTML.  Keep that range
     together so the .blk wrapper cannot make the browser close <details>
     before its children are inserted. */
  function detailsTagDelta(raw) {
    var s = String(raw || '').replace(/<!--[\s\S]*?-->/g, ''), open = 0, close = 0, m;
    var re = /<\/?details\b[^>]*>/gi;
    while ((m = re.exec(s))) {
      if (/^<\//.test(m[0])) close++;
      else if (!/\/\s*>$/.test(m[0])) open++;
    }
    return { open: open, close: close };
  }
  function lexBlocks(src) {
    var toks;
    try { toks = marked.lexer(src); }
    catch (e) { return src.trim() ? [{ start: 0, end: src.length, raw: src, type: 'paragraph' }] : []; }
    var blocks = [], pos = 0, openTail = false;
    var detailsDepth = 0, detailsStart = -1, detailsEnd = -1, detailsRaw = '';
    function finishDetails() {
      blocks.push({ start: detailsStart, end: detailsEnd, raw: detailsRaw, type: 'html' });
      detailsDepth = 0; detailsStart = -1; detailsEnd = -1; detailsRaw = '';
      openTail = true;
    }
    for (var ti = 0; ti < toks.length; ti++) {
      var t = toks[ti];
      var raw = t.raw || '', start = pos; pos += raw.length;
      var tags = t.type === 'html' ? detailsTagDelta(raw) : { open: 0, close: 0 };
      if (detailsDepth) {
        detailsRaw += raw; detailsEnd = pos;
        detailsDepth += tags.open - tags.close;
        if (detailsDepth <= 0) finishDetails();
        continue;
      }
      if (tags.open > tags.close) {
        detailsStart = start; detailsEnd = pos; detailsRaw = raw;
        detailsDepth = tags.open - tags.close;
        if (detailsDepth <= 0) finishDetails();
        continue;
      }
      if (t.type === 'space') {                    // blank lines belong to the block above…
        if (openTail && blocks.length) blocks[blocks.length - 1].end = pos;
        continue;
      }
      if (t.type === 'def') { openTail = false; continue; }   // …but a link definition is nobody's tail
      blocks.push({ start: start, end: pos, raw: raw, type: t.type });
      openTail = true;
    }
    if (detailsDepth) finishDetails();
    return blocks;
  }
  function blockSource(b) { return (b.raw || '').replace(/\s+$/, ''); }
  function blkEl(i) { return preview.querySelector('.blk[data-blk="' + i + '"]'); }
  function blockAtOffset(off) {
    for (var i = 0; i < docBlocks.length; i++) if (off < docBlocks[i].end) return i;
    return docBlocks.length ? docBlocks.length - 1 : -1;
  }

  function renderMarkdown(text) {
    resetIds();
    var src = String(text == null ? '' : text);
    var err = null;
    var abbrDefs = null, fnDefs = {}, fnOrder = [], linkDefs = '';
    try {
      abbrDefs = processAbbr(src).abbr;
      var fn = processFootnotes(src); fnDefs = fn.defs; fnOrder = fn.order;
      linkDefs = collectLinkDefs(src);
    } catch (e) { err = e; }

    docBlocks = [];
    var parts = [];
    try {
      docBlocks = lexBlocks(src);
      docBlocks.forEach(function (b, i) {
        var out = '';
        try { out = renderBlockHtml(b, linkDefs, fnOrder, fnDefs); }
        catch (e) { err = err || e; out = '<pre class="raw-fallback">' + escapeHtml(b.raw) + '</pre>'; }
        b.blank = !out.trim();
        parts.push(b.blank ? '' : '<div class="blk" data-blk="' + i + '" data-btype="' + escapeHtml(b.type) + '">' + out + '</div>');
      });
    } catch (e) { err = err || e; }

    var html = parts.join('\n') + footnotesHtml(fnDefs, fnOrder);

    if (html && window.DOMPurify) {
      try {
        var clean = DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'], ADD_ATTR: ['target', 'loading', 'open'], USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true } });
        // never let the sanitizer swallow a whole local document
        if (clean && clean.trim()) html = clean;
      } catch (e) { /* keep unsanitized local html */ }
    }

    /* 换内容之前先把上一批图表的监听器 / 观察器收掉。
       少了这一步，重渲染就是纯泄漏 —— 见 createPanZoom 上方的说明。 */
    destroyPanZoom(preview);
    preview.innerHTML = html;

    // hard guard: a loaded doc must never render as a blank page
    if (src.trim() && !preview.textContent.trim() && !preview.querySelector('img,svg,table')) {
      preview.innerHTML = '<pre class="raw-fallback">' + escapeHtml(src) + '</pre>';
      docBlocks = [];
      renderError(err ? (err.message || 'parser error') : 'empty output');
    } else if (err) {
      renderError(err.message || 'parser error');
    }

    if (!src.trim()) preview.innerHTML = '<div class="doc-blank">这篇文档还是空的 —— 点下面那一行就能开始写。</div>';
    appendAddEnd();
    enhance(abbrDefs, src);
    safe('changes', paintChanges);          // 重排之后，改动条要跟着回到该在的块上
    safe('find', function () { refreshFind(false); });
    try { window.dispatchEvent(new CustomEvent('docsmith:rendered')); } catch (e) {}
  }
  function renderBlockHtml(b, linkDefs, fnOrder, fnDefs) {
    var s = emojify(b.raw);
    ABBR_DEF_RE.lastIndex = 0; FN_DEF_RE.lastIndex = 0;
    s = s.replace(ABBR_DEF_RE, '').replace(FN_DEF_RE, '');
    s = s.replace(/\[\^([^\]]+)\]/g, function (m, id) {
      if (!(id in fnDefs)) return m;
      var n = fnOrder.indexOf(id); if (n < 0) return m;
      return '<sup class="fn-ref" id="fnref-' + id + '"><a href="#fn-' + id + '">' + (n + 1) + '</a></sup>';
    });
    if (!s.trim()) return '';
    // reference-style links are resolved per block, so the doc's link defs ride along
    if (linkDefs && s.indexOf('[') >= 0) s += '\n\n' + linkDefs;
    return marked.parse(s);
  }
  function appendAddEnd() {
    var d = document.createElement('div');
    d.className = 'blk-add-end'; d.id = 'blkAddEnd';
    d.textContent = '＋ 在这里继续写';
    preview.appendChild(d);
  }
  function bindLinks(root) {
    root.querySelectorAll('a[href]').forEach(function (a) {
      var h = a.getAttribute('href') || '';
      if (/^https?:/i.test(h)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      else if (h.charAt(0) === '#') a.addEventListener('click', function (e) { var el = document.getElementById(decodeURIComponent(h.slice(1))); if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
    });
  }
  function enhance(abbrDefs, srcText) {
    bindLinks(preview);
    safe('tables', wrapTables); safe('callouts', transformCallouts); safe('inline-toc', fillInlineTOC);
    if (abbrDefs) safe('abbr', function () { wrapAbbr(abbrDefs); });
    safe('images', setupImages); safe('tasks', setupTasks); safe('diagrams', function () { renderDiagrams(); });
    safe('outline', buildOutline); safe('status', function () { updateStatus(srcText); });
    setTimeout(function () { safe('scrollspy', updateActiveHeading); }, 30);
    setTimeout(function () { safe('scrollnav', updateScrollNav); }, 40);
  }
  /* checkboxes are live in BOTH modes — ticking a box rewrites the Markdown */
  function setupTasks() {
    var n = 0;
    preview.querySelectorAll('li input[type=checkbox]').forEach(function (cb) {
      cb.disabled = false; cb.dataset.task = n++;
    });
  }
  function wrapTables(root) { (root || preview).querySelectorAll('table').forEach(function (t) { if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return; var w = document.createElement('div'); w.className = 'table-wrap'; t.parentNode.insertBefore(w, t); w.appendChild(t); }); }
  var CALLOUTS = { NOTE:{cls:'note',icon:'ℹ️',label:'Note'},TIP:{cls:'tip',icon:'💡',label:'Tip'},IMPORTANT:{cls:'important',icon:'❗',label:'Important'},WARNING:{cls:'warning',icon:'⚠️',label:'Warning'},CAUTION:{cls:'caution',icon:'🛑',label:'Caution'} };
  function transformCallouts(root) {
    (root || preview).querySelectorAll('blockquote').forEach(function (bq) {
      var first = bq.querySelector('p'); if (!first) return;
      var m = /^\s*\[!(\w+)\]\s*/.exec(first.textContent); if (!m) return;
      var cfg = CALLOUTS[m[1].toUpperCase()]; if (!cfg) return;
      first.innerHTML = first.innerHTML.replace(/^\s*\[!\w+\]\s*(<br\s*\/?>)?\s*/i, '');
      bq.className = 'callout callout-' + cfg.cls;
      bq.dataset.ctype = m[1].toUpperCase();
      var head = document.createElement('div'); head.className = 'callout-head'; head.contentEditable = 'false'; head.innerHTML = '<span class="callout-icon">' + cfg.icon + '</span><span class="callout-title">' + cfg.label + '</span>';
      bq.insertBefore(head, bq.firstChild); if (!first.textContent.trim()) first.remove();
    });
  }
  function fillInlineTOC() {
    var holders = preview.querySelectorAll('.toc-inline[data-toc]'); if (!holders.length) return;
    var heads = preview.querySelectorAll('h1,h2,h3,h4');
    var html = heads.length ? '<ul class="toc-tree">' + Array.prototype.map.call(heads, function (h) { return '<li class="lvl-' + h.tagName[1] + '"><a href="#' + h.id + '">' + escapeHtml(h.textContent.replace(/^#/, '')) + '</a></li>'; }).join('') + '</ul>' : '<p class="toc-empty">No headings.</p>';
    holders.forEach(function (h) { h.innerHTML = '<div class="toc-inline-title">Contents</div>' + html; h.removeAttribute('data-toc'); });
  }

  /* ---------- images -------------------------------------------------- */
  function resolvePath(baseDir, rel) { if (!rel) return rel; var parts = (baseDir ? baseDir.split('/') : []).concat(rel.split('/')), out = []; parts.forEach(function (p) { if (p === '' || p === '.') return; if (p === '..') out.pop(); else out.push(p); }); return out.join('/'); }
  function assetUrl(path) { var key = path.toLowerCase(); var f = assetMap[key]; if (!f) { var base = key.split('/').pop(); for (var k in assetMap) { if (k.split('/').pop() === base) { f = assetMap[k]; break; } } } if (!f) return null; var url = URL.createObjectURL(f); assetUrls.push(url); return url; }
  function setupImages(root) {
    var doc = curDoc(), baseDir = doc ? doc.dir : '';
    (root || preview).querySelectorAll('img').forEach(function (img) {
      var src = img.getAttribute('src') || '';
      if (src && !/^(https?:|data:|blob:)/i.test(src)) { var resolved = assetUrl(resolvePath(baseDir, src.replace(/^\.\//, ''))); if (resolved) img.src = resolved; }
      img.loading = 'lazy';
      img.addEventListener('error', function () { if (img.dataset.failed) return; img.dataset.failed = '1'; var ph = document.createElement('span'); ph.className = 'img-missing'; ph.innerHTML = '🖼️ image unavailable<br><small>' + escapeHtml(img.getAttribute('src') || '') + '</small>'; if (img.parentNode) img.parentNode.replaceChild(ph, img); });
      img.addEventListener('click', function () { openLightbox(img.currentSrc || img.src, img.alt); });
      img.classList.add('zoomable-img');
    });
  }

  /* ---------- mermaid + fit / pan / zoom / fullscreen ---------------
     这一段重写过。旧版有三个真问题，用户全都撞上了：

     1) createPanZoom 把 mousemove / mouseup 直接挂在 window 上，从来不解绑。
        一篇文档 17 张图，每重渲染一次就多 34 个全局监听器，每个还通过闭包
        吊着一整棵已经被丢弃的 SVG。翻十几次之后，鼠标动一下要跑几千个回调
        —— 表现就是"点啥都没反应"。现在改成 pointer 事件 + 指针捕获，
        全部挂在视口自己身上，并且每个实例带 destroy()，重渲染前统一清掉。

     2) 自适应算出缩放比之后又来一句 fit = Math.max(fit, 0.2)，把刚算好的
        比例强行抬上去，容器高度却仍按上限封顶 —— 图就被裁掉一截。
        现在容器高度直接由缩放后的图高决定，两者永远对得上。

     3) 全屏里的缩放/拖拽和行内共用一份代码，但滚轮在行内会吞掉页面滚动。
        现在行内滚轮默认让页面滚，按住 Ctrl/⌘ 才缩放；全屏里滚轮直接缩放。
     ------------------------------------------------------------------ */
  var MM_ICONS = {
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="21" y1="21" x2="15.8" y2="15.8"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/></svg>',
    in:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="21" y1="21" x2="15.8" y2="15.8"/><line x1="7.5" y1="10.5" x2="13.5" y2="10.5"/><line x1="10.5" y1="7.5" x2="10.5" y2="13.5"/></svg>',
    fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v3a2 2 0 0 1-2 2H4"/><path d="M20 9h-3a2 2 0 0 1-2-2V4"/><path d="M4 15h3a2 2 0 0 1 2 2v3"/><path d="M15 20v-3a2 2 0 0 1 2-2h3"/></svg>',
    one: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 8.5 8.8 7v10"/><path d="M13 17l4.6-6.2a2.2 2.2 0 1 0-3.9-1.6"/><path d="M13 17h4.8"/></svg>',   /* 1:1 的图标：按钮撤了，键盘 1 键还留着，图标先存着 */
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H5a1 1 0 0 0-1 1v3"/><path d="M20 8V5a1 1 0 0 0-1-1h-3"/><path d="M4 16v3a1 1 0 0 0 1 1h3"/><path d="M16 20h3a1 1 0 0 0 1-1v-3"/></svg>'
  };
  /* 工具条只留四个：缩小、放大、自适应、全屏。
     原来还有个「原始大小（1:1）」—— 但在侧边栏这种窄画布里，1:1 常常意味着
     只能看见图的左上角一小块，帮不上忙；真想看细节的人按放大或者进全屏。
     少一个按钮，剩下四个都更好点，也和参考实现（md-html-workspace.html）一致。
     百分比标签留着 —— 它不是按钮，是「我现在缩到多少了」的唯一反馈。
     快捷键里 1 键仍然可用（见下面 keydown），只是不再占一个按钮位。 */
  function toolsHtml(fs) {
    return '<div class="mm-tools' + (fs ? ' fs' : '') + '" role="toolbar" aria-label="图表视图">' +
      '<button type="button" data-z="out" title="缩小（−）" aria-label="缩小">' + MM_ICONS.out + '</button>' +
      '<button type="button" data-z="in" title="放大（+）" aria-label="放大">' + MM_ICONS.in + '</button>' +
      '<button type="button" data-z="fit" title="适应画布（0）" aria-label="适应画布">' + MM_ICONS.fit + '</button>' +
      '<span class="mm-zoom" data-zoomlabel>100%</span>' +
      (fs ? '' : '<button type="button" data-z="full" title="全屏看图" aria-label="全屏看图">' + MM_ICONS.full + '</button>') +
      '</div>';
  }
  function svgDims(svg) {
    var w = 0, h = 0, vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width) { w = vb.width; h = vb.height; }
    if (!w) { try { var bb = svg.getBBox(); if (bb && bb.width) { w = bb.width; h = bb.height; } } catch (e) {} }
    if (!w) { var r = svg.getBoundingClientRect(); w = r.width; h = r.height; }
    return { w: w || 600, h: h || 400 };
  }
  /** 行内图表的高度上限：跟着窗口走，小屏上不至于占满整屏 */
  function diagramMaxH() {
    var vh = window.innerHeight || 900;
    return Math.max(300, Math.min(760, Math.round(vh * 0.66)));
  }

  var MM_PAD = 14;
  /* MM_MIN 从 0.08 降到 0.02：侧边栏常态只有 300–400px 宽，而一张 3572px 宽的
     流程图要整个塞进去得缩到 0.05 上下。下限卡在 0.08，就等于「这张图永远
     显示不全」—— 那正是用户截图里「图表被裁剪」的一半原因。
     0.02 足够容纳任何真实图表，同时仍然拦住除零之类的病态值。 */
  var MM_MIN = 0.02, MM_MAX = 12;

  function createPanZoom(vp, stage, opts) {
    opts = opts || {};
    var d = opts.dims || { w: 600, h: 400 };
    var ac = (typeof AbortController === 'function') ? new AbortController() : null;
    var sigOpt = ac ? { signal: ac.signal } : false;
    var st = { s: 1, x: 0, y: 0 }, base = { s: 1, x: 0, y: 0 };
    var touched = false, raf = 0, dead = false, ro = null;

    function paint() { raf = 0; stage.style.transform = 'translate(' + st.x.toFixed(1) + 'px,' + st.y.toFixed(1) + 'px) scale(' + st.s.toFixed(4) + ')'; label(); }
    function apply() { if (!raf && !dead) raf = requestAnimationFrame(paint); }
    function label() {
      var el = opts.tools && opts.tools.querySelector('[data-zoomlabel]');
      if (el) el.textContent = Math.round(st.s * 100) + '%';
    }
    function clamp(v) { return Math.min(MM_MAX, Math.max(MM_MIN, v)); }

    function set(s, x, y, isBase) {
      st.s = clamp(s); st.x = x; st.y = y;
      if (isBase) { base = { s: st.s, x: x, y: y }; touched = false; }
      apply();
    }
    function zoomAt(f, cx, cy) {
      var ns = clamp(st.s * f);
      if (ns === st.s) return;
      var r = vp.getBoundingClientRect();
      cx = cx == null ? r.width / 2 : cx;
      cy = cy == null ? r.height / 2 : cy;
      st.x = cx - (cx - st.x) * (ns / st.s);
      st.y = cy - (cy - st.y) * (ns / st.s);
      st.s = ns; touched = true; apply();
    }
    /** 把整张图放进当前视口。容器高度也在这里定。

        缩放比先夹进合法区间，**然后**再算容器高度和居中偏移 —— 三个数必须
        出自同一个 k，否则又是裁剪。
        以前的写法是：算出 k → 用 k 算 boxH → set(k)，而 set() 里面又偷偷把 k
        夹到 [MM_MIN, MM_MAX]。窄面板配超宽图（截图里那张 3572px 宽的）时 k
        会小于 MM_MIN，于是「渲染用的是 MM_MIN，高度和位置是按更小的 k 算的」
        —— 视口 overflow:hidden，图就被横着切掉一截。
        文件头那段注释说这个问题修过，其实只修了高度那一半，clamp 这一半没修。
        现在先夹后算，两边永远对得上。 */
    function fit(tries) {
      if (dead) return;
      /* 宽度用 getBoundingClientRect 而不是 clientWidth：
         clientWidth 是取整后的整数，图表是逐个顺序渲染的（见 renderDiagrams 的
         step()），挂载那一刻容器可能还在布局中间态 —— 差一两个像素，
         图就会看着偏左一点，多张图叠起来就很明显（用户说的「没有居中」）。
         rect.width 是亚像素精度，且必要时下面还会再校一次。 */
      var rect = vp.getBoundingClientRect();
      var vpW = rect.width || vp.clientWidth || 0;
      if (vpW < 50 && (tries || 0) < 12) { requestAnimationFrame(function () { fit((tries || 0) + 1); }); return; }
      if (!vpW) vpW = Math.max(280, (preview.clientWidth || 700) - 40);
      var maxH = opts.setHeight ? (opts.maxH ? opts.maxH() : 620) : (vp.clientHeight || 480);
      var k = Math.min((vpW - MM_PAD * 2) / d.w, (maxH - MM_PAD * 2) / d.h, opts.allowUpscale ? 3 : 1);
      if (!isFinite(k) || k <= 0) k = 1;
      k = clamp(k);                    // ← 先夹。下面所有数都用这个 k。
      var boxH = opts.setHeight
        ? Math.max(120, Math.round(d.h * k + MM_PAD * 2))
        : (vp.clientHeight || Math.round(d.h * k + MM_PAD * 2));
      if (opts.setHeight) vp.style.height = boxH + 'px';
      set(k, (vpW - d.w * k) / 2, (boxH - d.h * k) / 2, true);

      /* 设完高度之后再量一次：改 height 可能带来滚动条出现/消失，宽度随之变化。
         真变了就按新宽度重算一次居中（只做一轮，不会来回抖）。 */
      if (opts.setHeight && !(tries || 0)) {
        requestAnimationFrame(function () {
          if (dead || touched) return;
          var w2 = vp.getBoundingClientRect().width;
          if (w2 && Math.abs(w2 - vpW) > 1) fit(1);
        });
      }
    }
    function actual() {
      var r = vp.getBoundingClientRect();
      set(1, (r.width - d.w) / 2, Math.max(MM_PAD, (r.height - d.h) / 2));
      touched = true;
    }
    function reset() { set(base.s, base.x, base.y); touched = false; }

    /* --- 拖拽：pointer 事件 + 指针捕获。指针跑出视口也不丢，
           而且不需要任何 window 级监听器 —— 泄漏从源头上没有了。 --- */
    var dragId = null, px = 0, py = 0;
    vp.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest && e.target.closest('.mm-tools')) return;
      dragId = e.pointerId; px = e.clientX; py = e.clientY;
      try { vp.setPointerCapture(e.pointerId); } catch (err) {}
      vp.classList.add('grabbing');
      e.preventDefault();
    }, sigOpt);
    vp.addEventListener('pointermove', function (e) {
      if (dragId !== e.pointerId) return;
      st.x += e.clientX - px; st.y += e.clientY - py;
      px = e.clientX; py = e.clientY; touched = true; apply();
    }, sigOpt);
    function endDrag(e) {
      if (dragId !== e.pointerId) return;
      dragId = null;
      try { vp.releasePointerCapture(e.pointerId); } catch (err) {}
      vp.classList.remove('grabbing');
    }
    vp.addEventListener('pointerup', endDrag, sigOpt);
    vp.addEventListener('pointercancel', endDrag, sigOpt);

    /* 滚轮 = 缩放，行内和全屏一样，不用按 Ctrl。
       （用户要求对齐 md-html-workspace.html 的手感：鼠标在图上滚就是缩放。）

       代价说清楚：鼠标停在图表上时滚轮不再滚动页面 —— 想接着往下读得先把
       指针移开图表。所以只有真的落在画布上才拦，图表以外的一切照常滚动。
       opts.wheelZoom === false 仍然保留「必须按 Ctrl」的老行为，留给以后
       可能出现的、不该抢滚轮的场景。 */
    vp.addEventListener('wheel', function (e) {
      if (opts.wheelZoom === false && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      var r = vp.getBoundingClientRect();
      var f = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 16 : 1));
      f = Math.min(1.6, Math.max(1 / 1.6, f));
      zoomAt(f, e.clientX - r.left, e.clientY - r.top);
    }, ac ? { passive: false, signal: ac.signal } : { passive: false });

    /* 双击：正常情况下在「适应」和 1:1 之间来回。
       但如果这张图在行内被缩得很小（侧边栏里的宽图常常只有 0.1 倍），
       跳到 1:1 也帮不上忙 —— 只能看见左上角一小块。这种时候直接开全屏，
       那才是用户双击时真正想要的：「我要看清这张图」。 */
    vp.addEventListener('dblclick', function (e) {
      if (e.target.closest && e.target.closest('.mm-tools')) return;
      e.preventDefault();
      if (opts.setHeight && base.s < 0.5 && typeof opts.onFull === 'function') { opts.onFull(); return; }
      if (Math.abs(st.s - base.s) < 0.01) actual(); else reset();
    }, sigOpt);

    /* 键盘：视口可聚焦，方向键平移，+/-/0/1 缩放 */
    vp.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 60 : 24, hit = true;
      if (e.key === '+' || e.key === '=') zoomAt(1.25);
      else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.25);
      else if (e.key === '0') fit();
      else if (e.key === '1') actual();
      else if (e.key === 'ArrowLeft') { st.x += step; touched = true; apply(); }
      else if (e.key === 'ArrowRight') { st.x -= step; touched = true; apply(); }
      else if (e.key === 'ArrowUp') { st.y += step; touched = true; apply(); }
      else if (e.key === 'ArrowDown') { st.y -= step; touched = true; apply(); }
      else hit = false;
      if (hit) e.preventDefault();
    }, sigOpt);

    /* 容器宽度变了（侧栏开合、窗口缩放）就重新适应 —— 但只在用户还没
       手动缩放过的时候，否则会把他调好的视角冲掉。 */
    if (typeof ResizeObserver === 'function') {
      var t = 0;
      ro = new ResizeObserver(function () {
        if (dead || touched) return;
        clearTimeout(t); t = setTimeout(function () { if (!dead && !touched) fit(0); }, 120);
      });
      try { ro.observe(vp); } catch (e) {}
    }

    var api = {
      set: set, zoomAt: zoomAt, reset: reset, fit: fit, actual: actual,
      get scale() { return st.s; },
      destroy: function () {
        if (dead) return; dead = true;
        if (raf) cancelAnimationFrame(raf);
        if (ro) { try { ro.disconnect(); } catch (e) {} }
        if (ac) { try { ac.abort(); } catch (e) {} }
        if (vp.__pz === api) delete vp.__pz;
      }
    };
    vp.__pz = api;
    return api;
  }

  /** 重渲染 / 关闭全屏之前，把这一片里所有视口的监听器和观察器收干净。 */
  function destroyPanZoom(root) {
    if (!root) return;
    var list = root.querySelectorAll ? root.querySelectorAll('.mm-viewport') : [];
    Array.prototype.forEach.call(list, function (vp) { if (vp.__pz) vp.__pz.destroy(); });
    if (root.classList && root.classList.contains('mm-viewport') && root.__pz) root.__pz.destroy();
  }

  /* 把 SVG 摆成「画布上的一张图」：尺寸写死成它自己的固有尺寸，位置全交给
     createPanZoom 的 transform 管。

     ⚠ margin:0 是必需的，不是保险。diagrams.css 里 `.dg{margin:0 auto}` ——
     那条规则对「直接嵌在文章里的一张 SVG」是对的（自己居中），但在画布里
     就成了**第二次居中**：stage 被 fit() 平移 tx 居中，而 SVG 又在 stage
     内部靠 auto margin 再偏移一次（实测 858px 视口里 margin-left 给到 218px）。
     两次相加，图就明显偏右 —— 用户原话「渲染图未在画布中间，偏右」。
     居中这件事只能有一个负责人，这里指定给 transform。 */
  function prepSvg(svg, d) { if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', '0 0 ' + d.w + ' ' + d.h); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet'); svg.removeAttribute('width'); svg.removeAttribute('height'); svg.style.maxWidth = 'none'; svg.style.margin = '0'; svg.style.width = d.w + 'px'; svg.style.height = d.h + 'px'; svg.style.display = 'block'; }
  function bindTools(tools, pz, stage, d) {
    if (!tools) return;
    tools.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-z]'); if (!btn) return;
      var z = btn.dataset.z;
      if (z === 'in') pz.zoomAt(1.25);
      else if (z === 'out') pz.zoomAt(1 / 1.25);
      else if (z === 'fit') pz.fit();
      else if (z === 'reset') pz.reset();
      else if (z === 'one') pz.actual();
      else if (z === 'full') { if (e.detail > 0) btn.blur(); openChartFull(stage.querySelector('svg'), d); }
    });
  }
  // htmlLabels:false 下，mermaid 会先把标签里的 & < > 等转成实体（& → &amp;）作为文本写入，
  // 再序列化 SVG 时又转义一次 → 得到「&amp;amp;」这类双重转义；浏览器只解码一层，
  // 于是屏幕上出现字面的 &amp; / &gt;。这里把多余的一层折叠掉（渲染即为 & / >）。
  // 只匹配 &amp; 紧跟已知实体名/数字实体的形态，不会误伤 URL 中正常的 &amp;（如 a=1&amp;b=2）。
  function fixMermaidEntities(svgHtml) {
    if (!svgHtml || svgHtml.indexOf('&amp;') < 0) return svgHtml;
    return svgHtml.replace(/&amp;(gt|lt|amp|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g, '&$1;');
  }
  function mountDiagram(target, svgHtml) {
    svgHtml = fixMermaidEntities(svgHtml);
    var language = target.closest('.diagram-block')?.dataset.diagramLanguage || 'mermaid';
    if (window.DOMPurify && language !== 'infographic') {
      svgHtml = DOMPurify.sanitize(svgHtml, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject'] });
    }
    /* Infographic 的本地适配器已经清掉 script/style、事件属性和远程 href。
       这里不能再过 DOMPurify 的纯 SVG profile：AntV 的中文排版依赖
       foreignObject/span，图标依赖 symbol/use，二次清洗会把两者都掏空。 */
    var probe = document.createElement('template'); probe.innerHTML = svgHtml;
    if (!probe.content.querySelector('svg')) throw new Error('图表没有生成 SVG');
    destroyPanZoom(target);
    target.innerHTML = '<div class="mm-viewport" tabindex="0" role="img" aria-label="图表，可拖动和缩放">'
      + '<div class="mm-stage">' + svgHtml + '</div></div>' + toolsHtml(false);
    var vp = target.querySelector('.mm-viewport'), stage = target.querySelector('.mm-stage'), svg = stage.querySelector('svg');
    if (!svg) return;
    var d = svgDims(svg); prepSvg(svg, d);
    var tools = target.querySelector('.mm-tools');
    var pz = createPanZoom(vp, stage, {
      dims: d, tools: tools, setHeight: true, maxH: diagramMaxH, wheelZoom: true,
      /* 图被缩得太小时，双击直接开全屏 —— 见 createPanZoom 里 dblclick 那段 */
      onFull: function () { openChartFull(stage.querySelector('svg'), d); }
    });
    bindTools(tools, pz, stage, d);
    requestAnimationFrame(function () { pz.fit(0); });
  }
  function sweepMermaidLeftovers() {
    document.querySelectorAll('body > div[id^="dmmd-"], body > div[id^="dmermaid-"]').forEach(function (n) { n.remove(); });
  }
  function quoteQuadrantText(raw) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw), text = m ? m[2] : raw;
    if (!/[^\x00-\x7F]/.test(text) || /^"[\s\S]*"$/.test(text)) return raw;
    return (m ? m[1] : '') + '"' + text.replace(/"/g, '#34;') + '"' + (m ? m[3] : '');
  }
  function prepareMermaidSource(src) {
    if (!/(?:^|\n)\s*quadrantChart\s*(?:\n|$)/i.test(src)) return src;
    return src.split(/\r?\n/).map(function (line) {
      var axis = /^(\s*[xy]-axis\s+)(.+?)(\s*-->\s*)(.+?)(\s*)$/i.exec(line);
      if (axis) return axis[1] + quoteQuadrantText(axis[2]) + axis[3] + quoteQuadrantText(axis[4]) + axis[5];
      var quadrant = /^(\s*quadrant-[1-4]\s+)(.+?)(\s*)$/i.exec(line);
      if (quadrant) return quadrant[1] + quoteQuadrantText(quadrant[2]) + quadrant[3];
      var point = /^(\s*)(.+?)(\s*:\s*\[[^\]]+\]\s*)$/.exec(line);
      if (point) return point[1] + quoteQuadrantText(point[2]) + point[3];
      return line;
    }).join('\n');
  }
  var mmRunToken = 0;
  function renderDiagrams(root) {
    if (!window.DocsmithDiagrams) return;
    var blocks = (root || preview).querySelectorAll('.diagram-block');
    if (!blocks.length) return;
    var idx = 0;
    /* 每次重渲染换一个令牌。上一轮还在排队的图会在下一步发现令牌变了就退出，
       否则文档一改就叠一条新队列，几轮之后同一时刻有十几条队列在跑。 */
    var token = ++mmRunToken;
    /* Render diagrams ONE AT A TIME.
       While laying out a diagram, mermaid drops a temporary <div id="dmmd-N"> into
       the <body>, measures it, then removes it. The old code rendered every block in
       parallel and called sweepMermaidLeftovers() inside each promise — so the first
       diagram to finish deleted the still-in-flight temp nodes of the later ones.
       Those interrupted renders then hit "Cannot read properties of null (reading
       'appendChild')". Rendering sequentially keeps exactly one temp node live at a
       time, so the sweep can never race an in-flight render. */
    function step() {
      if (token !== mmRunToken) return;
      if (idx >= blocks.length) return;
      var b = blocks[idx++];
      if (!b.isConnected) { step(); return; }
      var codeEl = b.querySelector('.diagram-source code'), target = b.querySelector('.diagram-render');
      if (!codeEl || !target) { step(); return; }
      var language = b.dataset.diagramLanguage || 'mermaid';
      var raw = codeEl.textContent;
      var src = language === 'mermaid' ? prepareMermaidSource(raw) : raw;
      if (!src || !src.trim()) { mmError(b, target, new Error('empty diagram')); step(); return; }
      var advance = function () { sweepMermaidLeftovers(); step(); };
      try {
        var out = DocsmithDiagrams.renderFencedDiagram(language, src);
        if (out && typeof out.then === 'function') {
          out.then(function (svg) { try { mountDiagram(target, svg && svg.svg ? svg.svg : svg); } catch (e) { mmError(b, target, e); } })
             .catch(function (e) { mmError(b, target, e); })
             .then(advance, advance);
        } else if (typeof out === 'string') { mountDiagram(target, out); advance(); }
        else { advance(); }
      } catch (e) { mmError(b, target, e); advance(); }
    }
    step();
  }
  function mmError(block, target, err) {
    block.dataset.view = 'source';
    /* 画不出来 → 已经切到源码视图了，两颗按钮的文案都得跟上：
       切换键要给出回去的路，复制键这时复制的是**源码**（图根本不存在，
       还写着 Copy image 就是骗人，点了只会报「图表还没渲染完成」）。
       走 syncMmLabel 读 data-*，和正常切换走同一条路，不再手抄字符串。 */
    syncMmLabel(block.querySelector('.mm-toggle'), 'source');
    syncMmLabel(block.querySelector('.mm-copy'), 'source');
    var kind = err && err.unsupportedKind;
    if (kind && window.DocsmithDiagrams) {
      target.innerHTML = '<div class="mm-error mm-notice">'
        + '<b>暂不支持这类图（' + escapeHtml(kind) + '）</b>'
        + '<span>已经切换到源码，内容一个字都没丢。</span></div>';
      return;
    }
    target.innerHTML = '<div class="mm-error">画不出来 —— ' + escapeHtml((err && err.message) || '语法有问题') + '</div>';
  }

  function openChartFull(svg, d) {
    if (!svg) return;
    var clone = svg.cloneNode(true);
    showOverlay('<button class="overlay-close" title="关闭（Esc）" aria-label="关闭">\u2715</button>'
      + '<div class="mm-viewport fs" tabindex="0"><div class="mm-stage"></div></div>' + toolsHtml(true), 'is-chart');
    var vp = overlayBody.querySelector('.mm-viewport'), stage = overlayBody.querySelector('.mm-stage');
    stage.appendChild(clone);
    var tools = overlayBody.querySelector('.mm-tools');
    var pz = createPanZoom(vp, stage, {
      dims: d, tools: tools, setHeight: false, wheelZoom: true, allowUpscale: true
    });
    bindTools(tools, pz, stage, d);
    requestAnimationFrame(function () { pz.fit(0); try { vp.focus({ preventScroll: true }); } catch (e) {} });
  }

  /* ---------- overlay ------------------------------------------------- */
  function showOverlay(html, cls) { destroyPanZoom(overlayBody); overlayBody.className = 'overlay-body ' + (cls || ''); overlayBody.innerHTML = html; overlay.classList.add('open'); }
  function closeOverlay() { destroyPanZoom(overlayBody); overlay.classList.remove('open'); overlayBody.innerHTML = ''; }
  /* 关闭只认「按下和松开都在遮罩上」。以前只看 click 的 target，
     在画布里拖到边缘一松手就整个关掉了，拖拽根本没法用。 */
  var _ovDownOnBackdrop = false;
  overlay.addEventListener('pointerdown', function (e) { _ovDownOnBackdrop = (e.target === overlay); });
  overlay.addEventListener('click', function (e) {
    if (e.target.classList && e.target.classList.contains('overlay-close')) { closeOverlay(); return; }
    if (e.target === overlay && _ovDownOnBackdrop) closeOverlay();
    _ovDownOnBackdrop = false;
  });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.classList.contains('open')) closeOverlay(); });
  /* 普通图片放大：以前只塞一张 <img> 进去，能看不能动 —— 缩放、拖拽、
     适应画布这些图表早就有了，图片却一样都没有。这里复用图表那套 pan/zoom，
     把图片当成图表的"画布"来摆，于是图片也有了适应/放大/缩小/1:1/拖拽/滚轮缩放。
     图片的真实尺寸要等它加载完才知道，所以等 onload（已缓存则同步）再接管。 */
  function openLightbox(src, alt) {
    showOverlay('<button class="overlay-close" title="关闭（Esc）" aria-label="关闭">\u2715</button>'
      + '<div class="mm-viewport fs" tabindex="0"><div class="mm-stage"></div></div>' + toolsHtml(true), 'is-image');
    var vp = overlayBody.querySelector('.mm-viewport'), stage = overlayBody.querySelector('.mm-stage');
    var tools = overlayBody.querySelector('.mm-tools');
    var img = new Image();
    img.className = 'lightbox-img';
    img.alt = alt || '';
    img.draggable = false;
    img.addEventListener('dragstart', function (e) { e.preventDefault(); });
    stage.appendChild(img);

    var started = false;
    function start() {
      if (started) return; started = true;
      var d = { w: img.naturalWidth || img.width || 600, h: img.naturalHeight || img.height || 400 };
      img.style.width = d.w + 'px'; img.style.height = d.h + 'px';
      img.style.maxWidth = 'none'; img.style.display = 'block';
      var pz = createPanZoom(vp, stage, { dims: d, tools: tools, setHeight: false, wheelZoom: true, allowUpscale: true });
      bindTools(tools, pz, stage, d);
      requestAnimationFrame(function () { pz.fit(0); try { vp.focus({ preventScroll: true }); } catch (e) {} });
    }
    img.onload = start;
    img.onerror = start;      // 加载失败也别卡住，兜底尺寸让画布能开
    img.src = encodeURI(src);
    if (img.complete && img.naturalWidth) start();
  }

  /* ---------- copy (WYSIWYG) ----------------------------------------- */
  /* Canvas has hard limits (Chrome ~16k per side / ~268M px, Safari far less).
     Very large mermaid diagrams must be down-scaled instead of silently failing. */
  var PNG_MAX_SIDE = 8192, PNG_MAX_PIXELS = 26e6;
  function pngScale(w, h) {
    var s = Math.min(2, PNG_MAX_SIDE / w, PNG_MAX_SIDE / h, Math.sqrt(PNG_MAX_PIXELS / (w * h)));
    if (!isFinite(s) || s <= 0) s = 1;
    return Math.max(0.15, s);
  }
  function svgToPng(svg) {
    return new Promise(function (res, rej) {
      try {
        var d = svgDims(svg);
        var clone = svg.cloneNode(true);
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
        clone.setAttribute('width', d.w); clone.setAttribute('height', d.h);
        if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', '0 0 ' + d.w + ' ' + d.h);
        clone.style.maxWidth = 'none';
        var xml = new XMLSerializer().serializeToString(clone);
        var scale = pngScale(d.w, d.h);
        var img = new Image();
        img.decoding = 'sync';
        img.onload = function () {
          try {
            var cw = Math.max(1, Math.round(d.w * scale)), ch = Math.max(1, Math.round(d.h * scale));
            var c = document.createElement('canvas'); c.width = cw; c.height = ch;
            var ctx = c.getContext('2d');
            var bg = (window.DocsmithDiagrams && window.DocsmithDiagrams.background && window.DocsmithDiagrams.background())
              || (getComputedStyle(preview).getPropertyValue('--doc-bg') || '#fff').trim() || '#fff';
            ctx.fillStyle = bg; ctx.fillRect(0, 0, cw, ch);
            ctx.drawImage(img, 0, 0, cw, ch);
            c.toBlob(function (b) { b ? res({ blob: b, scale: scale, w: cw, h: ch }) : rej(new Error('图片过大，浏览器无法生成')); }, 'image/png');
          } catch (e) { rej(e); }
        };
        img.onerror = function () { rej(new Error('SVG 无法转为图片')); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      } catch (e) { rej(e); }
    });
  }
  /* Copying an image to the clipboard needs transient activation from the click, a
     focused document, and — crucially inside an iframe (e.g. embedded in the workbench)
     — a *synchronous* write of a real Blob. Chromium routinely rejects the "delayed"
     ClipboardItem(Promise) form in embedded frames with NotAllowedError, which used to
     drop us straight to a download. So we pre-render the PNG on hover / pointer-down and,
     at click time, write the ready Blob synchronously; if it isn't ready we render then
     write the real Blob (transient activation is still valid for a short window). */
  function canWriteImage() { return !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem); }
  function localWriteImage(blob, okc, failc) {
    if (!canWriteImage()) { failc(); return; }
    try { navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(okc, failc); }
    catch (e) { failc(); }
  }
  /* When embedded in the workbench, the iframe's own document is usually not "focused"
     as far as the clipboard API is concerned, so navigator.clipboard.write() rejects.
     A click inside a child frame propagates transient activation up to the top document,
     which IS focused — so we hand the PNG blob to the shell and let it do the write. */
  var _copyReqs = {};
  function shellCopyImage(blob, cb) {
    var id = 'cp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var done = false, finish = function (ok) { if (done) return; done = true; delete _copyReqs[id]; cb(!!ok); };
    _copyReqs[id] = finish;
    try { window.parent.postMessage({ ns: BUS_NS, type: 'copyImage', id: id, mime: 'image/png', blob: blob }, '*'); }
    catch (e) { finish(false); return; }
    setTimeout(function () { finish(false); }, 2500);   // no ack → fall back locally
  }
  function warmPng(block) {
    if (!block) return null;
    if (block._pngReady) return Promise.resolve(block._pngReady);
    if (block._pngPromise) return block._pngPromise;
    var svg = block.querySelector('.mm-stage svg') || block.querySelector('.diagram-render svg');
    if (!svg) return null;
    var p = svgToPng(svg).then(function (out) { block._pngReady = out; block._pngPromise = null; return out; },
                               function (e) { block._pngPromise = null; return Promise.reject(e); });
    block._pngPromise = p; p.catch(function () {});
    return p;
  }
  function copyDiagramImage(block, btn) {
    var svg = block.querySelector('.mm-stage svg') || block.querySelector('.diagram-render svg');
    if (!svg) { toast('这个图表还没渲染完成', 'err'); return; }
    var d = svgDims(svg);
    var okMsg = function (o) { flashBtn(btn, 'Copied'); toast('复制图片成功 · ' + o.w + '×' + o.h + (o.scale < 1 ? '（已按 ' + Math.round(o.scale * 100) + '% 缩放）' : ''), 'ok'); };
    var savePng = function (blob) { download(currentName() + '-diagram.png', blob, 'image/png'); toast('当前环境不允许写入图片剪贴板，已保存为 PNG', 'err'); };
    var writeBlob = function (o) {
      var okc = function () { okMsg(o); }, failc = function () { savePng(o.blob); };
      if (IN_SHELL) { shellCopyImage(o.blob, function (ok) { if (ok) okc(); else localWriteImage(o.blob, okc, failc); }); return; }
      localWriteImage(o.blob, okc, failc);
    };
    try { window.focus(); } catch (e) {}          // clipboard needs a focused document
    // 1) pre-warmed & ready → synchronous write inside the gesture (reliable, incl. iframes)
    if (block._pngReady && block._pngReady.blob) { writeBlob(block._pngReady); return; }
    // 2) render now, then write the real blob (activation stays valid for a brief window)
    if (d.w * d.h > 4e6) toast('图表较大，正在生成图片…');
    var p = warmPng(block);
    if (!p) { toast('这个图表还没渲染完成', 'err'); return; }
    p.then(function (o) { writeBlob(o); }, function (e) { toast('生成图片失败：' + ((e && e.message) || '未知错误'), 'err'); });
  }
  /* 图表那颗「Copy image」只在图表视图下才需要预热 PNG。
     源码视图下它是「Copy code」，复制的是文本，没有 canvas 要准备。 */
  function warmFromEvent(e) {
    var b = e.target && e.target.closest && e.target.closest('.mm-copy');
    if (!b) return;
    var blk = b.closest('.diagram-block');
    if (blk && blk.dataset.view !== 'source') warmPng(blk);
  }
  preview.addEventListener('pointerover', warmFromEvent);
  preview.addEventListener('pointerdown', warmFromEvent);
  /** 这颗按钮当前该显示哪套文案 —— 两套都写在 data-* 上，见 mermaidBlock()。 */
  function syncMmLabel(btn, view) {
    if (!btn) return;
    var t = btn.dataset[view === 'source' ? 'sourceLabel' : 'diagramLabel'];
    if (t) btn.textContent = t;
  }
  preview.addEventListener('click', function (e) {
    /* 图表块那颗合并后的复制键：复制**你正在看的东西**。
       图表视图 → 复制图片；源码视图 → 复制源码。见 mermaidBlock() 的注释。 */
    var mmCopy = e.target.closest('.mm-copy');
    if (mmCopy) {
      var mmBlk = mmCopy.closest('.diagram-block');
      if (mmBlk && mmBlk.dataset.view === 'source') {
        var srcEl = mmBlk.querySelector('pre code');
        copyText(srcEl ? srcEl.textContent : '', mmCopy, 'Copied');
        toast('复制源码成功', 'ok');
      } else {
        copyDiagramImage(mmBlk, mmCopy);
      }
      return;
    }
    var copy = e.target.closest('.copy-btn');
    if (copy) {
      var block = copy.closest('.code-block, .diagram-block');
      var el = block.querySelector('pre code');
      copyText(el ? el.textContent : '', copy, 'Copied');
      toast('复制代码成功', 'ok');
      return;
    }
    var tog = e.target.closest('.mm-toggle');
    if (tog) {
      var blk = tog.closest('.diagram-block');
      var next = blk.dataset.view === 'diagram' ? 'source' : 'diagram';
      blk.dataset.view = next;
      syncMmLabel(tog, next);
      tog.setAttribute('aria-pressed', next === 'source' ? 'true' : 'false');
      /* 复制键跟着换文案。**不要**再 disable 它 —— 以前源码视图下把
         Copy PNG 禁掉，是因为那颗只会复制图片；现在它复制"当前看到的东西"，
         两个视图下都有意义。 */
      syncMmLabel(blk.querySelector('.mm-copy'), next);
    }
  });
  /* label 可选：代码块那几个按钮是英文的（Copy code / Copy image），闪 'Copied'；
     工具栏上的「复制 HTML」是中文按钮，闪「已复制」。所以默认值留中文，
     英文那两处显式传进来，别让一个按钮中英文混着跳。 */
  function copyText(str, btn, label) { var done = function () { if (btn) flashBtn(btn, label || '已复制'); }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(str).then(done, function () { legacyCopy(str, done); }); else legacyCopy(str, done); }
  function legacyCopy(str, done) { var ta = document.createElement('textarea'); ta.value = str; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) {} document.body.removeChild(ta); }

  /* ---------- outline + scroll spy ----------------------------------- */
  function buildOutline() {
    var heads = preview.querySelectorAll('h1, h2, h3, h4');
    var tc = $('#tocCount'); if (tc) tc.textContent = heads.length;
    if (!heads.length) { tocBody.innerHTML = '<p class="toc-empty">No headings.</p>'; return; }
    var html = '', open = false;
    Array.prototype.forEach.call(heads, function (h) {
      var lvl = +h.tagName[1];
      var link = '<a class="toc-link" href="#' + h.id + '" data-id="' + h.id + '">' + escapeHtml(h.textContent.replace(/^#/, '')) + '</a>';
      if (lvl <= 2) { if (open) { html += '</div></div>'; open = false; } if (lvl === 2) { html += '<div class="toc-group"><div class="toc-group-head"><button class="toc-caret" aria-label="Toggle">▾</button>' + link + '</div><div class="toc-children">'; open = true; } else html += '<div class="toc-lvl1">' + link + '</div>'; }
      else html += '<div class="toc-sub lvl-' + lvl + '">' + link + '</div>';
    });
    if (open) html += '</div></div>';
    tocBody.innerHTML = html;
    tocBody.querySelectorAll('.toc-caret').forEach(function (c) { c.addEventListener('click', function (e) { e.stopPropagation(); this.closest('.toc-group').classList.toggle('collapsed'); }); });
    tocBody.querySelectorAll('a.toc-link').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); var el = document.getElementById(a.dataset.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); if (window.innerWidth <= 860) ROOT.classList.remove('side-open'); }); });
  }
  function updateActiveHeading() {
    var links = tocBody.querySelectorAll('a.toc-link'); if (!links.length) return;
    var heads = preview.querySelectorAll('h1, h2, h3, h4'); var pTop = previewPane.getBoundingClientRect().top, active = null;
    Array.prototype.forEach.call(heads, function (h) { if (h.getBoundingClientRect().top - pTop <= 96) active = h; });
    links.forEach(function (a) { var on = !!active && a.dataset.id === active.id; a.classList.toggle('active', on); if (on) { var g = a.closest('.toc-group'); if (g) g.classList.remove('collapsed'); } });
  }
  previewPane.addEventListener('scroll', throttle(updateActiveHeading, 120));

  /* ---------- files sidebar ------------------------------------------ */
  /* ---------- 已打开的文件：搜索、关闭单个、全部关闭 ------------------
     之前这一栏只能往里加，不能往外拿：打开一个文件夹进来几十个 md，
     既没法过滤，也没法关掉任何一个 —— 只能刷新整个插件。现在补齐。 */
  var fileQuery = '';

  function matchDoc(d, q) {
    if (!q) return true;
    return (d.relPath || d.name || '').toLowerCase().indexOf(q) >= 0;
  }

  function renderFileList() {
    var fc = $('#filesCount'); if (fc) fc.textContent = docs.length;
    var clr = $('#fileFilterClear'); if (clr) clr.hidden = !fileQuery;
    var allBtn = $('#filesCloseAll'); if (allBtn) allBtn.disabled = !docs.length;

    if (!docs.length) { filesBody.innerHTML = '<p class="side-empty">还没有打开文件</p>'; return; }

    var q = fileQuery.toLowerCase();
    var shown = docs.filter(function (d) { return matchDoc(d, q); });

    if (!shown.length) {
      filesBody.innerHTML = '<p class="side-empty">没有匹配「' + escapeHtml(fileQuery) + '」的文件<br>'
        + '<small>共 ' + docs.length + ' 个已打开</small></p>';
      return;
    }

    var tree = {};
    shown.forEach(function (d) {
      var parts = d.relPath.split('/');
      if (parts.length > 1) (tree[parts[0]] = tree[parts[0]] || []).push(d);
      else (tree.__root__ = tree.__root__ || []).push(d);
    });

    var html = '';
    if (q) html += '<p class="file-hint">找到 ' + shown.length + ' / ' + docs.length + ' 个</p>';
    if (tree.__root__) tree.__root__.forEach(function (d) { html += fileItem(d, false, q); });
    Object.keys(tree).filter(function (k) { return k !== '__root__'; }).sort().forEach(function (folder) {
      html += '<div class="file-folder"><div class="file-folder-head">'
        + '<button class="toc-caret" type="button" aria-label="折叠">▾</button>'
        + '<span class="file-folder-name">📁 ' + escapeHtml(folder) + '</span>'
        + '<button class="folder-x" type="button" data-folder="' + escapeHtml(folder) + '" title="关闭这个文件夹里的全部文件" aria-label="关闭整个文件夹">✕</button>'
        + '</div><div class="file-folder-body">';
      tree[folder].forEach(function (d) { html += fileItem(d, true, q); });
      html += '</div></div>';
    });
    filesBody.innerHTML = html;

    filesBody.querySelectorAll('.toc-caret').forEach(function (c) {
      c.addEventListener('click', function (e) { e.stopPropagation(); this.closest('.file-folder').classList.toggle('collapsed'); });
    });
    filesBody.querySelectorAll('.folder-x').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); closeFolder(b.dataset.folder); });
    });
    filesBody.querySelectorAll('.fi-x').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); closeDoc(b.closest('.file-item').dataset.id); });
    });
    filesBody.querySelectorAll('.file-item').forEach(function (it) {
      it.addEventListener('click', function () {
        var id = it.dataset.id;
        if (id !== currentId && isDirty() && !confirm('当前文档有 ' + (chgCount() || '一些') + ' 处未保存的修改，切换后这些修改会保留在内存里但不会写入本地文件。仍要切换吗？')) return;
        openDoc(id);
      });
    });
  }

  function fileItem(d, nested, q) {
    var label = nested ? d.relPath.split('/').slice(1).join('/') : d.name;
    return '<div class="file-item' + (d.id === currentId ? ' active' : '') + (d.dirty ? ' dirty' : '')
      + '" data-id="' + d.id + '" title="' + escapeHtml(d.relPath) + (d.dirty ? ' · 未保存' : '') + '">'
      + '<span class="fi-ico">●</span>'
      + '<span class="fi-name">' + highlightMatch(label, q) + '</span>'
      + '<button class="fi-x" type="button" title="关闭这个文件" aria-label="关闭 ' + escapeHtml(label) + '">✕</button>'
      + '</div>';
  }

  /** 把命中的那几个字标出来。转义在前、插标签在后，顺序反了就是 XSS。 */
  function highlightMatch(label, q) {
    var safe = escapeHtml(label);
    if (!q) return safe;
    var i = label.toLowerCase().indexOf(q);
    if (i < 0) return safe;
    return escapeHtml(label.slice(0, i)) + '<mark class="fi-hit">'
      + escapeHtml(label.slice(i, i + q.length)) + '</mark>' + escapeHtml(label.slice(i + q.length));
  }

  /** 关掉一个文件。有未保存改动会先问一句 —— 关掉就真的没了。 */
  function closeDoc(id, silent) {
    var i = -1;
    for (var k = 0; k < docs.length; k++) if (docs[k].id === id) { i = k; break; }
    if (i < 0) return false;
    var d = docs[i];
    if (!silent && d.dirty && !confirm('「' + d.name + '」还有未保存的修改。\n关闭后这些修改会丢失，确定吗？')) return false;
    docs.splice(i, 1);
    if (currentId === id) {
      currentId = null;
      if (docs.length) openDoc(docs[Math.min(i, docs.length - 1)].id);
      else showNoDocs();
    }
    renderFileList();
    return true;
  }

  function closeFolder(folder) {
    var inFolder = docs.filter(function (d) { return d.relPath.split('/')[0] === folder && d.relPath.indexOf('/') >= 0; });
    if (!inFolder.length) return;
    var dirty = inFolder.filter(function (d) { return d.dirty; }).length;
    if (!confirm('关闭文件夹「' + folder + '」里的 ' + inFolder.length + ' 个文件？'
      + (dirty ? '\n其中 ' + dirty + ' 个有未保存的修改，会一并丢失。' : ''))) return;
    inFolder.forEach(function (d) { closeDoc(d.id, true); });
    renderFileList();
  }

  function closeAllDocs() {
    if (!docs.length) return;
    var dirty = docs.filter(function (d) { return d.dirty; }).length;
    if (!confirm('关闭全部 ' + docs.length + ' 个文件？'
      + (dirty ? '\n其中 ' + dirty + ' 个有未保存的修改，会一并丢失。' : ''))) return;
    docs = [];
    currentId = null;
    currentFolderHandle = null;
    updateReloadFolderState();
    fileQuery = '';
    var fi = $('#fileFilter'); if (fi) fi.value = '';
    showNoDocs();
    renderFileList();
    toast('已全部关闭', 'ok');
  }

  /** 一个文件都不剩时回到空状态，而不是留一篇读不到的残影。 */
  function showNoDocs() {
    currentId = null;
    currentUrl = '';
    clearInterval(refreshTimer);
    docBlocks = [];
    preview.innerHTML = '';
    editor.value = '';
    ROOT.classList.add('empty');
    if (ROOT.dataset.mode === 'source') setMode('read');
    histReset('');
    updateStatus('');
    updateSaveState();
    updateWorkspaceTitle();
    buildOutline();
  }


  /* ---------- doc loading -------------------------------------------- */
  function addDocs(list) {
    var added = [];
    list.forEach(function (f) {
      if (f && f.url) { added.push({ id: uid(), name: f.name || f.url.split('/').pop(), relPath: f.name || f.url.split('/').pop(), dir: '', url: f.url, text: f.text || null, source: 'url' }); return; }
      var rel = f.webkitRelativePath || f._rel || f.name;
      var dir = rel.indexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/')) : '';
      assetMap[rel.toLowerCase()] = f;
      if (/\.(md|markdown|mkd|mdx)$/i.test(f.name)) added.push({ id: uid(), name: f.name, relPath: rel, dir: dir, file: f, text: null, source: 'file', handle: f._handle || null, folderRoot: f._folderRoot || null, savedText: null, dirty: false });
    });
    docs = docs.concat(added); renderFileList(); return added;
  }
  function loadDocText(d) { return new Promise(function (res, rej) { if (d.text != null) return res(d.text); if (d.file) { var r = new FileReader(); r.onload = function () { d.text = r.result; res(d.text); }; r.onerror = rej; r.readAsText(d.file); } else if (d.url) fetchText(d.url).then(function (t) { d.text = t; res(t); }, rej); else res(''); }); }
  function openDoc(id) {
    var d = docs.filter(function (x) { return x.id === id; })[0]; if (!d) return;
    currentId = id;
    updateWorkspaceTitle();
    assetUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); assetUrls = [];
    ROOT.classList.remove('empty');
    loadDocText(d).then(function (t) {
      currentUrl = d.source === 'url' ? d.url : '';
      if (d.savedText == null) d.savedText = t;              // 记住磁盘上的原始内容，作为「已保存」基线
      d.dirty = (d.text !== d.savedText);
      if (!d.dirty) checkExternal(d, t);                     // 磁盘这份，跟你上次认可的那份，比一下
      hideTools(); histReset(t);
      renderMarkdown(t); previewPane.scrollTop = 0; renderFileList(); syncEditor(); updateSaveState();
      try { window.dispatchEvent(new CustomEvent('docsmith:doc-changed', { detail: { id: d.id } })); } catch (e) {}
      if (window.innerWidth <= 860) ROOT.classList.remove('side-open');
      if (d.source === 'url') startAutoRefresh(); else clearInterval(refreshTimer);
    }).catch(function () { toast('Failed to read ' + d.name, 'err'); });
  }

  /* ---------- URL fetch + refresh ------------------------------------ */
  function normalizeUrl(u) { u = u.trim(); var gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u); if (gh) return 'https://raw.githubusercontent.com/' + gh[1] + '/' + gh[2] + '/' + gh[3]; var gist = /^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)$/.exec(u); if (gist) return u + '/raw'; return u; }
  function useProxy() { return store.get('proxy', '0') === '1'; }
  function fetchText(url) { return fetch(url, { redirect: 'follow' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).catch(function (err) { if (!useProxy()) throw err; return fetch('https://corsproxy.io/?url=' + encodeURIComponent(url)).then(function (r2) { if (!r2.ok) throw new Error('proxy HTTP ' + r2.status); return r2.text(); }); }); }
  function loadUrl(raw) {
    var url = normalizeUrl(raw || ''); if (!url) return;
    toast('Loading ' + url.replace(/^https?:\/\//, '') + ' …');
    fetchText(url).then(function (text) { var added = addDocs([{ url: url, name: url.split('/').pop() || 'remote.md', text: text }]); lastFetched = text; openDoc(added[0].id); toast('Loaded.', 'ok'); try { history.replaceState(null, '', location.pathname + '?url=' + encodeURIComponent(url)); } catch (e) {} }).catch(function (err) { toast('Could not load — ' + err.message + '. Enable CORS proxy in settings (Aa).', 'err'); });
  }
  function startAutoRefresh() {
    clearInterval(refreshTimer);
    var refresh = parseInt(store.get('refresh', '0'), 10);
    if (!currentUrl || !refresh) return;
    refreshTimer = setInterval(function () {
      if (editing || cellEdit || ROOT.dataset.mode === 'source') return;   // 正在编辑就不打断
      fetchText(currentUrl).then(function (text) { if (text !== lastFetched) { lastFetched = text; var y = previewPane.scrollTop; var d = curDoc(); if (d) { if (!d.dirty && !d.extBase) { d.extBase = d.savedText == null ? d.text : d.savedText; d._extBlks = null; d.extTs = d.extTs || Date.now(); extCache = null; bannerOff = false; } d.text = text; if (!d.dirty) d.savedText = text; } histPush(text); renderMarkdown(text); noSmooth(function () { previewPane.scrollTop = y; }); syncEditor(); updateSaveState(); toast('已从来源刷新 —— 变动的地方标出来了', 'ok'); } }).catch(function () {});
    }, refresh);
  }

  /* ---------- 复制 Markdown 源码 -----------------------------------------
     用户要的是：点一下，粘进飞书云文档 / WPS 在线文档，就是渲染好的效果。

     ⚠ 这里绕了一大圈才找到对的做法，把过程记下来，别再走回头路：

     第一版：往剪贴板写 text/html，并把计算样式抄成内联 style。
       结果 WPS 好了、飞书完全没排版。原因是飞书是**自研 Block 结构化编辑器**，
       内部用专属 JSON 存标题/表格/代码，不是通用 HTML 富文本引擎 ——
       粘贴时只保留最基础的标签，自定义样式被整片过滤掉。

     第二版：既然飞书会把纯文本按 Markdown 解析，那就 text/html 和
       text/plain 各给一份，让两边各取所需。**这条路从根上不成立** ——
       富文本编辑器在两种格式都存在时**一律优先取 text/html**（实测：
       派一个同时带两种格式的 paste 事件，接收方拿到的是 html 那份）。
       所以飞书压根不会去看我们准备的 Markdown。

     现在：**只复制 Markdown 源码**（只写 text/plain）。
       飞书和 WPS 都支持粘贴 Markdown 自动渲染，用户已实测确认。
       没有 text/html，接收方就只能走 Markdown 那条路 —— 这才是可靠的。
       代价是 Word 不认 Markdown，但那本来就该走「导出 → Word」
       （已经有那个功能，而且是真正的 Open XML 排版，比粘贴强得多）。

     **不对内容做任何加工**，包括 mermaid。曾经想"贴心"地把 ```mermaid
     换成图片，那是画蛇添足：飞书和 WPS 本来就能渲染 mermaid，替换反而
     把它们的能力废掉、还把可编辑的图表变成一张死图。
     复制源码就是复制源码。 */

  /** 拿来复制的 Markdown —— 就是文档原文，不做任何加工。 */
  function markdownForCopy() {
    var d = curDoc();
    /* 就是原文，一个字都不动。

       ⚠ 这里曾经把 ```mermaid 围栏替换成 `![图表](data:image/svg+xml,…)`，
       理由是"飞书和 WPS 把 mermaid 显示成代码块"。那是**想多了**：
         · 复制源码就该给源码。擅自改内容，用户拿到的就不是他那份文档了；
         · 飞书和 WPS 本来就支持 mermaid 渲染 —— 替换成图片反而把它们
           自己的渲染能力废掉了，图还从"可编辑的图表"退化成一张死图。
       原样给出去，接收方爱怎么渲染怎么渲染，这才是「复制源码」的语义。 */
    return (d && d.text != null) ? d.text : '';
  }

  /**
   * 复制 Markdown 源码到剪贴板。
   *
   * 只写 text/plain。走 execCommand 那条路而不是 clipboard.writeText —— 后者
   * 在合并进外壳的文档里会被拒（NotAllowedError: Write permission denied，
   * 实测能力页和外壳两次都拒）。execCommand 从一个真实选区复制，
   * 不需要 clipboard 权限、也不要求文档有焦点。
   */
  function copyMarkdown(btn) {
    if (!currentId) { toast('先打开一份文档', 'err'); return; }
    var md;
    try { md = markdownForCopy(); }
    catch (e) { toast('生成内容失败：' + ((e && e.message) || '未知错误'), 'err'); return; }
    if (!md) { toast('这篇文档是空的', 'err'); return; }

    var ok = function () {
      if (btn) flashBtn(btn, '已复制');
      toast('已复制 · 去飞书 / WPS 直接粘贴，会自动排版', 'ok');
    };
    if (copyPlainViaSelection(md)) { ok(); return; }
    /* 退路：clipboard API。它常被拒，但万一 execCommand 被禁用了还有这一条。 */
    copyText(md, btn);
    toast('已复制 · 去飞书 / WPS 直接粘贴，会自动排版', 'ok');
  }

  /**
   * 用「选中 + execCommand('copy')」写纯文本。
   *
   * 为什么不直接 clipboard.writeText：见 copyMarkdown 的说明（会被拒）。
   *
   * ⚠ 必须在 copy 事件里 setData('text/plain', md) 再 preventDefault ——
   * 光靠选区的话，浏览器会把 textarea 里的内容当 text/plain（这里恰好一样，
   * 但显式设更稳），而且**绝对不能让 text/html 也进去**：
   * 富文本编辑器在两种格式都有时一律优先取 html，那样飞书就又看不到
   * Markdown 了（这正是上一版失败的原因）。
   */
  function copyPlainViaSelection(text) {
    /* 用 textarea 而不是 contenteditable div：textarea 里的选区天然只有
       纯文本，不会带出任何 HTML 结构。 */
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('style',
      'position:fixed;left:-99999px;top:0;width:600px;height:200px;opacity:0;' +
      'pointer-events:none;white-space:pre');
    document.body.appendChild(ta);

    var fired = false;
    var onCopy = function (e) {
      fired = true;
      try {
        var dt = e.clipboardData;
        if (dt) {
          dt.setData('text/plain', text);
          /* 显式清掉 html：有些浏览器会顺手放一份 text/html 进去，
             而那会让飞书优先走 HTML 那条路，Markdown 就白准备了。 */
          try { dt.setData('text/html', ''); } catch (x) {}
          e.preventDefault();
        }
      } catch (err) { /* 设不进去就用默认行为 */ }
    };
    document.addEventListener('copy', onCopy, true);

    var okFlag = false;
    try {
      ta.focus();
      ta.select();
      okFlag = document.execCommand('copy');
      if (!fired) okFlag = false;      // 事件没触发 = 什么都没真写进去
    } catch (e) {
      okFlag = false;
    } finally {
      document.removeEventListener('copy', onCopy, true);
      document.body.removeChild(ta);
    }
    return okFlag;
  }

  /* ---------- export / print / copy ---------------------------------- */
  /* 导出的网页里内嵌这一段。它要做三件事，都要在**离线单文件**里成立：

       1. 「View source ⇄ View diagram」切换视图；
       2. 那颗合并后的复制键：看图时复制图片（PNG 进剪贴板），
          看源码时复制源码 —— 和工作台里的行为逐字一致；
       3. 图表的缩放 / 拖拽 / 适应画布（用户要求：「导出为网页中的图片可以加上
          放大、缩小、拖拽、自适应画布吗？在查看大图，特别是宽的图比较优化」）。

     文案不在这里硬编码，一律读 data-diagram-label / data-source-label ——
     那两个属性由 mermaidBlock() 写在按钮上，跟着导出的 HTML 一起走。
     以前这里抄了一份字符串，结果页面上写「看源码」、导出件里写 "View diagram"，
     同一个按钮两副面孔。读 data-* 就不可能再对不上。

     刻意用 ES5 + 手写压缩风格：这段字符串会原样塞进导出的 <script> 里，
     收件人的浏览器版本无法预设，也没有构建步骤帮它降级。 */
  var EXPORT_JS = [
    "(function(){",
    "var MIN=0.02,MAX=12,PAD=14;",
    /* 一张图一套状态。把 api 挂在视口元素上，工具栏按钮直接取。 */
    "function setup(vp){",
    "var stage=vp.querySelector('.mm-stage'),svg=stage&&stage.querySelector('svg');",
    "if(!svg)return null;",
    "var vb=svg.viewBox&&svg.viewBox.baseVal,d={w:(vb&&vb.width)||svg.clientWidth||600,h:(vb&&vb.height)||svg.clientHeight||400};",
    "svg.removeAttribute('width');svg.removeAttribute('height');",
    "svg.style.maxWidth='none';svg.style.margin='0';svg.style.width=d.w+'px';svg.style.height=d.h+'px';svg.style.display='block';",
    "var st={s:1,x:0,y:0},base={s:1,x:0,y:0},raf=0;",
    "function paint(){raf=0;stage.style.transform='translate('+st.x.toFixed(1)+'px,'+st.y.toFixed(1)+'px) scale('+st.s.toFixed(4)+')';",
    "var l=vp.parentNode.querySelector('[data-zoomlabel]');if(l)l.textContent=Math.round(st.s*100)+'%';}",
    "function apply(){if(!raf)raf=requestAnimationFrame(paint);}",
    "function clamp(v){return Math.min(MAX,Math.max(MIN,v));}",
    "function fit(){",
    "var vpW=vp.getBoundingClientRect().width||vp.clientWidth;if(!vpW)return;",
    "var maxH=Math.max(300,Math.min(760,Math.round((window.innerHeight||900)*0.72)));",
    "var k=clamp(Math.min((vpW-PAD*2)/d.w,(maxH-PAD*2)/d.h,1));",
    "var boxH=Math.max(120,Math.round(d.h*k+PAD*2));vp.style.height=boxH+'px';",
    "st.s=k;st.x=(vpW-d.w*k)/2;st.y=(boxH-d.h*k)/2;base={s:st.s,x:st.x,y:st.y};apply();}",
    "function zoomAt(f,cx,cy){var ns=clamp(st.s*f);if(ns===st.s)return;",
    "var r=vp.getBoundingClientRect();cx=cx==null?r.width/2:cx;cy=cy==null?r.height/2:cy;",
    "st.x=cx-(cx-st.x)*(ns/st.s);st.y=cy-(cy-st.y)*(ns/st.s);st.s=ns;apply();}",
    /* 拖拽用 pointer + 指针捕获：手指/鼠标移出视口也不会丢 */
    "var drag=null,px=0,py=0;",
    "vp.addEventListener('pointerdown',function(e){if(e.button!=null&&e.button!==0)return;",
    "if(e.target.closest&&e.target.closest('.mm-tools'))return;",
    "drag=e.pointerId;px=e.clientX;py=e.clientY;try{vp.setPointerCapture(e.pointerId);}catch(x){}",
    "vp.classList.add('grabbing');e.preventDefault();});",
    "vp.addEventListener('pointermove',function(e){if(drag!==e.pointerId)return;",
    "st.x+=e.clientX-px;st.y+=e.clientY-py;px=e.clientX;py=e.clientY;apply();});",
    "function end(e){if(drag!==e.pointerId)return;drag=null;",
    "try{vp.releasePointerCapture(e.pointerId);}catch(x){}vp.classList.remove('grabbing');}",
    "vp.addEventListener('pointerup',end);vp.addEventListener('pointercancel',end);",
    /* 滚轮缩放。只有指针真的落在画布上才拦，页面其余部分照常滚。 */
    "vp.addEventListener('wheel',function(e){e.preventDefault();var r=vp.getBoundingClientRect();",
    "var f=Math.pow(1.0015,-e.deltaY*(e.deltaMode===1?16:1));f=Math.min(1.6,Math.max(1/1.6,f));",
    "zoomAt(f,e.clientX-r.left,e.clientY-r.top);},{passive:false});",
    "vp.addEventListener('dblclick',function(e){if(e.target.closest&&e.target.closest('.mm-tools'))return;",
    "e.preventDefault();if(Math.abs(st.s-base.s)<0.01){var r=vp.getBoundingClientRect();",
    "st.s=1;st.x=(r.width-d.w)/2;st.y=Math.max(PAD,(r.height-d.h)/2);apply();}else{st=({s:base.s,x:base.x,y:base.y});apply();}});",
    "var api={fit:fit,zoomAt:zoomAt,reset:function(){st={s:base.s,x:base.x,y:base.y};apply();},",
    "actual:function(){var r=vp.getBoundingClientRect();st.s=1;st.x=(r.width-d.w)/2;st.y=Math.max(PAD,(r.height-d.h)/2);apply();}};",
    "vp.__pz=api;fit();",
    "if(typeof ResizeObserver==='function'){var t=0;",
    "try{new ResizeObserver(function(){clearTimeout(t);t=setTimeout(fit,120);}).observe(vp);}catch(x){}}",
    "return api;}",
    /* 每张图配一条工具栏。图标和工作台里那套一致（见 MM_ICONS）。 */
    "var ICO={out:'<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M20 20l-3.6-3.6M8 11h6\"/></svg>',",
    "in:'<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M20 20l-3.6-3.6M11 8v6M8 11h6\"/></svg>',",
    "fit:'<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M3 15v4a2 2 0 0 0 2 2h4\"/></svg>'};",
    "function tools(vp){",
    "var t=document.createElement('div');t.className='mm-tools';t.setAttribute('role','toolbar');",
    "t.innerHTML='<button type=\"button\" data-z=\"out\" title=\"缩小\" aria-label=\"缩小\">'+ICO.out+'</button>'",
    "+'<button type=\"button\" data-z=\"in\" title=\"放大\" aria-label=\"放大\">'+ICO.in+'</button>'",
    "+'<button type=\"button\" data-z=\"fit\" title=\"适应画布\" aria-label=\"适应画布\">'+ICO.fit+'</button>'",
    "+'<span class=\"mm-zoom\" data-zoomlabel>100%</span>';",
    "t.addEventListener('click',function(e){var b=e.target.closest('button[data-z]');if(!b)return;",
    "var pz=vp.__pz;if(!pz)return;var z=b.dataset.z;",
    "if(z==='in')pz.zoomAt(1.25);else if(z==='out')pz.zoomAt(1/1.25);else pz.fit();});",
    "return t;}",
    "function boot(){",
    "var list=document.querySelectorAll('.diagram-render .mm-viewport');",
    "for(var i=0;i<list.length;i++){var vp=list[i];",
    "if(vp.__pz)continue;",
    /* 导出的 HTML 是工作台 DOM 的克隆，里面已经带着一条 .mm-tools（那是
       mountDiagram() 挂的，按钮上没有事件监听 —— 监听器不会跟着 cloneNode 走）。
       不先删掉就会出现两条工具栏叠在一起，其中一条还是死的。 */
    "var host=vp.parentNode,old=host.querySelectorAll('.mm-tools');",
    "for(var j=0;j<old.length;j++)old[j].parentNode.removeChild(old[j]);",
    "if(setup(vp))host.appendChild(tools(vp));}}",
    "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();",
    /* 复制成 PNG：和工作台一样先把 SVG 画到 canvas 上，再写剪贴板。
       写不进去（浏览器不给权限）就退成下载一张图，别让用户点了没反应。 */
    "function svgToPng(svg,cb){try{",
    "var vb=svg.viewBox&&svg.viewBox.baseVal,w=(vb&&vb.width)||300,h=(vb&&vb.height)||200;",
    "var c=svg.cloneNode(true);c.setAttribute('xmlns','http://www.w3.org/2000/svg');",
    "c.setAttribute('width',w);c.setAttribute('height',h);c.style.maxWidth='none';c.style.margin='0';",
    "var s=Math.min(2,8192/w,8192/h,Math.sqrt(26e6/(w*h)));if(!isFinite(s)||s<=0)s=1;s=Math.max(0.15,s);",
    "var xml=new XMLSerializer().serializeToString(c),img=new Image();",
    "img.onload=function(){try{var cw=Math.max(1,Math.round(w*s)),ch=Math.max(1,Math.round(h*s));",
    "var cv=document.createElement('canvas');cv.width=cw;cv.height=ch;var x=cv.getContext('2d');",
    "var bg=(getComputedStyle(document.body).getPropertyValue('--doc-bg')||'#fff').trim()||'#fff';",
    "x.fillStyle=bg;x.fillRect(0,0,cw,ch);x.drawImage(img,0,0,cw,ch);",
    "cv.toBlob(function(b){cb(b);},'image/png');}catch(err){cb(null);}};",
    "img.onerror=function(){cb(null);};",
    "img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(xml);}catch(err){cb(null);}}",
    "function flash(b,t){var o=b.dataset.busy||b.textContent;b.textContent=t;",
    "setTimeout(function(){b.textContent=o;},1400);}",
    "document.addEventListener('click',function(e){",
    /* 图表块那颗合并后的复制键 */
    "var m=e.target.closest('.mm-copy');",
    "if(m){var blk=m.closest('.diagram-block');",
    "if(blk.dataset.view==='source'){var el=blk.querySelector('pre code');",
    "navigator.clipboard&&navigator.clipboard.writeText(el?el.textContent:'');flash(m,'Copied');return;}",
    "var svg=blk.querySelector('.mm-stage svg');if(!svg)return;",
    "m.dataset.busy=m.dataset.diagramLabel||m.textContent;m.textContent='…';",
    "svgToPng(svg,function(b){",
    "if(!b){flash(m,'Failed');return;}",
    "var done=function(){flash(m,'Copied');};",
    "var save=function(){try{var u=URL.createObjectURL(b),a=document.createElement('a');",
    "a.href=u;a.download=(document.title||'diagram')+'.png';document.body.appendChild(a);a.click();",
    "document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},1000);flash(m,'Saved');}catch(x){flash(m,'Failed');}};",
    "if(navigator.clipboard&&navigator.clipboard.write&&window.ClipboardItem){",
    "try{navigator.clipboard.write([new ClipboardItem({'image/png':b})]).then(done,save);}catch(x){save();}}",
    "else save();});return;}",
    /* 普通代码块的复制键 */
    "var c=e.target.closest('.copy-btn');",
    "if(c){var b2=c.closest('.code-block,.diagram-block');var el2=b2&&b2.querySelector('pre code');",
    "navigator.clipboard&&navigator.clipboard.writeText(el2?el2.textContent:'');",
    "var o=c.textContent;c.textContent='Copied';setTimeout(function(){c.textContent=o;},1400);return;}",
    /* 视图切换：两颗按钮的文案都从 data-* 读，和工作台永远一致 */
    "var g=e.target.closest('.mm-toggle');",
    "if(g){var k=g.closest('.diagram-block');var n=k.dataset.view==='diagram'?'source':'diagram';",
    "k.dataset.view=n;",
    "var lab=function(btn){if(!btn)return;var t=n==='source'?btn.dataset.sourceLabel:btn.dataset.diagramLabel;if(t)btn.textContent=t;};",
    "lab(g);lab(k.querySelector('.mm-copy'));",
    "if(n==='diagram'){var v=k.querySelector('.mm-viewport');if(v&&v.__pz)v.__pz.fit();}}",
    "});",
    "})();"
  ].join('');
  function currentName() { var d = curDoc(); return d ? d.name.replace(/\.(md|markdown|mkd|mdx)$/i, '') : 'document'; }
  /* exported / copied HTML must not carry the editing scaffolding */
  function cleanDocHtml() {
    var c = preview.cloneNode(true);
    c.querySelectorAll('.src-box,.blk-new,.blk-add-end,.doc-blank,.chg-del,.chg-diff').forEach(function (n) { n.remove(); });
    c.querySelectorAll('[data-chg]').forEach(function (n) { n.removeAttribute('data-chg'); });
    c.querySelectorAll('.rich').forEach(function (n) { n.classList.remove('rich'); });
    c.querySelectorAll('.find-match-block,.find-current-block').forEach(function (n) { n.classList.remove('find-match-block', 'find-current-block'); });
    c.querySelectorAll('.blk').forEach(function (b) {
      var p = b.parentNode; while (b.firstChild) p.insertBefore(b.firstChild, b); p.removeChild(b);
    });
    c.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    c.querySelectorAll('.cell-editing').forEach(function (n) { n.classList.remove('cell-editing'); });
    c.querySelectorAll('input[type=checkbox]').forEach(function (n) { n.disabled = true; n.removeAttribute('data-task'); });
    return c.innerHTML;
  }
  /* 「导出 PDF」那条路会往导出的网页里多塞这一句：打开即唤起打印框，
     用户在系统对话框里选「另存为 PDF」。
     等 document.fonts.ready 再打印 —— 不等的话 Chrome 有时会按回退字体的
     字宽分页，公式和代码块的断行位置就跟屏幕上看到的不一样了；
     再挂一个 1.2 秒的兜底，万一 fonts.ready 不兑现也不会卡在这儿。
     只有 PDF 这条路加，用户手动导出的 .html 不该一打开就弹打印框。 */
  var EXPORT_PRINT_JS = "(function(){var p=function(){try{window.print();}catch(e){}};var d=false;"
    + "var go=function(){if(d)return;d=true;setTimeout(p,120);};"
    + "if(document.fonts&&document.fonts.ready){document.fonts.ready.then(go);}"
    + "setTimeout(go,1200);})();";

  /* ---------- 导出网页：把样式真的带上 --------------------------------
     单文件导出必须自给自足：收件人可能没网、可能把文件拷进 U 盘、可能直接
     双击打开。所以不能 <link> 到 CDN（以前链的是 jsdelivr，离线就整篇裸奔），
     更不能指望 $('#docStyles') —— 那个节点在 index.html 里压根不存在，
     拼出来永远是空字符串，于是导出的网页一点样式都没有。

     现在的做法：导出时把扩展里那几份真样式表读回来，原样拼进 <style>。
     全是同源的扩展资源，fetch 不会被拦；读完缓存住，连点两次导出不重复读盘。
     顺序要紧 —— 后面的能盖前面的，doc.css 必须排在 tokens.css 之后。 */
  var EXPORT_CSS_FILES = [
    '../../core/tokens.css',        // --accent 等基础变量：diagrams.css 的配色要用
    './doc.css',                    // 文档本体（含 @media print）
    '../../diagrams/diagrams.css'   // 自带画图器的 .dg-* 配色
  ];
  /* 上面那些相对路径的基准。

     **不能用 location.href**：内置能力合并进外壳后，location 是外壳的
     src/app/index.html —— './doc.css' 会解析成 src/app/doc.css（不存在），
     fetchText2 把失败吞成空字符串，于是导出的网页一条样式都没有：
     没字体、没表格边框、没版心宽度（用户截图里那个裸奔的样子）。
     这个 bug 只在合并模式下出现，独立打开这一页时 location 恰好是对的。

     改成锚定**本脚本自己的地址**：document.currentScript 在模块顶层同步
     可用，import.meta 在 classic script 里没有。拿不到就退回 location，
     并把 src/views/markdown/ 补上 —— 至少比解析到外壳目录强。 */
  var SELF_DIR = (function () {
    try {
      var u = (document.currentScript && document.currentScript.src) || '';
      if (u) return u.replace(/[^/]+$/, '');       // …/src/views/markdown/
    } catch (e) {}
    return new URL('src/views/markdown/', location.href).href;
  })();
  var _exportCssCache = null;
  function fetchText2(url) {
    return fetch(url).then(function (r) { return r.ok ? r.text() : ''; }, function () { return ''; });
  }
  /* hljs 亮暗两套都是裸 .hljs 选择器，直接拼在一起后一份会无条件盖掉另一份。
     导出的页面 <html> 上带着 data-theme，所以给每份加个属性前缀，让选择器
     自己去挑 —— 两套都带上，收件人切系统主题也不会掉色。
     这两个文件各约 1.3KB、规则寥寥、没有 @media 也没有 url()（已核对过），
     所以在这里用正则加前缀是安全的。**不要**把这个函数用到别的样式表上。

     先把 /* *\/ 注释剥掉再匹配：hljs 的文件里正好有一处是「注释紧接着选择器」
     （…*\/.hljs{color:#24292e}），而下面这个正则以 } 或开头定位，
     夹在注释后面的那条就会被漏掉 —— 漏掉的偏偏是设定前景/背景色的 .hljs 本体，
     两套主题一拼就又互相覆盖了。剥掉注释，这个洞就不存在。 */
  function scopeHljs(css, theme) {
    var s = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
    return s.replace(/(^|})\s*([^{}@]+)\{/g, function (m, brace, sel) {
      if (!sel.trim()) return m;
      return brace + sel.split(',').map(function (x) {
        return '[data-theme=' + theme + '] ' + x.trim();
      }).join(',') + '{';
    });
  }
  function collectExportCss() {
    if (_exportCssCache) return Promise.resolve(_exportCssCache);
    var base = SELF_DIR;          // ← 不是 location.href，见 SELF_DIR 那段注释
    var jobs = EXPORT_CSS_FILES.map(function (rel) { return fetchText2(new URL(rel, base).href); });
    jobs.push(fetchText2(new URL('../../vendor/hljs-light.css', base).href).then(function (c) { return scopeHljs(c, 'light'); }));
    jobs.push(fetchText2(new URL('../../vendor/hljs-dark.css', base).href).then(function (c) { return scopeHljs(c, 'dark'); }));
    return Promise.all(jobs).then(function (parts) {
      var all = parts.join('\n');
      /* 一条样式都没抓到 = 上面某个路径解析错了。**不要**静默继续 ——
         那样导出的网页会裸奔，而用户以为导出成功了。 */
      if (!all.replace(/\s/g, '')) {
        throw new Error('样式表没读到（base=' + base + '）');
      }
      _exportCssCache = all;
      return _exportCssCache;
    });
  }

  /* ---------- 导出网页：数学公式的字体 --------------------------------
     KaTeX 的字体是相对路径引的（url(fonts/KaTeX_Main-Regular.woff2)）。
     单文件导出没有 fonts/ 目录，链过去必然 404 —— 公式会退成一堆错位的字符。
     所以把字体本体转成 data URI 焊进 CSS 里。

     只带常用的那 7 个：Main 三种字形、Math-Italic、Size1/2、AMS —— 普通数学
     公式全靠它们，加起来约 124KB（base64 后约 165KB）。花体、哥特体、
     等宽、无衬线那些一并去掉 @font-face，浏览器退回系统字体去画那几个生僻
     符号，比链一个 404 好看得多。
     没有公式的文档整段跳过，别让每篇文档白背 200KB。
     另外 katex.min.css 里同时写了 woff2/woff/ttf 三种回退，但我们只随包带了
     woff2 —— 另外两种在扩展里本来就是 404，一并剔掉，省得导出件里留死链。 */
  var KATEX_KEEP = [
    'KaTeX_Main-Regular', 'KaTeX_Main-Bold', 'KaTeX_Main-Italic',
    'KaTeX_Math-Italic', 'KaTeX_Size1-Regular', 'KaTeX_Size2-Regular',
    'KaTeX_AMS-Regular'
  ];
  var _katexCssCache = null;
  function bytesToBase64(buf) {
    var bytes = new Uint8Array(buf), CH = 0x8000, out = '';
    for (var i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(out);
  }
  function buildKatexCss() {
    if (_katexCssCache) return Promise.resolve(_katexCssCache);
    var base = SELF_DIR;          // ← 同 collectExportCss：不能用 location.href，
                                  //   合并模式下会解析到外壳目录，公式字体全丢
    var cssUrl = new URL('../../vendor/katex/katex.min.css', base).href;
    return fetchText2(cssUrl).then(function (css) {
      if (!css) return '';
      var fonts = {};
      return Promise.all(KATEX_KEEP.map(function (name) {
        var u = new URL('../../vendor/katex/fonts/' + name + '.woff2', base).href;
        return fetch(u).then(function (r) { return r.ok ? r.arrayBuffer() : null; }, function () { return null; })
          .then(function (buf) { if (buf) fonts[name] = 'data:font/woff2;base64,' + bytesToBase64(buf); });
      })).then(function () {
        /* 逐个 @font-face 块处理：留下的换成 data URI 且只保留 woff2，
           没留下的整块删掉。 */
        var out = css.replace(/@font-face\{[^}]*\}/g, function (blk) {
          var m = /url\((?:["']?)fonts\/(KaTeX_[A-Za-z0-9-]+)\.woff2/.exec(blk);
          var name = m && m[1];
          if (!name || !fonts[name]) return '';
          return blk.replace(/src:[^;}]*/, "src:url(" + fonts[name] + ") format('woff2')");
        });
        _katexCssCache = out;
        return out;
      });
    });
  }

  /* 导出的网页现在**是**一个能看图的画布，不再是一张死页面。

     cleanDocHtml() 已经从 DOM 层面拿掉了 .src-box / .blk / [contenteditable]
     那一批（编辑脚手架），这里补的是纯样式上的差异。

     藏掉的只剩一个：
       · .h-anchor  标题前那个 # —— 用户说「导出的网页里一堆井号」就是它，
                    它靠 opacity:0 藏着，样式一丢就现形。

     ⚠ 以前这里还藏掉了 .mm-tools / .mm-zoom / .mm-copy-png，并且写了
         .mm-viewport{height:auto} + .mm-stage{transform:none}
       —— 因为那时导出页里没有任何 JS 撑着画布，缩放按钮点了不会动。
       现在 EXPORT_JS 把 pan/zoom、适应画布、复制图片全实现了（用户要求：
       「导出为网页中的图片可以加上放大、缩小、拖拽、自适应画布吗？」），
       所以这三条**必须删掉**：
         · 藏 .mm-tools     → 工具栏没了，缩放按钮无从点起
         · height:auto      → 视口高度不受控，fit() 算出来的 boxH 被忽略
         · transform:none   → 平移和缩放全部失效，图永远停在原始尺寸
       删掉之后，超宽的图靠 fit() 缩进视口，读者还能自己放大拖拽去看细节。
       这也是为什么 svg 上那句 max-width:100% 一起去掉了 —— 它会和
       transform 缩放叠加，图会被缩两次。

     .copy-btn / .mm-toggle / .mm-copy 都留着，EXPORT_JS 真的实现了它们。
     收件人按 Ctrl+P 打印时，doc.css 里的 @media print 会把按钮和工具栏全藏掉，
     并且把 .mm-viewport 放开成 height:auto、.mm-stage 清掉 transform ——
     打印那一份要的是「整张图摊开」，和屏幕上可缩放的画布正好相反，
     两种需求各由各的媒体查询管，不再互相打架。 */
  var EXPORT_SHIM_CSS = 'html,body{height:auto;overflow:visible;display:block;}'
    + 'body{margin:0;background:var(--doc-bg);color:var(--doc-fg);}'
    + '.doc{margin:0 auto;}'
    + '.doc .h-anchor{display:none !important;}'
    /* 画布要能裁剪（否则拖动时图会溢出到正文上），且默认手型提示可拖 */
    + '.doc .diagram-render{position:relative;}'
    + '.doc .mm-viewport{overflow:hidden; cursor:grab; touch-action:pan-y;}'
    + '.doc .mm-viewport.grabbing{cursor:grabbing; touch-action:none;}'
    + '.doc .mm-stage{transform-origin:0 0;}'
    + '.doc .mm-stage svg{margin:0 !important;}';

  /* 以前这个函数是同步的 —— 因为它其实什么都没收集。现在要把样式读回来，
     只能返回 Promise。两个调用点都跟着改成 .then：exportStandaloneHtml
     和 shareHtml（分享网页走的也是这一份产物，一次修好两处）。
     opts.autoPrint 只给「导出 PDF」那条路用，见 exportPdf()。 */
  function buildStandalone(opts) {
    opts = opts || {};
    var theme = resolvedTheme();
    var custom = ($('#customCss') || {}).textContent || '';
    var needKatex = !!preview.querySelector('.katex, .math-block');
    return Promise.all([
      collectExportCss(),
      needKatex ? buildKatexCss() : Promise.resolve('')
    ]).then(function (css) {
      return '<!DOCTYPE html>\n<html lang="zh-CN" data-theme="' + theme + '">\n<head>\n'
        + '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        + '<title>' + escapeHtml(currentName()) + '</title>\n'
        + '<style>\n' + css[1] + '\n' + css[0] + '\n' + EXPORT_SHIM_CSS + '\n'
        + '.doc{--doc-measure:' + settings.width + 'px;font-size:' + settings.size + 'px;}\n'
        + custom + '\n</style>\n</head>\n'
        /* 字体那一档照抄用户当前的选择（黑体/圆体/衬线）—— 导出的网页要和
           屏幕上一模一样。FONT_CLASSES 是白名单，防止 store 里存了别的值时
           拼出一个 doc.css 里不存在的 class。 */
        + '<body><article class="doc font-' + (FONT_CLASSES.indexOf(settings.font) >= 0 ? settings.font : 'sans') + '">'
        + cleanDocHtml() + '</article>\n'
        + '<script>' + EXPORT_JS + (opts.autoPrint ? EXPORT_PRINT_JS : '') + '<\/script>\n'
        + '</body>\n</html>';
    });
  }
  /* ---------- 打印：就在当前页面唤起 --------------------------------------
     用户要求「简化操作」：不要先开一个标签页再让他去那边点打印。

     能直接打印的前提有两条，缺一不可：
       1. 文档和 doc.css 的 @media print 在**同一个文档**里（合并模式成立；
          能力页如果还是 iframe 就不成立）；
       2. 外壳那套「一屏内自己滚」的布局在打印时被解开，否则内容被裁到第一页
          —— 这一条由 app/shell.css 末尾的 @media print 负责。
     两条都满足时 window.print() 打出来的就是这篇文档本身，页眉里的标题
     即文件名（Chrome 用 document.title 作为「另存为 PDF」的默认文件名）。

     打印期间把 document.title 临时换成文件名：外壳的标题是「Docsmith · 文匠」，
     不换的话另存出来的 PDF 就叫 Docsmith。打完立刻换回去。

     ⚠ window.print() 是**同步阻塞**的（对话框关掉才返回），所以恢复标题的代码
     放在它后面就够了；但 Chrome 在某些版本里对 beforeprint/afterprint 的时机
     有差异，所以两头都挂上，确保标题一定还原。 */
  function canPrintInPlace() {
    /* 仍然是 iframe 的话（用户自建能力那种挂载方式），打印会按外层算，
       走不通 —— 退回开标签页那条路。合并模式下 self === top，这里为 true。 */
    try { if (window.self !== window.top) return false; } catch (e) { return false; }
    return typeof window.print === 'function';
  }
  function printInPlace() {
    if (!canPrintInPlace()) { printViaTab(); return; }
    var docName = currentName();
    var prevTitle = document.title;
    var restored = false;
    var restore = function () {
      if (restored) return; restored = true;
      document.title = prevTitle;
      window.removeEventListener('afterprint', restore);
    };
    document.title = docName;              // ← 另存为 PDF 的默认文件名
    window.addEventListener('afterprint', restore);
    try {
      window.print();
    } catch (e) {
      restore();
      toast('这个环境不允许直接打印，改用新标签页…');
      printViaTab();
      return;
    }
    /* print() 返回后对话框已经关了（或者浏览器异步处理，afterprint 会兜住）。
       再挂一个超时兜底，避免极端情况下标题一直停在文件名上。 */
    setTimeout(restore, 60000);
    restore();
  }
  /* 兜底：老路子 —— 生成一份自给自足的网页，在真标签页里打开并自动唤起打印。
     只在 window.print() 走不通时用（iframe 挂载、或 print 被禁用）。 */
  function printViaTab() {
    toast('正在准备打印版式…');
    buildStandalone({ autoPrint: true }).then(function (html) {
      if (IN_SHELL) {
        try {
          window.parent.postMessage({ ns: BUS_NS, type: 'printHtml',
            name: currentName() + '.pdf', html: html }, '*');
          toast('已在新标签页打开 —— 在打印窗口里选「另存为 PDF」');
          return;
        } catch (e) { /* 发不出去就自己开，见下 */ }
      }
      openPrintTab(html);     // 整页模式 / 直接打开这个页面时走这里
    }, function (e) {
      toast('准备打印失败：' + ((e && e.message) || '未知错误'), 'err');
    });
  }

  /* 自己开一个标签页把导出的网页打开（不在外壳里时用；在外壳里则交给外壳，
     那边有 chrome.tabs，见 app/main.js 的 printHtml）。
     blob: URL 60 秒后再撤 —— 打印预览还要读它，撤早了会拿到一张白纸。 */
  function openPrintTab(html) {
    var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    var w = null;
    try { w = window.open(url, '_blank'); } catch (e) {}
    if (!w) toast('浏览器拦住了新标签页。允许弹出窗口后再试，或先「导出 → 网页」再自己打印。', 'err');
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  }
  function download(name, content, type) {
    try { window.dispatchEvent(new CustomEvent('docsmith:export', { detail: { format: (name.split('.').pop() || '').toLowerCase() } })); } catch (e) {}
    var blob = new Blob([content], { type: type || 'text/plain' });
    if (IN_SHELL) { try { var id = 's_' + uid(); var to = setTimeout(function () { localSave(blob, name); }, 1500); window._mdrSaves = window._mdrSaves || {}; window._mdrSaves[id] = to; window.parent.postMessage({ ns: BUS_NS, type: 'saveBlob', id: id, name: name, mime: blob.type, blob: blob }, '*'); return; } catch (e) {} }
    localSave(blob, name);
  }
  function localSave(blob, name) { var url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }

  /* ---------- Microsoft Word (.docx) export ---------------------------
     The rendered document is the conversion source. This preserves the
     reader's Markdown extensions (callouts, task lists, Mermaid and so on)
     while docx.js writes a genuine Open XML package that Word can edit. */
  var WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  var wordExporting = false;

  function wordHex(value, fallback) {
    var v = String(value || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(v)) v = v.replace(/./g, function (c) { return c + c; });
    return /^[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : (fallback || 'C8891A');
  }
  function wordAccent() {
    var a = appearNow && appearNow();
    return wordHex(ACCENTS[(a && a.accent) || 'amber'], 'C8891A');
  }
  function wordFileName() {
    var n = (currentName() || 'document').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
    return (n || 'document') + '.docx';
  }
  function wordSetBusy(on, label) {
    var b = $('#downloadBtn'); if (!b) return;
    b.disabled = !!on; b.classList.toggle('busy', !!on);
    b.setAttribute('aria-busy', on ? 'true' : 'false');
    b.textContent = on ? (label || 'Preparing...') : 'Export Word';
  }
  function wordProgress(ctx, label) {
    if (!ctx) return;
    var suffix = ctx.mediaTotal ? ' ' + Math.min(ctx.mediaDone, ctx.mediaTotal) + '/' + ctx.mediaTotal : '';
    wordSetBusy(true, label + suffix);
  }
  function wordMediaDone(ctx) { ctx.mediaDone++; wordProgress(ctx, 'Images'); }
  function wordCommitEditing() {
    closeBlockEditor(true); endCellEdit(true);
    if (ROOT.dataset.mode === 'source') setMode('read');
  }
  function wordWaitForDiagrams(timeout) {
    return new Promise(function (resolve) {
      var started = Date.now();
      (function check() {
        var pending = $$('.diagram-block', preview).some(function (b) {
          return !b.querySelector('.mm-stage svg,.diagram-render svg,.mm-error');
        });
        if (!pending || Date.now() - started >= timeout) { resolve(); return; }
        setTimeout(check, 90);
      })();
    });
  }
  function wordBlobBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader(); r.onload = function () { resolve(r.result); }; r.onerror = reject; r.readAsArrayBuffer(blob);
    });
  }
  function wordLoadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片格式无法读取')); };
      img.src = url;
    });
  }
  function wordCanvasBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('图片无法转换为 PNG')); }, 'image/png');
    });
  }
  async function wordImageData(src, ctx) {
    if (ctx.imageCache[src]) return ctx.imageCache[src];
    var task = (async function () {
      var response;
      try { response = await fetch(src); }
      catch (e) { throw new Error('浏览器阻止读取这张图片（可能缺少 CORS 权限）'); }
      if (!response.ok) throw new Error('图片请求失败（HTTP ' + response.status + '）');
      var source = await response.blob(), img = await wordLoadImage(source);
      var naturalW = img.naturalWidth || img.width || 1, naturalH = img.naturalHeight || img.height || 1;
      var rasterScale = Math.min(1, 1800 / naturalW, 1800 / naturalH);
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(naturalW * rasterScale));
      canvas.height = Math.max(1, Math.round(naturalH * rasterScale));
      var g = canvas.getContext('2d');
      if (!g) throw new Error('浏览器无法创建图片画布');
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      var png = await wordCanvasBlob(canvas), display = Math.min(1, 620 / naturalW, 760 / naturalH);
      return { data: await wordBlobBytes(png), width: Math.max(1, Math.round(naturalW * display)), height: Math.max(1, Math.round(naturalH * display)) };
    })();
    ctx.imageCache[src] = task;
    try { return await task; } catch (e) { delete ctx.imageCache[src]; throw e; }
  }
  function wordImageLabel(img) {
    return (img.getAttribute('alt') || img.getAttribute('title') || 'image').trim() || 'image';
  }
  async function wordImageRun(img, ctx) {
    var src = img.currentSrc || img.src || img.getAttribute('src') || '';
    try {
      if (!src) throw new Error('图片没有可用地址');
      var d = await wordImageData(src, ctx);
      return new ctx.D.ImageRun({
        data: d.data,
        transformation: { width: d.width, height: d.height },
        altText: { title: wordImageLabel(img), description: wordImageLabel(img), name: wordImageLabel(img) }
      });
    } catch (e) {
      ctx.warnings.push(wordImageLabel(img) + '：' + ((e && e.message) || '无法嵌入'));
      return new ctx.D.TextRun({ text: '[图片未嵌入：' + wordImageLabel(img) + ']', italics: true, color: 'A15C00' });
    } finally { wordMediaDone(ctx); }
  }

  function wordTextRun(text, style, ctx) {
    if (text == null || text === '') return null;
    style = style || {};
    var value = String(text).replace(/\u00a0/g, ' ');
    if (!style.preserve) value = value.replace(/[\r\n\t]+/g, ' ');
    if (!value) return null;
    var o = { text: value };
    if (style.bold) o.bold = true;
    if (style.italics) o.italics = true;
    if (style.strike) o.strike = true;
    if (style.underline) o.underline = { type: 'single', color: style.color || '0563C1' };
    if (style.superScript) o.superScript = true;
    if (style.subScript) o.subScript = true;
    if (style.font) o.font = style.font;
    if (style.size) o.size = style.size;
    if (style.color) o.color = style.color;
    if (style.shading) o.shading = { type: ctx.D.ShadingType.CLEAR, color: 'auto', fill: style.shading };
    return new ctx.D.TextRun(o);
  }
  function wordStyleFor(el, base) {
    var s = Object.assign({}, base || {}), tag = el.tagName.toLowerCase();
    if (tag === 'strong' || tag === 'b') s.bold = true;
    if (tag === 'em' || tag === 'i') s.italics = true;
    if (tag === 'del' || tag === 's' || tag === 'strike') s.strike = true;
    if (tag === 'u' || tag === 'ins') s.underline = true;
    if (tag === 'sup') s.superScript = true;
    if (tag === 'sub') s.subScript = true;
    if (tag === 'mark') s.shading = 'FFF2A8';
    if (tag === 'code' || tag === 'kbd') { s.font = 'Consolas'; s.size = 19; s.shading = 'F1F3F5'; s.color = '9C2F5A'; }
    return s;
  }
  function wordSkipInline(el) {
    return !!(el.matches && el.matches('button,.h-anchor,.cb-head,.mm-tools,.fn-back,.callout-head,.chg-diff,.chg-del,.src-box,.blk-add-end,.render-error'));
  }
  async function wordInline(parent, ctx, style, options) {
    var out = [], nodes = Array.prototype.slice.call(parent.childNodes), opts = options || {};
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType === 3) { var run = wordTextRun(n.nodeValue, style, ctx); if (run) out.push(run); continue; }
      if (n.nodeType !== 1) continue;
      var el = n, tag = el.tagName.toLowerCase();
      if (wordSkipInline(el) || tag === 'script' || tag === 'style' || tag === 'svg') continue;
      if (opts.skipLists && (tag === 'ul' || tag === 'ol')) continue;
      if (tag === 'br') { out.push(new ctx.D.TextRun({ break: 1 })); continue; }
      if (tag === 'img') { out.push(await wordImageRun(el, ctx)); continue; }
      if (tag === 'input' && el.type === 'checkbox') {
        out.push(new ctx.D.TextRun({ text: el.checked ? '\u2612 ' : '\u2610 ', font: 'Segoe UI Symbol' })); continue;
      }
      if (el.classList.contains('katex')) {
        var ann = el.querySelector('annotation[encoding="application/x-tex"]');
        var math = wordTextRun((ann && ann.textContent) || el.textContent || '', { font: 'Cambria Math', italics: true }, ctx);
        if (math) out.push(math); continue;
      }
      var next = wordStyleFor(el, style);
      if (tag === 'a') {
        var href = el.getAttribute('href') || '', linkedStyle = Object.assign({}, next);
        if (/^(https?:|mailto:)/i.test(href)) { linkedStyle.color = '0563C1'; linkedStyle.underline = true; }
        var linked = await wordInline(el, ctx, linkedStyle, opts);
        if (/^(https?:|mailto:)/i.test(href) && linked.length) out.push(new ctx.D.ExternalHyperlink({ link: href, children: linked }));
        else out = out.concat(linked);
        continue;
      }
      out = out.concat(await wordInline(el, ctx, next, opts));
    }
    return out;
  }
  function wordAlignment(el, ctx) {
    var a = (el.getAttribute && el.getAttribute('align')) || (el.style && el.style.textAlign) || '';
    if (!a && el.isConnected) { try { a = getComputedStyle(el).textAlign; } catch (e) {} }
    if (a === 'center') return ctx.D.AlignmentType.CENTER;
    if (a === 'right' || a === 'end') return ctx.D.AlignmentType.RIGHT;
    if (a === 'justify') return ctx.D.AlignmentType.JUSTIFIED;   // 作者真要两端对齐就随他
    /* 兜底返回 LEFT，而不是 null。
       null 等于「不往 docx 里写 <w:jc>」，而 docx 只在给了 alignment 时才产出
       这个标签 —— 没有它，Word 就去继承**收件人自己模板**里「正文」样式的
       对齐方式，而中文版 Word 的「正文」默认往往是「两端对齐」。
       于是代码块里那种一整行没有空格的长公式，Word 断不开词，只能把
       **字符之间**的间隙撑满整行 —— 用户截图里「每个字隔得老远、横贯整页」
       就是这么来的。
       导出的文档该长什么样，得由我们说清楚，不能交给对方的模板去猜。 */
    return ctx.D.AlignmentType.LEFT;
  }
  async function wordParagraph(el, ctx, options) {
    var opt = options || {}, runs = opt.runs || await wordInline(el, ctx, opt.runStyle || {}, opt.inlineOptions);
    if (!runs.length) runs = [new ctx.D.TextRun('')];
    var p = { children: runs, spacing: Object.assign({ after: 120, line: 320 }, opt.spacing || {}) };
    var align = opt.alignment || wordAlignment(el, ctx); if (align) p.alignment = align;
    ['heading','numbering','indent','border','shading','style','keepNext','keepLines','pageBreakBefore'].forEach(function (k) { if (opt[k] != null) p[k] = opt[k]; });
    return new ctx.D.Paragraph(p);
  }
  function wordBorder(ctx, color, size) { return { style: ctx.D.BorderStyle.SINGLE, size: size || 4, color: color || 'D7DCE2' }; }
  function wordCodeParagraphs(text, lang, ctx) {
    var lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n'), runs = [];
    lines.forEach(function (line, i) {
      runs.push(new ctx.D.TextRun({ text: line || ' ', break: i ? 1 : undefined, font: 'Consolas', size: 18, color: '263238' }));
    });
    var out = [];
    if (lang) out.push(new ctx.D.Paragraph({ children: [new ctx.D.TextRun({ text: lang, bold: true, size: 17, color: '6B7280', font: 'Aptos' })], spacing: { before: 100, after: 40 }, keepNext: true, alignment: ctx.D.AlignmentType.LEFT }));
    out.push(new ctx.D.Paragraph({
      children: runs, spacing: { after: 160, line: 270 }, keepLines: true,
      /* 代码块永远左对齐，而且关掉「为了对齐而调整字距」。
         两端对齐 + 一行没有空格的长公式 = Word 断不开词，只能把字符之间的
         间隙撑满整行（截图里那种「年 节 省 = 被 替 代 人 力 数」）。
         alignment 必须显式写：不写就等于让收件人的 Word 模板替我们决定。
         wordWrap:false 产出 <w:wordWrap w:val="0"/>，允许长行直接溢出，
         而不是硬凑成一行 —— 代码宁可跑出边界，也不该被拉变形。 */
      alignment: ctx.D.AlignmentType.LEFT,
      /* 注意这里是 true。docx 的开关是「有没有传值」，传了才产出
         <w:wordWrap w:val="0"/> —— 而 w:val="0" 在 OOXML 里的含义正是
         「不要为了凑满一行而强行断字」。写 false 等于什么都不写，标签根本
         不会出现（试过，确实不出现）。名字和语义反着来，所以留一句在这儿。 */
      wordWrap: true,
      shading: { type: ctx.D.ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' },
      border: { top: wordBorder(ctx), bottom: wordBorder(ctx), left: wordBorder(ctx), right: wordBorder(ctx) },
      indent: { left: 160, right: 160 }
    }));
    return out;
  }
  async function wordCodeBlock(el, ctx) {
    var code = el.querySelector('pre code'), lang = el.querySelector('.cb-lang');
    return wordCodeParagraphs(code ? code.textContent : el.textContent, lang ? lang.textContent.trim() : '', ctx);
  }
  async function wordDiagramBlock(el, ctx) {
    var language = (el.dataset.diagramLanguage || 'diagram').trim().toLowerCase();
    var label = language === 'infographic' ? '信息图' : (language === 'mermaid' ? 'Mermaid 图表' : '图表');
    try {
      var svg = el.querySelector('.mm-stage svg') || el.querySelector('.diagram-render svg');
      if (!svg) throw new Error('图表没有渲染完成');
      var png = await svgToPng(svg), dims = svgDims(svg), scale = Math.min(1, 620 / dims.w, 760 / dims.h);
      var run = new ctx.D.ImageRun({
        data: await wordBlobBytes(png.blob),
        transformation: { width: Math.max(1, Math.round(dims.w * scale)), height: Math.max(1, Math.round(dims.h * scale)) },
        altText: { title: label, description: label, name: label }
      });
      return [new ctx.D.Paragraph({ children: [run], alignment: ctx.D.AlignmentType.CENTER, spacing: { before: 100, after: 180 }, keepLines: true })];
    } catch (e) {
      ctx.warnings.push(label + '：' + ((e && e.message) || '无法嵌入'));
      var code = el.querySelector('.diagram-source code');
      return wordCodeParagraphs(code ? code.textContent : '', language, ctx);
    } finally { wordMediaDone(ctx); }
  }
  function wordAddNumbering(el, ctx, depth) {
    var ordered = el.tagName.toLowerCase() === 'ol', ref = 'mdw-list-' + (++ctx.listCounter);
    var start = ordered ? (parseInt(el.getAttribute('start'), 10) || 1) : 1;
    var bullets = ['\u2022', '\u25e6', '\u25aa'];
    ctx.numbering.push({ reference: ref, levels: [{
      level: 0, format: ordered ? ctx.D.LevelFormat.DECIMAL : ctx.D.LevelFormat.BULLET,
      text: ordered ? '%1.' : bullets[depth % bullets.length], alignment: ctx.D.AlignmentType.LEFT, start: start,
      style: { paragraph: { indent: { left: 720 * (depth + 1), hanging: 360 } } }
    }] });
    return ref;
  }
  async function wordList(el, ctx, depth) {
    var items = Array.prototype.filter.call(el.children, function (n) { return n.tagName && n.tagName.toLowerCase() === 'li'; });
    var ref = wordAddNumbering(el, ctx, depth), out = [];
    for (var i = 0; i < items.length; i++) {
      var li = items[i], task = !!li.querySelector(':scope > input[type=checkbox],:scope > p > input[type=checkbox]');
      out.push(await wordParagraph(li, ctx, {
        inlineOptions: { skipLists: true },
        numbering: task ? null : { reference: ref, level: 0 },
        indent: task ? { left: 720 * (depth + 1), hanging: 360 } : null,
        spacing: { after: 45, line: 300 }
      }));
      var nested = Array.prototype.filter.call(li.children, function (n) { return n.tagName && /^(ul|ol)$/i.test(n.tagName); });
      for (var j = 0; j < nested.length; j++) out = out.concat(await wordList(nested[j], ctx, depth + 1));
    }
    return out;
  }
  async function wordTable(el, ctx) {
    var trs = Array.prototype.slice.call(el.querySelectorAll('tr'));
    if (!trs.length) return [];
    var cols = 1; trs.forEach(function (r) { cols = Math.max(cols, r.children.length); });
    var rows = [];
    for (var i = 0; i < trs.length; i++) {
      var cells = [], sourceCells = Array.prototype.slice.call(trs[i].children);
      for (var c = 0; c < cols; c++) {
        var cell = sourceCells[c], head = !!(cell && cell.tagName.toLowerCase() === 'th');
        var para = cell ? await wordParagraph(cell, ctx, { runStyle: head ? { bold: true, color: '27313D' } : {}, spacing: { after: 0, line: 285 } })
                        : new ctx.D.Paragraph({ children: [new ctx.D.TextRun('')] });
        cells.push(new ctx.D.TableCell({
          children: [para], width: { size: 100 / cols, type: ctx.D.WidthType.PERCENTAGE },
          shading: head ? { type: ctx.D.ShadingType.CLEAR, color: 'auto', fill: 'EEF1F4' } : undefined,
          margins: { top: 90, bottom: 90, left: 110, right: 110 }, verticalAlign: ctx.D.VerticalAlign.CENTER,
          borders: { top: wordBorder(ctx), bottom: wordBorder(ctx), left: wordBorder(ctx), right: wordBorder(ctx) }
        }));
      }
      rows.push(new ctx.D.TableRow({ children: cells, tableHeader: i === 0 && sourceCells.some(function (x) { return x.tagName.toLowerCase() === 'th'; }), cantSplit: true }));
    }
    return [new ctx.D.Table({ rows: rows, width: { size: 100, type: ctx.D.WidthType.PERCENTAGE }, layout: ctx.D.TableLayoutType.AUTOFIT })];
  }
  async function wordQuote(el, ctx, depth) {
    var out = [], children = Array.prototype.slice.call(el.children);
    for (var i = 0; i < children.length; i++) {
      var ch = children[i], tag = ch.tagName.toLowerCase();
      if (tag === 'p') out.push(await wordParagraph(ch, ctx, {
        runStyle: { italics: true, color: '57606A' }, indent: { left: 360, right: 180 },
        border: { left: wordBorder(ctx, 'B7C0CA', 12) }, spacing: { before: 45, after: 90, line: 310 }
      }));
      else out = out.concat(await wordBlocks(ch, ctx, depth + 1));
    }
    if (!out.length) out.push(await wordParagraph(el, ctx, { runStyle: { italics: true, color: '57606A' }, indent: { left: 360 } }));
    return out;
  }
  async function wordCallout(el, ctx, depth) {
    var kind = (el.dataset.ctype || 'NOTE').toUpperCase();
    var map = { NOTE:['Note','2563A6','EAF3FF'], TIP:['Tip','13795B','EAF8F1'], IMPORTANT:['Important','6C4EC7','F2EEFF'], WARNING:['Warning','A15C00','FFF6DF'], CAUTION:['Caution','B42332','FFF0F1'] };
    var cfg = map[kind] || map.NOTE, body = [];
    body.push(new ctx.D.Paragraph({ children: [new ctx.D.TextRun({ text: cfg[0], bold: true, color: cfg[1], size: 21 })], spacing: { after: 80 }, keepNext: true }));
    var children = Array.prototype.slice.call(el.children).filter(function (n) { return !n.classList.contains('callout-head'); });
    for (var i = 0; i < children.length; i++) body = body.concat(await wordBlocks(children[i], ctx, depth + 1));
    var edge = wordBorder(ctx, cfg[1], 16), light = wordBorder(ctx, cfg[2], 4);
    var cell = new ctx.D.TableCell({
      children: body.length ? body : [new ctx.D.Paragraph({ children: [] })],
      shading: { type: ctx.D.ShadingType.CLEAR, color: 'auto', fill: cfg[2] },
      margins: { top: 150, bottom: 120, left: 180, right: 180 },
      borders: { top: light, right: light, bottom: light, left: edge }
    });
    return [new ctx.D.Table({ rows: [new ctx.D.TableRow({ children: [cell], cantSplit: true })], width: { size: 100, type: ctx.D.WidthType.PERCENTAGE } })];
  }
  function wordBlockSkip(el) {
    return !!(el.matches && el.matches('.blk-add-end,.chg-del,.chg-diff,.src-box,.doc-blank,.render-error,.cb-head,.mm-tools'));
  }
  async function wordChildBlocks(parent, ctx, depth) {
    var out = [], nodes = Array.prototype.slice.call(parent.childNodes);
    for (var i = 0; i < nodes.length; i++) out = out.concat(await wordBlocks(nodes[i], ctx, depth));
    return out;
  }
  async function wordBlocks(node, ctx, depth) {
    depth = depth || 0;
    if (node.nodeType === 3) {
      if (!node.nodeValue.trim()) return [];
      return [new ctx.D.Paragraph({ children: [new ctx.D.TextRun(node.nodeValue.trim())], spacing: { after: 120 } })];
    }
    if (node.nodeType !== 1 || wordBlockSkip(node)) return [];
    var el = node, tag = el.tagName.toLowerCase();
    if (el.classList.contains('blk')) return wordChildBlocks(el, ctx, depth);
    if (el.classList.contains('table-wrap')) { var table = el.querySelector(':scope > table') || el.querySelector('table'); return table ? wordTable(table, ctx) : []; }
    if (el.classList.contains('code-block')) return wordCodeBlock(el, ctx);
    if (el.classList.contains('diagram-block')) return wordDiagramBlock(el, ctx);
    if (el.classList.contains('math-block')) {
      var ann = el.querySelector('annotation[encoding="application/x-tex"]'), value = (ann && ann.textContent) || el.textContent || '';
      return [new ctx.D.Paragraph({ children: [new ctx.D.TextRun({ text: value.trim(), font: 'Cambria Math', italics: true, size: 22 })], alignment: ctx.D.AlignmentType.CENTER, spacing: { before: 100, after: 160 }, keepLines: true })];
    }
    if (/^h[1-6]$/.test(tag)) {
      var level = parseInt(tag.slice(1), 10), sizes = [0, 36, 32, 28, 25, 23, 22];
      return [await wordParagraph(el, ctx, {
        heading: ctx.D.HeadingLevel['HEADING_' + level], runStyle: { bold: true, size: sizes[level], color: level === 1 ? ctx.accent : '202833' },
        spacing: { before: level === 1 ? 180 : 220, after: level === 1 ? 160 : 100, line: 300 }, keepNext: true
      })];
    }
    if (tag === 'p') return [await wordParagraph(el, ctx)];
    if (tag === 'ul' || tag === 'ol') return wordList(el, ctx, depth);
    if (tag === 'table') return wordTable(el, ctx);
    if (tag === 'blockquote') return el.classList.contains('callout') ? wordCallout(el, ctx, depth) : wordQuote(el, ctx, depth);
    if (tag === 'hr') return [new ctx.D.Paragraph({ children: [], border: { bottom: wordBorder(ctx, 'C9CED6', 6) }, spacing: { before: 150, after: 160 } })];
    if (tag === 'pre' || el.classList.contains('raw-fallback')) return wordCodeParagraphs(el.textContent || '', '', ctx);
    if (tag === 'img') return [new ctx.D.Paragraph({ children: [await wordImageRun(el, ctx)], alignment: ctx.D.AlignmentType.CENTER, spacing: { before: 80, after: 160 }, keepLines: true })];
    if (el.classList.contains('footnotes')) {
      var foot = [new ctx.D.Paragraph({ children: [new ctx.D.TextRun({ text: 'Footnotes', bold: true, size: 24, color: '4B5563' })], spacing: { before: 320, after: 100 }, keepNext: true })];
      var footChildren = Array.prototype.slice.call(el.children).filter(function (n) { return n.tagName.toLowerCase() !== 'hr'; });
      for (var f = 0; f < footChildren.length; f++) foot = foot.concat(await wordBlocks(footChildren[f], ctx, depth));
      return foot;
    }
    if (tag === 'figure') {
      var fig = [], image = el.querySelector(':scope > img'); if (image) fig.push(new ctx.D.Paragraph({ children: [await wordImageRun(image, ctx)], alignment: ctx.D.AlignmentType.CENTER }));
      var cap = el.querySelector(':scope > figcaption'); if (cap) fig.push(await wordParagraph(cap, ctx, { runStyle: { italics: true, color: '6B7280', size: 19 }, alignment: ctx.D.AlignmentType.CENTER }));
      return fig;
    }
    if (tag === 'details') {
      var details = [], summary = el.querySelector(':scope > summary');
      if (summary) details.push(await wordParagraph(summary, ctx, { runStyle: { bold: true } }));
      var dc = Array.prototype.slice.call(el.children).filter(function (n) { return n !== summary; });
      for (var d = 0; d < dc.length; d++) details = details.concat(await wordBlocks(dc[d], ctx, depth));
      return details;
    }
    if (tag === 'dl') {
      var defs = [];
      for (var q = 0; q < el.children.length; q++) {
        var item = el.children[q], isTerm = item.tagName.toLowerCase() === 'dt';
        defs.push(await wordParagraph(item, ctx, { runStyle: isTerm ? { bold: true } : {}, indent: isTerm ? null : { left: 360 }, spacing: { after: isTerm ? 35 : 100 } }));
      }
      return defs;
    }
    if (tag === 'figcaption' || tag === 'summary' || tag === 'dt' || tag === 'dd') return [await wordParagraph(el, ctx)];
    var hasBlocks = Array.prototype.some.call(el.children, function (n) { return /^(address|article|aside|blockquote|details|div|dl|fieldset|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|ul)$/i.test(n.tagName); });
    if (hasBlocks || /^(article|aside|main|nav|section)$/i.test(tag)) return wordChildBlocks(el, ctx, depth);
    return (el.textContent || '').trim() || el.querySelector('img') ? [await wordParagraph(el, ctx)] : [];
  }
  function wordDocumentOptions(ctx, children) {
    var options = {
      creator: 'Docsmith · 文匠', title: currentName(), description: 'Exported from Markdown as an editable Word document',
      /* paragraph 里的 alignment 必须写死成左对齐。
         不写的话 docx 不产出 <w:jc>，Word 就去问收件人自己的「正文」样式 ——
         中文版 Word 的「正文」默认常常是「两端对齐」。段落被继承成两端对齐后，
         代码块里那种一整行没有空格的长公式就会被撑成满页宽（见 wordCodeParagraphs）。
         导出的版式该由我们说，不该由对方的模板说。 */
      styles: { default: { document: { run: { font: 'Aptos', size: 22, color: '202833' }, paragraph: { spacing: { line: 320, after: 120 }, alignment: ctx.D.AlignmentType.LEFT } } } },
      sections: [{
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
        children: children.length ? children : [new ctx.D.Paragraph({ children: [] })]
      }]
    };
    if (ctx.numbering.length) options.numbering = { config: ctx.numbering };
    return options;
  }
  async function exportWord() {
    if (wordExporting) return;
    if (!currentId) { toast('请先打开或新建一个 Markdown 文档', 'err'); return; }
    if (!window.docx || !window.docx.Packer) { toast('Word 导出组件没有加载成功，请检查网络后刷新页面', 'err'); return; }
    wordExporting = true; wordSetBusy(true, 'Preparing...');
    try {
      wordCommitEditing();
      await wordWaitForDiagrams(9000);
      var D = window.docx, ctx = {
        D: D, accent: wordAccent(), warnings: [], imageCache: {}, numbering: [], listCounter: 0,
        mediaTotal: preview.querySelectorAll('img,.diagram-block').length, mediaDone: 0
      };
      wordProgress(ctx, ctx.mediaTotal ? 'Images' : 'Building');
      var children = await wordChildBlocks(preview, ctx, 0);
      wordSetBusy(true, 'Packaging...');
      var documentFile = new D.Document(wordDocumentOptions(ctx, children));
      var blob = await D.Packer.toBlob(documentFile), name = wordFileName();
      download(name, blob, WORD_MIME);
      try { window.dispatchEvent(new CustomEvent('mdword:exported', { detail: { name: name, size: blob.size, warnings: ctx.warnings.length } })); } catch (e) {}
      toast('已导出 ' + name + (ctx.warnings.length ? ' · ' + ctx.warnings.length + ' 个图片/图表改用文字占位' : ''), ctx.warnings.length ? 'err' : 'ok');
    } catch (e) {
      console.error('[md-word] export failed:', e);
      toast('Word 导出失败：' + ((e && e.message) || '未知错误'), 'err');
    } finally {
      wordExporting = false; wordSetBusy(false);
    }
  }

  /* ---------- 分享 ------------------------------------------------------
     把当前内容传到用户自己的云存储，换回一条链接，同时往文件库写一条记录。
     扩展里所有页面同源，文件库和这里读的是同一份数据，传完立刻可见。
     具体连的是哪家云由 DSCloud 决定，这里不关心。
     -------------------------------------------------------------------- */
  /* 下面这几个函数原本自己拼 XHR 直传对象存储。现在它们只是把活儿交给
     DSCloud —— 换云服务、加新云服务都不用动这个文件。 */
  var OSS_UNCAT = '__uncat__';
  function cloud() {
    if (!window.DSCloud) throw new Error('云存储模块没能加载，刷新一下扩展试试。');
    return window.DSCloud;
  }
  function ossIncomplete() { return !cloud().ready(); }
  function ossProblem() { return cloud().problem(); }
  function ossFormatShare(name, url) { return cloud().formatShare(name, url); }
  function ossRecordHistory(rec) { return cloud().recordHistory(rec); }
  function ossHasUrl(url) { return cloud().hasUrl(url); }
  function ossAutoCopy() { return cloud().autoCopy(); }
  function ossUpload(blob, filename, onProgress) {
    return cloud().upload(blob, filename, onProgress);
  }

  function shareStatus(text) { var b = $('#shareBody'); if (b) b.innerHTML = '<div class="share-status"><span class="spinner"></span> ' + escapeHtml(text) + '</div>'; }
  function gotoFiles(fileId) { try { cloud().gotoFiles(fileId); } catch (e) {} }

  /* ---------- 去重：同一份内容只上传一次 ------------------------------
     指纹取「会影响产物的全部输入」：
       .html → 正文 + 主题 + 字族 + 字号 + 版心 + 自定义 CSS
       .md   → 正文本身（导出的就是它，别的都不影响字节）
     命中缓存就直接把上次的链接摆出来，一次网络请求都不发。
     -------------------------------------------------------------------- */
  var sharing = false;
  function shareKeyFor(kind, name) {
    var d = curDoc(), text = (d && d.text) || '';
    var payload = kind === 'md' ? text
      : [Appearance.resolved(), settings.font, settings.size, settings.width, store.get('customCss', ''), text].join('\u0000');
    return ShareCache.key(kind, name, payload);
  }
  function ossHasUrl(url) {
    var h = ossReadState().history;
    if (!Array.isArray(h)) return false;
    for (var i = 0; i < h.length; i++) if (h[i] && h[i].downUrl === url) return true;
    return false;
  }
  /* 复用链接。若文件库那边的记录被清掉了，就补一条指向同一个 URL 的记录 ——
     依旧不重传，OSS 上的对象还在。 */
  function ossReuse(key, hit) {
    var r = { url: hit.url, id: hit.id, name: hit.name, size: hit.size, autoCopy: ossAutoCopy() };
    if (!ossHasUrl(hit.url)) {
      // 文件库那边的记录被清掉了：补一条指向同一个链接的记录，不重新上传
      r.id = ossRecordHistory({ fileName: hit.name, size: hit.size, downUrl: hit.url });
      ShareCache.put(key, r);
    }
    return r;
  }

  /* Share：先让用户选分享哪种文件 —— 网页(.html) 或 Markdown 源文件(.md)，
     两者都取「当前内容」（含最新编辑）。选完再走各自的上传/去重流程。 */
  function openShareChooser() {
    if (!currentId) { toast('先打开一份文档', 'err'); return; }
    $('#shareModal').classList.add('open');
    if (ossIncomplete()) { shareNeedConfig(); return; }
    renderShareChooser();
  }
  function renderShareChooser() {
    if (sharing) return;
    var dirty = isDirty();
    $('#shareBody').innerHTML =
      '<div class="share-choose">' +
        '<button class="share-pick" id="pickHtml" type="button"><span class="sp-ico">🌐</span>' +
          '<span><span class="sp-t">网页（.html）</span><span class="sp-d">渲染后的完整网页，带主题样式、图表与公式，收到就能直接在浏览器打开。</span></span></button>' +
        '<button class="share-pick" id="pickMd" type="button"><span class="sp-ico">📄</span>' +
          '<span><span class="sp-t">Markdown 源文件（.md）</span><span class="sp-d">纯文本源码，方便对方继续编辑或二次加工。</span></span></button>' +
      '</div>' +
      '<p class="share-tip">分享的是<strong>当前内容</strong>' + (dirty ? '（含尚未保存到本地的最新编辑）' : '（含最新编辑）') + '，上传到文件库后生成可分享链接。</p>';
    var h = $('#pickHtml'); if (h) h.addEventListener('click', function () { shareHtml(false); });
    var m = $('#pickMd'); if (m) m.addEventListener('click', function () { shareMdSource(false); });
  }
  function shareHtml(force) {
    if (!currentId) { toast('先打开一份文档', 'err'); return; }
    $('#shareModal').classList.add('open');
    if (ossIncomplete()) { shareNeedConfig(); return; }
    var name = currentName() + '.html';
    var key = shareKeyFor('html', name);
    var hit = force ? null : ShareCache.get(key);
    if (hit) {
      var r0 = ossReuse(key, hit);
      shareOk(r0, 'html', true);
      if (r0.autoCopy) copyPlain(ossFormatShare(r0.name, r0.url));
      return;
    }
    if (sharing) return;
    sharing = true;
    /* 打包成品现在是异步的（要先把样式表读回来），所以整条上传链挪进 .then。
       注意 sharing = false 这个收尾必须在失败路径上也跑到 —— 不然打包一失败
       就永远卡在「正在分享」，再点没反应。 */
    shareStatus('正在打包网页…');
    buildStandalone().then(function (html) {
      var blob = new Blob([html], { type: 'text/html' });
      shareStatus('正在上传网页到文件库…');
      return ossUpload(blob, name, function (pct) { shareStatus('上传中 ' + pct + '%'); })
        .then(function (r) { ShareCache.put(key, r); shareOk(r, 'html'); if (r.autoCopy) copyPlain(ossFormatShare(r.name, r.url)); });
    }).then(null, function (e) { shareErr(e); })
      .then(function () { sharing = false; });
  }
  function shareMdSource(force) {
    if (!currentId) { toast('先打开一份文档', 'err'); return; }
    $('#shareModal').classList.add('open');
    if (ossIncomplete()) { shareNeedConfig(); return; }
    var d = curDoc(); if (!d || d.text == null) { toast('没有可分享的源文件', 'err'); return; }
    var name = currentName() + '.md';
    var key = shareKeyFor('md', name);
    var hit = force ? null : ShareCache.get(key);
    if (hit) { shareOk(ossReuse(key, hit), 'md', true); return; }
    if (sharing) return;
    sharing = true;
    var blob = new Blob([d.text], { type: 'text/markdown' });
    shareStatus('正在上传 Markdown 源文件…');
    ossUpload(blob, name, function (pct) { shareStatus('上传中 ' + pct + '%'); })
      .then(function (r) { ShareCache.put(key, r); shareOk(r, 'md'); }, function (e) { shareErr(e); })
      .then(function () { sharing = false; });
  }
  function shareNeedConfig() {
    var why = ossProblem() || '还没有连接云存储。';
    $('#shareBody').innerHTML =
      '<div class="share-err">还没法生成分享链接</div>' +
      '<p class="share-hint">' + escapeHtml(why) + '<br>' +
      '分享要先把文件传到你自己的云盘上。连一次，以后都不用再管。</p>' +
      '<button class="btn primary" id="shareSetup" type="button" style="margin-top:12px">去连接云存储</button>' +
      '<p class="share-hint" style="margin-top:14px">不想连也没关系 —— ' +
      '「导出」里的 Word、PDF、网页文件都能直接存到本地。</p>';
    var s = $('#shareSetup');
    if (s) s.addEventListener('click', function () { cloud().openSettings(); });
  }
  function shareOk(r, kind, reused) {
    try { window.dispatchEvent(new CustomEvent('docsmith:share', { detail: { kind: kind } })); } catch (e) {}
    var body = $('#shareBody');
    body.innerHTML =
      (reused ? '<div class="share-ok reused">♻️ 内容没有变化 · 沿用上次的链接</div>' +
                '<p class="share-hint" style="margin:-6px 0 12px">没有重复上传，文件库里也不会多出一条记录。</p>'
              : '<div class="share-ok">✅ 已存入文件库 · 链接可直接分享</div>') +
      '<div class="share-url-row"><input id="shareUrl" readonly value="' + escapeHtml(r.url) + '"><button class="btn primary" id="shareCopy" type="button">复制分享</button></div>' +
      '<a class="share-open" href="' + escapeHtml(r.url) + '" target="_blank" rel="noopener">打开链接 ↗</a>' +
      '<div class="share-actions">' +
        (kind === 'html' ? '<button class="btn" id="shareMdBtn" type="button">同时分享 .md 源文件</button>' : '') +
        (kind === 'md' ? '<button class="btn" id="shareHtmlBtn" type="button">同时分享 .html 网页</button>' : '') +
        (reused ? '<button class="btn" id="shareRegen" type="button">重新上传，生成新链接</button>' : '') +
        '<button class="btn" id="shareGoFiles" type="button">在文件库中查看 →</button>' +
      '</div>' +
      '<button class="share-back" id="shareBack" type="button">← 换一种格式分享</button>';
    $('#shareCopy').addEventListener('click', function () {
      copyPlain(ossFormatShare(r.name, r.url));
      this.textContent = '已复制'; var b = this; setTimeout(function () { b.textContent = '复制分享'; }, 1400);
    });
    var md = $('#shareMdBtn'); if (md) md.addEventListener('click', function () { shareMdSource(false); });
    var htmlBtn = $('#shareHtmlBtn'); if (htmlBtn) htmlBtn.addEventListener('click', function () { shareHtml(false); });
    var rg = $('#shareRegen'); if (rg) rg.addEventListener('click', function () { kind === 'md' ? shareMdSource(true) : shareHtml(true); });
    var go = $('#shareGoFiles'); if (go) go.addEventListener('click', function () { gotoFiles(r.id); });
    var back = $('#shareBack'); if (back) back.addEventListener('click', function () { renderShareChooser(); });
  }
  function shareErr(e) {
    if (e && (e.needsSetup || e.message === 'NO_CONFIG')) { shareNeedConfig(); return; }
    var msg = (e && e.message) || '上传没有完成';
    $('#shareBody').innerHTML =
      '<div class="share-err">上传失败</div>' +
      '<p class="share-hint">' + escapeHtml(msg) + '</p>' +
      '<div class="share-actions" style="margin-top:12px">' +
        '<button class="btn" id="shareRetry" type="button">再试一次</button>' +
        '<button class="btn" id="shareSetup" type="button">检查云存储设置</button>' +
      '</div>';
    var r = $('#shareRetry'); if (r) r.addEventListener('click', function () { renderShareChooser(); });
    var s = $('#shareSetup'); if (s) s.addEventListener('click', function () { cloud().openSettings(); });
  }
  function copyPlain(str) {
    var fallback = function () {
      try { var t = document.createElement('textarea'); t.value = str; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); var ok = document.execCommand('copy'); document.body.removeChild(t); return !!ok; } catch (e) { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(function () {}, function () { if (!fallback()) toast('复制被浏览器拦截，请手动选中复制', 'err'); });
      return;
    }
    if (!fallback()) toast('复制被浏览器拦截，请手动选中复制', 'err');
  }

  /* ---------- theme / settings + shell sync -------------------------- */
  /* theme 交给 Appearance（docsmith:appearance）；这里只留阅读器自己的偏好 */
  /* 正文默认黑体。以前默认是 serif，但衬线那一支的中文实际掉到了浏览器默认
     宋体（Newsreader/Georgia 都没有汉字，插件也没打包字体），屏幕上笔画细、
     发灰、看久了累 —— 用户反馈的「字体看着眼睛难受」就是它。
     现在两支的中文都显式指定了（见 doc.css 的 --doc-cjk-*），
     默认给更适合屏幕的黑体，想要衬线的在设置里切一下即可。 */
  function readNumberSetting(key, fallback, min, max) {
    var n = parseInt(store.get(key, String(fallback)), 10);
    if (!isFinite(n)) n = fallback;
    return Math.max(min, Math.min(max, n));
  }
  function readReadingSettings() {
    return {
      font: store.get('font', 'sans'),
      size: readNumberSetting('size', 18, 14, 26),
      width: readNumberSetting('width', 860, 560, 1200),
      refresh: readNumberSetting('refresh', 0, 0, 60000)
    };
  }
  var settings = readReadingSettings();
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var ACCENTS = { amber:'#f59e0b', blue:'#3b82f6', green:'#22c55e', violet:'#8b5cf6', pink:'#ec4899', cyan:'#06b6d4' };
  function resolvedTheme() { return Appearance.resolved(); }
  var shellAppear = null;                       // 外壳接管时的外观（内存优先，不靠 localStorage）
  function appearNow() { if (shellAppear) return shellAppear; var a = Appearance.read(); return { theme: a.theme, accent: a.accent }; }
  function applyTheme() { var _a = appearNow(), mode = Appearance.resolve(_a.theme); var _r = document.documentElement; _r.dataset.theme = mode; _r.dataset.accent = _a.accent; var l = $('#hljs-light'), d = $('#hljs-dark'); if (l) l.disabled = mode !== 'light'; if (d) d.disabled = mode !== 'dark'; if (window.mermaid) mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', htmlLabels: false, fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', flowchart: { htmlLabels: false, useMaxWidth: false }, theme: mode === 'dark' ? 'dark' : 'default' }); var doc = curDoc(); if (doc && doc.text != null) renderMarkdown(doc.text); }
  /* 三档正文字体（黑体 / 圆体 / 衬线）都要在这里落到对应的 class 上。
     新增一档就得在**三处**同时加：settings.js 的 options、doc.css 的
     .doc.font-*、以及这里 —— 少一处就是个「选了没反应」的假选项。
     FONT_CLASSES 集中列一次，省得再漏。 */
  var FONT_CLASSES = ['sans', 'round', 'serif'];
  function applyFontClass(el, font) {
    if (!el) return;
    FONT_CLASSES.forEach(function (f) { el.classList.toggle('font-' + f, font === f); });
  }
  function applyReading() { preview.style.fontSize = settings.size + 'px'; preview.style.setProperty('--doc-measure', settings.width + 'px'); applyFontClass(preview, settings.font); var seg = function (n, v) { $$('.seg-opt[data-set="' + n + '"]').forEach(function (b) { b.classList.toggle('on', b.dataset.val === String(v)); }); }; seg('theme', appearNow().theme); seg('font', settings.font); seg('refresh', settings.refresh); var sz = $('#sizeRange'), wd = $('#widthRange'); if (sz) { sz.value = settings.size; $('#sizeVal').textContent = settings.size + 'px'; } if (wd) { wd.value = settings.width; $('#widthVal').textContent = settings.width + 'px'; } }
  function saveSettings() {
    store.set('font', settings.font); store.set('size', settings.size);
    store.set('width', settings.width); store.set('refresh', settings.refresh);
    // 阅读偏好交给 core/prefs.js 统一保管，换台电脑导入配置就能带过去
    try { window.dispatchEvent(new CustomEvent('docsmith:reading-changed', { detail: settings })); } catch (e) {}
  }
  function applyCustomCss(css) { var el = $('#customCss'); if (el) el.textContent = css || ''; store.set('customCss', css || ''); }
  function applyAccent(hex) { if (!hex) return; document.documentElement.style.setProperty('--accent', hex); document.documentElement.style.setProperty('--doc-accent', hex); }
  /* 独立打开还是嵌在外壳里，都用同一份外观 */
  var appearSig = '';
  function applyShellAppearance() {
    var a = appearNow(), sig = a.theme + '|' + a.accent + '|' + Appearance.resolve(a.theme);
    applyAccent(ACCENTS[a.accent] || ACCENTS.amber);
    applyReading();                                  // 便宜：只刷新面板上的选中态
    if (sig === appearSig) return;                   // 外观没真的变 → 不重排 mermaid、不重渲染整篇
    appearSig = sig;
    applyTheme();
  }
  /* 改外观的唯一入口：本地改的要上报外壳，外壳下发的不再回声，两边都用「值相同就不动」断环 */
  function setAppearance(patch, from) {
    var cur = appearNow();
    var next = { theme: patch && patch.theme || cur.theme, accent: patch && patch.accent || cur.accent };
    if (next.theme === cur.theme && next.accent === cur.accent) return;
    try { Appearance.write(next); } catch (e) {}     // 存得住就存，独立打开时下次还记得
    var got = Appearance.read();                     // 真的存进去了吗？（iframe 里可能被分区或拦掉）
    shellAppear = (got.theme === next.theme && got.accent === next.accent) ? null : next;
    applyShellAppearance();
    if (from !== 'shell') tellShell(next);
  }
  function tellShell(a) {
    if (!IN_SHELL) return;
    try { window.parent.postMessage({ ns: BUS_NS, type: 'appearance', theme: a.theme, accent: a.accent }, '*'); } catch (e) {}
  }
  Appearance.onChange(function () { shellAppear = null; applyShellAppearance(); });

  /* ======================================================================
     EDITING  ==  READING
     ----------------------------------------------------------------------
     There is one surface: the rendered document. Turning Edit on does not
     open a second pane — it makes the blocks you are already reading
     clickable. Click a paragraph and that paragraph (only) becomes a small
     Markdown box in place; click a table cell and you edit the cell, with
     row/column controls floating above the table. Every change is a splice
     into the Markdown source, which stays the single source of truth, so
     Save / Export / Share keep working exactly as before.
     The full-source view (</>) is a deliberate full-width alternative, never
     a column beside the preview, and it lands you on the same section you
     were reading — so the "left pane says 4.3, right pane says 6.1" problem
     cannot exist.
     ====================================================================== */

  var hist = [], histIdx = -1;                 // document-level undo stack
  var hoverBlk = null, cellEdit = null;

  function docText() { var d = curDoc(); return d && d.text != null ? d.text : ''; }
  function syncEditor() { if (ROOT.dataset.mode === 'source') { var d = curDoc(); editor.value = d && d.text != null ? d.text : ''; sourceEntryText = editor.value; refreshFind(false); } }
  function makeScratch() { var d = { id: uid(), name: 'untitled.md', relPath: 'untitled.md', dir: '', text: '', source: 'scratch', handle: null, savedText: '', dirty: false }; docs.push(d); currentId = d.id; ROOT.classList.remove('empty'); updateWorkspaceTitle(); renderFileList(); histReset(''); return d; }

  function histReset(t) { hist = [t == null ? '' : t]; histIdx = 0; updateHistBtns(); }
  function histPush(t) { hist = hist.slice(0, histIdx + 1); hist.push(t); if (hist.length > 200) hist.shift(); histIdx = hist.length - 1; updateHistBtns(); }
  function updateHistBtns() {
    var u = $('#undoBtn'), r = $('#redoBtn');
    if (u) u.disabled = histIdx <= 0;
    if (r) r.disabled = histIdx >= hist.length - 1;
    if (u) u.style.opacity = u.disabled ? '.4' : '';
    if (r) r.style.opacity = r.disabled ? '.4' : '';
  }
  function undo() { if (histIdx <= 0) { toast('没有可撤销的操作'); return; } histIdx--; applyText(hist[histIdx]); updateHistBtns(); toast('已撤销'); }
  function redo() { if (histIdx >= hist.length - 1) { toast('没有可重做的操作'); return; } histIdx++; applyText(hist[histIdx]); updateHistBtns(); toast('已重做'); }

  function noSmooth(fn) { var p = previewPane.style.scrollBehavior; previewPane.style.scrollBehavior = 'auto'; fn(); previewPane.style.scrollBehavior = p; }
  function applyText(next, patchIdx) {
    var d = curDoc() || makeScratch();
    d.text = next;
    d.dirty = (next !== (d.savedText || ''));
    currentUrl = ''; clearInterval(refreshTimer);              // 手动编辑后不再被 URL 自动刷新覆盖
    var done = (patchIdx != null) && patchBlock(next, patchIdx);
    if (!done) {
      var y = previewPane.scrollTop;
      hideTools(); renderMarkdown(next);
      noSmooth(function () { previewPane.scrollTop = y; });
    }
    if (ROOT.dataset.mode === 'source' && editor.value !== next) editor.value = next;
    updateSaveState();
    refreshFind(false);
    // 告诉审阅器和记忆模块：正文变了
    try { window.dispatchEvent(new CustomEvent('docsmith:text-changed')); } catch (e) {}
  }
  /* Typing in one cell shouldn't cost a whole-document re-render (and shouldn't
     make every diagram in the file redraw). When a change provably touches a
     single non-heading block, only that block is re-rendered. */
  function patchBlock(next, i) {
    var old = docBlocks[i]; if (!old) return false;
    var nb;
    try { nb = lexBlocks(next); } catch (e) { return false; }
    if (nb.length !== docBlocks.length) return false;
    for (var k = 0; k < nb.length; k++) if (k !== i && nb[k].raw !== docBlocks[k].raw) return false;
    var t = nb[i];
    if (t.type === 'heading' || old.type === 'heading') return false;       // ids / outline would shift
    if (/\[\^|!\[|<img|```\s*(?:mermaid|infographic)\b/i.test(t.raw)
      || /\[\^|!\[|<img|```\s*(?:mermaid|infographic)\b/i.test(old.raw)) return false;
    var el = blkEl(i); if (!el) return false;
    var html;
    try {
      var fn = processFootnotes(next);
      html = renderBlockHtml(t, collectLinkDefs(next), fn.order, fn.defs);
    } catch (e) { return false; }
    if (!html.trim()) return false;
    if (window.DOMPurify) {
      try {
        var c = DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'], ADD_ATTR: ['target', 'loading', 'open'], USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true } });
        if (c && c.trim()) html = c;
      } catch (e) {}
    }
    docBlocks = nb;
    el.innerHTML = html;
    el.classList.remove('editing');
    el.dataset.btype = t.type;
    bindLinks(el);
    safe('tables', wrapTables); safe('callouts', transformCallouts); safe('tasks', setupTasks);
    safe('status', function () { updateStatus(next); });
    safe('changes', paintChanges);
    safe('find', function () { refreshFind(false); });
    return true;
  }
  function commitText(next, patchIdx) { if (next === docText()) return false; histPush(next); applyText(next, patchIdx); return true; }

  /* ---------- block level operations (all are source splices) --------- */
  function replaceBlock(i, md) {
    var b = docBlocks[i]; if (!b) return;
    var src = docText();
    var trail = (/\s*$/.exec(src.slice(b.start, b.end)) || [''])[0];
    var text = String(md == null ? '' : md).replace(/\s+$/, '');
    var next;
    if (!text.trim()) { commitText(src.slice(0, b.start) + src.slice(b.end)); return; }
    next = src.slice(0, b.start) + text + (trail || (b.end >= src.length ? '\n' : '\n\n')) + src.slice(b.end);
    commitText(next, i);
  }
  function insertAt(pos, md, then) {
    var src = docText();
    var text = String(md).replace(/\s+$/, '');
    var before = src.slice(0, pos), after = src.slice(pos);
    var lead = !before ? '' : (/\n\n$/.test(before) ? '' : (/\n$/.test(before) ? '\n' : '\n\n'));
    var body = text + '\n\n';
    var next = before + lead + body + after;
    var at = before.length + lead.length;
    if (!commitText(next)) return;
    var idx = -1;
    for (var i = 0; i < docBlocks.length; i++) { if (docBlocks[i].start >= at) { idx = i; break; } }
    if (then) then(idx);
  }
  function insertBlock(i, where, md, then) {
    var pos;
    if (!docBlocks.length || i == null || i < 0) pos = docText().length;
    else pos = where === 'before' ? docBlocks[i].start : docBlocks[i].end;
    insertAt(pos, md, then);
  }
  function moveBlock(i, dir) {
    var j = i + dir; if (j < 0 || j >= docBlocks.length) return;
    var a = docBlocks[Math.min(i, j)], b = docBlocks[Math.max(i, j)];
    var src = docText();
    if (src.slice(a.end, b.start).trim()) { toast('这两块之间还有别的内容，暂时不能交换', 'err'); return; }
    var aT = src.slice(a.start, a.end).replace(/\s+$/, ''), bT = src.slice(b.start, b.end).replace(/\s+$/, '');
    var tail = (/\s*$/.exec(src.slice(b.start, b.end)) || [''])[0] || (b.end >= src.length ? '\n' : '\n\n');
    var next = src.slice(0, a.start) + bT + '\n\n' + aT + tail + src.slice(b.end);
    commitText(next);
    var target = blkEl(j); if (target) flashBlock(target);
  }
  function duplicateBlock(i) { var b = docBlocks[i]; if (!b) return; insertBlock(i, 'after', blockSource(b), function (n) { var el = blkEl(n); if (el) flashBlock(el); }); }
  function deleteBlock(i) { var b = docBlocks[i]; if (!b) return; replaceBlock(i, ''); toast('已删除该块 · ⌘/Ctrl+Z 可撤销'); }
  function flashBlock(el) { el.classList.add('hot'); setTimeout(function () { el.classList.remove('hot'); }, 700); }

  /* ---------- 所见即所得的就地编辑 --------------------------------------
     普通用户不该看见星号。点一下段落，字还是那些字，直接改；点别处就生效。
     只有代码块 / 公式 / 图这类"没法所见即所得"的块，才退回源码框。
     写回时把 DOM 直译成 Markdown —— 源码始终是唯一真相。 */
  var rich = null;                 // {i, el, type, orig, pending}
  var RICH_TYPES = { paragraph: 1, heading: 1, list: 1, blockquote: 1 };
  var NO_RICH = '.katex, .math-block, .diagram-block, pre, img, .toc-inline, .fn-ref, table, .raw-fallback';

  function richOK(el, type) { return !!RICH_TYPES[type] && !el.querySelector(NO_RICH); }

  /* --- DOM → Markdown ------------------------------------------------- */
  function escMd(s) { return s.replace(/([\\`*\[\]])/g, '\\$1'); }
  function escLead(s) { return s.replace(/^(\s*)(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|---+\s*$|```)/, '$1\\$2'); }
  function wrapNE(s, m) {
    if (!s || !s.trim()) return s;
    var a = /^\s*/.exec(s)[0], b = /\s*$/.exec(s)[0];
    return a + m + s.slice(a.length, s.length - b.length) + m + b;
  }
  function mdInline(node) {
    var out = '';
    Array.prototype.forEach.call(node.childNodes, function (n) {
      if (n.nodeType === 3) { out += escMd(n.nodeValue.replace(/\u00a0/g, ' ')); return; }
      if (n.nodeType !== 1) return;
      if (n.classList && (n.classList.contains('h-anchor') || n.classList.contains('callout-head'))) return;
      var keep = n.getAttribute('data-md');
      if (keep != null) { out += keep; return; }
      var tag = n.tagName.toLowerCase();
      if (tag === 'br') { out += '  \n'; return; }
      if (tag === 'strong' || tag === 'b') { out += wrapNE(mdInline(n), '**'); return; }
      if (tag === 'em' || tag === 'i') { out += wrapNE(mdInline(n), '*'); return; }
      if (tag === 'del' || tag === 's' || tag === 'strike') { out += wrapNE(mdInline(n), '~~'); return; }
      if (tag === 'mark') { out += wrapNE(mdInline(n), '=='); return; }
      if (tag === 'code') { var t = n.textContent, f = /`/.test(t) ? '``' : '`'; out += f + t + f; return; }
      if (tag === 'a') {
        var txt = mdInline(n), href = n.getAttribute('data-href') || n.getAttribute('href') || '';
        out += txt ? '[' + txt + '](' + href + ')' : ''; return;
      }
      if (tag === 'img') { out += '![' + (n.getAttribute('alt') || '') + '](' + (n.dataset.osrc || n.getAttribute('src') || '') + ')'; return; }
      if (tag === 'input') return;                       // 任务勾选框在块序列化里单独处理
      if (tag === 'p' || tag === 'div') { var b = mdInline(n); if (b.trim()) out += (out.replace(/\s+$/, '') ? '\n\n' : '') + b; return; }
      out += mdInline(n);
    });
    return out;
  }
  function listToMd(list, indent) {
    var ol = list.tagName === 'OL', start = parseInt(list.getAttribute('start') || '1', 10) || 1;
    var out = [], n = 0;
    Array.prototype.forEach.call(list.children, function (li) {
      if (li.tagName !== 'LI') return;
      var marker = ol ? (start + n) + '. ' : '- ';
      var cb = li.querySelector('input[type=checkbox]');
      var task = cb ? ('[' + (cb.checked ? 'x' : ' ') + '] ') : '';
      var clone = li.cloneNode(true);
      Array.prototype.slice.call(clone.children).forEach(function (c) { if (c.tagName === 'UL' || c.tagName === 'OL') c.remove(); });
      Array.prototype.slice.call(clone.querySelectorAll('input[type=checkbox]')).forEach(function (c) { c.remove(); });
      var pad = rep(' ', marker.length);
      var body = mdInline(clone).trim().replace(/\n/g, '\n' + indent + pad);
      out.push(indent + marker + task + body);
      Array.prototype.forEach.call(li.children, function (sub) {
        if (sub.tagName === 'UL' || sub.tagName === 'OL') out.push(listToMd(sub, indent + pad));
      });
      n++;
    });
    return out.join('\n');
  }
  function quoteToMd(bq) {
    var body = [];
    if (bq.classList.contains('callout') && bq.dataset.ctype) body.push('[!' + bq.dataset.ctype + ']');
    Array.prototype.forEach.call(bq.children, function (ch) {
      if (ch.classList && ch.classList.contains('callout-head')) return;
      var md = nodeToMd(ch);
      if (md.trim()) body.push(md);
    });
    return body.join('\n\n').split('\n').map(function (l) { return ('> ' + l).replace(/\s+$/, ''); }).join('\n');
  }
  function nodeToMd(n) {
    var tag = n.tagName || '';
    if (/^H[1-6]$/.test(tag)) return rep('#', +tag.charAt(1)) + ' ' + mdInline(n).trim();
    if (tag === 'UL' || tag === 'OL') return listToMd(n, '');
    if (tag === 'BLOCKQUOTE' || (n.classList && n.classList.contains('callout'))) return quoteToMd(n);
    if (tag === 'HR') return '---';
    return escLead(mdInline(n).trim());
  }
  function blockToMd(el, type) {
    var out = [];
    Array.prototype.forEach.call(el.children, function (n) { var md = nodeToMd(n); if (md.trim()) out.push(md); });
    if (!out.length) { var t = escLead(mdInline(el).trim()); if (t.trim()) out.push(t); }
    return out.join('\n\n');
  }

  /* --- 打开 / 关闭 ---------------------------------------------------- */
  function openBlockEditor(i, caret) {                    // 外部入口：能所见即所得就所见即所得
    if (ROOT.dataset.edit !== 'on') return;
    var b = docBlocks[i], el = blkEl(i);
    if (!b || !el) return;
    if (richOK(el, b.type)) openRich(i, caret); else openSrcBox(i, caret);
  }
  function openRich(i, caret) {
    if (rich && rich.el === blkEl(i)) return;
    closeBlockEditor(true); endCellEdit(true);
    var b = docBlocks[i], el = blkEl(i);
    if (!b || !el) return;
    hideHandles();
    el.setAttribute('contenteditable', 'true');
    el.classList.add('rich');
    rich = { i: i, el: el, type: b.type, orig: blockSource(b), pending: false, html0: el.innerHTML };
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}
    placeCaret(el, caret || 'end');
    hoverBlk = el; showBlkHandle(el);
  }
  function openNewAfter(i, frag) {                        // 回车产生的新段落：先只存在于页面上，写了字才落进源码
    var d = document.createElement('div');
    d.className = 'blk blk-new'; d.dataset.btype = 'paragraph';
    var p = document.createElement('p');
    if (frag && frag.childNodes.length && (frag.textContent || '').trim()) p.appendChild(frag);
    else p.appendChild(document.createElement('br'));
    d.appendChild(p);
    var ref = blkEl(i);
    if (ref && ref.parentNode) ref.parentNode.insertBefore(d, ref.nextSibling);
    else preview.insertBefore(d, $('#blkAddEnd'));
    d.setAttribute('contenteditable', 'true'); d.classList.add('rich');
    rich = { i: i, el: d, type: 'paragraph', orig: '', pending: true };
    placeCaret(d, 'start');
    d.scrollIntoView({ block: 'nearest' });
  }
  function placeCaret(el, where) {
    el.focus();
    try {
      if (where && where.x != null) {                     // 点哪儿，光标就落哪儿
        var hit = null;
        if (document.caretRangeFromPoint) hit = document.caretRangeFromPoint(where.x, where.y);
        else if (document.caretPositionFromPoint) {
          var p = document.caretPositionFromPoint(where.x, where.y);
          if (p) { hit = document.createRange(); hit.setStart(p.offsetNode, p.offset); hit.collapse(true); }
        }
        if (hit && el.contains(hit.startContainer)) { var s0 = window.getSelection(); s0.removeAllRanges(); s0.addRange(hit); return; }
        where = 'end';
      }
      var r = document.createRange(); r.selectNodeContents(el); r.collapse(where !== 'end');
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    } catch (e) {}
  }
  function closeBlockEditor(commit) {                     // 外部入口：把正在编辑的块落盘
    if (srcBox) { closeSrcBox(commit); return; }
    closeRich(commit);
  }
  function closeRich(commit) {
    if (!rich || rich.busy) return;
    var r = rich; rich = null; hideSelTools(); hideBlkHandle();
    var el = r.el;
    el.removeAttribute('contenteditable'); el.classList.remove('rich');
    if (!r.pending && el.innerHTML === r.html0) return;   // 没动过：不重排、不进历史
    var md = null;
    try { md = blockToMd(el, r.type); } catch (e) { md = null; }
    if (r.pending) {
      el.remove();
      if (commit && md && md.trim()) insertBlock(r.i, 'after', md, function (n) { var t = blkEl(n); if (t) flashBlock(t); });
      return;
    }
    if (!commit || md == null) { patchBlock(docText(), r.i) || renderMarkdown(docText()); return; }
    if (md.trim() === r.orig.trim()) { if (!patchBlock(docText(), r.i)) renderMarkdown(docText()); return; }
    if (!md.trim()) { deleteBlock(r.i); return; }
    replaceBlock(r.i, md);
  }

  /* --- 键盘：回车 = 新段落，退格在块首 = 并回上一块 --------------------- */
  function inList() {
    var s = window.getSelection(); if (!s.rangeCount) return false;
    var n = s.getRangeAt(0).startContainer;
    n = n.nodeType === 1 ? n : n.parentElement;
    return !!(n && n.closest && n.closest('li'));
  }
  function atStart(el) {
    var s = window.getSelection(); if (!s.rangeCount) return false;
    var r = s.getRangeAt(0); if (!r.collapsed) return false;
    var t = document.createRange(); t.selectNodeContents(el); t.setEnd(r.startContainer, r.startOffset);
    return t.toString().replace(/\s/g, '') === '';
  }
  function cutTail(el) {
    var s = window.getSelection(); if (!s.rangeCount) return null;
    var r = s.getRangeAt(0);
    var t = document.createRange();
    t.setStart(r.endContainer, r.endOffset);
    t.setEnd(el, el.childNodes.length);
    var frag = t.extractContents();
    if (!(frag.textContent || '').trim()) return null;
    return flattenFrag(frag);
  }
  /* 剪出来的东西可能还裹着 <p>/<div>；新段落自己会有 <p>，不能再套一层 */
  function flattenFrag(frag) {
    var out = document.createDocumentFragment();
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 1 && (n.tagName === 'P' || n.tagName === 'DIV' || n.tagName === 'LI')) { walk(n); return; }
        if (n.nodeType === 3 && !n.nodeValue.trim() && !out.childNodes.length) return;
        out.appendChild(n);
      });
    })(frag);
    return out.childNodes.length ? out : null;
  }
  function enterNewBlock() {
    var r = rich; if (!r) return;
    var frag = null, headMd;
    try { frag = cutTail(r.el); } catch (e) {}
    try { headMd = blockToMd(r.el, r.type); } catch (e) { headMd = ''; }
    if (!headMd.trim()) {                                  // 光标在块首：把剪下来的放回去，什么也不做
      if (frag) r.el.appendChild(frag);
      placeCaret(r.el, 'start');
      return;
    }
    if (r.pending) {
      rich = null; r.el.remove();
      insertBlock(r.i, 'after', headMd, function (n) { openNewAfter(n < 0 ? r.i : n, frag); });
      return;
    }
    rich = null; hideSelTools();
    r.el.removeAttribute('contenteditable'); r.el.classList.remove('rich');
    if (headMd.trim() !== r.orig.trim()) replaceBlock(r.i, headMd);
    else patchBlock(docText(), r.i);
    openNewAfter(r.i, frag);
  }
  function backOut(e) {
    var r = rich; if (!r || !atStart(r.el)) return;
    if (inList()) return;                                  // 列表交给浏览器：退格 = 降级 / 合并
    e.preventDefault();
    if (r.pending) {
      var left = '';
      try { left = blockToMd(r.el, 'paragraph'); } catch (e) {}
      rich = null; r.el.remove();
      var prev = docBlocks[r.i];
      if (left.trim() && prev && prev.type === 'paragraph') replaceBlock(r.i, blockSource(prev) + ' ' + left.trim());
      openBlockEditor(r.i, 'end');
      return;
    }
    if (r.i > 0) { var md = blockToMd(r.el, r.type); rich = null; r.el.removeAttribute('contenteditable'); r.el.classList.remove('rich'); mergeBack(r.i, md); }
  }
  function mergeBack(i, md) {
    var prev = docBlocks[i - 1];
    if (!prev || prev.type !== 'paragraph' || docBlocks[i].type !== 'paragraph') { patchBlock(docText(), i); openBlockEditor(i - 1, 'end'); return; }
    var joined = blockSource(prev) + (md.trim() ? ' ' + md.trim() : '');
    var src = docText();
    var next = src.slice(0, prev.start) + joined + '\n\n' + src.slice(docBlocks[i].end);
    commitText(next);
    openBlockEditor(i - 1, 'end');
  }
  function richKeys(e) {
    if (!rich) return;
    var meta = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') { e.preventDefault(); cancelRich(); return; }
    if (meta && /^[sS]$/.test(e.key)) { e.preventDefault(); closeRich(true); saveDoc(); return; }
    if (meta && /^[bB]$/.test(e.key)) { e.preventDefault(); fmt('bold'); return; }
    if (meta && /^[iI]$/.test(e.key)) { e.preventDefault(); fmt('italic'); return; }
    if (meta && /^[kK]$/.test(e.key)) { e.preventDefault(); fmt('link'); return; }
    if (meta && /^[zZ]$/.test(e.key)) {
      /* 光标停在一个还没动过的块里按撤销 —— 用户要撤销的是上一步操作，不是这一块 */
      if (!rich.pending && rich.el.innerHTML === rich.html0) { e.preventDefault(); closeRich(true); if (e.shiftKey) redo(); else undo(); }
      return;                                              // 动过了：交给浏览器逐字撤销
    }
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); document.execCommand('insertLineBreak'); return; }
    if (e.key === 'Enter' && !meta) { if (inList()) return; e.preventDefault(); enterNewBlock(); return; }
    if (e.key === 'Backspace') { backOut(e); return; }
    if (e.key === '/' && isBlockEmpty(rich.el)) { setTimeout(function () { if (rich) slashMenu(rich.el); }, 0); return; }
  }
  function isBlockEmpty(el) { return !(el.textContent || '').trim(); }
  function cancelRich() {
    var r = rich; if (!r) return;
    rich = null; hideSelTools();
    r.el.removeAttribute('contenteditable'); r.el.classList.remove('rich');
    if (r.pending) { r.el.remove(); return; }
    patchBlock(docText(), r.i) || renderMarkdown(docText());
  }

  /* --- 选中文字就出现的格式条 ------------------------------------------ */
  var savedRange = null;
  function saveRange() { var s = window.getSelection(); if (s.rangeCount) savedRange = s.getRangeAt(0).cloneRange(); }
  function restoreRange() { if (!savedRange) return; var s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
  var SEL_BTNS = [
    { op: 'bold', ico: '<b>B</b>', t: '加粗  ⌘/Ctrl B' },
    { op: 'italic', ico: '<i>I</i>', t: '斜体  ⌘/Ctrl I' },
    { op: 'strike', ico: '<s>S</s>', t: '删除线' },
    { op: 'code', ico: '&lt;&gt;', t: '行内代码' },
    { op: 'link', ico: '🔗', t: '插入链接  ⌘/Ctrl K' },
    { op: 'clear', ico: '⌫', t: '清除格式' }
  ];
  function showSelTools() {
    var bar = $('#selTools'); if (!bar || !rich) return;
    var s = window.getSelection();
    if (!s.rangeCount || s.isCollapsed || !rich.el.contains(s.anchorNode)) { hideSelTools(); return; }
    if (!bar.dataset.built) { bar.innerHTML = SEL_BTNS.map(function (b) { return '<button type="button" data-op="' + b.op + '" title="' + b.t + '">' + b.ico + '</button>'; }).join(''); bar.dataset.built = '1'; }
    var r = s.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) { hideSelTools(); return; }
    var pr = previewPane.getBoundingClientRect();
    bar.classList.add('show'); bar.style.visibility = 'hidden';
    var left = r.left - pr.left + previewPane.scrollLeft + r.width / 2 - bar.offsetWidth / 2;
    bar.style.left = Math.max(4, Math.min(left, previewPane.clientWidth - bar.offsetWidth - 8)) + 'px';
    bar.style.top = Math.max(2, r.top - pr.top + previewPane.scrollTop - bar.offsetHeight - 8) + 'px';
    bar.style.visibility = '';
  }
  function hideSelTools() { var b = $('#selTools'); if (b) b.classList.remove('show'); var l = $('#linkBox'); if (l) l.classList.remove('show'); }
  function fmt(op) {
    if (!rich) return;
    if (op === 'link') { linkBox(); return; }
    if (op === 'code') { wrapCode(); return; }
    if (op === 'clear') { document.execCommand('removeFormat'); document.execCommand('unlink'); return; }
    if (op === 'strike') { document.execCommand('strikeThrough'); return; }
    document.execCommand(op);
    showSelTools();
  }
  function wrapCode() {
    var s = window.getSelection(); if (!s.rangeCount || s.isCollapsed) return;
    var r = s.getRangeAt(0);
    var host = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);
    var ex = host && host.closest ? host.closest('code') : null;
    if (ex && rich.el.contains(ex)) { var t = document.createTextNode(ex.textContent); ex.parentNode.replaceChild(t, ex); return; }
    var c = document.createElement('code');
    try { c.appendChild(r.extractContents()); r.insertNode(c); } catch (e) { return; }
    var nr = document.createRange(); nr.selectNodeContents(c);
    s.removeAllRanges(); s.addRange(nr);
    showSelTools();
  }
  function linkBox() {
    var box = $('#linkBox'), bar = $('#selTools'); if (!box || !rich) return;
    saveRange();
    var cur = '';
    var host = savedRange && (savedRange.startContainer.nodeType === 1 ? savedRange.startContainer : savedRange.startContainer.parentElement);
    var a = host && host.closest ? host.closest('a') : null;
    if (a) cur = a.getAttribute('href') || '';
    box.innerHTML = '<input type="text" placeholder="粘贴链接地址，例如 https://…" value="' + escapeHtml(cur) + '"><button type="button" data-lk="ok">确定</button><button type="button" data-lk="rm" title="去掉链接">移除</button>';
    box.classList.add('show');
    box.style.left = bar.style.left; box.style.top = bar.style.top;
    var inp = box.querySelector('input');
    inp.focus(); inp.select();
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); applyLink(inp.value); }
      if (e.key === 'Escape') { e.preventDefault(); hideSelTools(); rich && rich.el.focus(); }
    });
  }
  function applyLink(url) {
    var box = $('#linkBox');
    if (rich) rich.el.focus();
    restoreRange();
    url = (url || '').trim();
    if (!url) document.execCommand('unlink');
    else document.execCommand('createLink', false, /^[a-z]+:|^\//i.test(url) ? url : 'https://' + url);
    box.classList.remove('show'); hideSelTools();
  }

  /* --- 源码框：只给代码 / 公式 / 图这类块用 ---------------------------- */
  var srcBox = null;
  function openSrcBox(i, caret) {
    closeRich(true); endCellEdit(true);
    if (srcBox && srcBox.i === i) return;
    closeSrcBox(true);
    var b = docBlocks[i], el = blkEl(i); if (!b || !el) return;
    hideHandles();
    var orig = blockSource(b);
    var stash = el.querySelector('.diagram-block, img') ? null : el.innerHTML;
    var kind = srcLabel(b.type, orig);
    var live = /^```mermaid/.test(orig) || /^\$\$/.test(orig) || b.type === 'table';

    var wrap = document.createElement('div'); wrap.className = 'src-box' + (live ? ' has-live' : '');
    wrap.innerHTML = '<div class="src-head"><span class="src-what">' + kind + '</span>' +
      '<span class="src-tip">' + srcHint(b.type, orig) + '</span>' +
      '<span class="src-act"><button type="button" data-sb="ok">完成</button><button type="button" data-sb="no">取消</button></span></div>';

    var ta = document.createElement('textarea');
    ta.className = 'blk-editor'; ta.spellcheck = false; ta.value = orig;

    /* 边改边看。用户的原话是"我不懂源码，看不懂源码啊" —— 让他对着结果改，
       而不是对着一堆符号猜。图表 / 公式 / 表格都给一块实时预览。 */
    var pane = null, liveBox = null;
    if (live) {
      pane = document.createElement('div'); pane.className = 'src-panes';
      liveBox = document.createElement('div'); liveBox.className = 'src-live doc';
      liveBox.setAttribute('aria-live', 'polite');
      pane.appendChild(ta); pane.appendChild(liveBox);
      wrap.appendChild(pane);
    } else {
      wrap.appendChild(ta);
    }

    el.classList.add('editing'); el.innerHTML = ''; el.appendChild(wrap);
    srcBox = { i: i, ta: ta, orig: orig, el: el, stash: stash, live: liveBox };
    autosize(ta);
    if (liveBox) paintLive(liveBox, ta.value);
    var repaint = debounce(function () { if (srcBox && srcBox.live) paintLive(srcBox.live, ta.value); }, 260);
    ta.addEventListener('input', function () { autosize(ta); if (liveBox) repaint(); });
    ta.addEventListener('keydown', srcBoxKeys);
    wrap.addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
    wrap.addEventListener('click', function (e) {
      var b2 = e.target.closest('button[data-sb]'); if (!b2) return;
      closeSrcBox(b2.dataset.sb === 'ok');
    });
    ta.focus();
    var c = caret === 'start' ? 0 : orig.length;
    try { ta.setSelectionRange(c, c); } catch (e) {}
  }
  function diagramFence(raw) {
    var match = /^```\s*(mermaid|infographic)\b/i.exec(raw);
    return match ? match[1].toLowerCase() : '';
  }
  function srcLabel(type, raw) {
    var fence = diagramFence(raw);
    if (fence === 'mermaid') return '图表源码（Mermaid）';
    if (fence === 'infographic') return '信息图源码（Infographic）';
    if (type === 'code') return '代码块';
    if (/^\$\$/.test(raw)) return '数学公式';
    if (type === 'table') return '表格源码';
    if (/^!\[/.test(raw)) return '图片';
    return 'Markdown 源码';
  }
  /** 一句人话，告诉用户眼前这堆符号是干什么的。 */
  function srcHint(type, raw) {
    if (diagramFence(raw)) return '改左边的文字，右边立刻重画';
    if (type === 'code') return '代码原样保留，不会被格式化';
    if (/^\$\$/.test(raw)) return '改左边，右边是排版后的样子';
    if (type === 'table') return '一行一条记录，竖线分隔各列';
    if (/^!\[/.test(raw)) return '方括号里是图片说明，圆括号里是地址';
    return '这一段的原始写法';
  }

  /** 实时预览：走的还是正文那条渲染管线，所见即最终效果。 */
  function paintLive(box, text) {
    try {
      box.innerHTML = renderBlockHtml(lexBlocks(String(text || ''))[0] || { type: 'paragraph', raw: '' }, '', [], {});
      if (window.DocsmithDiagrams) renderDiagrams(box);
    } catch (e) {
      box.innerHTML = '<p class="src-live-err">这样写画不出来 —— ' + escapeHtml((e && e.message) || '再检查一下') + '</p>';
    }
  }

  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; }
  function srcBoxKeys(e) {
    var meta = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') { e.preventDefault(); closeSrcBox(false); return; }
    if (meta && e.key === 'Enter') { e.preventDefault(); closeSrcBox(true); return; }
    if (meta && /^[sS]$/.test(e.key)) { e.preventDefault(); closeSrcBox(true); saveDoc(); return; }
    if (e.key === 'Tab') { e.preventDefault(); var s = this.selectionStart, en = this.selectionEnd; this.value = this.value.slice(0, s) + '  ' + this.value.slice(en); this.selectionStart = this.selectionEnd = s + 2; autosize(this); }
  }
  function closeSrcBox(commit) {
    if (!srcBox || srcBox.busy) return;
    var sb = srcBox; srcBox = null; sb.busy = true;
    if (sb.live) destroyPanZoom(sb.live);        // 预览里的图也会挂监听器，一并收掉
    var v = sb.ta.value;
    if (commit && v.replace(/\s+$/, '') !== sb.orig) { replaceBlock(sb.i, v); return; }
    if (sb.stash != null && sb.el && sb.el.isConnected) { sb.el.innerHTML = sb.stash; sb.el.classList.remove('editing'); bindLinks(sb.el); return; }
    var y = previewPane.scrollTop; renderMarkdown(docText()); noSmooth(function () { previewPane.scrollTop = y; });
  }

  /* ---------- Markdown tables: real row / column editing --------------
     Everything below works on the table's Markdown, never on the DOM, so a
     rendered table and its source can never disagree. Cells are re-serialised
     with padded columns so the raw file stays readable (CJK width aware). */
  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
    var out = [], cur = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '\\' && i + 1 < s.length) { cur += c + s.charAt(i + 1); i++; continue; }
      if (c === '|') { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    out.push(cur.trim());
    return out;
  }
  function parseTable(raw) {
    var lines = String(raw).replace(/\s+$/, '').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) return null;
    var head = splitRow(lines[0]), delim = splitRow(lines[1]);
    if (!/^[\s|:-]+$/.test(lines[1])) return null;
    var align = delim.map(function (d) {
      d = d.trim();
      var l = d.charAt(0) === ':', r = d.charAt(d.length - 1) === ':';
      return (l && r) ? 'center' : (r ? 'right' : (l ? 'left' : ''));
    });
    var n = head.length;
    while (align.length < n) align.push('');
    var rows = lines.slice(2).map(function (l) { var c = splitRow(l); while (c.length < n) c.push(''); return c.slice(0, n); });
    return { head: head, align: align.slice(0, n), rows: rows };
  }
  var WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
  function cellW(s) { var n = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) n += WIDE_RE.test(s.charAt(i)) ? 2 : 1; return n; }
  function rep(ch, n) { return new Array(Math.max(0, n) + 1).join(ch); }
  function padCell(s, w) { s = String(s || ''); return s + rep(' ', w - cellW(s)); }
  function serializeTable(t) {
    var n = t.head.length, widths = [];
    for (var c = 0; c < n; c++) {
      var mx = Math.max(cellW(t.head[c]), 3);
      t.rows.forEach(function (r) { mx = Math.max(mx, cellW(r[c])); });
      widths.push(mx);
    }
    var line = function (cells) { return '| ' + cells.map(function (x, c) { return padCell(x, widths[c]); }).join(' | ') + ' |'; };
    var dl = '| ' + t.align.map(function (a, c) {
      var w = widths[c];
      if (a === 'center') return ':' + rep('-', Math.max(1, w - 2)) + ':';
      if (a === 'right') return rep('-', Math.max(1, w - 1)) + ':';
      if (a === 'left') return ':' + rep('-', Math.max(1, w - 1));
      return rep('-', w);
    }).join(' | ') + ' |';
    return [line(t.head), dl].concat(t.rows.map(line)).join('\n');
  }
  function blank(n) { var a = []; for (var i = 0; i < n; i++) a.push(''); return a; }
  function tableAt(i) { var b = docBlocks[i]; if (!b || b.type !== 'table') return null; return parseTable(b.raw); }
  function tblOp(i, op, r, c) {
    endCellEdit(true);                       // 先把正在输入的单元格写回源码，再动结构
    var t = tableAt(i);
    if (!t) { toast('这不是一个标准 Markdown 表格', 'err'); return; }
    var n = t.head.length, nr = r, nc = c;
    if (op === 'rowAbove') {
      if (r < 0) { toast('表头上面不能再插入行', 'err'); return; }
      t.rows.splice(r, 0, blank(n)); nr = r;
    } else if (op === 'rowBelow') {
      nr = (r < 0 ? 0 : r + 1); t.rows.splice(nr, 0, blank(n));
    } else if (op === 'rowDel') {
      if (r < 0) { toast('表头不能删除 —— 要整张表消失请用块工具的 ✕', 'err'); return; }
      t.rows.splice(r, 1); nr = Math.min(r, t.rows.length - 1);
    } else if (op === 'colLeft') {
      t.head.splice(c, 0, ''); t.align.splice(c, 0, ''); t.rows.forEach(function (x) { x.splice(c, 0, ''); }); nc = c;
    } else if (op === 'colRight') {
      t.head.splice(c + 1, 0, ''); t.align.splice(c + 1, 0, ''); t.rows.forEach(function (x) { x.splice(c + 1, 0, ''); }); nc = c + 1;
    } else if (op === 'colDel') {
      if (n <= 1) { toast('至少要保留一列', 'err'); return; }
      t.head.splice(c, 1); t.align.splice(c, 1); t.rows.forEach(function (x) { x.splice(c, 1); });
      nc = Math.min(c, t.head.length - 1);
    } else if (op === 'alignL' || op === 'alignC' || op === 'alignR') {
      t.align[c] = op === 'alignL' ? 'left' : op === 'alignC' ? 'center' : 'right';
    } else return;
    replaceBlock(i, serializeTable(t));
    focusCell(i, nr, nc);
  }

  /* ---------- 表格：单元格直接改，行/列各有一个把手 -------------------- */
  function cellPos(td) {
    var tr = td.parentElement, table = td.closest('table');
    if (!tr || !table) return null;
    var c = td.cellIndex;
    if (tr.parentElement && tr.parentElement.tagName === 'THEAD') return { r: -1, c: c };
    var body = table.tBodies[0]; if (!body) return null;
    return { r: Array.prototype.indexOf.call(body.rows, tr), c: c };
  }
  function escPipes(v) { return v.replace(/\\\|/g, '\u0000').replace(/\|/g, '\\|').replace(/\u0000/g, '\\|'); }
  function startCellEdit(td) {
    var el = td.closest('.blk'); if (!el) return;
    var i = +el.dataset.blk, b = docBlocks[i];
    if (!b || b.type !== 'table') { openBlockEditor(i); return; }
    var t = parseTable(b.raw), pos = cellPos(td);
    if (!t || !pos) { openSrcBox(i); return; }
    if (cellEdit && cellEdit.td === td) return;
    endCellEdit(true);
    closeBlockEditor(true);
    var raw = pos.r < 0 ? (t.head[pos.c] || '') : (((t.rows[pos.r] || [])[pos.c]) || '');
    cellEdit = { i: i, r: pos.r, c: pos.c, td: td, orig: raw };
    td.classList.add('cell-editing');
    td.textContent = raw;
    td.setAttribute('contenteditable', 'true');
    td.focus();
    try {
      var range = document.createRange(); range.selectNodeContents(td); range.collapse(false);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } catch (e) {}
    hideBlkHandle();
    showCellHandles(td);
  }
  function endCellEdit(commit) {
    if (!cellEdit) return;
    var ce = cellEdit; cellEdit = null;
    var td = ce.td;
    td.removeAttribute('contenteditable');
    td.classList.remove('cell-editing');
    var val = escPipes((td.textContent || '').replace(/\s*\n+\s*/g, '<br>').trim());
    if (commit && val !== ce.orig) {
      var t = tableAt(ce.i);
      if (t) {
        if (ce.r < 0) t.head[ce.c] = val; else if (t.rows[ce.r]) t.rows[ce.r][ce.c] = val;
        replaceBlock(ce.i, serializeTable(t));
        return;
      }
    }
    try { td.innerHTML = marked.parseInline(ce.orig); } catch (e) { td.textContent = ce.orig; }
  }
  function focusCell(i, r, c) {
    var el = blkEl(i); if (!el) return;
    var tb = el.querySelector('table'); if (!tb) return;
    var tr = r < 0 ? (tb.tHead && tb.tHead.rows[0]) : (tb.tBodies[0] && tb.tBodies[0].rows[r]);
    var td = tr && tr.cells[Math.max(0, c)];
    if (td) startCellEdit(td);
  }
  function cellStep(dir) {
    if (!cellEdit) return;
    var i = cellEdit.i, r = cellEdit.r, c = cellEdit.c;
    endCellEdit(true);
    var t = tableAt(i); if (!t) return;
    var n = t.head.length;
    c += dir;
    if (c >= n) { c = 0; r++; }
    if (c < 0) { c = n - 1; r--; }
    if (r < -1) { r = -1; c = 0; }
    if (r >= t.rows.length) { t.rows.push(blank(n)); replaceBlock(i, serializeTable(t)); }
    focusCell(i, r, c);
  }
  function cellDown() {
    if (!cellEdit) return;
    var i = cellEdit.i, r = cellEdit.r, c = cellEdit.c;
    endCellEdit(true);
    var t = tableAt(i); if (!t) return;
    r++;
    if (r >= t.rows.length) { t.rows.push(blank(t.head.length)); replaceBlock(i, serializeTable(t)); }
    focusCell(i, r, c);
  }

  /* ---------- 浮动的把手与菜单 ----------------------------------------
     一个原则：鼠标停到哪，那一块 / 那一行 / 那一列的入口就出现在旁边；
     入口只有一个小按钮，点开是中文的文字菜单，不用猜图标的意思。 */
  function hideBlkHandle() { var h = $('#blkHandle'); if (h) h.classList.remove('show'); }
  function hideCellHandles() { ['#rowH', '#colH'].forEach(function (s) { var h = $(s); if (h) h.classList.remove('show'); }); }
  function hideHandles() { hideBlkHandle(); hideCellHandles(); hideMenu(); }
  function hideTools() { hideHandles(); hideSelTools(); hoverBlk = null; }

  function showBlkHandle(el) {
    if (ROOT.dataset.edit !== 'on' || srcBox || cellEdit) return;
    if (el.classList.contains('blk-new')) return;
    var h = $('#blkHandle'); if (!h || !el.dataset.blk) return;
    h.dataset.i = el.dataset.blk;
    h.classList.add('show'); h.style.visibility = 'hidden';
    var fc = el.firstElementChild || el;
    var pr = previewPane.getBoundingClientRect(), r = el.getBoundingClientRect(), fr = fc.getBoundingClientRect();
    var lh = parseFloat(getComputedStyle(fc).lineHeight) || 24;
    var top = fr.top - pr.top + previewPane.scrollTop + Math.max(0, (Math.min(fr.height, lh) - h.offsetHeight) / 2);
    var left = r.left - pr.left + previewPane.scrollLeft - h.offsetWidth - 8;
    if (left < 2) { h.style.left = '2px'; h.style.top = Math.max(2, top - h.offsetHeight - 2) + 'px'; }
    else { h.style.left = left + 'px'; h.style.top = Math.max(2, top) + 'px'; }
    h.style.visibility = '';
  }
  function showCellHandles(td) {
    if (ROOT.dataset.edit !== 'on') return;
    var el = td.closest('.blk'); if (!el) return;
    var i = +el.dataset.blk, b = docBlocks[i];
    if (!b || b.type !== 'table') return;
    var pos = cellPos(td); if (!pos) return;
    var tb = td.closest('table'); if (!tb) return;
    var pr = previewPane.getBoundingClientRect(), rr = td.getBoundingClientRect(), tr = tb.getBoundingClientRect();
    var rowH = $('#rowH'), colH = $('#colH');
    if (pos.r >= 0) {
      rowH.dataset.i = i; rowH.dataset.r = pos.r; rowH.dataset.c = pos.c;
      rowH.classList.add('show');
      rowH.style.left = Math.max(2, tr.left - pr.left + previewPane.scrollLeft - 20) + 'px';
      rowH.style.top = (rr.top - pr.top + previewPane.scrollTop + (rr.height - 22) / 2) + 'px';
    } else rowH.classList.remove('show');
    colH.dataset.i = i; colH.dataset.r = pos.r; colH.dataset.c = pos.c;
    colH.classList.add('show');
    colH.style.left = (rr.left - pr.left + previewPane.scrollLeft + (rr.width - 22) / 2) + 'px';
    colH.style.top = Math.max(2, tr.top - pr.top + previewPane.scrollTop - 20) + 'px';
  }

  var menuItems = null, menuClose = null;
  function showMenu(items, anchor, onClose) {
    var m = $('#popMenu'); if (!m) return;
    menuItems = items; menuClose = onClose || null;
    m.innerHTML = items.map(function (x, n) {
      if (x.sep) return '<div class="pm-sep"></div>';
      if (x.head) return '<div class="pm-head">' + x.head + '</div>';
      return '<button type="button" data-mi="' + n + '"' + (x.danger ? ' class="danger"' : '') + (x.on ? ' data-on="1"' : '') + '>' +
        '<span class="pm-ico">' + (x.ico || '') + '</span><span class="pm-lab">' + x.k + '</span>' +
        (x.kbd ? '<span class="pm-kbd">' + x.kbd + '</span>' : '') + '</button>';
    }).join('');
    m.classList.add('show'); m.style.visibility = 'hidden';
    var pr = previewPane.getBoundingClientRect(), r = anchor.getBoundingClientRect();
    var left = r.left - pr.left + previewPane.scrollLeft;
    var top = r.bottom - pr.top + previewPane.scrollTop + 4;
    var maxTop = previewPane.scrollTop + previewPane.clientHeight - m.offsetHeight - 8;
    if (top > maxTop) top = Math.max(previewPane.scrollTop + 4, r.top - pr.top + previewPane.scrollTop - m.offsetHeight - 4);
    m.style.left = Math.max(4, Math.min(left, previewPane.clientWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(2, top) + 'px';
    m.style.visibility = '';
  }
  function hideMenu() {
    var m = $('#popMenu'); if (!m || !m.classList.contains('show')) return;
    m.classList.remove('show');
    var cb = menuClose; menuItems = null; menuClose = null;
    if (cb) cb(false);
  }

  /* --- 插入 ----------------------------------------------------------- */
  var INSERTS = [
    { k: '正文段落', ico: '¶', md: '在这里写点什么' },
    { k: '标题（大）', ico: 'H2', md: '## 标题' },
    { k: '标题（小）', ico: 'H3', md: '### 标题' },
    { sep: 1 },
    { k: '无序列表', ico: '•', md: '- 列表项\n- 列表项' },
    { k: '有序列表', ico: '1.', md: '1. 第一项\n2. 第二项' },
    { k: '待办清单', ico: '☑', md: '- [ ] 待办事项\n- [ ] 待办事项' },
    { sep: 1 },
    { k: '表格', ico: '▦', md: '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |', table: true },
    { k: '引用', ico: '❝', md: '> 引用内容' },
    { k: '提示框', ico: '💡', md: '> [!TIP]\n> 提示内容' },
    { k: '分割线', ico: '—', md: '---', noEdit: true },
    { sep: 1 },
    { k: '代码块', ico: '{ }', md: '```js\n\n```' },
    { k: '流程图', ico: '◇', md: '```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```' },
    { k: '数学公式', ico: '∑', md: '$$\nE = mc^2\n$$' },
    { k: '图片', ico: '🖼', md: '![描述](图片地址)' },
    { k: '目录', ico: '≡', md: '[[TOC]]', noEdit: true }
  ];
  function insertMenu(i, where, anchor, onClose) {
    showMenu(INSERTS.map(function (x) {
      if (x.sep) return { sep: 1 };
      return { k: x.k, ico: x.ico, act: function () { runInsert(x, i, where); } };
    }), anchor, onClose);
  }
  function afterInsert(x) {
    return function (idx) {
      if (idx < 0) return;
      var el = blkEl(idx); if (el) flashBlock(el);
      if (x.table) { focusCell(idx, -1, 0); return; }
      if (!x.noEdit) openBlockEditor(idx, 'end');
    };
  }
  function runInsert(x, i, where) {
    var m = $('#popMenu'); if (m) m.classList.remove('show');
    menuItems = null; menuClose = null;
    if (where === 'slash') {
      var r = rich;
      if (r && r.pending) { rich = null; r.el.remove(); insertBlock(r.i, 'after', x.md, afterInsert(x)); return; }
      if (r) { rich = null; r.el.removeAttribute('contenteditable'); r.el.classList.remove('rich'); replaceBlock(r.i, x.md); var el = blkEl(r.i); if (el) flashBlock(el); if (x.table) focusCell(r.i, -1, 0); else if (!x.noEdit) openBlockEditor(r.i, 'end'); return; }
      return;
    }
    insertBlock(i, where, x.md, afterInsert(x));
  }
  function slashMenu(el) {
    if (!rich) return;
    insertMenu(rich.i, 'slash', el, function () {
      if (rich && rich.el === el && (el.textContent || '').trim() === '/') { el.innerHTML = '<p><br></p>'; placeCaret(el, 'start'); }
    });
  }

  /* --- 块菜单（⠿）：全是中文，不用猜 ---------------------------------- */
  var TURNS = [
    { k: '正文', ico: '¶', kind: 'p' },
    { k: '标题（大）', ico: 'H2', kind: 'h2' },
    { k: '标题（小）', ico: 'H3', kind: 'h3' },
    { k: '无序列表', ico: '•', kind: 'ul' },
    { k: '有序列表', ico: '1.', kind: 'ol' },
    { k: '待办清单', ico: '☑', kind: 'task' },
    { k: '引用', ico: '❝', kind: 'quote' },
    { k: '代码块', ico: '{ }', kind: 'code' }
  ];
  var TURNABLE = { paragraph: 1, heading: 1, list: 1, blockquote: 1, code: 1 };
  function stripMarks(raw) {
    return String(raw).replace(/\s+$/, '').split('\n').map(function (l) {
      return l.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').replace(/^```.*$/, '').trim();
    }).filter(function (l) { return l !== ''; });
  }
  function turnInto(i, kind) {
    var b = docBlocks[i]; if (!b) return;
    var lines = stripMarks(b.raw);
    if (!lines.length) return;
    var md;
    if (kind === 'p') md = lines.join('\n\n');
    else if (kind === 'h2') md = '## ' + lines.join(' ');
    else if (kind === 'h3') md = '### ' + lines.join(' ');
    else if (kind === 'ul') md = lines.map(function (l) { return '- ' + l; }).join('\n');
    else if (kind === 'ol') md = lines.map(function (l, n) { return (n + 1) + '. ' + l; }).join('\n');
    else if (kind === 'task') md = lines.map(function (l) { return '- [ ] ' + l; }).join('\n');
    else if (kind === 'quote') md = lines.map(function (l) { return '> ' + l; }).join('\n');
    else if (kind === 'code') md = '```\n' + lines.join('\n') + '\n```';
    else return;
    replaceBlock(i, md);
    var el = blkEl(i); if (el) flashBlock(el);
  }
  function blockMenu(i, anchor) {
    var b = docBlocks[i]; if (!b) return;
    var items = [
      { k: '添加评审意见', ico: '💬', act: function () { try { window.dispatchEvent(new CustomEvent('docsmith:add-review-note', { detail: { kind: 'block', block: i } })); } catch (e) {} } },
      { sep: 1 },
      { k: '上移', ico: '↑', act: function () { moveBlock(i, -1); } },
      { k: '下移', ico: '↓', act: function () { moveBlock(i, 1); } },
      { k: '复制一份', ico: '⧉', act: function () { duplicateBlock(i); } }
    ];
    if (TURNABLE[b.type]) {
      items.push({ sep: 1 }, { head: '转换为' });
      TURNS.forEach(function (t) { items.push({ k: t.k, ico: t.ico, act: function () { turnInto(i, t.kind); } }); });
    }
    items.push({ sep: 1 },
      { k: '编辑 Markdown 源码', ico: '&lt;/&gt;', act: function () { openSrcBox(i, 'end'); } },
      { k: '删除', ico: '🗑', danger: 1, kbd: '⌘/Ctrl Z 可撤销', act: function () { deleteBlock(i); } });
    showMenu(items, anchor);
  }
  function rowMenu(i, r, c, anchor) {
    showMenu([
      { k: '给这个单元格提意见', ico: '💬', act: function () { try { window.dispatchEvent(new CustomEvent('docsmith:add-review-note', { detail: { kind: 'cell', block: i, row: r, col: c } })); } catch (e) {} } },
      { sep: 1 },
      { k: '在上方插入一行', ico: '↑', act: function () { tblOp(i, 'rowAbove', r, c); } },
      { k: '在下方插入一行', ico: '↓', act: function () { tblOp(i, 'rowBelow', r, c); } },
      { sep: 1 },
      { k: '删除这一行', ico: '🗑', danger: 1, act: function () { tblOp(i, 'rowDel', r, c); } }
    ], anchor);
  }
  function colMenu(i, r, c, anchor) {
    var t = tableAt(i), a = t ? (t.align[c] || '') : '';
    showMenu([
      { k: '给这个单元格提意见', ico: '💬', act: function () { try { window.dispatchEvent(new CustomEvent('docsmith:add-review-note', { detail: { kind: 'cell', block: i, row: r, col: c } })); } catch (e) {} } },
      { sep: 1 },
      { k: '在左侧插入一列', ico: '←', act: function () { tblOp(i, 'colLeft', r, c); } },
      { k: '在右侧插入一列', ico: '→', act: function () { tblOp(i, 'colRight', r, c); } },
      { sep: 1 }, { head: '这一列的对齐' },
      { k: '左对齐', ico: '⇤', on: a === 'left' || !a, act: function () { tblOp(i, 'alignL', r, c); } },
      { k: '居中', ico: '↔', on: a === 'center', act: function () { tblOp(i, 'alignC', r, c); } },
      { k: '右对齐', ico: '⇥', on: a === 'right', act: function () { tblOp(i, 'alignR', r, c); } },
      { sep: 1 },
      { k: '删除这一列', ico: '🗑', danger: 1, act: function () { tblOp(i, 'colDel', r, c); } }
    ], anchor);
  }

  /* ---------- task checkboxes ---------------------------------------- */
  var TASK_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm;
  function toggleTask(cb) {
    var n = parseInt(cb.dataset.task, 10); if (isNaN(n)) return;
    var src = docText(), k = 0;
    TASK_RE.lastIndex = 0;
    var next = src.replace(TASK_RE, function (m, a, mid, b) {
      if (k++ !== n) return m;
      return a + (/[xX]/.test(mid) ? ' ' : 'x') + b;
    });
    commitText(next);
  }

  /* ---------- mode switching ------------------------------------------ */
  var sourceEntryText = '';
  function topBlockIndex() {
    var els = preview.querySelectorAll('.blk'), pTop = previewPane.getBoundingClientRect().top;
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.bottom - pTop > 8) return +els[i].dataset.blk;
    }
    return docBlocks.length ? 0 : -1;
  }
  function scrollToBlock(i) {
    var el = blkEl(i); if (!el) return;
    var pTop = previewPane.getBoundingClientRect().top;
    var y = previewPane.scrollTop + (el.getBoundingClientRect().top - pTop) - 12;
    noSmooth(function () { previewPane.scrollTop = Math.max(0, y); });
    flashBlock(el);
  }
  function setEdit(on) {
    ROOT.dataset.edit = on ? 'on' : 'off';
    store.set('edit', on ? 'on' : 'off');
    var btn = $('#editBtn'); if (btn) btn.classList.toggle('active', on);
    if (on) {
      if (!currentId) { makeScratch(); renderMarkdown(''); }
      updateHistBtns();
      toast(store.get('editTip') ? '可以直接改了 · 点任意文字' : '点任意文字就能改 · 选中文字会浮出格式条 · 左侧 ＋ 加内容', 'ok');
      store.set('editTip', '1');
    } else {
      closeBlockEditor(true); endCellEdit(true); hideTools();
      if (ROOT.dataset.mode === 'source') setMode('read');
    }
  }
  function setMode(m) {
    var prev = ROOT.dataset.mode || 'read';
    if (m === prev) return;
    if (m === 'source') {
      if (ROOT.dataset.edit !== 'on') setEdit(true);
      var d = curDoc() || makeScratch();
      closeBlockEditor(true); endCellEdit(true); hideTools();
      var i = topBlockIndex();
      sourceEntryText = d.text || '';
      editor.value = sourceEntryText;
      ROOT.dataset.mode = 'source';
      var pos = (i >= 0 && docBlocks[i]) ? docBlocks[i].start : 0;
      setTimeout(function () {
        editor.focus();
        try { editor.setSelectionRange(pos, pos); } catch (e) {}
        var before = (editor.value.slice(0, pos).match(/\n/g) || []).length;
        var total = (editor.value.match(/\n/g) || []).length + 1;
        editor.scrollTop = Math.max(0, (before / total) * editor.scrollHeight - 60);
      }, 20);
    } else {
      var caret = editor.selectionStart || 0;
      var sourceChanged = editor.value !== sourceEntryText;
      var rendered = commitText(editor.value);
      if (sourceChanged && !rendered) { hideTools(); renderMarkdown(editor.value); }
      sourceEntryText = editor.value;
      ROOT.dataset.mode = 'read';
      var j = blockAtOffset(caret);
      if (j >= 0) setTimeout(function () { scrollToBlock(j); }, 20);
    }
    var b = $('#srcBtn'); if (b) b.classList.toggle('active', m === 'source');
    setTimeout(function () { refreshFind(false); }, 0);
  }
  var onEditInput = debounce(function () {
    if (ROOT.dataset.mode !== 'source') return;
    var d = curDoc() || makeScratch();
    if (editor.value === d.text) return;
    histPush(editor.value);
    d.text = editor.value; d.dirty = (d.text !== (d.savedText || ''));
    currentUrl = ''; clearInterval(refreshTimer);
    updateStatus(d.text); updateSaveState();
    refreshFind(false);
  }, 300);

  /* ---------- find / replace ------------------------------------------
     Reading view searches what the reader can actually see and paints exact
     ranges with the CSS Highlight API. Source view searches the textarea.
     Replacements still splice the Markdown source and use the document-level
     history above, so one replace action is one undo step. */
  var findState = {
    matches: [], current: -1, caseSensitive: false, sourceMode: false,
    pendingSeed: '', latestSeed: '', returnFocus: null, rawMap: {}
  };
  var FIND_SKIP = 'button,.h-anchor,.cb-head,.src-head,.mm-tools,.chg-diff,.chg-del,.blk-add-end,.render-error,.doc-blank';

  function findIsOpen() { return !!(findPanel && findPanel.classList.contains('open')); }
  function normalizeFindSeed(s) {
    return String(s || '').replace(/\u00a0/g, ' ').replace(/\r?\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  }
  function selectedDocumentText() {
    var a = document.activeElement;
    if (a && (a === editor || (a.classList && a.classList.contains('blk-editor'))) &&
        typeof a.selectionStart === 'number' && a.selectionEnd > a.selectionStart) {
      return normalizeFindSeed(a.value.slice(a.selectionStart, a.selectionEnd));
    }
    var s = window.getSelection && window.getSelection();
    if (!s || !s.rangeCount || s.isCollapsed) return '';
    var r = s.getRangeAt(0), n = r.commonAncestorContainer;
    if (n.nodeType !== 1) n = n.parentElement;
    return n && preview.contains(n) ? normalizeFindSeed(s.toString()) : '';
  }
  function rememberDocumentSelection() {
    var selected = selectedDocumentText();
    if (selected) findState.latestSeed = selected;
    return selected;
  }
  function seedForFind() {
    var live = rememberDocumentSelection();
    if (live) return live;
    var active = document.activeElement;
    return active && findPanel.contains(active) ? '' : findState.latestSeed;
  }
  function literalMatches(text, query, matchCase) {
    var out = [];
    if (!query) return out;
    var pat = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), re;
    try { re = new RegExp(pat, matchCase ? 'g' : 'gi'); } catch (e) { return out; }
    var m;
    while ((m = re.exec(text))) {
      out.push({ start: m.index, end: m.index + m[0].length });
      if (out.length >= 50000) break;
    }
    return out;
  }
  function clearFindHighlights() {
    if (window.CSS && CSS.highlights) {
      try { CSS.highlights.delete('mdr-find'); CSS.highlights.delete('mdr-find-current'); } catch (e) {}
    }
    $$('.find-match-block,.find-current-block', preview).forEach(function (b) {
      b.classList.remove('find-match-block', 'find-current-block');
    });
  }
  function searchableNodes(root) {
    var nodes = [];
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue) return NodeFilter.FILTER_SKIP;
        var p = n.parentElement;
        if (!p || (p.closest && p.closest(FIND_SKIP))) return NodeFilter.FILTER_REJECT;
        try { if (!p.getClientRects().length) return NodeFilter.FILTER_REJECT; } catch (e) {}
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n; while ((n = w.nextNode())) nodes.push(n);
    return nodes;
  }
  function pointAtTextOffset(nodes, off) {
    var at = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].nodeValue.length;
      if (off <= at + len) return { node: nodes[i], offset: Math.max(0, off - at) };
      at += len;
    }
    var last = nodes[nodes.length - 1];
    return last ? { node: last, offset: last.nodeValue.length } : null;
  }
  function previewMatches(query, matchCase) {
    var out = [], roots = $$('.blk', preview);
    var foot = $('.footnotes', preview);
    if (foot) roots.push(foot);
    if (!roots.length) roots = [preview];
    roots.forEach(function (root) {
      var nodes = searchableNodes(root); if (!nodes.length) return;
      var text = nodes.map(function (n) { return n.nodeValue; }).join('');
      var hits = literalMatches(text, query, matchCase);
      var block = root.classList.contains('blk') ? +root.dataset.blk : -1;
      hits.forEach(function (h, ordinal) {
        var a = pointAtTextOffset(nodes, h.start), z = pointAtTextOffset(nodes, h.end);
        if (!a || !z) return;
        try {
          var range = document.createRange();
          range.setStart(a.node, a.offset); range.setEnd(z.node, z.offset);
          out.push({ range: range, block: block, ordinal: ordinal });
        } catch (e) {}
      });
    });
    return out;
  }
  function matchBlock(m) {
    if (!m) return null;
    if (m.block >= 0) return blkEl(m.block);
    var n = m.range && m.range.commonAncestorContainer;
    if (n && n.nodeType !== 1) n = n.parentElement;
    return n && n.closest ? n.closest('.blk,.footnotes,.raw-fallback') : null;
  }
  function paintFindHighlights() {
    clearFindHighlights();
    if (findState.sourceMode || !findState.matches.length) return;
    var exact = !!(window.CSS && CSS.highlights && typeof window.Highlight === 'function');
    if (exact) {
      try {
        var all = new Highlight();
        findState.matches.forEach(function (m) { if (m.range) all.add(m.range); });
        CSS.highlights.set('mdr-find', all);
        if (findState.current >= 0) {
          var one = new Highlight(); one.add(findState.matches[findState.current].range);
          CSS.highlights.set('mdr-find-current', one);
        }
        return;
      } catch (e) { clearFindHighlights(); }
    }
    findState.matches.forEach(function (m) { var b = matchBlock(m); if (b) b.classList.add('find-match-block'); });
    var cur = matchBlock(findState.matches[findState.current]); if (cur) cur.classList.add('find-current-block');
  }
  function updateFindControls() {
    var n = findState.matches.length, has = n > 0 && !!findInput.value;
    $('#findCount').textContent = n ? ((findState.current + 1) + ' / ' + n) : '0 / 0';
    ['#findPrev', '#findNext', '#replaceOne', '#replaceAll'].forEach(function (s) { var b = $(s); if (b) b.disabled = !has; });
    findInput.setAttribute('aria-invalid', findInput.value && !n ? 'true' : 'false');
  }
  function firstMatchFrom(anchor) {
    if (!findState.matches.length) return -1;
    if (findState.sourceMode) {
      for (var i = 0; i < findState.matches.length; i++) if (findState.matches[i].start >= anchor) return i;
      return 0;
    }
    var top = previewPane.getBoundingClientRect().top + 8;
    for (var j = 0; j < findState.matches.length; j++) {
      try { if (findState.matches[j].range.getBoundingClientRect().bottom >= top) return j; } catch (e) {}
    }
    return 0;
  }
  function revealFindCurrent() {
    var m = findState.matches[findState.current]; if (!m) return;
    if (findState.sourceMode) {
      try { editor.setSelectionRange(m.start, m.end); } catch (e) {}
      var total = Math.max(1, editor.value.length), max = Math.max(0, editor.scrollHeight - editor.clientHeight);
      editor.scrollTop = Math.max(0, Math.min(max, (m.start / total) * editor.scrollHeight - editor.clientHeight * .35));
      return;
    }
    var rect = null;
    try { rect = m.range.getBoundingClientRect(); } catch (e) {}
    if (!rect || (!rect.width && !rect.height)) {
      var b = matchBlock(m); if (b) b.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    var pr = previewPane.getBoundingClientRect();
    if (rect.top < pr.top + 18 || rect.bottom > pr.bottom - 18) {
      var y = previewPane.scrollTop + rect.top - pr.top - previewPane.clientHeight * .34;
      previewPane.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  }
  function runFind(opts) {
    if (!findIsOpen()) return;
    opts = opts || {};
    var old = findState.current, oldQuery = findState.query;
    clearFindHighlights(); findState.rawMap = {};
    findState.query = findInput.value;
    findState.sourceMode = ROOT.dataset.mode === 'source';
    var anchor = opts.anchor;
    if (anchor == null) anchor = findState.sourceMode ? (editor.selectionStart || 0) : 0;
    findState.matches = findState.query ? (findState.sourceMode
      ? literalMatches(editor.value, findState.query, findState.caseSensitive)
      : previewMatches(findState.query, findState.caseSensitive)) : [];
    if (!findState.matches.length) findState.current = -1;
    else if (opts.index != null) findState.current = Math.max(0, Math.min(opts.index, findState.matches.length - 1));
    else if (opts.keep && oldQuery === findState.query && old >= 0) findState.current = Math.min(old, findState.matches.length - 1);
    else findState.current = firstMatchFrom(anchor);
    paintFindHighlights(); updateFindControls();
    if (opts.reveal !== false && findState.current >= 0) revealFindCurrent();
  }
  function refreshFind(reveal) {
    if (findIsOpen()) runFind({ keep: true, reveal: !!reveal });
  }
  function stepFind(dir) {
    var n = findState.matches.length;
    if (!n) { if (findInput.value) toast('没有找到“' + findInput.value + '”'); return; }
    findState.current = (findState.current + dir + n) % n;
    paintFindHighlights(); updateFindControls(); revealFindCurrent();
  }
  function setReplaceOpen(on) {
    findPanel.classList.toggle('replace-on', !!on);
    $('#findReplaceToggle').setAttribute('aria-expanded', on ? 'true' : 'false');
    $('#findReplaceToggle').setAttribute('aria-label', on ? '隐藏替换' : '显示替换');
  }
  function openFind(withReplace, seed) {
    var wasOpen = findIsOpen();
    var selected = seed == null ? seedForFind() : normalizeFindSeed(seed);
    if (!wasOpen) findState.returnFocus = document.activeElement;
    closeMenus(); $('#settingsPanel').classList.remove('open'); toggleChgPanel(false);
    closeBlockEditor(true); endCellEdit(true);
    findPanel.classList.add('open'); $('#findBtn').classList.add('active');
    if (withReplace) setReplaceOpen(true); else if (!wasOpen) setReplaceOpen(false);
    if (selected) findInput.value = selected;
    runFind({ reveal: true });
    setTimeout(function () { findInput.focus(); findInput.select(); }, 0);
  }
  function closeFind() {
    if (!findIsOpen()) return;
    findPanel.classList.remove('open'); $('#findBtn').classList.remove('active');
    clearFindHighlights();
    var back = findState.returnFocus; findState.returnFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function') {
      try { back.focus({ preventScroll: true }); } catch (e) { try { back.focus(); } catch (ignore) {} }
    }
  }

  /* Determine which literal source occurrence produced a visible match.
     Markers rendered in link destinations / HTML attributes disappear from
     textContent, while markers around visible Markdown text survive. */
  function visibleRawOrder(blockIndex, query, matchCase) {
    var key = blockIndex + '|' + (matchCase ? '1|' : '0|') + query;
    if (findState.rawMap[key]) return findState.rawMap[key];
    var b = docBlocks[blockIndex], result = { raw: [], visible: [] };
    if (!b) return result;
    result.raw = literalMatches(b.raw, query, matchCase);
    if (!result.raw.length) { findState.rawMap[key] = result; return result; }
    var tagged = '', at = 0;
    result.raw.forEach(function (m, i) {
      tagged += b.raw.slice(at, m.start) + '\uE000' + i.toString(36) + '\uE001' + b.raw.slice(m.start, m.end);
      at = m.end;
    });
    tagged += b.raw.slice(at);
    var oldIds = usedIds, oldMm = mmCounter, html = '';
    try {
      usedIds = Object.assign({}, usedIds);
      var fn = processFootnotes(docText());
      html = renderBlockHtml({ raw: tagged, type: b.type }, collectLinkDefs(docText()), fn.order, fn.defs);
    } catch (e) { html = ''; }
    usedIds = oldIds; mmCounter = oldMm;
    if (html) {
      var box = document.createElement('div'); box.innerHTML = html;
      $$(FIND_SKIP, box).forEach(function (n) { n.remove(); });
      var re = /\uE000([0-9a-z]+)\uE001/g, m, text = box.textContent || '';
      while ((m = re.exec(text))) result.visible.push(parseInt(m[1], 36));
    }
    if (!result.visible.length && result.raw.length) {
      for (var i = 0; i < result.raw.length; i++) result.visible.push(i);
    }
    findState.rawMap[key] = result; return result;
  }
  function rawPositionForVisible(v, base) {
    if (!v || v.block < 0 || !docBlocks[v.block]) return null;
    var map = visibleRawOrder(v.block, findInput.value, findState.caseSensitive);
    var rawIndex = map.visible[v.ordinal];
    if (rawIndex == null || !map.raw[rawIndex]) return null;
    var h = map.raw[rawIndex], b = docBlocks[v.block];
    var pos = { start: b.start + h.start, end: b.start + h.end };
    return pos.end <= base.length ? pos : null;
  }
  function replacementPositions(base, onlyCurrent) {
    if (findState.sourceMode) {
      if (onlyCurrent) return findState.current >= 0 ? [findState.matches[findState.current]] : [];
      return findState.matches.slice();
    }
    var list = onlyCurrent ? [findState.matches[findState.current]] : findState.matches;
    var seen = {}, out = [];
    list.forEach(function (v) {
      var p = rawPositionForVisible(v, base);
      if (p && !seen[p.start + ':' + p.end]) { seen[p.start + ':' + p.end] = 1; out.push(p); }
    });
    return out.sort(function (a, b) { return a.start - b.start; });
  }
  function commitReplacement(base, next) {
    if (base === next) return false;
    if (base !== docText()) {
      if (hist[histIdx] !== base) histPush(base);
      var d = curDoc() || makeScratch(); d.text = base; d.dirty = (base !== (d.savedText || ''));
    }
    return commitText(next);
  }
  function replaceCurrent() {
    if (findState.current < 0 || !findInput.value) return;
    var base = findState.sourceMode ? editor.value : docText();
    var pos = replacementPositions(base, true)[0];
    if (!pos) { toast('这一处在 Markdown 源码中不是连续文本，请切到源码视图替换', 'err'); return; }
    var next = base.slice(0, pos.start) + replaceInput.value + base.slice(pos.end);
    if (!commitReplacement(base, next)) { toast('查找内容和替换内容相同'); return; }
    var keepsMatch = literalMatches(replaceInput.value, findInput.value, findState.caseSensitive).length > 0;
    var nextIndex = findState.current + (keepsMatch ? 1 : 0);
    runFind({ index: nextIndex, reveal: true });
    toast('已替换 1 处 · 可用 ⌘/Ctrl+Z 撤销', 'ok');
  }
  function replaceAllMatches() {
    if (!findState.matches.length || !findInput.value) return;
    var visibleCount = findState.matches.length;
    var base = findState.sourceMode ? editor.value : docText();
    var positions = replacementPositions(base, false);
    if (!positions.length) { toast('可见匹配在 Markdown 源码中不是连续文本，请切到源码视图替换', 'err'); return; }
    var out = '', at = 0;
    positions.forEach(function (p) { out += base.slice(at, p.start) + replaceInput.value; at = p.end; });
    out += base.slice(at);
    if (!commitReplacement(base, out)) { toast('查找内容和替换内容相同'); return; }
    runFind({ index: 0, reveal: false });
    var skipped = findState.sourceMode ? 0 : Math.max(0, visibleCount - positions.length);
    toast('已替换 ' + positions.length + ' 处' + (skipped ? ' · ' + skipped + ' 处复杂格式未改动' : '') + ' · 可用 ⌘/Ctrl+Z 撤销', 'ok');
  }
  function initFind() {
    var btn = $('#findBtn');
    document.addEventListener('selectionchange', rememberDocumentSelection);
    preview.addEventListener('mouseup', rememberDocumentSelection);
    preview.addEventListener('keyup', rememberDocumentSelection);
    editor.addEventListener('select', rememberDocumentSelection);
    btn.addEventListener('mousedown', function (e) { findState.pendingSeed = seedForFind(); e.preventDefault(); });
    btn.addEventListener('click', function () { openFind(false, findState.pendingSeed); findState.pendingSeed = ''; });
    $('#findReplaceToggle').addEventListener('click', function () {
      var on = !findPanel.classList.contains('replace-on'); setReplaceOpen(on);
      if (on) setTimeout(function () { replaceInput.focus(); }, 0);
    });
    $('#findCase').addEventListener('click', function () {
      findState.caseSensitive = !findState.caseSensitive;
      this.classList.toggle('active', findState.caseSensitive);
      this.setAttribute('aria-pressed', findState.caseSensitive ? 'true' : 'false');
      runFind({ reveal: true });
    });
    findInput.addEventListener('input', function () { runFind({ reveal: true }); });
    findInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    replaceInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (e.metaKey || e.ctrlKey) replaceAllMatches(); else replaceCurrent(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });
    $('#findPrev').addEventListener('click', function () { stepFind(-1); });
    $('#findNext').addEventListener('click', function () { stepFind(1); });
    $('#findClose').addEventListener('click', closeFind);
    $('#replaceOne').addEventListener('click', replaceCurrent);
    $('#replaceAll').addEventListener('click', replaceAllMatches);
  }

  /* ---------- wiring for the editing surface -------------------------- */
  function initEditing() {
    /* 鼠标停在哪，那一块的把手就出现在它左边；停在单元格上，行/列把手出现在旁边。 */
    preview.addEventListener('mouseover', function (e) {
      if (ROOT.dataset.edit !== 'on' || srcBox) return;
      var td = e.target.closest('td,th');
      if (td && preview.contains(td)) { hideBlkHandle(); hoverBlk = null; showCellHandles(td); return; }
      if (!cellEdit && !e.target.closest('.doc table')) hideCellHandles();
      var el = e.target.closest('.blk'); if (!el || el === hoverBlk) return;
      hoverBlk = el; showBlkHandle(el);
    });
    previewPane.addEventListener('mouseleave', function () {
      if (srcBox || cellEdit) return;
      hideBlkHandle(); hideCellHandles(); hoverBlk = null;
    });
    previewPane.addEventListener('scroll', throttle(function () {
      if (hoverBlk && hoverBlk.isConnected && $('#blkHandle').classList.contains('show')) showBlkHandle(hoverBlk);
      if (cellEdit && cellEdit.td.isConnected && $('#rowH').classList.contains('show')) showCellHandles(cellEdit.td);
      hideMenu();
      if (rich) showSelTools();
    }, 80));

    /* 点哪儿改哪儿 —— 光标落在你点的那个字上，而不是块尾 */
    preview.addEventListener('click', function (e) {
      if (ROOT.dataset.edit !== 'on') return;
      if (e.target.closest('a,button,input,img,details,summary,.mm-viewport,.blk-editor,.src-box,.blk-add-end,.toc-inline')) return;
      var td = e.target.closest('td,th');
      if (td && preview.contains(td)) { startCellEdit(td); return; }
      var el = e.target.closest('.blk'); if (!el) return;
      if (rich && rich.el === el) return;
      if (window.getSelection && String(window.getSelection()).length > 1) return;   // 让用户能正常划选文字
      openBlockEditor(+el.dataset.blk, { x: e.clientX, y: e.clientY });
    });
    preview.addEventListener('change', function (e) {
      var cb = e.target;
      if (cb && cb.matches && cb.matches('input[type=checkbox]')) { e.preventDefault(); toggleTask(cb); }
    });
    preview.addEventListener('keydown', function (e) {
      if (cellEdit) {
        if (e.key === 'Tab') { e.preventDefault(); cellStep(e.shiftKey ? -1 : 1); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cellDown(); return; }
        if (e.key === 'Escape') { e.preventDefault(); endCellEdit(false); hideCellHandles(); return; }
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); endCellEdit(true); saveDoc(); return; }
        return;
      }
      if (rich) richKeys(e);
    });
    /* 边写边亮起「保存」，但不重排页面 —— 真正写回源码发生在离开这一块时 */
    preview.addEventListener('input', function () {
      if (!rich) return;
      hideSelTools();
      var d = curDoc();
      if (d && !d.dirty) { d.dirty = true; updateSaveState(); }
    });
    preview.addEventListener('focusout', function (e) {
      if (cellEdit && e.target === cellEdit.td) {
        setTimeout(function () {
          var a = document.activeElement;
          if (a && (a.closest('#rowH') || a.closest('#colH') || a.closest('#popMenu') || a === (cellEdit && cellEdit.td))) return;
          endCellEdit(true);
        }, 0);
        return;
      }
      if (rich && e.target === rich.el) {
        setTimeout(function () {
          if (!rich) return;
          var a = document.activeElement;
          if (a && (a.closest('#selTools') || a.closest('#linkBox') || a.closest('#popMenu') || a.closest('#blkHandle') || rich.el.contains(a))) return;
          closeRich(true);
        }, 0);
      }
    });
    document.addEventListener('selectionchange', function () { if (rich) showSelTools(); });

    /* 块把手：＋ 插入内容，⠿ 打开这一块的菜单 */
    $('#blkHandle').addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
    $('#blkHandle').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var i = parseInt(this.dataset.i, 10); if (isNaN(i)) return;
      if (b.dataset.h === 'add') insertMenu(i, 'after', b);
      else blockMenu(i, b);
    });
    /* 表格的行 / 列把手 */
    $('#rowH').addEventListener('mousedown', function (e) { e.preventDefault(); });
    $('#colH').addEventListener('mousedown', function (e) { e.preventDefault(); });
    $('#rowH').addEventListener('click', function () { rowMenu(+this.dataset.i, +this.dataset.r, +this.dataset.c, this); });
    $('#colH').addEventListener('click', function () { colMenu(+this.dataset.i, +this.dataset.r, +this.dataset.c, this); });
    /* 所有的菜单都走同一套：中文文字项，点了就干活 */
    $('#popMenu').addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
    $('#popMenu').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mi]'); if (!b) return;
      var it = menuItems && menuItems[+b.dataset.mi];
      this.classList.remove('show'); menuItems = null; menuClose = null;
      if (it && it.act) it.act();
    });
    /* 选中文字就出现的格式条 */
    $('#selTools').addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
    $('#selTools').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (b) fmt(b.dataset.op);
    });
    $('#linkBox').addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
    $('#linkBox').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-lk]'); if (!b) return;
      applyLink(b.dataset.lk === 'rm' ? '' : this.querySelector('input').value);
    });

    document.addEventListener('mousedown', function (e) {
      if (e.target.closest('#popMenu') || e.target.closest('#blkHandle') || e.target.closest('#rowH') || e.target.closest('#colH')) return;
      hideMenu();
      if (!e.target.closest('#selTools') && !e.target.closest('#linkBox') && !e.target.closest('.blk.rich')) hideSelTools();
      if (!e.target.closest('.doc table')) hideCellHandles();
    });
    /* 文末的「继续写」：点了就直接能打字，不弹任何东西 */
    previewPane.addEventListener('click', function (e) {
      if (!e.target.closest('.blk-add-end')) return;
      closeBlockEditor(true); endCellEdit(true);
      openNewAfter(docBlocks.length ? docBlocks.length - 1 : -1, null);
    });
  }

  /* ---------- save Markdown back to a local file --------------------------
     编辑后要能让本地的 .md 真正更新，否则本地文件与导出的 HTML 就对不上。
       ① 用「文件 / 文件夹选择器」打开的文档 → 拿得到可写句柄（File System
          Access API），直接原地写回，本地文件立即同步，之后 ⌘/Ctrl+S 静默保存；
       ② 拖入 / <input> 打开、或首次保存的草稿 → 弹一次「另存为」，选好位置后
          记住句柄，后续同样能原地写回；
       ③ 浏览器不支持、或在跨源 iframe 里被拦 → 退回下载（在工具台里会经外壳
          下载），提示用户覆盖本地文件。
     ---------------------------------------------------------------------- */
  /* ======================================================================
     基线库：「上次你认可的那份内容」—— 跨会话活着的那一层
     ----------------------------------------------------------------------
     A 层（未保存的改动）比的是「内存 vs 磁盘」，Save 一按就清零，只活在这次会话里。
     这一层比的是「磁盘 vs 你上次认可的那份」，它写在 localStorage 上、按文件路径记，
     所以关掉浏览器、明天再打开、甚至你中途用别的编辑器改了这个文件 —— 一打开就看得见
     「你不在的时候，这儿变了哪些」。认可的方式有三种：初次打开（没有历史可比）、
     按 Save（你自己写回的）、点「知道了」（外面改的，你已经看过了）。
     ====================================================================== */
  var SEEN_KEY = 'mdr:seen';
  var SEEN_MAX_TEXT = 131072;                              // 单篇存全文的上限：128KB（约 6 万字中文）
  var SEEN_MAX_BYTES = 2200000;                            // 整个基线库的上限，超了淘汰最旧的
  var bannerOff = false;
  function fnv(str) {
    str = String(str); var h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); h1 ^= c; h1 = Math.imul(h1, 0x01000193); h2 ^= c; h2 = Math.imul(h2, 0x85ebca6b); }
    return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36) + '-' + str.length.toString(36);
  }
  function seenRead() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function stableDocKey(d) {
    if (!d) return '';
    if (d.source === 'url') return 'url|' + normalizeUrl(d.url || d.relPath || '');
    if (d.source === 'scratch' && !d.handle) return 'session|' + d.id;
    var folder = d.folderRoot && d.folderRoot.name ? d.folderRoot.name + '/' : '';
    var path = folder + (d.relPath || d.name || '');
    /* 浏览器不会暴露独立文件的绝对路径。文件夹场景可用「目录名 + 相对路径」；
       独立文件只能退到文件名。不能掺内容指纹 —— 一保存内容就变，意见会像丢了。
       极少数同名独立文件会共用评审数据，这是浏览器权限模型下可解释的退化。 */
    return (folder ? 'folder|' : 'file|') + path.toLowerCase();
  }
  function seenKey(d) {
    if (!d) return '';
    if (d.source === 'scratch' && !d.handle) return '';
    return stableDocKey(d);
  }
  function seenGet(d) { var k = seenKey(d); if (!k) return null; return seenRead()[k] || null; }
  function seenPut(d, text) {
    var k = seenKey(d); if (!k) return;
    text = String(text == null ? '' : text);
    var o = seenRead();
    o[k] = { t: text.length <= SEEN_MAX_TEXT ? text : null, h: fnv(text), ts: Date.now(), n: d.name || '' };
    var s = JSON.stringify(o);
    while (s.length > SEEN_MAX_BYTES) {                    // 装不下就先扔最久没碰过的
      var ks = Object.keys(o); if (ks.length <= 1) break;
      ks.sort(function (a, b) { return (o[a].ts || 0) - (o[b].ts || 0); });
      delete o[ks[0]]; s = JSON.stringify(o);
    }
    try { localStorage.setItem(SEEN_KEY, s); } catch (e) { /* 存不下就算了，标记只是锦上添花 */ }
  }
  function agoText(ts) {
    if (!ts) return '';
    var s = Math.max(0, Date.now() - ts) / 1000;
    if (s < 90) return '刚刚';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    if (s < 86400 * 30) return Math.round(s / 86400) + ' 天前';
    return new Date(ts).toLocaleDateString();
  }
  /* 打开文件时问一次：磁盘上这份，跟你上次认可的那份，是不是同一个东西？ */
  function checkExternal(d, t) {
    d.extBase = null; d.extBig = false; d.extTs = 0; d._extBlks = null; extCache = null; bannerOff = false;
    var rec = seenGet(d);
    if (!rec) { seenPut(d, t); return; }                   // 初次见面：悄悄记下，没有历史可言
    if (rec.h === fnv(t)) return;                          // 跟你上次认可的一模一样 → 什么也没发生
    d.extTs = rec.ts || 0;
    if (rec.t == null) { d.extBig = true; return; }        // 当时太大只存了指纹：知道变了，定位不到
    d.extBase = rec.t;
  }
  function extBaseBlocks(d) {
    if (d._extBlksFor !== d.extBase || !d._extBlks) {
      d._extBlksFor = d.extBase;
      try { d._extBlks = lexBlocks(d.extBase || ''); } catch (e) { d._extBlks = []; }
    }
    return d._extBlks;
  }

  /* ======================================================================
     未保存的改动：标记 + 清单 + 逐条还原
     ----------------------------------------------------------------------
     savedText 是「上次真正写回磁盘的那份内容」，text 是「现在看到的这份」。
     两边各自切成块，块级 LCS 对一遍，就得到「新增 / 修改 / 删除」三种改动点：
       · 正文里：改过的块左边一根改动条，删掉的地方留一道可展开的痕迹；
       · 顶栏里：一个改动数，点开是清单，可以逐条跳过去、逐条还原；
       · Save 时：告诉用户这次写回了几处。
     标记与 Save 共用同一个基线，所以「看见的改动」和「写进文件的改动」不会
     是两回事 —— 这正是这个功能存在的理由。
     ====================================================================== */
  var chgMarks = store.get('chgmarks', '1') !== '0';
  var chgCache = null;
  var LCS_CAP = 260000;                                    // 超大文档退回粗粒度，别把主线程卡住
  var TYPE_ZH = { paragraph:'段落', heading:'标题', code:'代码块', table:'表格', list:'列表', blockquote:'引用', hr:'分隔线', html:'HTML 块', def:'链接定义', text:'文本', space:'空行' };

  function typeZh(t) { return TYPE_ZH[t] || t || '内容'; }
  function normRaw(b) { return String((b && b.raw) || '').replace(/\s+$/, ''); }
  function baseBlocks(d) {                                 // 基线只在 savedText 变了才重新切
    var s = d.savedText == null ? '' : d.savedText;
    if (d._baseSrc !== s || !d._baseBlks) {
      d._baseSrc = s;
      try { d._baseBlks = lexBlocks(s); } catch (e) { d._baseBlks = []; }
    }
    return d._baseBlks;
  }
  function chgExcerpt(raw, max) {
    var s = String(raw == null ? '' : raw).replace(/\r/g, '');
    s = s.replace(/^\s*>+\s?/gm, '').replace(/^\s*#{1,6}\s*/gm, '').replace(/^\s*([*+-]|\d+[.)])\s+/gm, '');
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
    max = max || 56;
    if (!s) return '（空内容）';
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  function lcsPairs(a, b) {                                // 只跑在「前后相同部分」之外的那一小段上
    var n = a.length, m = b.length, i, j;
    if (!n || !m) return [];
    var dp = []; for (i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var out = []; i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return out;
  }
  function emptyChg() { return { list: [], mark: {}, dels: {}, add: 0, mod: 0, del: 0, n: 0 }; }
  function diffDoc(A, B) {
    var a = A.map(normRaw), b = B.map(normRaw), res = emptyChg();
    var p = 0, n = a.length, m = b.length;
    while (p < n && p < m && a[p] === b[p]) p++;                      // 共同的开头
    var ea = n, eb = m;
    while (ea > p && eb > p && a[ea - 1] === b[eb - 1]) { ea--; eb--; } // 共同的结尾
    var am = a.slice(p, ea), bm = b.slice(p, eb);
    var pairs = (am.length * bm.length > LCS_CAP) ? [] : lcsPairs(am, bm);
    pairs = pairs.concat([[am.length, bm.length]]);                   // 收尾哨兵
    var ai = 0, bi = 0;
    pairs.forEach(function (pr) {
      var ga = pr[0] - ai, gb = pr[1] - bi, common = Math.min(ga, gb), k;
      for (k = 0; k < common; k++) chgPush(res, 'mod', p + bi + k, B[p + bi + k], am[ai + k]);   // 一一对上的算「改」
      for (k = common; k < gb; k++) chgPush(res, 'add', p + bi + k, B[p + bi + k], '');          // 多出来的算「增」
      if (ga > common) chgPushDel(res, p + pr[1], am.slice(ai + common, ai + ga));               // 少掉的算「删」，挂在后一块前面
      ai = pr[0] + 1; bi = pr[1] + 1;
    });
    res.n = res.add + res.mod + res.del;
    return res;
  }
  function chgPush(res, kind, i, blk, old) {
    res.mark[i] = kind;
    res[kind === 'add' ? 'add' : 'mod']++;
    res.list.push({ k: kind, i: i, type: (blk && blk.type) || 'paragraph', text: chgExcerpt(blk && blk.raw), old: old, oldText: chgExcerpt(old) });
  }
  function chgPushDel(res, i, olds) {
    res.dels[i] = olds;
    res.del += olds.length;
    res.list.push({ k: 'del', i: i, type: 'del', olds: olds, count: olds.length, text: chgExcerpt(olds.join(' ')), oldText: '' });
  }
  function changeSet() {
    var d = curDoc();
    if (!d || !d.dirty) return emptyChg();
    var cur = d.text == null ? '' : d.text, base = d.savedText == null ? '' : d.savedText;
    if (chgCache && chgCache.id === d.id && chgCache.blocks === docBlocks && chgCache.base === base && chgCache.cur === cur) return chgCache.res;
    // 渲染退回整篇源码时 docBlocks 是空的，这时候标记只会误导人，索性不标
    var res = (cur.trim() && !docBlocks.length) ? emptyChg() : diffDoc(baseBlocks(d), docBlocks);
    chgCache = { id: d.id, blocks: docBlocks, base: base, cur: cur, res: res };
    return res;
  }
  /* ---------- 词级 diff：把「原来」和「现在」的差别精确到词 ----------
     汉字 / 假名 / 韩文逐字切，拉丁按词切（含下划线），emoji 的代理对不许拆开。
     先掐掉共同的头尾再对中间做 LCS；大段落超过上限就退回整块红/绿，不做词级高亮。 */
  var WDIFF_CAP = 220000;
  var CJK = '\\u3400-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af';
  //  ① 代理对整体成词：否则 diff 边界落在 emoji 中间会吐出半个字符（乱码）
  //  ② 汉字 / 假名 / 韩文逐字   ③ 标识符含下划线（foo_bar 是一个词，不是三个）
  //  ④ 连续空白   ⑤ 其余任何单字符兜底
  var WTOK_RE = new RegExp('[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[' + CJK + ']|[A-Za-z0-9_]+|\\s+|[\\s\\S]', 'g');
  function wtok(s) { WTOK_RE.lastIndex = 0; return String(s == null ? '' : s).match(WTOK_RE) || []; }
  function wordDiff(a, b) {
    var A = wtok(a), B = wtok(b), out = [];
    var push = function (t, arr) {                       // 相邻的同类合并，片段更少、DOM 更少
      if (!arr || !arr.length) return;
      var s = arr.join(''), last = out[out.length - 1];
      if (last && last.t === t) last.s += s; else out.push({ t: t, s: s });
    };
    var p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
    var ea = A.length, eb = B.length;
    while (ea > p && eb > p && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    var am = A.slice(p, ea), bm = B.slice(p, eb);
    push('=', A.slice(0, p));
    if (am.length * bm.length > WDIFF_CAP) { push('-', am); push('+', bm); }
    else {
      var pairs = lcsPairs(am, bm).concat([[am.length, bm.length]]);
      var ai = 0, bi = 0;
      pairs.forEach(function (pr) {
        push('-', am.slice(ai, pr[0]));
        push('+', bm.slice(bi, pr[1]));
        if (pr[0] < am.length) push('=', [am[pr[0]]]);
        ai = pr[0] + 1; bi = pr[1] + 1;
      });
    }
    push('=', A.slice(ea));
    return out;
  }
  /* 一行流式的「删了什么 / 加了什么」，源码级 —— 渲染态的 ghost 负责「原来长什么样」，
     这一行负责「到底动了哪几个字」，两个各司其职。
     纯空白的增删不上色：Markdown 里空格多一个少一个不改变任何东西，给它涂个绿块
     只会淹没真正改了的字（表格重排对齐时尤其明显）。但换行是结构，要显形；
     代码块里空白就是内容（缩进），那儿照实标。 */
  function inlineWordDiff(oldRaw, newRaw, wsMatters) {
    return wordDiff(oldRaw, newRaw).map(function (p) {
      var t = escapeHtml(p.s);
      if (p.t === '=') return t;
      var tag = p.t === '-' ? 'del' : 'ins', cls = p.t === '-' ? 'w-del' : 'w-ins';
      if (!wsMatters && !/\S/.test(p.s)) {
        if (/\n/.test(p.s)) return '<' + tag + ' class="' + cls + ' w-nl">↵</' + tag + '>';
        return p.t === '+' ? t : '';                  // 加的空格照原样画出来，删的直接不画
      }
      return '<' + tag + ' class="' + cls + '">' + t + '</' + tag + '>';
    }).join('');
  }
  /* 表格不摊管道符。
     改一个格子，serializeTable 会按新列宽把整张表的填充空白重排一遍 —— 源码级 diff
     于是满屏都是空白变动，真正改的那几个字反而看不见了；`|---|---|` 那一行更是纯噪音。
     表格该按格子比：只列出真的变了的那几格，列名就是表头。 */
  function tableCellDiff(oldRaw, newRaw) {
    var A, B;
    try { A = parseTable(oldRaw); B = parseTable(newRaw); } catch (e) { return null; }
    if (!A || !B) return null;
    var out = [], head = B.head || [];
    var colName = function (c) {
      var h = head[c] != null ? String(head[c]).trim() : '';
      return h ? h : '第 ' + (c + 1) + ' 列';
    };
    var cmpRow = function (a, b, label) {
      var n = Math.max(a ? a.length : 0, b ? b.length : 0);
      for (var c = 0; c < n; c++) {
        var x = String((a && a[c]) || '').trim(), y = String((b && b[c]) || '').trim();
        if (x === y) continue;
        out.push({ where: label + ' · ' + colName(c), diff: inlineWordDiff(x, y) });
      }
    };
    cmpRow(A.head, B.head, '表头');
    var rows = Math.max(A.rows.length, B.rows.length);
    for (var r = 0; r < rows; r++) {
      var lab = '第 ' + (r + 1) + ' 行';
      if (r >= A.rows.length) { out.push({ where: lab, diff: '<ins class="w-ins">' + escapeHtml(B.rows[r].join(' · ')) + '</ins>' }); continue; }
      if (r >= B.rows.length) { out.push({ where: lab, diff: '<del class="w-del">' + escapeHtml(A.rows[r].join(' · ')) + '</del>' }); continue; }
      cmpRow(A.rows[r], B.rows[r], lab);
    }
    return out;
  }

  /* ---------- 渲染态回放：把「原来」按它在文档里的样子画出来 ----------
     单块渲染要带上全文的脚注 / 链接定义，否则 [^1]、[链接][ref] 会散架。 */
  function renderBlockSafe(raw, srcForDefs) {
    var html = '', src = srcForDefs || raw;
    try {
      var fn = processFootnotes(src);
      html = renderBlockHtml({ raw: raw, type: 'paragraph' }, collectLinkDefs(src), fn.order, fn.defs);
    } catch (e) { html = '<pre class="raw-fallback">' + escapeHtml(raw) + '</pre>'; }
    if (window.DOMPurify) {
      try {
        var c = DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'], ADD_ATTR: ['target', 'loading', 'open'], USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true } });
        if (c && c.trim()) html = c;
      } catch (e) {}
    }
    return html || '<span class="cd-nil">（空内容）</span>';
  }
  /* 回放也得跟正文长一个样：图片要显示、图表要画出来、callout 要成形、宽表格要能滚。
     但它只是一段回放，不是文档的一部分 —— 所以 id 全摘掉（否则标题锚点重复、大纲会跳错），
     勾选框一律禁用（那一块在源码里已经不存在了，点它没有意义）。 */
  function enhanceGhost(root) {
    if (!root) return;
    safe('g-tables', function () { wrapTables(root); });
    safe('g-callouts', function () { transformCallouts(root); });
    safe('g-images', function () { setupImages(root); });
    safe('g-mermaid', function () { renderDiagrams(root); });
    safe('g-links', function () { bindLinks(root); });
    root.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
    root.querySelectorAll('input[type=checkbox]').forEach(function (n) { n.disabled = true; n.removeAttribute('data-task'); });
  }
  function baseSrcOf(mode) {
    var d = curDoc(); if (!d) return '';
    return mode === 'ext' ? (d.extBase || '') : (d.savedText || '');
  }

  function chgCount() { return changeSet().n; }

  /* B 层：磁盘上这份，相对「你上次认可的那份」改了哪儿。
     只在你自己还没动这篇文档时才算 —— 一旦有了未保存的改动，块的位置就漂了，
     而且那时候你要关心的是「Save 会写进去什么」，B 层该让位。 */
  var extCache = null;
  function extChangeSet() {
    var d = curDoc();
    if (!d || d.dirty || !d.extBase) return emptyChg();
    var cur = d.savedText == null ? '' : d.savedText;      // 此刻 text === savedText === 磁盘内容
    if (extCache && extCache.id === d.id && extCache.blocks === docBlocks && extCache.base === d.extBase) return extCache.res;
    var res = (cur.trim() && !docBlocks.length) ? emptyChg() : diffDoc(extBaseBlocks(d), docBlocks);
    extCache = { id: d.id, blocks: docBlocks, base: d.extBase, res: res };
    return res;
  }
  /* 同一时刻只有一层是「当下要看的」：你自己的改动优先，没有才轮到外面的 */
  function chgMode() {
    if (changeSet().n) return 'own';
    var d = curDoc();
    if (extChangeSet().n) return 'ext';
    if (d && d.extBig && !d.dirty) return 'big';            // 知道变了，但当初没存下全文，定位不到
    return '';
  }
  function activeSet() { var cs = changeSet(); return cs.n ? cs : extChangeSet(); }
  function chgCountAny() { var m = chgMode(); return m === 'big' ? 1 : activeSet().n; }

  var chgIdx = -1;                    // 当前聚焦到第几处（-1 = 还没开始逐条看）
  var diffAll = false;                // true = 所有改动点同时就地展开
  function paintChanges() {
    var d = curDoc(), mode = chgMode(), cs = activeSet();
    ROOT.classList.toggle('has-chg', !!mode && (cs.n > 0 || mode === 'big'));
    ROOT.dataset.chgmode = mode;                  // own = 琥珀（你还没写进去）· ext = 蓝（别处已经写进去了）
    ROOT.dataset.chg = (chgMarks && cs.n && mode !== 'big') ? 'on' : 'off';
    preview.querySelectorAll('.blk[data-chg]').forEach(function (el) { el.removeAttribute('data-chg'); });
    preview.querySelectorAll('.chg-del,.chg-diff').forEach(function (el) { el.remove(); });
    if (chgIdx >= cs.list.length) chgIdx = cs.list.length - 1;   // 还原掉一处之后，焦点顺势落到下一处
    if (!cs.n) { chgIdx = -1; diffAll = false; }
    updateChgChip(cs, mode);
    if (cs.n && chgMarks && mode !== 'big') {
      Object.keys(cs.mark).forEach(function (i) { var el = blkEl(+i); if (el) el.setAttribute('data-chg', cs.mark[i]); });
      cs.list.forEach(function (c, n) {
        var open = diffAll || n === chgIdx;
        if (open) insertDiffCard(c, n, mode);             // 展开：渲染态的「原来」
        else if (c.k === 'del') insertDelMark(c, n);      // 收起：删除处留一道虚线（点开就是上面那张卡片）
      });
    }
    updateChgNav(cs, mode);
    paintBanner(d, mode, cs);
    if (chgPanelOpen()) { if (cs.n || mode === 'big') renderChgPanel(); else toggleChgPanel(false); }
  }
  /* 就地展开这一处的「原来」。卡片是块的兄弟节点，不塞进块里面 ——
     块的 DOM 是编辑时反译回 Markdown 的依据，往里加东西会污染源码。
     「现在」不用画：卡片下面那个真实的块就是，而且它天生带着全文的上下文。 */
  function insertDiffCard(c, n, mode) {
    var ext = (mode === 'ext'), src = baseSrcOf(mode);
    var card = document.createElement('div');
    card.className = 'chg-diff'; card.dataset.at = c.i; card.dataset.n = n; card.dataset.k = c.k;
    var tag = c.k === 'add' ? '新增' : (c.k === 'del' ? '删除' : '原来');
    var what, ghost = '', detail = '';
    if (c.k === 'mod') {
      what = (ext ? '别处把这块改了' : '这块被改过') + ' · 下面那块是现在的样子';
      detail = modDetail(c);
      /* 表格改动的 detail 本身就是一张「原来 → 现在」的对照表（逐格标了旧值），
         再画一张旧表的 ghost 就成了三张表叠在一起。所以只有非表格块（或表格
         比对没生成对照视图时）才补一张旧内容的 ghost。 */
      if (!/\bcd-detail-table\b/.test(detail)) {
        ghost = '<div class="cd-ghost">' + renderBlockSafe(c.old, src) + '</div>';
      }
    } else if (c.k === 'add') {
      what = ext ? '别处新加的一块 —— 原来没有它' : '原来没有这一块，下面那块是新加的';
    } else {
      what = (ext ? '别处删掉了 ' : '这里原来有 ') + c.count + ' 块，现在没有了';
      ghost = '<div class="cd-ghost">' + c.olds.map(function (r) { return renderBlockSafe(r, src); }).join('') + '</div>';
    }
    card.innerHTML =
      '<div class="cd-head"><span class="cd-tag">' + tag + '</span><span class="cd-what">' + what + '</span></div>' +
      ghost + detail +
      '<div class="cd-acts">' +
        (ext ? '' : '<button type="button" data-cd="revert" class="cd-primary">' + (c.k === 'del' ? '恢复这' + c.count + '块' : '撤回这处') + '</button>') +
        '<button type="button" data-cd="prev" title="上一处（Alt+↑）">↑</button>' +
        '<button type="button" data-cd="next" title="下一处（Alt+↓）">↓</button>' +
        '<button type="button" data-cd="close">收起</button>' +
      '</div>';
    placeAt(card, c.i);
    enhanceGhost(card);
    if (window.DSTableDiff) DSTableDiff.bind(card);   // 表格审阅里的「只看改动」开关                                   // 图片 / 图表 / callout / 表格：回放也得跟正文长一样
  }
  /* 收起态的删除痕迹：正文里留一道虚线，点它就展开成上面那张渲染态卡片 */
  function insertDelMark(c, n) {
    var node = document.createElement('div');
    node.className = 'chg-del'; node.dataset.at = c.i; node.dataset.n = n;
    node.setAttribute('title', '这里原来有内容 —— 点一下看它原本长什么样');
    node.innerHTML = '<span class="cd-lab">✕ 这里删掉了 ' + c.count + ' 块内容</span>';
    placeAt(node, c.i);
  }
  function placeAt(node, i) {
    var ref = null;
    for (var k = i; k < docBlocks.length && !ref; k++) ref = blkEl(k);
    if (ref) preview.insertBefore(node, ref);
    else { var end = $('#blkAddEnd'); if (end && end.parentNode === preview) preview.insertBefore(node, end); else preview.appendChild(node); }
  }
  /* 「精确到词」这一行长什么样，取决于这一块是什么：
     表格 → 逐格列出真的变了的那几格；代码 → 空白照实标（缩进就是内容）；其余 → 一行流式。 */
  function modDetail(c) {
    var b = docBlocks[c.i], type = b ? b.type : '', now = blockRawAt(c.i);

    if (type === 'table') {
      /* 表格改动画回表格里看 —— 逐格高亮、增删行原位标注。
         比「第 3 行 · 单价：12 → 15」这种清单直观得多：不用在脑子里
         把坐标还原成表格，扫一眼就知道动了哪儿。 */
      if (window.DSTableDiff) {
        var onlyChanged = window.DSPrefs
          ? window.DSPrefs.get('table-review-only-changed', false) : false;
        var tv = null;
        try {
          tv = DSTableDiff.review(c.old, now, {
            wordDiff: function (a, b2) { return inlineWordDiff(a, b2); },
            onlyChanged: onlyChanged
          });
        } catch (e) { tv = null; }
        if (tv && tv.empty) {
          return '<div class="cd-detail cd-quiet">只是把表格的对齐空白重排了一遍，格子里的内容没变</div>';
        }
        if (tv && tv.html) return tv.html;
      }
      // 表格太大或解析不出来 → 退回清单式，至少信息不丢
      var cells = tableCellDiff(c.old, now);
      if (cells) {
        if (!cells.length) return '<div class="cd-detail cd-quiet">只是把表格的对齐空白重排了一遍，格子里的内容没变</div>';
        return '<div class="cd-cells">' + cells.map(function (x) {
          return '<div class="cd-cell"><span class="cd-where">' + escapeHtml(x.where) + '</span><span class="cd-cdiff">' + x.diff + '</span></div>';
        }).join('') + '</div>';
      }
    }

    var html = inlineWordDiff(c.old, now, type === 'code');
    if (!/<(del|ins)\b/.test(html)) return '<div class="cd-detail cd-quiet">只动了空白（空格 / 换行），块里的内容没变</div>';
    return '<div class="cd-detail">' + html + '</div>';
  }
  function blockRawAt(i) { var b = docBlocks[i]; return b ? blockSource(b) : ''; }
  function updateChgNav(cs, mode) {
    var nav = $('#chgNav'); if (!nav) return;
    var c = $('#chgNavCount');
    if (c) c.textContent = (cs.n && mode !== 'big') ? ((chgIdx < 0 ? '·' : chgIdx + 1) + '/' + cs.list.length) : '·';
  }
  /* 上一处 / 下一处：跳过去，并且只把这一处就地展开 */
  function gotoChange(dir) {
    var cs = activeSet();
    if (!cs.n) { toast('没有可跳转的改动'); return; }
    if (!chgMarks) { chgMarks = true; store.set('chgmarks', '1'); }
    var n = cs.list.length;
    chgIdx = (chgIdx < 0) ? (dir > 0 ? 0 : n - 1) : ((chgIdx + dir) % n + n) % n;
    paintChanges();
    jumpToChange(chgIdx);
  }
  /* 打开就看见：文件在你不在的时候变过，正文顶上直接说一声 */
  function paintBanner(d, mode, cs) {
    var el = $('#chgBanner'); if (!el) return;
    var show = !bannerOff && (mode === 'ext' || mode === 'big');
    ROOT.classList.toggle('has-ext', show);
    if (!show) return;
    var when = d && d.extTs ? '（上次是' + agoText(d.extTs) + '）' : '';
    var txt = mode === 'big'
      ? '这个文件在别处被改过 —— 它太大，没存下当时的原文，定位不到具体位置' + when
      : '你上次看过之后，这个文件在别处被改过 <b>' + cs.n + '</b> 处' + when;
    el.innerHTML = '<span class="cb-dot"></span><span class="cb-txt">' + txt + '</span>' +
      (mode === 'ext' ? '<button class="cb-btn" type="button" data-cb="list">看改了哪儿</button>' : '') +
      '<button class="cb-btn cb-ok" type="button" data-cb="ack">知道了</button>' +
      '<button class="cb-x" type="button" data-cb="hide" title="先收起来，标记还留着">✕</button>';
  }
  /* 外面改的东西已经在文件里了，Save 不会动它 —— 所以「确认已读」就是把基线推到当前 */
  function ackExternal() {
    var d = curDoc(); if (!d) return;
    var n = extChangeSet().n;
    seenPut(d, d.savedText == null ? (d.text || '') : d.savedText);
    d.extBase = null; d.extBig = false; d.extTs = 0; d._extBlks = null; extCache = null;
    toggleChgPanel(false);
    updateSaveState();
    toast(n ? '已确认这 ' + n + ' 处外部改动 · 痕迹清零' : '已确认外部改动 · 痕迹清零', 'ok');
  }
  function updateChgChip(cs, mode) {
    var b = $('#chgBtn'); if (!b) return;
    b.classList.toggle('ext', mode === 'ext' || mode === 'big');
    if (mode === 'big') {
      b.innerHTML = '别处改过';
      b.title = '这个文件在别处被改过，但当初没存下原文，定位不到具体位置';
      return;
    }
    b.innerHTML = '<span class="cg-n">' + cs.n + '</span> ' + (mode === 'ext' ? '处新变化' : '处改动');
    b.title = !cs.n ? '没有未保存的改动'
      : (mode === 'ext'
          ? ('你上次看过之后，别处改了 ' + cs.n + ' 处（已经在文件里了）—— 点开逐条看')
          : ('未保存：新增 ' + cs.add + ' · 修改 ' + cs.mod + ' · 删除 ' + cs.del + ' —— 点开逐条看' + (chgMarks ? '' : '（正文标记已关）')));
  }

  /* ---------- 改动清单面板 ---------- */
  function chgPanelOpen() { var p = $('#chgPanel'); return !!(p && p.classList.contains('open')); }
  function toggleChgPanel(on) {
    var p = $('#chgPanel'), b = $('#chgBtn'); if (!p) return;
    var want = (on == null) ? !p.classList.contains('open') : !!on;
    p.classList.toggle('open', want);
    if (b) { b.classList.toggle('on', want); b.setAttribute('aria-expanded', want ? 'true' : 'false'); }
    if (want) renderChgPanel();
  }
  function chgTargetLabel(d) {
    if (!d) return '';
    if (d.handle) return '写回 <b>' + escapeHtml(d.name) + '</b>（原文件）';
    return '还没有绑定本地文件 —— Save 时会让你选一次保存位置';
  }
  function renderChgPanel() {
    var p = $('#chgPanel'); if (!p) return;
    var d = curDoc(), mode = chgMode(), cs = activeSet(), ext = (mode === 'ext');
    p.dataset.mode = mode || 'own';
    var head = '<div class="chg-head"><span class="chg-title">' + (ext ? '上次保存之后的变化' : '未保存的改动') + '</span>' +
      (cs.n ? '<span class="chg-nav-mini"><button type="button" data-chg-act="prev" title="上一处（Alt+↑）">↑</button>' +
              '<button type="button" data-chg-act="next" title="下一处（Alt+↓）">↓</button>' +
              '<button type="button" data-chg-act="all" class="' + (diffAll ? 'on' : '') + '" title="所有改动点就地展开「原来 → 现在」">全部展开</button></span>' : '') +
      '<span class="chg-sum">' +
      '<span class="s-add">＋' + cs.add + '</span><span class="s-mod">～' + cs.mod + '</span><span class="s-del">－' + cs.del + '</span></span></div>';
    var body, foot;
    if (mode === 'big') {
      body = '<div class="chg-empty">这个文件在别处被改过。<br>它超过 128KB，当初没存下原文，定位不到改在哪儿。</div>';
      foot = '<div class="chg-foot"><span class="chg-toggle">只能告诉你「变了」</span><button class="btn primary" type="button" data-chg-act="ack">知道了</button></div>';
    } else if (!cs.n) {
      body = '<div class="chg-empty">文件和你现在看到的一模一样。<br>改点什么，这里就会列出改了哪儿。</div>';
      foot = '<div class="chg-foot"><label class="chg-toggle"><input type="checkbox" id="chgMarkTgl"' + (chgMarks ? ' checked' : '') + '>正文里显示标记</label></div>';
    } else {
      var rows = cs.list.map(function (c, n) {
        var badge = c.k === 'add' ? '＋' : (c.k === 'mod' ? '～' : '－');
        var what = c.k === 'add' ? ((ext ? '别处新增 · ' : '新增 · ') + typeZh(c.type))
                 : c.k === 'mod' ? ((ext ? '别处修改 · ' : '修改 · ') + typeZh(c.type))
                 : ((ext ? '别处删除 · ' : '删除 · ') + c.count + ' 块');
        return '<div class="chg-row' + (n === chgIdx ? ' on' : '') + '" data-k="' + c.k + '" data-n="' + n + '" role="button" tabindex="0" title="点一下跳过去，就地展开它原来的样子">' +
                 '<span class="chg-badge">' + badge + '</span>' +
                 '<div class="chg-body"><div class="chg-what">' + what + '</div>' +
                   '<div class="chg-text">' + escapeHtml(c.text) + '</div></div>' +
                 (ext ? '' : '<button class="chg-undo" type="button" data-undo="' + n + '" title="把这一处改回上次保存的样子">撤回</button>') +
               '</div>';
      }).join('');
      var where = ext
        ? '这些改动<b>已经在文件里了</b> —— Save 不会改变它们' + (d && d.extTs ? '。你上次看到的是' + agoText(d.extTs) + '的版本' : '')
        : '保存后：' + chgTargetLabel(d);
      body = '<div class="chg-where">' + where + '</div><div class="chg-list">' + rows + '</div>';
      foot = '<div class="chg-foot"><label class="chg-toggle"><input type="checkbox" id="chgMarkTgl"' + (chgMarks ? ' checked' : '') + '>正文里显示标记</label>' +
        (ext ? '<button class="btn primary" type="button" data-chg-act="ack">知道了</button>'
             : '<button class="btn" type="button" data-chg-act="revertAll">撤回全部</button><button class="btn primary" type="button" data-chg-act="save" title="把这 ' + cs.n + ' 处改动全部写回文件">保存（接受全部）</button>') +
        '</div>';
    }
    p.innerHTML = head + body + foot;
  }
  function jumpToChange(n) {
    var cs = activeSet(), c = cs.list[n]; if (!c) return;
    chgIdx = n;
    var el = preview.querySelector('.chg-diff[data-n="' + n + '"]');
    if (!el && c.k === 'del') el = preview.querySelector('.chg-del[data-at="' + c.i + '"]');
    if (!el) el = blkEl(c.i) || blkEl(c.i - 1);
    if (!el) { toast('这处改动暂时没法定位（试试打开正文标记）'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('chg-focus'); void el.offsetWidth; el.classList.add('chg-focus');
    setTimeout(function () { el.classList.remove('chg-focus'); }, 1400);
    updateChgNav(cs, chgMode());
  }
  function revertOne(n) {
    closeBlockEditor(true); endCellEdit(true);                       // 先让正在编辑的内容落盘，索引才作数
    var cs = changeSet(), c = cs.list[n]; if (!c) return;
    if (c.k === 'mod') replaceBlock(c.i, c.old);
    else if (c.k === 'add') replaceBlock(c.i, '');
    else {
      var md = c.olds.join('\n\n');
      if (c.i < docBlocks.length) insertBlock(c.i, 'before', md);
      else insertAt(docText().length, md);
    }
    toast('已撤回这一处 · ⌘/Ctrl+Z 可反悔', 'ok');
  }
  function revertAll() {
    var d = curDoc(); if (!d) return;
    closeBlockEditor(true); endCellEdit(true);
    var n = chgCount(); if (!n) { toast('没有需要还原的改动'); return; }
    if (!confirm('放弃这 ' + n + ' 处未保存的改动，把文档恢复成上次保存时的样子？\n（还原之后 ⌘/Ctrl+Z 仍然可以撤销）')) return;
    commitText(d.savedText || '');
    toggleChgPanel(false);
    toast('已撤回全部改动，回到上次保存的样子', 'ok');
  }
  function initChanges() {
    var b = $('#chgBtn');
    if (b) b.addEventListener('click', function (e) { e.stopPropagation(); toggleChgPanel(); });
    var p = $('#chgPanel');
    if (p) {
      p.addEventListener('click', function (e) {
        e.stopPropagation();
        var t = e.target; if (!t || !t.closest) return;
        var act = t.closest('[data-chg-act]');
        if (act) {
          var a = act.dataset.chgAct;
          if (a === 'save') { toggleChgPanel(false); saveDoc(); }
          else if (a === 'ack') ackExternal();
          else if (a === 'prev') gotoChange(-1);
          else if (a === 'next') gotoChange(1);
          else if (a === 'all') { diffAll = !diffAll; if (diffAll && !chgMarks) { chgMarks = true; store.set('chgmarks', '1'); } paintChanges(); }
          else revertAll();
          return;
        }
        var u = t.closest('[data-undo]');
        if (u) { revertOne(+u.dataset.undo); return; }
        if (t.closest('.chg-toggle')) return;                        // 交给 change 事件
        var row = t.closest('.chg-row');
        if (row) jumpToChange(+row.dataset.n);
      });
      p.addEventListener('keydown', function (e) {
        var row = e.target && e.target.closest && e.target.closest('.chg-row');
        if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); jumpToChange(+row.dataset.n); }
      });
      p.addEventListener('change', function (e) {
        if (e.target && e.target.id === 'chgMarkTgl') {
          chgMarks = e.target.checked; store.set('chgmarks', chgMarks ? '1' : '0');
          paintChanges();
          toast(chgMarks ? '正文里会标出改动点' : '已关掉正文标记 · 改动数还在顶栏');
        }
      });
    }
    document.addEventListener('click', function (e) {
      if (chgPanelOpen() && !(e.target && e.target.closest && e.target.closest('.chg-wrap'))) toggleChgPanel(false);
    });
    document.addEventListener('keydown', keyGate(function (e) {
      if (e.key === 'Escape' && chgPanelOpen()) { toggleChgPanel(false); return; }
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {   // Alt+↑/↓：上一处 / 下一处
        if (ROOT.dataset.mode === 'source' || !chgCountAny()) return;
        e.preventDefault(); gotoChange(e.key === 'ArrowDown' ? 1 : -1); return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) {   // ⌘/Ctrl+⇧+D：改动清单
        e.preventDefault(); if (!chgCountAny()) { toast('没有未保存的改动'); return; } toggleChgPanel(true);
      }
    }));
    // 点删除痕迹 → 展开 / 收起被删掉的原文；点就地卡片上的按钮 → 撤回 / 上下一处 / 收起
    preview.addEventListener('click', function (e) {
      var t = e.target; if (!t || !t.closest) return;
      var cb = t.closest('.chg-diff [data-cd]');
      if (cb) {
        e.preventDefault(); e.stopPropagation();
        var card = cb.closest('.chg-diff'), n = +card.dataset.n, a = cb.dataset.cd;
        if (a === 'revert') revertOne(n);
        else if (a === 'prev') gotoChange(-1);
        else if (a === 'next') gotoChange(1);
        else { if (diffAll) diffAll = false; chgIdx = -1; paintChanges(); }
        return;
      }
      if (t.closest('.chg-diff')) { e.stopPropagation(); return; }      // 卡片里的文字不该触发编辑
      var dm = t.closest('.chg-del');
      if (!dm) return;
      e.preventDefault(); e.stopPropagation();
      var dn = +dm.dataset.n;                 // 展开 = 聚焦到这一处，卡片替掉虚线
      chgIdx = dn; paintChanges(); jumpToChange(dn);
    }, true);
    var nav = $('#chgNav');
    if (nav) nav.addEventListener('click', function (e) {
      var b = e.target && e.target.closest && e.target.closest('[data-cn]'); if (!b) return;
      e.stopPropagation();
      var a = b.dataset.cn;
      if (a === 'prev') gotoChange(-1);
      else if (a === 'next') gotoChange(1);
      else toggleChgPanel();
    });
    var ban = $('#chgBanner');
    if (ban) ban.addEventListener('click', function (e) {
      var b = e.target && e.target.closest && e.target.closest('[data-cb]'); if (!b) return;
      e.stopPropagation();
      var a = b.dataset.cb;
      if (a === 'ack') ackExternal();
      else if (a === 'list') { toggleChgPanel(true); jumpToChange(0); }
      else { bannerOff = true; ROOT.classList.remove('has-ext'); }
    });
  }

  var MD_PICK_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mkd', '.mdx'] } }];
  function isDirty() { var d = curDoc(); return !!(d && d.dirty); }
  function updateSaveState() {
    var d = curDoc(), dirty = !!(d && d.dirty);
    var btn = $('#saveBtn');
    var n = dirty ? chgCount() : 0;
    if (btn) { btn.classList.toggle('dirty', dirty); btn.title = (n ? '有 ' + n + ' 处未保存的改动 · ' : dirty ? '有未保存的修改 · ' : '') + '保存 Markdown 到本地文件（⌘/Ctrl + S）'; }
    paintChanges();
    renderFileList();
  }
  function fsaSaveSupported() { return typeof window.showSaveFilePicker === 'function'; }
  function ensureRWPermission(handle) {
    return new Promise(function (res) {
      if (!handle || !handle.queryPermission) return res(true);
      var opts = { mode: 'readwrite' };
      Promise.resolve(handle.queryPermission(opts)).then(function (p) {
        if (p === 'granted') return res(true);
        Promise.resolve(handle.requestPermission(opts)).then(function (p2) { res(p2 === 'granted'); }, function () { res(false); });
      }, function () { res(false); });
    });
  }
  function writeToHandle(handle, text) {
    return handle.createWritable().then(function (w) { return Promise.resolve(w.write(text)).then(function () { return w.close(); }); });
  }
  /* Save 的含义在这一版里统一成了「我认可现在这份」：写回磁盘只是它在有未保存改动时的副作用，
     它同时会把跨会话的基线推到当前 —— 于是两层痕迹一起归零。 */
  function markSaved(d) {
    d.savedText = d.text; d.dirty = false;
    seenPut(d, d.text);
    d.extBase = null; d.extBig = false; d.extTs = 0; d._extBlks = null; extCache = null; bannerOff = false;
    updateSaveState();
  }

  function saveDoc() {
    var d = curDoc();
    if (!d) { toast('先打开或新建一个文档', 'err'); return; }
    closeBlockEditor(true); endCellEdit(true);                            // 先把正在编辑的块 / 单元格落盘
    d = curDoc() || d;
    if (ROOT.dataset.mode === 'source' && editor.value !== d.text) { histPush(editor.value); d.text = editor.value; d.dirty = (d.text !== (d.savedText || '')); }
    var text = d.text || '';
    // 没东西可写、但外面改过 → 这一按的意思只能是「我看过了」，把基线推到当前就行，不碰文件
    if (!d.dirty && (extChangeSet().n || d.extBig)) { ackExternal(); return; }
    if (!d.dirty && d.handle) { toast('没有需要保存的改动', 'ok'); return; }
    var n = chgCount();                                                  // 写回之前先记下这次带走了几处
    var wrote = function () { return n ? ' · 写回 ' + n + ' 处改动' : ''; };
    toggleChgPanel(false);

    if (d.handle) {                                                      // ① 原地写回
      ensureRWPermission(d.handle).then(function (ok) {
        if (!ok) { toast('无法获得该文件的写入权限，改为「另存为」', 'err'); saveAs(d, text); return; }
        writeToHandle(d.handle, text).then(function () {
          markSaved(d); toast('已保存到原文件 ✓' + wrote(), 'ok');
        }, function (e) { toast('写入失败：' + ((e && e.message) || e) + '，改为另存', 'err'); saveAs(d, text); });
      });
      return;
    }
    saveAs(d, text);                                                     // ② / ③
  }

  function saveAs(d, text) {
    var n = chgCount(), wrote = n ? ' · 写回 ' + n + ' 处改动' : '';
    if (fsaSaveSupported()) {
      var suggested = (d.name && /\.(md|markdown|mkd|mdx)$/i.test(d.name)) ? d.name : (currentName() + '.md');
      var p;
      try { p = window.showSaveFilePicker({ suggestedName: suggested, types: MD_PICK_TYPES }); }
      catch (e) { p = null; }                                            // 跨源 iframe 会同步抛错
      if (p && p.then) {
        p.then(function (handle) {
          return ensureRWPermission(handle).then(function (ok) {
            if (!ok) throw new Error('no-permission');
            return writeToHandle(handle, text).then(function () {
              d.handle = handle; if (handle.name) { d.name = handle.name; d.relPath = handle.name; }
              markSaved(d); updateWorkspaceTitle(); renderFileList();
              toast('已保存 ✓' + wrote + ' · 之后按 ⌘/Ctrl+S 可直接写回这个文件', 'ok');
            });
          });
        }, function (e) {
          if (e && e.name === 'AbortError') return;                      // 用户取消，不做任何事
          downloadMd(d, text);                                           // 其它错误 → 退回下载
        });
        return;
      }
    }
    downloadMd(d, text);
  }

  function downloadMd(d, text) {
    download((currentName() || 'document') + '.md', text, 'text/markdown');
    markSaved(d);
    toast(IN_SHELL ? '已导出 .md 到下载目录（当前环境不支持原地写回，请覆盖你的本地文件）'
                   : '已下载 .md（此浏览器不支持原地写回，请覆盖你的本地文件）');
  }

  /* 用 File System Access 打开文件：拿到可写句柄，编辑后才能原地保存回去 */
  function openFiles() {
    if (typeof window.showOpenFilePicker === 'function') {
      var p;
      try { p = window.showOpenFilePicker({ multiple: true, types: MD_PICK_TYPES }); }
      catch (e) { p = null; }
      if (p && p.then) {
        p.then(function (handles) {
          Promise.all(handles.map(function (h) { return h.getFile().then(function (f) { f._handle = h; return f; }); }))
            .then(function (files) { if (files.length) ingest(files); });
        }, function (e) { if (e && e.name !== 'AbortError') $('#fileInput').click(); });
        return;
      }
    }
    $('#fileInput').click();
  }

  /* ---------- status -------------------------------------------------- */
  function updateStatus(text) { text = text || ''; var words = (text.trim().match(/[\u4e00-\u9fa5]|[A-Za-z0-9]+/g) || []).length; var min = Math.max(1, Math.round(words / 220)); var n = isDirty() ? chgCount() : 0; statusEl.textContent = (currentId ? currentName() + ' · ' : '') + words + ' words · ~' + min + ' min read' + (currentUrl ? ' · from URL' : '') + (isDirty() ? ' · ● 未保存' + (n ? '（' + n + ' 处改动）' : '') : ''); }

  /* ---------- folder (File System Access API + fallback) ------------- */
  function readDir(handle, path, out) {
    return (async function () {
      for await (var entry of handle.values()) {
        if (entry.kind === 'file') { var f = await entry.getFile(); f._rel = path + entry.name; f._handle = entry; out.push(f); }
        else if (entry.kind === 'directory') { await readDir(entry, path + entry.name + '/', out); }
      }
    })();
  }
  function updateReloadFolderState() {
    var b = $('#openMenu [data-open="reload-folder"]');
    if (!b) return;
    b.disabled = !currentFolderHandle;
    b.title = currentFolderHandle ? '重新读取“' + currentFolderHandle.name + '”的最新内容' : '先打开一个文件夹';
  }
  function openFolder() {
    if (window.showDirectoryPicker) {
      var p;
      try { p = window.showDirectoryPicker(); }
      catch (e) { p = null; }                                            // 跨源 iframe 会同步抛错（和上面两个选择器一样）
      if (p && p.then) {
        p.then(function (dir) {
          var out = [];
          readDir(dir, '', out).then(function () {
            if (!out.some(function (f) { return /\.(md|markdown|mkd|mdx)$/i.test(f.name); })) { toast('没有找到 .md 文件', 'err'); return; }
            currentFolderHandle = dir;
            out.forEach(function (f) { f._folderRoot = dir; });
            updateReloadFolderState();
            ingest(out);
          }, function (e) { toast('读取文件夹失败：' + ((e && e.message) || e), 'err'); });
        }, function (e) { if (e && e.name !== 'AbortError') $('#folderInput').click(); });
        return;
      }
    }
    $('#folderInput').click();
  }
  function reloadFolder() {
    var dir = currentFolderHandle;
    if (!dir) { toast('请先用“打开文件夹”载入一个文件夹', 'err'); return; }
    var dirty = docs.filter(function (d) { return d.dirty; }).length;
    if (dirty && !confirm('重新载入会重新读取文件夹。\n当前有 ' + dirty + ' 个文件存在未保存修改，这些修改会保留，不会被磁盘内容覆盖。继续吗？')) return;
    toast('正在重新载入“' + dir.name + '”…');
    var out = [];
    readDir(dir, '', out).then(function () {
      out.forEach(function (f) { f._folderRoot = dir; });
      var mdFiles = out.filter(function (f) { return /\.(md|markdown|mkd|mdx)$/i.test(f.name); });
      if (!mdFiles.length) { toast('这个文件夹里没有找到 .md 文件', 'err'); return; }
      var byPath = {};
      docs.forEach(function (d) { if (d.source === 'file' && d.folderRoot === dir) byPath[(d.relPath || d.name).toLowerCase()] = d; });
      var fresh = [], reads = [], changed = 0, added = 0;
      mdFiles.forEach(function (f) {
        var rel = f._rel || f.name, key = rel.toLowerCase(), d = byPath[key];
        assetMap[key] = f;
        if (!d) { fresh.push(f); added++; return; }
        delete byPath[key];
        d.file = f; d.handle = f._handle || d.handle; d.folderRoot = dir; d.name = f.name; d.relPath = rel;
        if (d.dirty) return;
        var before = d.savedText;
        d.text = null;
        reads.push(loadDocText(d).then(function (text) {
          if (text !== before) changed++;
          d.text = text; d.savedText = text; checkExternal(d, text);
          if (d.id === currentId) {
            var y = previewPane.scrollTop;
            histReset(text); renderMarkdown(text); noSmooth(function () { previewPane.scrollTop = y; });
            syncEditor(); updateSaveState();
          }
        }));
      });
      var addedDocs = addDocs(fresh);
      Promise.all(reads).then(function () {
        Object.keys(byPath).forEach(function (key) {
          var d = byPath[key];
          if (d && !d.dirty) closeDoc(d.id, true);
        });
        renderFileList();
        if (!currentId && addedDocs.length) openDoc(addedDocs[0].id);
        var removedKeys = Object.keys(byPath), removed = 0, keptDirty = 0;
        removedKeys.forEach(function (key) { if (byPath[key].dirty) keptDirty++; else removed++; });
        toast('已重新载入“' + dir.name + '” · ' + mdFiles.length + ' 个文件'
          + (added ? ' · 新增 ' + added : '') + (removed ? ' · 移除 ' + removed : '')
          + (keptDirty ? ' · 保留 ' + keptDirty + ' 个未保存文件' : '')
          + (changed ? ' · 更新 ' + changed : ''), 'ok');
      });
    }, function (e) {
      if (e && e.name === 'NotAllowedError') toast('文件夹权限已失效，请重新打开文件夹', 'err');
      else toast('重新载入失败：' + ((e && e.message) || e), 'err');
    });
  }
  function ingest(fileList) { var arr = Array.prototype.slice.call(fileList); var added = addDocs(arr); if (added.length) { openDoc(added[0].id); toast('已载入 ' + added.length + ' 个文件（仅本地读取，未上传）'); } else toast('没有找到 .md 文件', 'err'); }
  function traverseEntry(entry, path, out) { return new Promise(function (res) { if (entry.isFile) entry.file(function (f) { f._rel = path + entry.name; out.push(f); res(); }, res); else if (entry.isDirectory) { var reader = entry.createReader(), all = []; (function rb() { reader.readEntries(function (ents) { if (!ents.length) { Promise.all(all.map(function (e) { return traverseEntry(e, path + entry.name + '/', out); })).then(res); return; } all = all.concat(ents); rb(); }, res); })(); } else res(); }); }

  /* ---------- wiring -------------------------------------------------- */
  function isNarrow() { return window.innerWidth <= 860; }
  function toggleSidebar(force) {
    if (isNarrow()) {
      var on = force == null ? !ROOT.classList.contains('side-open') : force;
      ROOT.classList.toggle('side-open', on);
    } else {
      var col = force == null ? !ROOT.classList.contains('side-collapsed') : !force;
      ROOT.classList.toggle('side-collapsed', col);
      store.set('sideCollapsed', col ? '1' : '0');
    }
  }
  function closeMenus() { var m = $('#openMenu'); if (m) m.classList.remove('open'); var u = $('#urlPop'); if (u) u.classList.remove('open'); var c = $('#openCaret'); if (c) c.setAttribute('aria-expanded', 'false'); }
  function openUrlPop() { closeMenus(); $('#urlPop').classList.add('open'); setTimeout(function () { urlInput.focus(); urlInput.select(); }, 20); }

  /* ---- back-to-top / to-bottom, scoped to the rendered preview --------
     Only the reading surface gets this. The editor textarea is deliberately
     left out: it is for writing, already has native Home/End / ⌘↑↓, and a
     floating button would sit on top of the text being typed.
     Each button shows only when it can move you: at the very top just "↓",
     near the bottom just "↑", both in between, and nothing at all when the
     document is too short to scroll — so it never competes with the content. */
  var EDGE = 320;  // px from an edge before the matching button appears
  function updateScrollNav() {
    var topBtn = $('#scrollTopBtn'), botBtn = $('#scrollBotBtn');
    if (!topBtn || !botBtn) return;
    var st = previewPane.scrollTop;
    var max = previewPane.scrollHeight - previewPane.clientHeight;
    var scrollable = max > EDGE + 40;                 // short docs: show neither
    topBtn.classList.toggle('show', scrollable && st > EDGE);
    botBtn.classList.toggle('show', scrollable && (max - st) > EDGE);
  }
  var scrollRun = 0, scrollBehaviorBefore = null;
  function finishPreviewScroll(run) {
    if (run !== scrollRun || scrollBehaviorBefore == null) return;
    previewPane.style.scrollBehavior = scrollBehaviorBefore;
    scrollBehaviorBefore = null;
  }
  function scrollPreviewTo(top) {
    var from = previewPane.scrollTop, to = Math.max(0, Math.min(top, previewPane.scrollHeight - previewPane.clientHeight));
    if (Math.abs(to - from) < 2) return;
    var run = ++scrollRun;
    if (scrollBehaviorBefore == null) scrollBehaviorBefore = previewPane.style.scrollBehavior;
    previewPane.style.scrollBehavior = 'auto';
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      previewPane.scrollTop = to; finishPreviewScroll(run); return;
    }
    var started = null, duration = Math.min(850, Math.max(360, Math.abs(to - from) * .32));
    function step(now) {
      if (run !== scrollRun) return;
      if (started == null) started = now;
      var p = Math.min(1, (now - started) / duration);
      var eased = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      previewPane.scrollTop = from + (to - from) * eased;
      if (p < 1) requestAnimationFrame(step); else finishPreviewScroll(run);
    }
    requestAnimationFrame(step);
  }
  function setupScrollNav() {
    var topBtn = $('#scrollTopBtn'), botBtn = $('#scrollBotBtn');
    if (!topBtn || !botBtn) return;
    topBtn.addEventListener('click', function () { scrollPreviewTo(0); });
    botBtn.addEventListener('click', function () { scrollPreviewTo(previewPane.scrollHeight); });
    previewPane.addEventListener('scroll', throttle(updateScrollNav, 120));
    window.addEventListener('resize', debounce(updateScrollNav, 150));
    updateScrollNav();
  }

  function initUI() {
    setupScrollNav();
    updateReloadFolderState();
    initFind();
    $('#urlBtn').addEventListener('click', function () { loadUrl(urlInput.value); $('#urlPop').classList.remove('open'); });
    urlInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { loadUrl(urlInput.value); $('#urlPop').classList.remove('open'); } if (e.key === 'Escape') $('#urlPop').classList.remove('open'); });

    $('#openBtn').addEventListener('click', function () { closeMenus(); openFiles(); });
    $('#openCaret').addEventListener('click', function (e) {
      e.stopPropagation();
      var m = $('#openMenu'), willOpen = !m.classList.contains('open');
      closeMenus(); m.classList.toggle('open', willOpen);
      this.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    $$('#openMenu .menu-item').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.dataset.open; closeMenus();
        if (a === 'file') openFiles();
        else if (a === 'folder') openFolder();
        else if (a === 'reload-folder') reloadFolder();
        else if (a === 'url') openUrlPop();
        else if (a === 'new') setEdit(true);
      });
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.open-group') && !e.target.closest('.url-pop')) closeMenus();
    });
    /* 这一整块 window 级快捷键，只在「Markdown 工作台正显示着」时生效。
       合并进外壳后三个能力共用一个 window，不设这道闸的话：在文件库界面上
       按 Ctrl+O，工作台和文件库会各弹一个「选文件」框。
       gate() 见 views/shared/active.js；它不在时退回原样（独立页面本来就
       只有一个能力，没有可抢的对象）。 */
    window.addEventListener('keydown', keyGate(function (e) {
      if (e.key === 'Escape' && findIsOpen()) { e.preventDefault(); closeFind(); return; }
      if (e.key === 'Escape') closeMenus();
      var meta = e.metaKey || e.ctrlKey;
      if (meta && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(false); return; }
      if (meta && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); openFind(true); return; }
      if (findIsOpen() && ((meta && (e.key === 'g' || e.key === 'G')) || e.key === 'F3')) {
        e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); return;
      }
      if (meta && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleSidebar(); }
      if (meta && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); if (e.shiftKey) openFolder(); else openFiles(); }
      if (meta && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveDoc(); }
      if (meta && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        if (e.shiftKey) setMode(ROOT.dataset.mode === 'source' ? 'read' : 'source');
        else setEdit(ROOT.dataset.edit !== 'on');
      }
      if (meta && (e.key === 'z' || e.key === 'Z') && ROOT.dataset.edit === 'on') {
        var t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;   // 让输入框用自己的撤销
        e.preventDefault(); e.shiftKey ? redo() : undo();
      }
    }));

    $('#folderInput').addEventListener('change', function (e) { if (e.target.files.length) ingest(e.target.files); e.target.value = ''; });
    $('#fileInput').addEventListener('change', function (e) { if (e.target.files.length) ingest(e.target.files); e.target.value = ''; });

    $('#sideToggle').addEventListener('click', function () { toggleSidebar(); });
    $('#sideRail').addEventListener('click', function () { toggleSidebar(); });

    /* 文件栏：搜索 + 全部关闭 */
    var ff = $('#fileFilter');
    if (ff) {
      ff.addEventListener('input', debounce(function () { fileQuery = ff.value.trim(); renderFileList(); }, 120));
      ff.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); ff.value = ''; fileQuery = ''; renderFileList(); ff.blur(); }
        if (e.key === 'Enter') {
          e.preventDefault();
          var first = filesBody.querySelector('.file-item');
          if (first) first.click();
        }
      });
    }
    var ffx = $('#fileFilterClear');
    if (ffx) ffx.addEventListener('click', function () { if (ff) ff.value = ''; fileQuery = ''; renderFileList(); if (ff) ff.focus(); });
    var closeAllBtn = $('#filesCloseAll');
    if (closeAllBtn) closeAllBtn.addEventListener('click', closeAllDocs);
    $$('.side-head').forEach(function (h) { h.addEventListener('click', function () { this.closest('.side-sec').classList.toggle('collapsed'); }); });

    $('#editBtn').addEventListener('click', function () { setEdit(ROOT.dataset.edit !== 'on'); });
    $('#srcBtn').addEventListener('click', function () { setMode(ROOT.dataset.mode === 'source' ? 'read' : 'source'); });
    $('#undoBtn').addEventListener('click', function () { undo(); });
    $('#redoBtn').addEventListener('click', function () { redo(); });
    $('#saveBtn').addEventListener('click', function () { saveDoc(); });
    editor.addEventListener('input', onEditInput);
    editor.addEventListener('keydown', function (e) {
      var meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 's' || e.key === 'S')) { e.preventDefault(); var d = curDoc(); if (d && editor.value !== d.text) { histPush(editor.value); d.text = editor.value; d.dirty = (d.text !== (d.savedText || '')); } saveDoc(); return; }
      if (meta && e.shiftKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); setMode('read'); return; }
      if (e.key === 'Tab') { e.preventDefault(); var s = editor.selectionStart, en = editor.selectionEnd; editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(en); editor.selectionStart = editor.selectionEnd = s + 2; onEditInput(); }
    });
    initEditing();
    initChanges();

    var panel = $('#settingsPanel');
    $('#settingsBtn').addEventListener('click', function (e) { e.stopPropagation(); panel.classList.toggle('open'); });
    document.addEventListener('click', function (e) { if (!panel.contains(e.target) && e.target.id !== 'settingsBtn') panel.classList.remove('open'); });
    $$('.seg-opt').forEach(function (b) { b.addEventListener('click', function () { var set = b.dataset.set, val = b.dataset.val; if (set === 'theme') { setAppearance({ theme: val }, 'local'); } else if (set === 'font') { settings.font = val; saveSettings(); applyReading(); } else if (set === 'refresh') { settings.refresh = parseInt(val, 10); saveSettings(); applyReading(); startAutoRefresh(); } }); });
    $('#sizeRange').addEventListener('input', function () { settings.size = parseInt(this.value, 10); $('#sizeVal').textContent = settings.size + 'px'; preview.style.fontSize = settings.size + 'px'; saveSettings(); });
    $('#widthRange').addEventListener('input', function () { settings.width = parseInt(this.value, 10); $('#widthVal').textContent = settings.width + 'px'; preview.style.setProperty('--doc-measure', settings.width + 'px'); saveSettings(); });
    $('#proxyChk').addEventListener('change', function () { store.set('proxy', this.checked ? '1' : '0'); });
    $('#cssApply').addEventListener('click', function () { applyCustomCss($('#cssArea').value); toast('Custom CSS applied.'); });
    $('#cssClear').addEventListener('click', function () { $('#cssArea').value = ''; applyCustomCss(''); toast('Custom CSS cleared.'); });

    // 先弹「选择分享格式」的面板，再各自上传
    $('#shareBtn').addEventListener('click', function () { openShareChooser(); });
    $('#shareModal .modal-close').addEventListener('click', function () { $('#shareModal').classList.remove('open'); });
    $('#shareModal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('open'); });

    /* 「复制源码」= 复制 Markdown 原文。飞书和 WPS 粘进去都会自动渲染。
       为什么不复制 HTML：见 copyMarkdown() 上面那段（绕过一大圈的记录）。 */
    $('#copyBtn').addEventListener('click', function () { copyMarkdown(this); });
    /* ⚠ 这三个按钮不一定还在 DOM 里，所以一律用 on() 而不是直接 addEventListener。

       #downloadBtn 已经被 export-menu.js 的 mountExportMenu() 用 replaceChild
       换成了「导出 ▾」那个分体按钮 —— 而且是必然发生、不是偶发竞态：
       wire-up.js 是 <script type="module">，在 window 'load' 之前就执行完了，
       而 boot() 挂在 'load' 上。等 boot() 跑到这里，#downloadBtn 早就没了。

       于是这一行抛 TypeError，boot() 后面的代码**全部**不再执行：
       拖放打开文件、data-edit/data-mode 初始化、自定义 CSS、侧栏折叠记忆、
       未保存离开提醒 —— 全都静默失效。页面看着正常，功能少了一半。
       （用 headless Chrome 打开这一页就能看到那句 Uncaught TypeError；
         这个 bug 在改 iframe 之前就存在，不是重构引入的。）

       新按钮自己调 MDW.exportWord()，所以这里不用补绑，跳过即可。
       #printBtn 同理，被 toolbar.js 的 stash() 收进暗处但仍在 DOM 里；
       真被移除也不该连累其余初始化。 */
    function on(sel, ev, fn) { var el = $(sel); if (el) el.addEventListener(ev, fn); }
    on('#downloadBtn', 'click', exportWord);
    /* #printBtn 走 MDW.exportPdf()，不是裸的 window.print()。
       它藏在 attic 里，但命令面板和旧代码还按 id 点它。
       exportPdf() 现在就地唤起打印框（printInPlace()），并且会先把
       document.title 换成文件名 —— 直接 window.print() 就少了这一步，
       另存出来的 PDF 会叫「Docsmith」而不是原文件名；iframe 挂载那种
       走不通的情形也由它自动退回开标签页。所以统一从这个入口进。 */
    on('#printBtn', 'click', function () { if (!currentId) { toast('先打开一份文档', 'err'); return; } window.MDW.exportPdf(); });

    $$('[data-action]').forEach(function (b) { b.addEventListener('click', function () { var a = b.dataset.action; if (a === 'folder') openFolder(); else if (a === 'file') openFiles(); else if (a === 'url') openUrlPop(); else if (a === 'edit') setEdit(true); }); });

    /* ---- 拖放 -------------------------------------------------------
       ① 只对「拖文件」响应：拖选中的文字、拖页面里的链接不再糊一层遮罩；
       ② 用计数器代替 relatedTarget —— 经过子元素时不会闪，拖出窗口 / 按 Esc
          也能干净收尾（dragend + 兜底定时器）；
       ③ 显式 dropEffect='copy'，光标是「＋」而不是禁止符号。
       ------------------------------------------------------------------ */
    var dropZone = $('#dropZone'), dragDepth = 0, dragTimer = null;
    function hasFiles(dt) {
      if (!dt) return false;
      var t = dt.types; if (!t) return false;
      for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
      return false;
    }
    function dragOn() {
      ROOT.classList.add('dropping');
      if (dropZone) dropZone.classList.add('over');
      clearTimeout(dragTimer);
      dragTimer = setTimeout(dragOff, 4000);   // 兜底：任何漏掉的 leave
    }
    function dragOff() {
      dragDepth = 0; clearTimeout(dragTimer);
      ROOT.classList.remove('dropping');
      if (dropZone) dropZone.classList.remove('over');
    }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault(); dragDepth++; dragOn();
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
      dragOn();
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e.dataTransfer)) return;
      if (--dragDepth <= 0) dragOff();
    });
    window.addEventListener('dragend', dragOff);
    window.addEventListener('drop', function (e) {
      e.preventDefault(); dragOff();
      var dt = e.dataTransfer; if (!dt) return; var items = dt.items;

      // 优先用 File System Access 句柄 —— 这样拖进来的文件之后也能原地保存
      if (items && items.length && items[0].getAsFileSystemHandle) {
        var hp = []; for (var j = 0; j < items.length; j++) { if (items[j].kind === 'file') hp.push(items[j].getAsFileSystemHandle()); }
        Promise.all(hp).then(function (handles) {
          var out = [];
          return Promise.all(handles.map(function (h) {
            if (!h) return null;
            if (h.kind === 'directory') return readDir(h, '', out);
            return h.getFile().then(function (f) { f._rel = f.name; f._handle = h; out.push(f); });
          })).then(function () { if (out.length) ingest(out); else toast('没有找到 .md 文件', 'err'); });
        }).catch(function () { dropViaEntries(dt); });
        return;
      }
      dropViaEntries(dt);
    });
    function dropViaEntries(dt) {
      var items = dt.items, entries = [];
      if (items && items.length && items[0].webkitGetAsEntry) { for (var i = 0; i < items.length; i++) { var en = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry(); if (en) entries.push(en); } }
      if (entries.length) { var out = []; Promise.all(entries.map(function (en) { return traverseEntry(en, '', out); })).then(function () { if (out.length) ingest(out); else toast('没有找到 .md 文件', 'err'); }); }
      else if (dt.files && dt.files.length) ingest(dt.files);
    }

    // 拖放区本身：点击 / 回车 = 打开文件选择器
    if (dropZone) {
      dropZone.addEventListener('click', function () { $('#fileInput').click(); });
      dropZone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); }
      });
    }
  }

  /* ---------- shell messaging ---------------------------------------- */
  window.addEventListener('message', function (e) {
    var d = e.data; if (!d || d.ns !== BUS_NS) return;
    if (d.type === 'saveBlobAck' && d.id && window._mdrSaves && window._mdrSaves[d.id]) { clearTimeout(window._mdrSaves[d.id]); delete window._mdrSaves[d.id]; }
    else if (d.type === 'copyImageResult' && d.id && _copyReqs[d.id]) { _copyReqs[d.id](d.ok); }
    else if (d.type === 'appearance') setAppearance({ theme: d.theme, accent: d.accent }, 'shell');
  });

  /* 有未保存改动时，离开/刷新前提醒（独立打开时生效；工具台内切换标签不触发） */
  window.addEventListener('beforeunload', function (e) {
    if (docs.some(function (d) { return d && d.dirty; })) { e.preventDefault(); e.returnValue = ''; return ''; }
  });

  /* ---------- boot --------------------------------------------------- */
  function boot() {
    initUI();
    if (window.mermaid) mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', htmlLabels: false, fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', flowchart: { htmlLabels: false, useMaxWidth: false }, theme: Appearance.resolved() === 'dark' ? 'dark' : 'default' });
    var pc = $('#proxyChk'); if (pc) pc.checked = store.get('proxy', '0') === '1';
    settings = readReadingSettings();
    var ca = $('#cssArea'), savedCss = store.get('customCss', ''); if (ca) ca.value = savedCss; applyCustomCss(savedCss);
    applyReading();
    ROOT.classList.add('empty');
    ROOT.dataset.edit = 'off';
    ROOT.dataset.mode = 'read';
    updateWorkspaceTitle();
    histReset('');
    if (store.get('sideCollapsed', '0') === '1' && !isNarrow()) ROOT.classList.add('side-collapsed');

    applyShellAppearance();
    if (IN_SHELL) { try { window.parent.postMessage({ ns: BUS_NS, type: 'ready', tab: 'markdown' }, '*'); } catch (e) {} }

    var initUrl = null; try { initUrl = new URLSearchParams(location.search).get('url'); } catch (e) {}
    if (initUrl) { urlInput.value = initUrl; loadUrl(initUrl); }
  }
  /* ==================================================================
     对外接口 —— 审阅面板、偏好记忆通过它和工作台对话。
     只读为主，改动一律走 applyText，这样撤销栈、保存状态都不会乱。
     ================================================================== */
  var preferredExport = '';
  window.MDW = {
    /* 界面状态挂在哪个元素上。toolbar.js 也要读写 data-mode / data-edit，
       必须和这里用同一个根 —— 各自去找 document.body 的话，合并进外壳后
       一个写容器、一个写 body，工具栏的分段控件就再也跟不上真实状态。 */
    root: function () { return ROOT; },
    getBlocks: function () { return docBlocks.map(function (b) { return { type: b.type, raw: b.raw, start: b.start, end: b.end }; }); },
    getBlockElement: function (i) { return blkEl(i); },
    getTableData: function (i) { return tableAt(i); },
    flashBlock: function (i) { var el = blkEl(i); if (el) { flashBlock(el); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } },
    getDoc: function () {
      var d = curDoc();
      return d ? { id: d.id, key: stableDocKey(d), name: d.name, relPath: d.relPath || d.name,
        source: d.source, text: d.text == null ? '' : d.text, dirty: !!d.dirty } : null;
    },
    setText: function (t) { histPush(t); applyText(t); },
    getScroller: function () { return previewPane; },
    getPreviewRoot: function () { return preview; },
    isEmpty: function () { return !currentId; },
    toast: function (m) { toast(m, 'ok'); },

    /* 主题：工具栏上的那颗按钮通过这里改，好让"写 localStorage + 通知外壳"
       这套逻辑只有一份实现（就是 setAppearance），不会两边走岔。 */
    getTheme: function () { return appearNow().theme; },
    setTheme: function (t) { setAppearance({ theme: t }); },

    closeDoc: function (id) { return closeDoc(id || currentId); },
    closeAllDocs: closeAllDocs,
    focusFileSearch: function () {
      ROOT.classList.add('side-open');
      var el = $('#fileFilter'); if (el) { el.focus(); el.select(); }
    },

    /* 行号 → 正文里对应的那个块。审阅面板靠它定位和画改动条。 */
    elementAtLine: function (line) {
      var blocks = lexBlocks(docText());
      var acc = 0;
      for (var i = 0; i < blocks.length; i++) {
        var n = ((blocks[i].raw || '').match(/\n/g) || []).length + 1;
        if (line < acc + n) return blkEl(i);
        acc += n;
      }
      return blkEl(blocks.length - 1);
    },
    scrollToLine: function (line) {
      var el = window.MDW.elementAtLine(line);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },

    /* 外壳的设置面板改了阅读偏好 → 应用到当前文档。
       这样字号、行宽只有一个地方能改，不会出现"页面里改了一个、
       设置里还是老值"这种自相矛盾的状态。 */
    applyReadingSetting: function (name, value) {
      if (name === 'customCss') { applyCustomCss(value); return; }
      if (!(name in settings)) return;
      settings[name] = (name === 'size' || name === 'width' || name === 'refresh') ? Number(value) : value;
      applyReading();
      saveSettings();
    },

    /* 导出：四种格式各自的实现，由 export-menu.js 组装成菜单 */
    exportWord: function () { return exportWord(); },
    exportStandaloneHtml: function () {
      /* 现在要先把几份样式表读回来才能拼出成品，所以是异步的 —— 给句提示，
         别让人以为点空了。 */
      if (!currentId) { toast('先打开一份文档', 'err'); return; }
      toast('正在打包网页…');
      buildStandalone().then(function (html) {
        download(currentName() + '.html', html, 'text/html;charset=utf-8');
      }, function (e) {
        toast('打包网页失败：' + ((e && e.message) || '未知错误'), 'err');
      });
    },
    /* 没有 exportMarkdown —— 打开的原文件就是 .md，导出成 Markdown 等于把
       同一个文件另存一遍。要源文件用「保存」。分享里的「分享 .md 源文件」
       是另一回事（那是传到云上拿链接），保留。 */

    /* PDF / 打印：**就在当前页面唤起打印**，不再绕道新标签页。

       历史：这条路曾经真的不通，所以才改成「生成一份网页 → 新标签页打开 →
       在那里打印」。当时能力页是 iframe，window.print() 打的是外壳那一层，
       而 @media print 写在能力页自己的样式表里，管不到外面 —— 点了没反应。

       现在两个前提都变了：
         · 内置能力已经合并进外壳文档，不再是 iframe；doc.css 也被注入同一个
           文档（经 scopeCss 限定），它的 @media print 直接生效。
         · 外壳那套「一屏之内自己滚」的布局（html/body overflow:hidden、
           .stage/.frame position:absolute）会把打印内容裁到只剩第一页 ——
           这一条已经在 app/shell.css 末尾的 @media print 里解开了。
           量过：120 段的文档，解开前 3638 个文字绘制指令、最后一页是满的
           （= 后面被截掉了），解开后 4938 个、最后一页是半页（= 真的印完了）。

       于是用户的操作从「点导出 → 等新标签页 → 在那边再点打印」变成
       「点一下 → 打印框直接弹出来」。

       仍然保留新标签页那条路作为兜底（openPrintTab），只在 window.print()
       真的不可用时才走 —— 见下面的 try/catch 和 canPrintInPlace()。 */
    exportPdf: function () {
      if (!currentId) { toast('先打开一份文档', 'err'); return; }
      printInPlace();
    },
    hasDoc: function () { return !!currentId; },

    /* 记忆模块算出"你最常导出成 Word"，回传过来当默认高亮 */
    setPreferredExport: function (fmt) { preferredExport = fmt; },
    getPreferredExport: function () { return preferredExport; }
  };

  /* 什么时候启动。
     原来是无条件 `window.addEventListener('load', boot)` —— 这在「这一页
     独占一个文档」的前提下成立：脚本随文档一起加载，load 必然还没来。

     内置能力合并进外壳后前提不成立了：脚本是在外壳跑起来之后才注入的，
     那时 document.readyState 已经是 'complete'，**load 事件永远不会再来**，
     于是 boot() 一次都不执行 —— 界面全空，而且不报任何错。

     所以按当前状态分三种情形：
       loading   → 等 DOMContentLoaded 再等 load（保留原来的两段式，
                   图片/字体就绪后再量尺寸，首屏排版才不会跳）
       interactive → DOM 已在，但资源可能还在下 → 等 load
       complete  → 全都就绪了，直接开工。用微任务错开一帧，让同批注入的
                   其他脚本（wire-up.js 等）先完成各自的模块初始化，
                   顺序和原来的 load 时序保持一致。 */
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', function () { window.addEventListener('load', boot); });
  } else if (document.readyState === 'interactive') {
    window.addEventListener('load', boot);
  } else {
    setTimeout(boot, 0);
  }

})();

  