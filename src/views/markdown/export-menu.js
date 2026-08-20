/* =====================================================================
 * Docsmith · 导出菜单
 * ---------------------------------------------------------------------
 * 原来是两个几乎一样的工作台，一个的导出按钮出网页、一个出 Word。合并成
 * 一个之后，四种格式收进一个菜单里。
 *
 * 菜单里"上次用的那个"会排在最前并标出来 —— 大多数人反复导的是同一种
 * 格式，不该每次都从头找一遍。
 * ===================================================================== */
import * as prefs from '../../core/prefs.js';
import { has, missingMessage } from '../../core/vendor.js';

/* 四种格式。刻意**没有** Markdown 那一项 —— 打开的原文件本来就是 .md，
   再「导出成 Markdown」等于把文件另存一遍，用户要的是「变成别的东西」。 */
const FORMATS = [
  {
    id: 'html',
    label: '网页',
    ext: '.html',
    hint: '一个文件包含全部样式、图表和公式，发给谁都能直接打开',
    needs: null,
    run: (MDW) => MDW.exportStandaloneHtml(),
  },
  {
    id: 'docx',
    label: 'Word',
    ext: '.docx',
    hint: '真正的 Word 排版，标题、表格、代码块都能继续编辑',
    needs: 'word',
    run: (MDW) => MDW.exportWord(),
  },
  {
    id: 'png',
    label: '图片',
    ext: '.png',
    hint: '整篇 Markdown 按当前排版生成一张 PNG',
    needs: 'documentImage',
    run: (MDW) => MDW.exportImage(),
  },
  {
    /* 标签写清楚这是「走打印对话框另存为 PDF」，不假装是一键生成 .pdf。

       为什么不做真·PDF 生成器：那需要在插件里内置一个 PDF 引擎**外加一款
       中文字体**（不带字体的话汉字全是方块），体积要多好几 MB，而代码块和
       表格的分页质量还一定不如浏览器自己的打印引擎。浏览器的「另存为 PDF」
       本来就是一个成熟的 PDF 导出器，借它的力更划算。

       用户报的问题是「导出保留 PDF，后面的效果是直接点击导出 PDF 直接触发
       打印啊 —— 移除错了能力」：功能本身是对的，错在**没说实话** ——
       菜单上写着「PDF / .pdf」，点下去却弹出打印对话框，像是坏了。
       现在名字和 hint 都直说。

       打印框现在**直接在面板里弹出**，不再先开一个标签页（用户要求简化操作）
       —— 见 workspace.js 的 printInPlace()。 */
    id: 'pdf',
    label: 'PDF',
    ext: '（打印另存为）',
    hint: '直接弹出打印窗口，在「目标打印机」里选「另存为 PDF」',
    needs: null,
    run: (MDW) => MDW.exportPdf(),
  },
];

export function mountExportMenu(MDW) {
  const btn = document.getElementById('downloadBtn');
  if (!btn) return;

  /* 拆成两半：左边直接导出上次用的格式（没用过就是网页），右边点开选别的。
     绝大多数人反复导同一种格式 —— 让那一种一步到位，其余的往后放一层。 */
  const wrap = document.createElement('span');
  wrap.className = 'ex-split';

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'ex-main-btn';   // 样式由 core/buttons.css 统一给

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'ex-caret';
  caret.setAttribute('aria-haspopup', 'true');
  caret.setAttribute('aria-expanded', 'false');
  caret.setAttribute('aria-label', '选择其他导出格式');
  caret.innerHTML = '<svg viewBox="0 0 10 6" width="9" height="6" aria-hidden="true">'
    + '<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  wrap.appendChild(main);
  wrap.appendChild(caret);
  btn.parentNode.replaceChild(wrap, btn);

  const menu = document.createElement('div');
  menu.className = 'ex-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  /* 挂进能力容器，**不要**挂 document.body。
     .ex-menu 的样式写在 workspace.css 里，而那份样式表被限定成
     `[data-ds-host="markdown"] .ex-menu`（见 app/main.js 的 scopeCss ——
     两个能力页有 14 个同名类，不限定会互相覆盖）。挂到 body 上就跑到
     限定范围之外，一条样式都命中不了：菜单变成页面底部一堆裸文字。
     容器本身没有 transform/filter，所以 position:fixed 仍然相对视口定位，
     下面那段 top/left 计算不受影响。 */
  (MDW.root?.() || document.body).appendChild(menu);

  function current() {
    const id = prefs.preferred('export.lastFormat', 'export', 'html');
    return FORMATS.find((f) => f.id === id) || FORMATS[0];
  }

  let busy = false;
  function syncMain() {
    const f = current();
    main.textContent = busy ? (f.id === 'png' ? '正在生成图片…' : `正在导出 ${f.label}…`) : `导出 ${f.label}`;
    main.title = `${f.hint}（点右边的箭头换格式）`;
  }

  async function run(f) {
    if (busy) return;
    if (f.needs && !has(f.needs)) { alert(missingMessage(f.needs)); return; }
    if (!MDW.hasDoc()) { MDW.toast?.('先打开一份文档'); return; }
    busy = true;
    main.disabled = true;
    caret.disabled = true;
    wrap.classList.add('busy');
    wrap.setAttribute('aria-busy', 'true');
    syncMain();
    try {
      await Promise.resolve(f.run(MDW));
      /* 成功的业务格式由 workspace 的 download() 事件记录。PDF 没有文件下载，
         在打印入口完成后单独记一次；失败路径不污染“上次导出”。 */
      if (f.id === 'pdf') {
        prefs.set('export.lastFormat', f.id);
        prefs.tally('export', f.id);
      }
    } catch (error) {
      console.error('[export-menu] export failed:', error);
    } finally {
      busy = false;
      main.disabled = false;
      caret.disabled = false;
      wrap.classList.remove('busy');
      wrap.setAttribute('aria-busy', 'false');
      syncMain();
    }
  }

  main.addEventListener('click', () => run(current()));

  function render() {
    const last = prefs.preferred('export.lastFormat', 'export', 'html');
    const ordered = [...FORMATS].sort((a, b) => (b.id === last) - (a.id === last));

    // 工具栏重组时把「复制 HTML」「打印」也归到这里了 —— 它们同样是
    // "把这篇文档变成别的东西"，没道理各占一个按钮位置
    const extras = window.DSExtraExports || [];

    menu.innerHTML = ordered.map((f) => {
      const off = f.needs && !has(f.needs);
      return `
        <button class="ex-item${off ? ' off' : ''}" role="menuitem"
                data-fmt="${f.id}" ${off ? 'data-off="1"' : ''}>
          <span class="ex-main">
            <span class="ex-label">${f.label}<code>${f.ext}</code></span>
            ${f.id === last ? '<span class="ex-tag">上次用的</span>' : ''}
          </span>
          <span class="ex-hint">${off ? '组件缺失，点一下看怎么补' : f.hint}</span>
        </button>`;
    }).join('')
      + (extras.length ? '<div class="ex-sep"></div>' : '')
      + extras.map((f) => `
        <button class="ex-item" role="menuitem" data-extra="${f.id}">
          <span class="ex-main"><span class="ex-label">${f.label}<code>${f.ext}</code></span></span>
          <span class="ex-hint">${f.hint}</span>
        </button>`).join('');

    menu.querySelectorAll('[data-extra]').forEach((el) => {
      el.addEventListener('click', () => {
        close();
        extras.find((x) => x.id === el.dataset.extra)?.run();
      });
    });

    menu.querySelectorAll('.ex-item[data-fmt]').forEach((el) => {
      el.addEventListener('click', () => {
        const f = FORMATS.find((x) => x.id === el.dataset.fmt);
        close();
        if (f) run(f);
      });
    });
  }

  function open() {
    render();
    menu.hidden = false;
    const r = wrap.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    // 靠右对齐，但别顶出屏幕
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
    caret.setAttribute('aria-expanded', 'true');
    menu.querySelector('.ex-item')?.focus();
  }

  function close() {
    menu.hidden = true;
    caret.setAttribute('aria-expanded', 'false');
  }

  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden ? open() : close();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) close();
  });

  syncMain();
}
