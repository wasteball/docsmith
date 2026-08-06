/* =====================================================================
 * Docsmith · Markdown 工作台接线
 * ---------------------------------------------------------------------
 * 把两件新东西挂到已有的工作台上：
 *   1. 改动审阅（右侧面板 + 工具栏按钮）
 *   2. 偏好记忆（阅读设置、上次看到哪儿、上次导出成什么）
 *
 * 这个文件排在 workspace.js 之后加载，那时候界面和它的内部状态都已就绪，
 * 通过 window.MDW 这个小接口和它对话，不去改它的内部实现。
 * ===================================================================== */
import { createReviewer } from './revision.js';
import { markTables } from './table-marks.js';
import { mountExportMenu } from './export-menu.js';
import { rebuildToolbar } from './toolbar.js';
import { createPalette } from './palette.js';
import * as prefs from '../../core/prefs.js';

const $ = (s, r = document) => r.querySelector(s);

/* workspace.js 会把这些钩子挂上来。它还没就绪时先排队等着。 */
function whenReady(fn, tries = 40) {
  if (window.MDW?.getDoc) { fn(); return; }
  if (tries <= 0) return;
  setTimeout(() => whenReady(fn, tries - 1), 100);
}

whenReady(() => {
  const MDW = window.MDW;

  /* 浮层（审阅面板、命令面板、导出菜单）挂在哪儿。
     以前一律 document.body —— 这一页独占一个 iframe，body 就是自己的。
     内置能力合并进外壳后，body 是外壳的：审阅面板挂上去，切到文件库时
     它还浮在那儿，因为它压根不属于任何一个能力容器。
     统一问 workspace.js 要根容器（MDW.root()）—— 挂进去，能力一隐藏，
     浮层跟着消失，不需要任何额外的显示/隐藏逻辑。 */
  const host = () => (typeof MDW.root === 'function' && MDW.root()) || document.body;

  /* ================================================== 改动审阅 */

  const reviewer = createReviewer({
    getDoc: () => MDW.getDoc(),
    setText: (t) => MDW.setText(t),
    scrollToLine: (n) => MDW.scrollToLine?.(n),
    elementAtLine: (n) => MDW.elementAtLine?.(n),
    getPreviewRoot: () => MDW.getPreviewRoot?.(),
    getPanelContainer: () => host(),
    toast: (m) => MDW.toast?.(m),
    onCountChange: (n) => paintBadge(n),
    onToggle: () => syncButton(),
  });

  window.DSReviewer = reviewer;

  /* 审阅不再单独占一个按钮 —— 工具栏上已经有「改动」了，两个入口讲同
     一件事只会让人犹豫。这里把它挂进「改动」面板底部，以及命令面板。 */
  const btn = document.createElement('button');
  btn.id = 'reviewBtn';
  btn.type = 'button';
  // 用宿主的按钮类，不自己造一套 —— 之前漏了这一行，它就长得跟别的都不一样
  btn.className = 'btn';
  btn.hidden = true;
  btn.addEventListener('click', () => { reviewer.toggle(host()); });
  host().appendChild(btn);

  function syncButton() {
    const on = document.documentElement.dataset.review === 'on';
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function paintBadge(n) {
    // 审阅按钮上标出"有多少处和原稿不一样"。「改动」按钮讲的是"还没保存"，
    // 两者不是一回事，各自显示各自的数，不混在一个徽标里。
    btn.classList.toggle('has-review', n > 0);
    btn.dataset.n = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
    btn.title = n > 0
      ? `和打开这篇时相比有 ${n} 处不同 · 表格按单元格上色（Alt + R）`
      : '和打开这篇时相比没有变化（Alt + R）';
  }

  /* 往「改动」面板底部塞一个入口。面板每次打开都会重画，所以盯着它。 */
  function injectReviewEntry() {
    const panel = $('#chgPanel');
    if (!panel || !panel.classList.contains('open')) return;
    if (panel.querySelector('.chg-review-link')) return;
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'chg-review-link btn--ghost';
    a.innerHTML = '逐处审阅 · 表格按单元格对比 <kbd>Alt</kbd><kbd>R</kbd>';
    a.title = '和「打开这篇时」比，跨会话保留';
    a.addEventListener('click', () => { reviewer.toggle(host()); });
    panel.appendChild(a);
  }
  /* 只盯「改动」面板自己的 class 变化。
     原来这里是 observe(document.body, {subtree:true, childList:true, attributes:true})
     —— 页面上任何一处 DOM 变动都会把它叫醒，包括图表平移时每一帧写在
     .mm-stage 上的 style。拖一次图 = 触发上百次回调。范围收窄到面板本身，
     行为一模一样，代价降到接近零。 */
  const chgPanelEl = $('#chgPanel');
  if (chgPanelEl) {
    new MutationObserver(injectReviewEntry)
      .observe(chgPanelEl, { attributes: true, attributeFilter: ['class'] });
  }

  /* --- 文档切换 / 内容变化时重算 ---
     当前文档 id 缓存在 curId 里，切换时更新一次，滚动回调就不必每帧调
     MDW.getDoc()（那个调用会 filter 一遍打开的文档、再造一个带正文的对象，
     放在滚动热路径上不划算）。 */
  let curId = MDW.getDoc()?.id || null;
  window.addEventListener('docsmith:doc-changed', () => {
    curId = MDW.getDoc()?.id || null;
    reviewer.onDocChanged();
    restoreScroll();
    markCurrentTables();
  });
  window.addEventListener('docsmith:text-changed', () => {
    reviewer.onTextChanged();
    markCurrentTables();
  });

  /* 正文里的表格就地标记：改过的单元格加个角标，悬停看原值 */
  function markCurrentTables() {
    const doc = MDW.getDoc();
    if (!doc) return;
    // 等这一轮渲染落地再标，否则标在旧的 DOM 上
    requestAnimationFrame(() => markTables(MDW.getPreviewRoot?.(), doc.text, doc.id));
  }

  /* 上次关掉时审阅是开着的 → 这次自动打开 */
  if (prefs.get('review.enabled')) {
    reviewer.open(host());
    syncButton();
  }

  /* ================================================== 偏好记忆 */

  /* 阅读设置（字号、版心、字体）由工作台自己经 DSPrefs 存下，
     这里不再重复写一遍 —— 两处都写会说不清以谁为准。 */

  /* --- 导出格式：记住上次选了什么，并统计出最常用的那个 --- */
  window.addEventListener('docsmith:export', (e) => {
    const fmt = e.detail?.format;
    if (!fmt) return;
    prefs.set('export.lastFormat', fmt);
    prefs.tally('export', fmt);
  });

  /* --- 分享类型同理 --- */
  window.addEventListener('docsmith:share', (e) => {
    const kind = e.detail?.kind;
    if (!kind) return;
    prefs.set('share.lastKind', kind);
    prefs.tally('share', kind);
  });

  /* 导出菜单：网页 / Word / PDF / Markdown 四选一，上次用的排最前 */
  mountExportMenu(MDW);

  /* 工具栏重组：16 个按钮收成 4 组。原按钮留在 DOM 里继续工作。 */
  const tb = rebuildToolbar(MDW);

  /* 命令面板：工具栏放不下的都在这儿，⌘K / Ctrl+K 打开 */
  const palette = createPalette(() => commands(MDW, tb, reviewer));
  window.DSPalette = palette;
  MDW.setPreferredExport?.(prefs.preferred('export.lastFormat', 'export', 'html'));

  /* --- 滚动位置：只在插件开着、这份文件正加载在插件里的时候记着 ---
     纯放在内存里（见 core/prefs.js 的 scrollPos），关掉插件就忘，
     不写进浏览器长期存储。DSPrefs 那套会把位置落进 docsmith:doc-state，
     长期占地方，这里不用它。 */
  const scroller = MDW.getScroller?.();
  scroller?.addEventListener('scroll', () => {
    if (curId) prefs.rememberScroll(curId, scroller.scrollTop);
  }, { passive: true });

  function restoreScroll() {
    if (!curId || !scroller) return;
    const top = prefs.recallScroll(curId);
    if (!top) return;
    // 等渲染完再滚，否则高度还没撑开
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scroller.scrollTop = top;
    }));
  }

  /* 「最近文档」不做浏览器记忆 —— 正文动辄几百 KB，缓存十几篇就是好几兆，
     占用浏览器空间不划算。用户想接着看，从文件库或系统里重新打开即可，
     文件一加载回来滚动位置（若本次会话记过）也会自动还原。 */
});


/* =====================================================================
 * 命令清单
 * ---------------------------------------------------------------------
 * 工具栏上有的、没有的，全部登记在这里。有了这张表，工具栏才敢做减法。
 * when() 返回 false 的条目不会出现 —— 比如没打开文档时不该看到「导出」。
 * ===================================================================== */
function commands(MDW, tb, reviewer) {
  const click = (sel) => () => document.querySelector(sel)?.click();
  const hasDoc = () => !!MDW.hasDoc?.();

  return [
    // ---- 文档
    { id: 'open-file', group: '文档', icon: '📄', title: '打开文件', key: '⌘+O',
      desc: '从电脑里选 Markdown 文件', order: 1,
      run: click('[data-open="file"]') },
    { id: 'open-folder', group: '文档', icon: '📁', title: '打开文件夹',
      desc: '一次读进整个目录', order: 2, run: click('[data-open="folder"]') },
    { id: 'open-url', group: '文档', icon: '🔗', title: '从链接加载',
      desc: 'GitHub 上的 README 也能直接贴', order: 3, run: click('[data-open="url"]') },
    { id: 'new-doc', group: '文档', icon: '✎', title: '新建文档', order: 4,
      run: click('[data-open="new"]') },

    // ---- 视图
    { id: 'view-read', group: '视图', icon: '👁', title: '阅读', keywords: 'yuedu read',
      when: hasDoc, run: () => tb?.gotoView('read') },
    { id: 'view-edit', group: '视图', icon: '✏️', title: '编辑', key: '⌘+E',
      keywords: 'bianji edit', when: hasDoc, run: () => tb?.gotoView('edit') },
    { id: 'view-source', group: '视图', icon: '</>', title: '源码', key: '⌘+⇧+E',
      keywords: 'yuanma source markdown', when: hasDoc, run: () => tb?.gotoView('source') },
    { id: 'find', group: '视图', icon: '⌕', title: '查找和替换', key: '⌘+F',
      when: hasDoc, run: click('#findBtn') },
    { id: 'toggle-side', group: '视图', icon: '☰', title: '收起 / 展开侧栏', key: '⌘+B',
      run: click('#sideToggle') },
    { id: 'reading-prefs', group: '视图', icon: 'Aa', title: '阅读设置',
      desc: '字号、行宽、字体', run: click('#settingsBtn') },

    // ---- 改动
    { id: 'changes', group: '改动', icon: '～', title: '查看未保存的改动',
      when: hasDoc, run: click('#chgBtn') },
    { id: 'review', group: '改动', icon: '⇄', title: '逐处审阅', key: 'Alt+R',
      desc: '表格按单元格对比，可逐处接受或还原', when: hasDoc,
      /* 和 whenReady 里的 host() 同一个意思，但这个函数在闭包外面，
         只能自己问一次 MDW.root() —— 挂错宿主的话审阅面板会留在外壳上，
         切到别的能力还浮着。 */
      run: () => reviewer?.toggle((typeof MDW.root === 'function' && MDW.root()) || document.body) },
    { id: 'undo', group: '改动', icon: '↺', title: '撤销', key: '⌘+Z',
      when: hasDoc, run: click('#undoBtn') },
    { id: 'redo', group: '改动', icon: '↻', title: '重做', key: '⌘+⇧+Z',
      when: hasDoc, run: click('#redoBtn') },

    // ---- 送出去
    { id: 'share', group: '送出去', icon: '🔗', title: '生成分享链接',
      desc: '传到你自己的云，回来一条链接', when: hasDoc, order: 5,
      run: click('#shareBtn') },
    { id: 'save-local', group: '送出去', icon: '💾', title: '保存到本地', key: '⌘+S',
      when: hasDoc, run: click('#saveBtn') },
    { id: 'exp-html', group: '送出去', icon: '🌐', title: '导出网页',
      keywords: 'html daochu', when: hasDoc, run: () => MDW.exportStandaloneHtml() },
    { id: 'exp-docx', group: '送出去', icon: '📘', title: '导出 Word',
      keywords: 'docx daochu', when: hasDoc, run: () => MDW.exportWord() },
    { id: 'exp-pdf', group: '送出去', icon: '📕', title: '导出 PDF',
      keywords: 'pdf daochu', when: hasDoc, run: () => MDW.exportPdf() },
    /* 没有「导出 Markdown」这一项 —— 打开的原文件就是 .md，再导一遍没意义。
       想拿源文件直接用「保存」，或者到文件夹里复制那个文件。 */
    { id: 'copy-md', group: '送出去', icon: '📋', title: '复制源码',
      desc: '复制 Markdown 原文，粘进飞书、WPS 会自动排版', when: hasDoc, run: click('#copyBtn') },

    // ---- 外观
    { id: 'theme', group: '外观', icon: '◐', title: '切换亮色 / 暗色',
      keywords: 'theme zhuti', run: () => window.Appearance?.toggle() },
    { id: 'goto-files', group: '外观', icon: '📁', title: '去文件库',
      desc: '上传、分类、批量下载',
      run: () => window.DSCloud?.gotoFiles() },
  ];
}


/* Markdown 工作台的 Aa 按钮也交给外壳的唯一设置面板（阅读分区）。
   页面自带一个设置浮层是 iframe 时代的产物，现在没必要了。

   ⚠ 必须从工作台自己的根容器里找 #settingsBtn，不能用
   document.getElementById —— 外壳侧栏也有一颗 id="settingsBtn" 的齿轮，
   而 getElementById 返回**文档里先出现的那一个**（合并后是外壳的）。
   拿错的话：点工作台的 Aa 没反应，点外壳齿轮反而弹「阅读」分区。
   这段在模块顶层执行，MDW 可能还没就绪，所以退回 document —— 那时页面里
   只有工作台自己这一份，不会有歧义。 */
import { toShell as _toShell, on as _on } from '../../core/bus.js';
((window.MDW?.root?.() || document).querySelector('#settingsBtn'))?.addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  _toShell('open-settings', { section: 'reading' });
}, true);

/* 外壳改了阅读设置 → 立刻应用到当前文档 */
_on('setting', ({ key, value }) => {
  if (!key?.startsWith('reading.')) return;
  window.MDW?.applyReadingSetting?.(key.slice(8), value);
});
