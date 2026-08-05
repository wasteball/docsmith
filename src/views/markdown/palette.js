/* =====================================================================
 * Docsmith · 命令面板（⌘K / Ctrl+K）
 * ---------------------------------------------------------------------
 * 这是"按钮太多"的正解。
 *
 * 工具栏上放不下的功能，通常有两个去处：塞进多层菜单，或者干脆砍掉。
 * 两个都不好 —— 前者让人找不到，后者让人用不了。
 *
 * 命令面板是第三条路：**所有功能都在一个搜索框后面**。于是工具栏只需要
 * 留最高频的那几个，其余的敲两个字母就到，既不占地方也没丢。
 *
 * 几个刻意的设计：
 *   · 支持拼音首字母。输入 "dcw" 能找到「导出 Word」—— 中文界面里
 *     不做这个，搜索框基本等于摆设。
 *   · 记住最近用过的。没输入时列出的是你常用的，不是字母序。
 *   · 每条都显示快捷键。用户用着用着就把快捷键学会了，最终连面板
 *     也不用开 —— 好的入口应该教会用户绕过自己。
 * ===================================================================== */
import * as prefs from '../../core/prefs.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* 常用汉字 → 声母。够用即可，不追求完整的拼音库。 */
const INITIALS = {
  导: 'd', 出: 'c', 分: 'f', 享: 'x', 保: 'b', 存: 'c', 打: 'd', 开: 'k',
  编: 'b', 辑: 'j', 阅: 'y', 读: 'd', 源: 'y', 码: 'm', 查: 'c', 找: 'z',
  替: 't', 换: 'h', 撤: 'c', 销: 'x', 重: 'c', 做: 'z', 改: 'g', 动: 'd',
  审: 's', 复: 'f', 制: 'z', 网: 'w', 页: 'y', 打印: 'dy', 设: 's', 置: 'z',
  主: 'z', 题: 't', 文: 'w', 件: 'j', 库: 'k', 上: 's', 传: 'c', 链: 'l',
  接: 'j', 目: 'm', 录: 'l', 大: 'd', 纲: 'g', 侧: 'c', 栏: 'l', 整: 'z',
  屏: 'p', 新: 'x', 建: 'j', 加: 'j', 载: 'z', 清: 'q', 空: 'k', 搜: 's',
  索: 's', 标: 'b', 记: 'j', 已: 'y', 还: 'h', 原: 'y', 全: 'q', 部: 'b',
  切: 'q', 亮: 'l', 暗: 'a', 色: 's', 字: 'z', 号: 'h', 宽: 'k', 度: 'd',
};

function initials(text) {
  let out = '';
  for (const ch of String(text)) {
    if (/[a-zA-Z0-9]/.test(ch)) out += ch.toLowerCase();
    else if (INITIALS[ch]) out += INITIALS[ch];
  }
  return out;
}

/** 打分：命中方式不同，排序权重不同 */
function score(cmd, q) {
  if (!q) return 0;
  const title = cmd.title.toLowerCase();
  const keys = (cmd.keywords || '').toLowerCase();
  const py = cmd.__py || (cmd.__py = initials(cmd.title + ' ' + (cmd.keywords || '')));

  if (title.startsWith(q)) return 100;
  if (py.startsWith(q)) return 90;          // 拼音首字母开头
  if (title.includes(q)) return 70;
  if (keys.includes(q)) return 50;
  if (py.includes(q)) return 40;

  // 松散匹配：字符按顺序出现即可，容忍中间隔了别的字
  let i = 0;
  for (const ch of py) { if (ch === q[i]) i++; if (i === q.length) return 20; }
  return -1;
}

export function createPalette(getCommands) {
  let root = null;
  let input = null;
  let list = null;
  let items = [];
  let cursor = 0;

  function build() {
    root = document.createElement('div');
    root.className = 'cp-root';
    root.hidden = true;
    root.innerHTML = `
      <div class="cp-backdrop"></div>
      <div class="cp-box" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="cp-field">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
            <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <input type="text" placeholder="想做什么？打几个字，或拼音首字母" aria-label="搜索命令" autocomplete="off" spellcheck="false">
          <kbd>esc</kbd>
        </div>
        <div class="cp-list" role="listbox"></div>
        <div class="cp-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>enter</kbd> 执行</span>
          <span class="cp-tip">工具栏放不下的功能都在这儿</span>
        </div>
      </div>`;
    /* 挂进能力容器，不挂 document.body —— .cp-* 的样式在 workspace.css 里，
       那份样式表被限定成 [data-ds-host="markdown"] 前缀（见 app/main.js 的
       scopeCss）。挂到 body 上就在限定范围之外，命令面板会变成一堆裸文字。 */
    (window.MDW?.root?.() || document.body).appendChild(root);

    input = root.querySelector('input');
    list = root.querySelector('.cp-list');

    root.querySelector('.cp-backdrop').addEventListener('click', close);
    input.addEventListener('input', () => { cursor = 0; render(); });
    input.addEventListener('keydown', onKey);
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.cp-item');
      if (row) exec(items[Number(row.dataset.i)]);
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); exec(items[cursor]); }
  }

  function move(d) {
    if (!items.length) return;
    cursor = (cursor + d + items.length) % items.length;
    paintCursor();
  }

  function paintCursor() {
    [...list.children].forEach((el, i) => {
      const on = i === cursor;
      el.classList.toggle('on', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    const all = getCommands().filter((c) => !c.when || c.when());

    if (!q) {
      // 没输入时列常用的 —— 字母序对用户没有意义
      const recent = prefs.get('palette.recent') || [];
      items = [...all].sort((a, b) => {
        const ra = recent.indexOf(a.id);
        const rb = recent.indexOf(b.id);
        if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
        return (a.order || 50) - (b.order || 50);
      }).slice(0, 12);
    } else {
      items = all
        .map((c) => ({ c, s: score(c, q) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c)
        .slice(0, 20);
    }

    if (!items.length) {
      list.innerHTML = `<div class="cp-empty">没有匹配的功能。<br><span>试试「导出」「分享」「主题」</span></div>`;
      return;
    }

    let lastGroup = '';
    list.innerHTML = items.map((c, i) => {
      const head = c.group && c.group !== lastGroup
        ? `<div class="cp-group">${esc(c.group)}</div>` : '';
      lastGroup = c.group || lastGroup;
      return head + `
        <div class="cp-item${i === cursor ? ' on' : ''}" data-i="${i}" role="option">
          <span class="cp-ico">${c.icon || '·'}</span>
          <span class="cp-body">
            <span class="cp-title">${esc(c.title)}</span>
            ${c.desc ? `<span class="cp-desc">${esc(c.desc)}</span>` : ''}
          </span>
          ${c.key ? `<span class="cp-key">${c.key.split('+').map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span>` : ''}
        </div>`;
    }).join('');
    paintCursor();
  }

  function exec(cmd) {
    if (!cmd) return;
    close();
    const recent = [cmd.id, ...(prefs.get('palette.recent') || []).filter((x) => x !== cmd.id)];
    prefs.set('palette.recent', recent.slice(0, 8));
    try { cmd.run(); } catch (e) { console.error('[docsmith] 命令执行出错', cmd.id, e); }
  }

  function open() {
    if (!root) build();
    root.hidden = false;
    input.value = '';
    cursor = 0;
    render();
    requestAnimationFrame(() => input.focus());
  }

  function close() {
    if (root) root.hidden = true;
  }

  function toggle() {
    if (!root || root.hidden) open(); else close();
  }

  /* ⌘K / Ctrl+K 只在 Markdown 工作台正显示着时开命令面板。
     合并进外壳后 window 是共用的 —— 不设闸的话在文件库界面上按 ⌘K，
     工作台的命令面板会浮出来，而它列的全是「当前看不见的那个页面」的操作。
     DSActive 在触发时才取（active.js 是 defer，绑定时不保证已就位）。 */
  window.addEventListener('keydown', (e) => {
    const A = window.DSActive;
    if (A?.isActive && !A.isActive(window.MDW?.root?.() || document.body)) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      toggle();
    }
  });

  return { open, close, toggle };
}
