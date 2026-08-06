/* =====================================================================
 * Docsmith · 差异引擎
 * ---------------------------------------------------------------------
 * 算出"改了哪儿"。三个层次，从粗到细：
 *
 *   行  →  哪几行变了            （LCS）
 *   词  →  这一行里具体改了哪个字（LCS，中文按字切）
 *   格  →  表格里哪个单元格变了  （先对行，再对列，再对词）
 *
 * 表格单独处理是有原因的：一张表改一个数字，按行比对会显示成"整行删掉、
 * 整行加回来"，满屏红绿，人根本看不出到底改了什么。按单元格比对之后，
 * 就只有那一格是高亮的 —— 这才是人想看到的。
 *
 * 没有外部依赖，纯手写。
 * ===================================================================== */

/* ============================================================ 分词 */

/* 中文没有空格，按词切会把整句话当成一个词，改一个字就整句飘红。
   所以中日韩字符一个字一个 token，拉丁文按词，标点单独成 token。 */
const TOKEN_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[A-Za-z0-9_]+|\s+|[^\s]/g;

export function tokenize(str) {
  return String(str ?? '').match(TOKEN_RE) || [];
}

/* ============================================================ LCS */

/**
 * 最长公共子序列。返回一串操作。
 * 超长输入会退化成 O(n²) 内存，所以设了上限；超了就走"整块替换"。
 */
function lcsOps(a, b, eq = (x, y) => x === y) {
  const n = a.length;
  const m = b.length;

  if (n * m > 4_000_000) {
    // 太大了，算不动。退回粗粒度：整段删、整段加。
    return [
      ...a.map((v, i) => ({ type: 'del', a: v, ai: i })),
      ...b.map((v, i) => ({ type: 'add', b: v, bi: i })),
    ];
  }

  // 掐头去尾：开头和结尾相同的部分不用参与计算，能省掉绝大多数工作量
  let head = 0;
  while (head < n && head < m && eq(a[head], b[head])) head += 1;
  let tail = 0;
  while (tail < n - head && tail < m - head && eq(a[n - 1 - tail], b[m - 1 - tail])) tail += 1;

  const A = a.slice(head, n - tail);
  const B = b.slice(head, m - tail);

  const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i -= 1) {
    for (let j = B.length - 1; j >= 0; j -= 1) {
      dp[i][j] = eq(A[i], B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  for (let i = 0; i < head; i += 1) ops.push({ type: 'same', a: a[i], b: b[i], ai: i, bi: i });

  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (eq(A[i], B[j])) {
      ops.push({ type: 'same', a: A[i], b: B[j], ai: head + i, bi: head + j });
      i += 1; j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', a: A[i], ai: head + i });
      i += 1;
    } else {
      ops.push({ type: 'add', b: B[j], bi: head + j });
      j += 1;
    }
  }
  while (i < A.length) { ops.push({ type: 'del', a: A[i], ai: head + i }); i += 1; }
  while (j < B.length) { ops.push({ type: 'add', b: B[j], bi: head + j }); j += 1; }

  for (let k = 0; k < tail; k += 1) {
    ops.push({ type: 'same', a: a[n - tail + k], b: b[m - tail + k], ai: n - tail + k, bi: m - tail + k });
  }
  return ops;
}

/* ==================================================== 词级差异 */

/**
 * 比较两行文字，返回带标记的片段。
 * @returns {{old: Array<{t,text}>, new: Array<{t,text}>}}  t: same|del|add
 */
export function diffWords(oldLine, newLine) {
  const ops = lcsOps(tokenize(oldLine), tokenize(newLine));
  const out = { old: [], new: [] };
  const push = (side, t, text) => {
    const arr = out[side];
    const last = arr[arr.length - 1];
    if (last && last.t === t) last.text += text;      // 相邻同类合并，少一堆碎标签
    else arr.push({ t, text });
  };
  for (const op of ops) {
    if (op.type === 'same') { push('old', 'same', op.a); push('new', 'same', op.b); }
    else if (op.type === 'del') push('old', 'del', op.a);
    else push('new', 'add', op.b);
  }
  return out;
}

/** 两行的相似度 0~1。用来判断"这是改了一行"还是"删一行又加一行"。 */
export function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const ta = tokenize(a);
  const tb = tokenize(b);
  const same = lcsOps(ta, tb).filter((o) => o.type === 'same').length;
  return (2 * same) / (ta.length + tb.length);
}

/* ==================================================== 表格 */

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);

/** `| a | b |` → ['a', 'b'] */
export function splitRow(line) {
  const s = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  let esc = false;
  for (const ch of s) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { cur += ch; esc = true; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** 一段连续的表格行 → 结构化 */
function parseTable(lines) {
  const rows = lines.filter((l) => !isTableSep(l)).map(splitRow);
  const sep = lines.find(isTableSep) || null;
  return { rows, sep, header: rows[0] || [] };
}

/**
 * 表格差异，做到单元格级。
 *
 * 行怎么配对：优先看第一列（多数表格第一列是行标识，比如姓名、项目名），
 * 第一列一样就认为是同一行，只是内容改了。第一列也变了才算删旧加新。
 * 这一点和飞书的表格审阅是同样的思路 —— 尽量让"改"显示成"改"，
 * 而不是"删了一行又加了一行"。
 */
export function diffTable(oldLines, newLines) {
  const A = parseTable(oldLines);
  const B = parseTable(newLines);

  const keyOf = (row) => (row[0] ?? '').trim();
  const rowOps = lcsOps(A.rows, B.rows, (x, y) => {
    if (x.join('\u0000') === y.join('\u0000')) return true;
    const kx = keyOf(x);
    const ky = keyOf(y);
    return !!kx && kx === ky;                 // 第一列相同 → 同一行
  });

  const columns = Math.max(
    ...A.rows.map((r) => r.length),
    ...B.rows.map((r) => r.length),
    1,
  );

  const rows = [];
  let changed = 0;

  for (const op of rowOps) {
    if (op.type === 'del') {
      rows.push({ state: 'del', cells: pad(op.a, columns).map((v) => ({ state: 'del', old: v, new: '' })) });
      changed += 1;
      continue;
    }
    if (op.type === 'add') {
      rows.push({ state: 'add', cells: pad(op.b, columns).map((v) => ({ state: 'add', old: '', new: v })) });
      changed += 1;
      continue;
    }

    const oldCells = pad(op.a, columns);
    const newCells = pad(op.b, columns);
    const cells = [];
    let rowChanged = false;

    for (let c = 0; c < columns; c += 1) {
      const o = oldCells[c];
      const n = newCells[c];
      if (o === n) {
        cells.push({ state: 'same', old: o, new: n });
      } else {
        rowChanged = true;
        changed += 1;
        cells.push({ state: 'mod', old: o, new: n, words: diffWords(o, n) });
      }
    }
    rows.push({ state: rowChanged ? 'mod' : 'same', cells });
  }

  return { rows, columns, changed, header: B.header.length ? B.header : A.header, sep: B.sep || A.sep };
}

function pad(row, n) {
  const out = row.slice(0, n);
  while (out.length < n) out.push('');
  return out;
}

/* ==================================================== 文档级差异 */

/**
 * 把整篇文档切成一段段"改动块"。
 *
 * @returns {Array<Hunk>} Hunk = {
 *   id, kind: 'text'|'table',
 *   oldStart, oldEnd, newStart, newEnd,   // 行号区间，左闭右开
 *   lines: [...],                          // kind==='text' 时的逐行标记
 *   table: {...},                          // kind==='table' 时的表格差异
 *   summary                                // 一句话说明改了什么
 * }
 */
export function diffDocument(oldText, newText) {
  const A = String(oldText ?? '').split('\n');
  const B = String(newText ?? '').split('\n');
  const ops = lcsOps(A, B);

  /* 第一步：把连续的非 same 操作聚成一堆 */
  const raw = [];
  let cur = null;
  for (const op of ops) {
    if (op.type === 'same') {
      if (cur) { raw.push(cur); cur = null; }
      continue;
    }
    if (!cur) cur = { dels: [], adds: [], oldStart: -1, newStart: -1 };
    if (op.type === 'del') {
      if (cur.oldStart < 0) cur.oldStart = op.ai;
      cur.dels.push(op.a);
    } else {
      if (cur.newStart < 0) cur.newStart = op.bi;
      cur.adds.push(op.b);
    }
  }
  if (cur) raw.push(cur);

  /* 第二步：定位区间，识别表格，做词级细化 */
  const hunks = raw.map((h, i) => {
    const oldStart = h.oldStart < 0 ? nearestOld(ops, h) : h.oldStart;
    const newStart = h.newStart < 0 ? nearestNew(ops, h) : h.newStart;
    const hunk = {
      id: `h${i}`,
      oldStart,
      oldEnd: oldStart + h.dels.length,
      newStart,
      newEnd: newStart + h.adds.length,
      oldLines: h.dels,
      newLines: h.adds,
    };
    hunk.kind = 'text';
    hunk.lines = pairLines(h.dels, h.adds);
    hunk.summary = describeText(h);
    return hunk;
  });

  /* 第三步：同一张表里的改动合并成一块。
     否则改两个单元格、又加一行，会被拆成三条审阅记录，中间还夹着没变的行 ——
     用户看到的是散落的碎片，而不是"这张表变成什么样了"。 */
  return groupTables(hunks, A, B);
}

/** 找出文本里所有连续的表格块，返回 [start, end) 行区间。 */
function tableBlocks(lines) {
  const blocks = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i += 1) {
    const isRow = i < lines.length && isTableRow(lines[i]);
    if (isRow && start < 0) start = i;
    else if (!isRow && start >= 0) {
      if (i - start >= 2) blocks.push([start, i]);   // 至少表头 + 分隔线才算表
      start = -1;
    }
  }
  return blocks;
}

const inBlock = (blocks, line) => blocks.find(([s, e]) => line >= s && line < e);

function groupTables(hunks, A, B) {
  const blocksA = tableBlocks(A);
  const blocksB = tableBlocks(B);
  if (!blocksB.length && !blocksA.length) return hunks;

  const out = [];
  const claimed = new Set();

  for (const h of hunks) {
    if (claimed.has(h.id)) continue;

    // 这处改动落在某张表里吗？（新增整行时 newStart 可能正好在块边界上）
    const bB = inBlock(blocksB, h.newStart) || inBlock(blocksB, h.newStart - 1);
    const bA = inBlock(blocksA, h.oldStart) || inBlock(blocksA, h.oldStart - 1);
    if (!bB && !bA) { out.push(h); continue; }

    const rangeB = bB || [h.newStart, h.newEnd];
    const rangeA = bA || [h.oldStart, h.oldEnd];

    // 把落在同一张表里的其他改动一并收走
    for (const other of hunks) {
      if (other === h || claimed.has(other.id)) continue;
      const oB = inBlock(blocksB, other.newStart) || inBlock(blocksB, other.newStart - 1);
      const oA = inBlock(blocksA, other.oldStart) || inBlock(blocksA, other.oldStart - 1);
      if ((oB && bB && oB[0] === bB[0]) || (oA && bA && oA[0] === bA[0])) claimed.add(other.id);
    }
    claimed.add(h.id);

    const oldLines = A.slice(rangeA[0], rangeA[1]);
    const newLines = B.slice(rangeB[0], rangeB[1]);
    const table = diffTable(oldLines, newLines);

    out.push({
      id: h.id,
      kind: 'table',
      oldStart: rangeA[0],
      oldEnd: rangeA[1],
      newStart: rangeB[0],
      newEnd: rangeB[1],
      oldLines,
      newLines,
      table,
      summary: describeTable(table),
    });
  }

  return out.sort((x, y) => x.newStart - y.newStart);
}

/* 把删除行和新增行配成对：足够像的算"改"，否则算"删"和"加" */
function pairLines(dels, adds) {
  const out = [];
  const used = new Set();
  for (let i = 0; i < dels.length; i += 1) {
    let best = -1;
    let bestScore = 0.55;                       // 低于这个相似度就不算同一行改的
    for (let j = 0; j < adds.length; j += 1) {
      if (used.has(j)) continue;
      const s = similarity(dels[i], adds[j]);
      if (s > bestScore) { bestScore = s; best = j; }
    }
    if (best >= 0) {
      used.add(best);
      out.push({ type: 'mod', old: dels[i], new: adds[best], words: diffWords(dels[i], adds[best]) });
    } else {
      out.push({ type: 'del', old: dels[i], new: '' });
    }
  }
  adds.forEach((line, j) => { if (!used.has(j)) out.push({ type: 'add', old: '', new: line }); });
  return out;
}

function describeText(h) {
  if (!h.dels.length) return `新增 ${h.adds.length} 行`;
  if (!h.adds.length) return `删除 ${h.dels.length} 行`;
  return `修改 ${Math.max(h.dels.length, h.adds.length)} 行`;
}

function describeTable(t) {
  const add = t.rows.filter((r) => r.state === 'add').length;
  const del = t.rows.filter((r) => r.state === 'del').length;
  const cells = t.rows.reduce((n, r) => n + r.cells.filter((c) => c.state === 'mod').length, 0);
  const parts = [];
  if (cells) parts.push(`${cells} 个单元格`);
  if (add) parts.push(`新增 ${add} 行`);
  if (del) parts.push(`删除 ${del} 行`);
  return parts.length ? `表格 · ${parts.join('，')}` : '表格有改动';
}

function nearestOld(ops, h) {
  const first = ops.find((o) => o.type === 'add' && o.b === h.adds[0]);
  return first ? Math.max(0, first.bi) : 0;
}
function nearestNew(ops, h) {
  const first = ops.find((o) => o.type === 'del' && o.a === h.dels[0]);
  return first ? Math.max(0, first.ai) : 0;
}

/* ==================================================== 应用改动 */

/** 还原一处改动：把当前文本这一段换回原来的样子。 */
export function revertHunk(currentText, hunk) {
  const lines = currentText.split('\n');
  lines.splice(hunk.newStart, hunk.newEnd - hunk.newStart, ...hunk.oldLines);
  return lines.join('\n');
}

/** 接受一处改动：基线这一段跟上当前的样子，这处改动就不再显示。 */
export function acceptHunk(baselineText, hunk) {
  const lines = baselineText.split('\n');
  lines.splice(hunk.oldStart, hunk.oldEnd - hunk.oldStart, ...hunk.newLines);
  return lines.join('\n');
}

/** 统计：给标题栏显示"共 N 处改动"。 */
export function countChanges(hunks) {
  return hunks.reduce((n, h) => n + (h.kind === 'table' ? h.table.changed : (h.lines?.length || 1)), 0);
}
