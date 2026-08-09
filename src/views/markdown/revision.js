/* =====================================================================
 * Docsmith · 改动审阅
 * ---------------------------------------------------------------------
 * 编辑完一份文档，你需要知道自己到底改了什么 —— 尤其是改表格的时候。
 *
 * 设计上参考了飞书云文档的审阅体验，三个要点：
 *
 *   1. 改动是"一处一处"的，不是一片红绿。
 *      每处改动是一张卡片，能单独保留或撤回。
 *
 *   2. 表格改动要能看懂。
 *      整张表画出来，只有变了的那一格上色，旧值划掉、新值跟在后面。
 *      改一个数字就只有一格是彩色的，不会满屏飘红。
 *
 *   3. 随时能跳过去看原文。
 *      点卡片就滚到正文对应位置，正文左边有一道颜色条标出改动范围。
 *
 * “确认点”是对比起点：第一次打开面板时记下当前内容；之后也能把当前版本
 * 重新记为已确认。确认点存在本机，关闭并重新打开文档后仍可继续对比。
 * ===================================================================== */
import { diffDocument, countChanges, revertHunk, acceptHunk } from './diff-engine.js';
import * as prefs from '../../core/prefs.js';
import { read, write } from '../../core/store.js';
import { KEYS } from '../../core/config.js';

const BASELINE_KEY = KEYS.baselines;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ==================================================== 基准存取 */

function baselines() { return read(BASELINE_KEY, {}); }

export function getBaseline(docId) {
  return baselines()[docId]?.text ?? null;
}

export function setBaseline(docId, text, name = '') {
  const all = baselines();
  all[docId] = { text, name, at: Date.now() };

  // 只留最近 20 篇，且总量控制在 2MB 以内，免得把本地空间吃光
  const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at);
  let bytes = 0;
  const kept = {};
  for (const [id, v] of entries.slice(0, 20)) {
    bytes += (v.text || '').length;
    if (bytes > 2_000_000 && Object.keys(kept).length) break;
    kept[id] = v;
  }
  try { write(BASELINE_KEY, kept); } catch (e) { /* 存不下就算了，审阅是增益功能 */ }
}

export function clearBaseline(docId) {
  const all = baselines();
  delete all[docId];
  write(BASELINE_KEY, all);
}

/* ==================================================== 审阅器 */

/**
 * @param {Object} host 宿主提供的钩子，把审阅器和 Markdown 工作台接起来
 *   host.getDoc()          → { id, name, text }
 *   host.setText(text)     写回正文（会触发重新渲染）
 *   host.scrollToLine(n)   把正文滚到某一行
 *   host.toast(msg)        提示
 */
export function createReviewer(host) {
  let hunks = [];
  let activeIdx = -1;
  let panel = null;
  let mounted = false;

  /* ------------------------------------------------------------ 计算 */

  function compute() {
    const doc = host.getDoc();
    if (!doc) { hunks = []; return; }
    let base = getBaseline((doc.key || doc.id));
    if (base == null) {
      // 第一次看这篇：把当前内容记为基准，此刻"零改动"
      base = doc.text ?? '';
      if (prefs.get('review.autoBaseline')) setBaseline((doc.key || doc.id), base, doc.name);
    }
    hunks = diffDocument(base, doc.text ?? '');
  }

  /* ------------------------------------------------------------ 渲染 */

  function render() {
    if (!panel) return;
    const doc = host.getDoc();
    const total = countChanges(hunks);

    panel.querySelector('.rv-count').textContent =
      total === 0 ? '没有改动' : `${total} 处改动`;
    panel.querySelector('.rv-nav').hidden = hunks.length === 0;
    panel.querySelector('.rv-bulk').hidden = hunks.length === 0;

    const body = panel.querySelector('.rv-body');

    if (!doc) {
      body.innerHTML = '<div class="rv-empty"><p>先打开一份文档。</p></div>';
      return;
    }
    if (!hunks.length) {
      body.innerHTML = `
        <div class="rv-empty">
          <p>和上次确认的版本一样。</p>
          <p class="rv-empty-sub">之后发生的变化会逐条列出来，可以保留或撤回。</p>
        </div>`;
      return;
    }

    body.innerHTML = hunks.map((h, i) => card(h, i)).join('');

    body.querySelectorAll('.rv-card').forEach((el) => {
      const i = Number(el.dataset.i);
      el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        focus(i);
      });
      el.querySelector('[data-act="accept"]')?.addEventListener('click', () => accept(i));
      el.querySelector('[data-act="revert"]')?.addEventListener('click', () => revert(i));
    });

    highlightActive();
  }

  function card(h, i) {
    const inner = h.kind === 'table' ? tableView(h.table) : textView(h.lines);
    return `
      <article class="rv-card${h.kind === 'table' ? ' is-table' : ''}" data-i="${i}">
        <header class="rv-card-head">
          <span class="rv-badge rv-badge-${h.kind}">${h.kind === 'table' ? '表格' : '正文'}</span>
          <span class="rv-summary">${esc(h.summary)}</span>
          <span class="rv-line">第 ${h.newStart + 1} 行</span>
        </header>
        <div class="rv-card-body">${inner}</div>
        <footer class="rv-card-foot">
          <button class="rv-btn rv-accept" data-act="accept">保留这处修改</button>
          <button class="rv-btn rv-revert" data-act="revert">还原</button>
        </footer>
      </article>`;
  }

  /* 正文改动：旧的划掉，新的标出来 */
  function textView(lines) {
    return `<div class="rv-text">${lines.map((l) => {
      if (l.type === 'add') {
        return `<div class="rv-line-row add"><span class="rv-mark">＋</span><span class="rv-content">${esc(l.new) || '<i>空行</i>'}</span></div>`;
      }
      if (l.type === 'del') {
        return `<div class="rv-line-row del"><span class="rv-mark">－</span><span class="rv-content"><del>${esc(l.old) || '<i>空行</i>'}</del></span></div>`;
      }
      return `<div class="rv-line-row mod">
          <span class="rv-mark">～</span>
          <span class="rv-content">${l.words.new.map(seg).join('')}</span>
        </div>
        <div class="rv-line-row mod was">
          <span class="rv-mark"></span>
          <span class="rv-content rv-was">原：${l.words.old.map(seg).join('')}</span>
        </div>`;
    }).join('')}</div>`;
  }

  const seg = (s) => {
    if (s.t === 'add') return `<ins>${esc(s.text)}</ins>`;
    if (s.t === 'del') return `<del>${esc(s.text)}</del>`;
    return esc(s.text);
  };

  /* 表格改动：整张表画出来，只给变了的格子上色 —— 这是这个功能的重点 */
  function tableView(t) {
    const rows = t.rows.map((r, ri) => {
      const cells = r.cells.map((c) => {
        if (r.state === 'add') return `<td class="c-add">${esc(c.new)}</td>`;
        if (r.state === 'del') return `<td class="c-del"><del>${esc(c.old)}</del></td>`;
        if (c.state === 'mod') {
          return `<td class="c-mod">
            <span class="c-old">${esc(c.old) || '<i>空</i>'}</span>
            <span class="c-arrow">→</span>
            <span class="c-new">${esc(c.new) || '<i>空</i>'}</span>
          </td>`;
        }
        return `<td>${esc(c.new)}</td>`;
      }).join('');

      const gutter = r.state === 'add' ? '＋' : r.state === 'del' ? '－' : r.state === 'mod' ? '～' : '';
      const tag = ri === 0 ? 'th' : 'td';
      const head = ri === 0
        ? r.cells.map((c) => `<th>${esc(c.new || c.old)}</th>`).join('')
        : cells;

      return `<tr class="r-${r.state}"><td class="r-gutter">${gutter}</td>${head}</tr>`;
    }).join('');

    return `<div class="rv-table-wrap"><table class="rv-table">${rows}</table></div>`;
  }

  /* ------------------------------------------------------------ 操作 */

  function focus(i) {
    activeIdx = i;
    const h = hunks[i];
    if (h) host.scrollToLine?.(h.newStart);
    highlightActive();
    paintGutter();
  }

  function highlightActive() {
    panel?.querySelectorAll('.rv-card').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.i) === activeIdx);
    });
    const el = panel?.querySelector('.rv-card.active');
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function step(delta) {
    if (!hunks.length) return;
    activeIdx = (activeIdx + delta + hunks.length) % hunks.length;
    focus(activeIdx);
  }

  function accept(i) {
    const doc = host.getDoc();
    const h = hunks[i];
    if (!doc || !h) return;
    const base = getBaseline((doc.key || doc.id)) ?? '';
    setBaseline((doc.key || doc.id), acceptHunk(base, h), doc.name);
    refresh();
    host.toast?.('已保留这处修改 · 尚未保存到文件');
  }

  function revert(i) {
    const doc = host.getDoc();
    const h = hunks[i];
    if (!doc || !h) return;
    host.setText(revertHunk(doc.text ?? '', h));
    refresh();
    host.toast?.('已还原');
  }

  function acceptAll() {
    const doc = host.getDoc();
    if (!doc || !hunks.length) return;
    setBaseline((doc.key || doc.id), doc.text ?? '', doc.name);
    activeIdx = -1;
    refresh();
    host.toast?.('当前版本已记为确认点 · 尚未保存到文件');
  }

  function revertAll() {
    const doc = host.getDoc();
    if (!doc) return;
    const base = getBaseline((doc.key || doc.id));
    if (base == null) return;
    if (!confirm('还原到你上次确认的版本？\n确认点之后的修改都会被撤回。')) return;
    host.setText(base);
    activeIdx = -1;
    refresh();
    host.toast?.('已还原到上次确认的版本');
  }

  /* --------------------------------------------- 正文左侧的改动条 */

  function paintGutter() {
    const root = host.getPreviewRoot?.();
    if (!root) return;
    root.querySelectorAll('.rv-gutter-bar').forEach((el) => el.remove());
    if (!prefs.get('review.enabled') || !hunks.length) return;

    hunks.forEach((h, i) => {
      const el = host.elementAtLine?.(h.newStart);
      if (!el) return;
      const bar = document.createElement('span');
      bar.className = `rv-gutter-bar${i === activeIdx ? ' active' : ''}`;
      bar.dataset.i = String(i);
      bar.title = h.summary;
      bar.addEventListener('click', () => focus(i));
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.appendChild(bar);
    });
  }

  /* ------------------------------------------------------------ 生命周期 */

  function refresh() {
    compute();
    render();
    paintGutter();
    host.onCountChange?.(countChanges(hunks));
  }

  function mount(container) {
    if (mounted) return;
    panel = document.createElement('aside');
    panel.className = 'rv-panel';
    panel.innerHTML = `
      <header class="rv-head">
        <div class="rv-title">
          <b>上次确认后的变化</b>
          <span class="rv-count">没有改动</span>
        </div>
        <div class="rv-nav" hidden>
          <button class="rv-icon" data-nav="prev" title="上一处 (Alt+↑)">↑</button>
          <button class="rv-icon" data-nav="next" title="下一处 (Alt+↓)">↓</button>
        </div>
        <button class="rv-icon rv-close" title="关闭审阅 (Alt+R)">✕</button>
      </header>
      <div class="rv-body"></div>
      <footer class="rv-foot rv-bulk" hidden>
        <button class="rv-btn rv-primary" data-bulk="accept">把当前版本记为已确认</button>
        <button class="rv-btn" data-bulk="revert">全部撤回</button>
      </footer>
      <p class="rv-hint">
        这里显示从你上次确认后发生的变化。“保留”只更新确认点，
        不会写入磁盘；要真正保存，请点工具栏的“保存”。
      </p>`;
    container.appendChild(panel);

    panel.querySelector('[data-nav="prev"]').addEventListener('click', () => step(-1));
    panel.querySelector('[data-nav="next"]').addEventListener('click', () => step(1));
    panel.querySelector('.rv-close').addEventListener('click', () => close());
    panel.querySelector('[data-bulk="accept"]').addEventListener('click', acceptAll);
    panel.querySelector('[data-bulk="revert"]').addEventListener('click', revertAll);

    mounted = true;
  }

  function open(container) {
    mount(container);
    panel.classList.add('open');
    document.documentElement.dataset.review = 'on';
    prefs.set('review.enabled', true);
    refresh();
  }

  function close() {
    panel?.classList.remove('open');
    delete document.documentElement.dataset.review;
    prefs.set('review.enabled', false);
    host.getPreviewRoot?.()?.querySelectorAll('.rv-gutter-bar').forEach((el) => el.remove());
    host.onToggle?.(false);
  }

  function toggle(container) {
    if (prefs.get('review.enabled')) close();
    else open(container);
  }

  /* 文档换了 / 内容变了都要重算 */
  function onDocChanged() {
    activeIdx = -1;
    if (prefs.get('review.enabled')) refresh();
  }

  function onTextChanged() {
    if (prefs.get('review.enabled')) refresh();
  }

  /* 键盘：Alt+R 开关审阅，Alt+↑↓ 跳改动 */
  /* Alt+R / Alt+↑ / Alt+↓ 只在工作台正显示着时生效。
     审阅面板属于 Markdown 工作台；合并进外壳后 window 共用，在文件库
     界面上按 Alt+R 不该把它拉出来。宿主给的容器就是判断依据。
     DSActive 在触发时才取（active.js 是 defer，绑定时不保证已就位）。 */
  window.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const A = window.DSActive;
    if (A?.isActive && !A.isActive(host.getPanelContainer?.() || document.body)) return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggle(host.getPanelContainer?.()); }
    else if (prefs.get('review.enabled') && e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (prefs.get('review.enabled') && e.key === 'ArrowDown') { e.preventDefault(); step(1); }
  });

  return {
    open, close, toggle, refresh,
    onDocChanged, onTextChanged,
    markReviewed: acceptAll,
    get count() { return countChanges(hunks); },
    get isOpen() { return !!prefs.get('review.enabled'); },
  };
}
