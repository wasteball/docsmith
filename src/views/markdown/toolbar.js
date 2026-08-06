/* =====================================================================
 * Docsmith · 工具栏重组
 * ---------------------------------------------------------------------
 * 原来一排 16 个按钮。问题不是"按钮多"，是**没有层次** —— 每个功能都
 * 平等地占一个位置，用户第一眼扫过去，不知道该看哪个。
 *
 * 重组的三条规则：
 *
 *   1. 互斥的状态用分段控件，不用并排按钮。
 *      阅读 / 编辑 / 源码是三选一，三个独立按钮表达不出"当前在哪一档"。
 *
 *   2. 同一个意图只留一个入口。
 *      "Copy HTML"、"Print / PDF"、"Export Word" 都是"把这篇文档变成
 *      别的东西"，收进一个「导出」里。
 *
 *   3. 只在有意义的时候出现。
 *      撤销重做在阅读模式下点不动，那就别占位置。
 *
 * 做法上不动原有代码：原按钮留在 DOM 里，只是移到暗处，新控件转发点击。
 * 这样 workspace.js 里所有绑定照常工作，改坏的风险接近零。
 * ===================================================================== */

/* 取节点默认从**工作台的根容器**里找，不从整个 document 找。
   合并进外壳后 #settingsBtn 是撞车的：外壳的齿轮和工作台的「Aa 阅读设置」
   同名，而 document.querySelector 命中的是先出现在 DOM 里的那个（外壳的）。
   于是「阅读设置」的事件会绑到外壳齿轮上，两颗按钮都变得不听话。
   MDW 还没就绪时退回 document —— 那时页面里只有这一份，不会有歧义。 */
const root = () => window.MDW?.root?.() || document;
const $ = (s, r) => (r || root()).querySelector(s);

/* 界面状态（data-mode / data-edit / data-viewMode）挂在工作台的根元素上，
   不一定是 document.body —— 内置能力合并进外壳后，body 是外壳的，三个能力
   共用它就会互相踩。所以统一问 workspace.js 要那个根（MDW.root()）。
   MDW 还没就绪时退回 document.body，和独立打开这一页时的行为一致。 */
function stateRoot(MDW) {
  return (MDW && typeof MDW.root === 'function' && MDW.root()) || document.body;
}

/** 让某个原按钮"隐身但仍可用" —— 移出视线，不移出 DOM */
function stash(el, host) {
  if (!el) return;
  el.classList.add('tb-stashed');
  host.appendChild(el);
}

export function rebuildToolbar(MDW) {
  const tools = $('.tools');
  if (!tools || tools.dataset.rebuilt) return;
  tools.dataset.rebuilt = '1';

  // 原按钮的收纳处：视觉上不可见，点击依然有效
  const attic = document.createElement('span');
  attic.className = 'tb-attic';
  attic.setAttribute('aria-hidden', 'true');
  tools.appendChild(attic);

  const editBtn = $('#editBtn');
  const srcBtn = $('#srcBtn');
  const copyBtn = $('#copyBtn');
  const printBtn = $('#printBtn');
  const saveBtn = $('#saveBtn');
  const reviewBtn = $('#reviewBtn');

  /* ============================================ 一、视图分段控件 */

  const seg = document.createElement('div');
  seg.className = 'tb-seg';
  seg.setAttribute('role', 'tablist');
  seg.setAttribute('aria-label', '视图');
  seg.innerHTML = `
    <button type="button" role="tab" data-view="read" title="阅读（Esc 回到这里）">阅读</button>
    <button type="button" role="tab" data-view="edit" title="在排好版的界面上直接改字（⌘/Ctrl + E）">编辑</button>
    <button type="button" role="tab" data-view="source" title="看 Markdown 原文（⌘/Ctrl + ⇧ + E）">源码</button>
    <span class="tb-seg-ink"></span>`;

  function currentView() {
    const root = stateRoot(MDW);
    if (root.dataset.mode === 'source') return 'source';
    return root.dataset.edit === 'on' ? 'edit' : 'read';
  }

  function gotoView(want) {
    const now = currentView();
    if (now === want) return;
    // 原按钮是"切换"语义，这里换算成"到达某个状态"该点哪几下
    if (want === 'source') { if (now !== 'source') srcBtn?.click(); return; }
    if (now === 'source') srcBtn?.click();
    const editing = stateRoot(MDW).dataset.edit === 'on';
    if (want === 'edit' && !editing) editBtn?.click();
    if (want === 'read' && editing) editBtn?.click();
  }

  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) gotoView(b.dataset.view);
  });

  function syncSeg() {
    const v = currentView();
    const btns = [...seg.querySelectorAll('[data-view]')];
    btns.forEach((b) => {
      const on = b.dataset.view === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // 滑块跟着走：位置变化比颜色变化更容易被余光捕捉到
    const active = seg.querySelector('.on');
    const ink = seg.querySelector('.tb-seg-ink');
    if (active && ink) {
      ink.style.width = `${active.offsetWidth}px`;
      ink.style.transform = `translateX(${active.offsetLeft}px)`;
    }
    stateRoot(MDW).dataset.viewMode = v;
  }

  /* data-mode / data-edit 由 workspace.js 改，这里盯着它变。
     必须盯 stateRoot（和写入方同一个元素）—— 盯 document.body 的话，
     合并进外壳后属性写在容器上，观察器一次都不会触发，分段控件就永远
     停在初始那一档，而且不报任何错。 */
  new MutationObserver(syncSeg).observe(stateRoot(MDW), {
    attributes: true, attributeFilter: ['data-mode', 'data-edit'],
  });

  /* ============================================ 二、导出合并 */

  /* 「复制 HTML」也是一种「把这篇变成别的东西」，收进导出菜单，
     工具栏上不再单独占位置。

     「打印」也在这里 —— 它曾被删掉，因为那一版走的是当前页面的
     window.print()，在能力页还是 iframe 的年代根本不通（打印排版按外壳算，
     而 @media print 写在能力页自己的样式表里，管不到外面），点了什么都不发生。
     但**删掉能力不等于修好问题**：用户要的「我就想直接打印」没有了入口，
     只剩一个名字叫 PDF、点下去却弹打印框的选项，看着像坏的。
     （用户原话：「导出保留 PDF，后面的效果是直接点击导出 PDF 直接触发打印啊
       —— 移除错了能力」。）

     现在 window.print() 这条路**是通的**：能力页已经合并进外壳文档，doc.css
     的 @media print 直接生效；外壳那套「一屏内自己滚」的布局也在
     app/shell.css 的 @media print 里解开了（不解开会把内容裁到只剩第一页）。
     所以两条都指向 MDW.exportPdf()，而它现在**就地弹打印框**、不再开标签页
     （用户要求简化操作）：
       · 「打印」            → 想在纸上或 PDF 里得到这篇，直说是打印
       · 「PDF（打印另存为）」→ 同一件事，写明最后一步在对话框里选另存为 PDF
     两个名字，一条实现，不存在「其中一个时好时坏」。 */
  window.DSExtraExports = [
    {
      id: 'copy-html',
      label: '复制 HTML',
      ext: '到剪贴板',
      hint: '粘进邮件、公众号、飞书文档里，样式跟着走',
      run: () => copyBtn?.click(),
    },
    {
      id: 'print',
      label: '打印',
      ext: '（含另存为 PDF）',
      hint: '直接弹出打印窗口，可以打印，也能选「另存为 PDF」',
      run: () => window.MDW?.exportPdf?.(),
    },
  ];

  stash(copyBtn, attic);
  stash(printBtn, attic);
  stash(srcBtn, attic);
  stash(editBtn, attic);
  /* 审阅**不再**被收进暗处。上一版把它折进「改动」面板底部的一行小字里，
     理由是"两个入口讲同一件事"。但那两个不是同一件事：
       ·「改动」= 还没保存的部分，关掉浏览器就没了
       ·「审阅」= 和你打开这篇时的样子逐处对比，表格按单元格上色，跨会话保留
     后者是这个工具最花力气做的东西，藏起来等于白做。给它一个常驻按钮。 */
  if (reviewBtn) {
    reviewBtn.hidden = false;
    reviewBtn.textContent = '审阅';
    reviewBtn.title = '逐处对比这篇文档的改动，表格按单元格上色（Alt + R）';
  }

  const openGroup = $('.open-group');
  const chgWrap = $('.chg-wrap');
  const settingsBtn = $('#settingsBtn');
  const shareBtn = $('#shareBtn');
  const exportSplit = $('.ex-split');
  const findBtn = $('#findBtn');
  const undoBtn = $('#undoBtn');
  const redoBtn = $('#redoBtn');

  /* 「Aa」按钮从工具栏上撤了（主题和设置统一收到外壳侧栏），但节点必须留着：
     ⌘K 命令面板里的「阅读设置」是靠 click('#settingsBtn') 触发的，
     而 wire-up.js 已经把这个按钮的点击转发给外壳的设置面板。
     收进 attic —— 看不见、不占位，但程序仍然点得到。 */
  stash(settingsBtn, attic);

  /* ============================================ 二·五、主题和设置不在这里

     以前工具栏上也放了一份主题按钮和「Aa」设置按钮。但外壳侧栏底部本来就有
     这两个入口（app/index.html 的 #themeBtn / #settingsBtn），于是同一件事有
     两个按钮、两个位置 —— 用户要求统一收到菜单栏那一处。

     去掉之后功能一点没少：
       · 主题 → 外壳侧栏底部那颗（三态循环：亮 / 暗 / 跟随系统）
       · 阅读设置（字号 / 行宽 / 正文字体）→ 外壳设置面板的「阅读」分区，
         改完经 bus 的 'setting' 广播实时套用到当前文档（见 wire-up.js）
       · ⌘K 命令面板里的「阅读设置」仍然可用，它点的是页面里那个隐藏的
         #settingsBtn，而那个按钮已被 wire-up.js 接管、转发给外壳面板。
     所以这里只是把重复的按钮从工具栏上摘掉，不动任何逻辑。 */

  /* ============================================ 三、重新排布 */

  const gEdit = group('tb-g-edit', [seg, findBtn, undoBtn, redoBtn]);
  const gDoc = group('tb-g-doc', [chgWrap, reviewBtn, saveBtn]);
  const gOut = group('tb-g-out', [shareBtn, exportSplit]);

  function group(cls, nodes) {
    const g = document.createElement('span');
    g.className = `tb-group ${cls}`;
    nodes.filter(Boolean).forEach((n) => g.appendChild(n));
    return g;
  }

  // 顺序即优先级：从哪儿来 → 怎么改 → 改了什么 → 送出去
  tools.insertBefore(gEdit, attic);
  tools.insertBefore(gDoc, attic);
  tools.insertBefore(gOut, attic);
  if (openGroup) tools.insertBefore(openGroup, gEdit);

  /* 分享是这个工具最有价值的动作，给它主按钮的分量 */
  shareBtn?.classList.add('primary');

  syncSeg();
  window.addEventListener('resize', syncSeg);
  if (document.fonts?.ready) document.fonts.ready.then(syncSeg);

  return { syncSeg, gotoView, currentView };
}
