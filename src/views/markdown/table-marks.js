/* =====================================================================
 * Docsmith · 正文里的表格改动标记
 * ---------------------------------------------------------------------
 * 侧栏的审阅面板是"逐条看"，这个模块管"就地看"：审阅打开时，正文里
 * 渲染出来的表格会直接把变过的单元格标出来 —— 鼠标停上去还能看到原值。
 *
 * 为什么要两套：
 *   看一张表整体变成什么样了 → 侧栏面板（并排对比，能接受/还原）
 *   编辑时随时知道这格动过没 → 正文标记（不打断，不用切视线）
 *
 * 飞书的表格审阅也是这个思路：正文里轻标记，侧栏里看细节。
 * ===================================================================== */
import { diffTable, splitRow } from './diff-engine.js';
import { getBaseline } from './revision.js';
import * as prefs from '../../core/prefs.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 从 Markdown 原文里切出所有表格块 */
function tableBlocks(text) {
  const lines = String(text ?? '').split('\n');
  const blocks = [];
  let start = -1;
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  for (let i = 0; i <= lines.length; i += 1) {
    const row = i < lines.length && isRow(lines[i]);
    if (row && start < 0) start = i;
    else if (!row && start >= 0) {
      if (i - start >= 2) blocks.push(lines.slice(start, i));
      start = -1;
    }
  }
  return blocks;
}

/** 表格的"身份"：用表头判断哪张表对应哪张表，比按顺序数可靠 */
function signature(block) {
  return splitRow(block[0] || '').join('\u0000');
}

/**
 * 给正文里的表格打标记。
 * @param {HTMLElement} root 预览区根元素
 * @param {string} currentText 当前 Markdown 原文
 * @param {string} docId
 */
export function markTables(root, currentText, docId) {
  if (!root) return;

  // 先清干净，避免上一次的标记残留
  root.querySelectorAll('[data-rv-cell]').forEach((td) => {
    td.removeAttribute('data-rv-cell');
    td.removeAttribute('title');
    td.querySelector('.rv-inline-old')?.remove();
  });
  root.querySelectorAll('tr[data-rv-changed]').forEach((tr) => tr.removeAttribute('data-rv-changed'));

  if (!prefs.get('review.enabled')) return;

  const base = getBaseline(docId);
  if (base == null) return;

  const oldBlocks = tableBlocks(base);
  const newBlocks = tableBlocks(currentText);
  if (!newBlocks.length) return;

  const tables = Array.from(root.querySelectorAll('table'));
  if (!tables.length) return;

  newBlocks.forEach((block, i) => {
    const dom = tables[i];
    if (!dom) return;

    // 表头一致的那张旧表才是"同一张表"；找不到就按位置退一步
    const sig = signature(block);
    const old = oldBlocks.find((b) => signature(b) === sig) || oldBlocks[i];
    if (!old) return;

    const d = diffTable(old, block);
    if (!d.changed) return;

    const domRows = Array.from(dom.rows);
    // diffTable 的第 0 行是表头，和 DOM 的 thead 行对应
    let domIdx = 0;
    for (const r of d.rows) {
      if (r.state === 'del') continue;              // 删掉的行在正文里已经不存在了
      const tr = domRows[domIdx];
      domIdx += 1;
      if (!tr) continue;

      if (r.state === 'add') {
        tr.dataset.rvChanged = 'add';
        continue;
      }
      if (r.state !== 'mod') continue;

      tr.dataset.rvChanged = 'mod';
      r.cells.forEach((c, ci) => {
        if (c.state !== 'mod') return;
        const td = tr.cells[ci];
        if (!td) return;
        td.dataset.rvCell = 'mod';
        td.title = `原来是：${c.old || '（空）'}`;

        // 把旧值挂一个小气泡，鼠标停上去能看到，不占版面
        const tip = document.createElement('span');
        tip.className = 'rv-inline-old';
        tip.innerHTML = `<b>改前</b>${esc(c.old) || '<i>空</i>'}`;
        td.appendChild(tip);
      });
    }
  });
}
