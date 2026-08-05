/* =====================================================================
 * Docsmith · 文件库接线
 * ---------------------------------------------------------------------
 * 把新加的东西挂到已有界面上：动态存储表单、去 Markdown 工作台的按钮、
 * 「还没连云存储」时的引导。
 *
 * 这个文件排在 library.js 之后加载，那时候界面已经渲染好了。
 * ===================================================================== */
import { render as renderStorageForm, bindTestButton } from './storage-form.js';
import * as cloud from '../../storage/index.js';
import { toShell, on } from '../../core/bus.js';

const $ = (s) => document.querySelector(s);

/* 说明文档的地址。

   ⚠ 不能写成相对路径 "../docs/index.html"：相对的基准是**当前文档的 URL**，
   而内置能力合并进外壳后，那是 src/app/index.html —— 会解析成
   src/docs/index.html（不存在），点「怎么连？看图文说明」直接 404。
   独立打开文件库时才恰好对。
   用 chrome.runtime.getURL 从扩展根算，两种模式都对；拿不到（比如直接用
   file:// 打开调试）就退回原来的相对路径。 */
function docsUrl() {
  const rel = 'src/views/docs/index.html?doc=storage';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(rel);
    }
  } catch (e) {}
  return '../docs/index.html?doc=storage';
}

/* ---------------------------------------------------------- 存储设置 */
renderStorageForm();
bindTestButton();
cloud.onConfigChange(() => { renderStorageForm(); paintGate(); });

/* ------------------------------------------------- 去 Markdown 工作台 */
$('#md-convert-link')?.addEventListener('click', () => {
  toShell('switch', { tab: 'markdown' });
});

/* --------------------------------------------------- 没连云存储的引导 *
 * 不把功能锁死到用户无从下手 —— 而是在上传区顶上放一句话和一个按钮，
 * 点一下就能去填。已经连好了就自动消失。
 * ------------------------------------------------------------------ */
function paintGate() {
  const host = $('.dropzone')?.parentElement || $('.app');
  if (!host) return;

  let gate = $('#storage-gate');
  const d = cloud.describe();

  if (d.ready) { gate?.remove(); return; }

  if (!gate) {
    gate = document.createElement('div');
    gate.id = 'storage-gate';
    gate.className = 'storage-gate';
    host.insertBefore(gate, host.firstChild);
  }
  gate.innerHTML = `
    <div class="sg-title">先告诉 Docsmith 文件存到哪里</div>
    <p class="sg-text">
      文件会传到<strong>你自己的</strong>云存储空间，Docsmith 不保管任何人的文件，
      也没有服务器。连一次，以后就不用再管了。
    </p>
    <div class="sg-actions">
      <button class="btn-add" id="sg-open">去设置</button>
      <a class="sg-link" href="${docsUrl()}" target="_blank" rel="noopener">怎么连？看图文说明</a>
    </div>`;
  gate.querySelector('#sg-open')?.addEventListener('click', () => {
    /* 直接请外壳开设置面板的「云存储」分区。
       原来是 document.getElementById('btn-settings').click() —— 借文件库
       自己那颗齿轮转发一下。那颗按钮已经删掉了（外壳侧栏本来就有一颗，
       同一件事不该有两个入口），点它等于什么都不发生。 */
    toShell('open-settings', { section: 'storage' });
    setTimeout(() => document.getElementById('cfg-provider')?.focus(), 300);
  });
}

paintGate();

/* 外壳要求定位到某条记录。
   监听挂在自己的容器上（合并模式）而不是 window —— view-boot.js 把事件派到
   目标能力的容器上再冒泡，这样切到文件库定位文件时，Markdown 工作台不会
   跟着响应。独立打开时容器就是 body，行为不变。 */
(document.querySelector('[data-ds-host="files"]') || window)
  .addEventListener('docsmith:focus-file', (e) => {
    if (typeof window.focusRecord === 'function') window.focusRecord(e.detail);
  });

/* =====================================================================
 * 搜索与清空
 * ---------------------------------------------------------------------
 * 记录攒到几十条以后，靠分类翻找就慢了。搜索按文件名和所在目录过滤，
 * 边打边筛。清空只清本地这份记录列表 —— 云上的文件一个都不会动，
 * 这一点必须在确认框里说清楚，否则用户不敢点。
 * ===================================================================== */

const search = document.getElementById('hist-search');
const searchClear = document.getElementById('hist-search-clear');
const countEl = document.getElementById('hist-count');


function applySearch(q) {
  if (!window.state) return;
  window.state.searchQuery = q;
  searchClear.hidden = !q;
  window.renderHistory?.();
  window.renderCatFilter?.();
  paintCount();
}

/* 输入停顿 120ms 再筛，避免每敲一个字就重画一遍整个列表 */
let searchTimer = null;
search?.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applySearch(search.value), 120);
});

search?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { search.value = ''; applySearch(''); search.blur(); }
});

searchClear?.addEventListener('click', () => {
  search.value = '';
  applySearch('');
  search.focus();
});

/* 斜杠键聚焦搜索，和多数工具一致。
   只在文件库正显示着时响应 —— 合并进外壳后 window 是共用的，否则在
   Markdown 工作台里按 / 会把焦点抢到一个看不见的搜索框上。 */
window.addEventListener('keydown', (e) => {
  const root = document.querySelector('[data-ds-host="files"]') || document.body;
  if (window.DSActive && !window.DSActive.isActive(root)) return;
  if (e.key === '/' && !/input|textarea|select/i.test(e.target.tagName || '')) {
    e.preventDefault();
    search?.focus();
  }
});

function paintCount() {
  // 这个函数会被 setTimeout 和事件回调触发，那时 library.js 可能还没把
  // state 挂出来（或者已经因为别的原因没挂）。任何一个环节缺席都直接返回。
  if (!countEl || typeof window === 'undefined' || !window.state?.history) return;
  const total = window.state.history.length || 0;
  const shown = window.visibleHistory ? window.visibleHistory().length : total;
  if (!total) { countEl.textContent = ''; return; }
  countEl.textContent = shown === total ? `${total} 个文件` : `${shown} / ${total}`;
}

/* 「⋯」菜单：低频动作从标题行收进来 */
const moreBtn = document.getElementById('hist-more');
const moreMenu = document.getElementById('hist-more-menu');

moreBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = moreMenu.hidden;
  moreMenu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
document.addEventListener('click', (e) => {
  if (moreMenu && !moreMenu.hidden && !moreMenu.contains(e.target)) {
    moreMenu.hidden = true;
    moreBtn?.setAttribute('aria-expanded', 'false');
  }
});
document.getElementById('hmm-export')?.addEventListener('click', () => {
  moreMenu.hidden = true;
  document.getElementById('btn-export-history')?.click();
});
document.getElementById('hmm-clear')?.addEventListener('click', () => {
  moreMenu.hidden = true;
  purgeHistory();
});

function purgeHistory() {
  const total = window.state?.history?.length || 0;
  if (!total) { window.toast?.('还没有记录', 'info'); return; }

  const ok = confirm(
    `确定清空这 ${total} 条记录吗？\n\n`
    + '只清掉本地这份列表 —— 已经上传到云上的文件不会被删除，'
    + '之前发出去的链接也照样能打开。\n\n'
    + '如果只是想找东西，用上面的搜索框会更快。',
  );
  if (!ok) return;

  window.state.history = [];
  window.selected?.clear?.();
  window.saveState?.();
  window.renderHistory?.();
  window.renderCatFilter?.();
  paintCount();
  window.toast?.('记录已清空，云上的文件没有动', 'success');
}

/* 上传完、切分类之后计数要跟着变 */
window.addEventListener('docsmith:history-changed', paintCount);
setTimeout(paintCount, 300);

/* =====================================================================
 * 批量操作条收敛
 * ---------------------------------------------------------------------
 * 选中文件后会冒出一排 7 个控件：移动、share、逐个、打包、copy urls、
 * delete、cancel。中英文还混着。
 *
 * 收成 4 个：一个主动作（分享）、一个下拉（下载：逐个 / 打包）、
 * 一个「⋯」（复制链接、删除）、一个 ×（取消）。
 *
 * 依旧不动原逻辑 —— 原按钮留在 DOM 里，新控件转发点击。
 * ===================================================================== */
(function consolidateBatchBar() {
  const bar = document.getElementById('batch-bar');
  if (!bar || bar.dataset.slim) return;
  bar.dataset.slim = '1';

  const pick = (id) => document.getElementById(id);
  const orig = {
    share: pick('batch-share'),
    download: pick('batch-download'),
    zip: pick('batch-zip'),
    copy: pick('batch-copy'),
    del: pick('batch-delete'),
    clear: pick('batch-clear'),
  };

  // 原按钮移进暗处：点击仍然有效，只是不再各占一格
  const attic = document.createElement('span');
  attic.className = 'tb-attic';
  attic.setAttribute('aria-hidden', 'true');
  bar.appendChild(attic);
  Object.values(orig).forEach((b) => b && attic.appendChild(b));

  const count = pick('batch-count');
  if (count) {
    // "0 selected" → "已选 3 项"，顺手把英文换掉
    new MutationObserver(() => {
      const n = parseInt(count.textContent, 10);
      if (!Number.isNaN(n) && !/已选/.test(count.textContent)) {
        count.textContent = `已选 ${n} 项`;
      }
    }).observe(count, { childList: true, characterData: true, subtree: true });
  }

  const slot = document.createElement('span');
  slot.className = 'batch-slim';
  bar.appendChild(slot);

  /* --- 分享：这一屏最该点的动作，给它主按钮 --- */
  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'btn primary btn--sm';
  share.textContent = '分享';
  share.title = '把所选文件的链接按你设定的格式复制出来';
  share.addEventListener('click', () => orig.share?.click());
  slot.appendChild(share);

  /* --- 下载：逐个和打包是同一件事的两种方式，合成一个下拉 --- */
  const dl = menuButton('下载', [
    { label: '逐个下载', desc: '每个文件单独存', run: () => orig.download?.click() },
    { label: '打包成 ZIP', desc: '按分类归到文件夹里', run: () => orig.zip?.click() },
  ]);
  slot.appendChild(dl);

  /* --- 低频动作收进「⋯」 --- */
  const more = menuButton('⋯', [
    { label: '只复制链接', desc: '不带文件名，纯 URL', run: () => orig.copy?.click() },
    { label: '从记录里删除', desc: '云上的文件不会动', danger: true, run: () => orig.del?.click() },
  ], 'icon');
  slot.appendChild(more);

  /* --- 取消选择：末尾一个 × --- */
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'icon-btn';
  cancel.title = '取消选择（Esc）';
  cancel.setAttribute('aria-label', '取消选择');
  cancel.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';
  cancel.addEventListener('click', () => orig.clear?.click());
  slot.appendChild(cancel);

  /** 一个带下拉的按钮。菜单里每项带一行说明，省得用户靠猜。 */
  function menuButton(label, entries, kind) {
    const wrap = document.createElement('span');
    wrap.className = 'bm-wrap';

    const b = document.createElement('button');
    b.type = 'button';
    b.className = kind === 'icon' ? 'icon-btn' : 'btn btn--sm';
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = kind === 'icon' ? label
      : `${label}<svg viewBox="0 0 10 6" width="9" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

    const menu = document.createElement('div');
    menu.className = 'bm-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    entries.forEach((en) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `hmm-item${en.danger ? ' danger' : ''}`;
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `<span>${en.label}</span><small>${en.desc}</small>`;
      item.addEventListener('click', () => { menu.hidden = true; b.setAttribute('aria-expanded', 'false'); en.run(); });
      menu.appendChild(item);
    });

    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !wrap.contains(e.target)) {
        menu.hidden = true;
        b.setAttribute('aria-expanded', 'false');
      }
    });

    wrap.appendChild(b);
    wrap.appendChild(menu);
    return wrap;
  }
})();

/* =====================================================================
 * 设置：交给外壳
 * ---------------------------------------------------------------------
 * 这个页面不再有自己的设置抽屉，也不再有自己的齿轮按钮 —— 外壳侧栏底部
 * 那一颗就是唯一入口，设置面板全应用只有一个。上传偏好、分享格式、下载
 * 默认格式都在那个面板里，文件库只读取（见 library.js / downloader.js 里
 * 的 DSPrefs.get）。设置改完，外壳会广播回来，这里重画受影响的列表。
 *
 * （原来这里给 #btn-settings 绑了个转发。按钮删掉后这段就没有对象了，
 *   一并去掉；页面内需要开设置的地方直接 toShell('open-settings')，
 *   比如上面「还没连云存储」引导里的「去设置」。）
 * ===================================================================== */

/* 外壳广播：某项设置变了。上传偏好现在都归全局面板，这里按 key 决定
   要不要立刻反应 —— 并发数改大了就多拉几个任务上传，分享格式变了下次
   分享就是新格式（无需重画），乱码修复这类只影响下一次上传，也不用动。 */
on('setting', ({ key }) => {
  if (!key) return;
  if (key === 'files.concurrency') window.processQueue?.();
});

/* 外壳清空了上传记录 */
on('history-cleared', () => {
  if (!window.state) return;
  window.state.history = [];
  window.saveState?.();
  window.renderHistory?.();
  window.renderCatFilter?.();
});
