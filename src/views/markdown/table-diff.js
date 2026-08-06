/* =====================================================================
 * Docsmith · 表格改动审阅
 * ---------------------------------------------------------------------
 * 表格改了一格，用文字描述是「第 3 行 · 单价：12 → 15」。一两处还行，
 * 十几处就没人看得下去了 —— 你得在脑子里把坐标还原成表格。
 *
 * 所以这里换个做法：把改动画回表格里。行的增删在原位显示，改过的格子
 * 直接高亮，格子里用删除线和下划线标出改了哪几个字。眼睛扫一遍就知道
 * 动了哪儿，不用对坐标。
 *
 * 行怎么配对是关键。按行号硬配，中间插一行会导致后面全错位、满屏飘红。
 * 这里先给每行算个指纹，再做一次 LCS 找出真正没变的那些行 —— 插入的行
 * 就只标它自己，其余行安安静静。
 *
 * 暴露 window.DSTableDiff，由 workspace.js 在渲染改动卡片时调用。
 * ===================================================================== */
(function (w) {
  'use strict';

  var MAX_CELLS = 4000;      // 超大表格不做逐格比对，退回原来的清单式
  var LCS_CAP = 90000;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------ 解析 */

  /** 把一段 Markdown 表格切成 {head, align, rows}。 */
  function parse(raw) {
    var lines = String(raw || '').replace(/\r/g, '').split('\n')
      .filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) return null;

    var cut = function (line) {
      var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      var out = [], buf = '', escaped = false;
      for (var i = 0; i < s.length; i++) {
        var ch = s[i];
        if (escaped) { buf += ch; escaped = false; continue; }
        if (ch === '\\') { escaped = true; buf += ch; continue; }
        if (ch === '|') { out.push(buf.trim()); buf = ''; continue; }
        buf += ch;
      }
      out.push(buf.trim());
      return out;
    };

    var head = cut(lines[0]);
    var sep = cut(lines[1]);
    // 第二行必须是 ---|:--:|--- 这种分隔行，否则它不是表格
    if (!sep.length || !sep.every(function (c) { return /^:?-{1,}:?$/.test(c.replace(/\s/g, '')); })) return null;

    var align = sep.map(function (c) {
      var t = c.replace(/\s/g, '');
      if (/^:.*:$/.test(t)) return 'center';
      if (/:$/.test(t)) return 'right';
      if (/^:/.test(t)) return 'left';
      return '';
    });

    var rows = lines.slice(2).map(cut);
    return { head: head, align: align, rows: rows };
  }

  /* -------------------------------------------------------- 行的配对 */

  /**
   * 一行的指纹，用来判断「还是不是同一行」。
   *
   * 只拿两张表都有的列来算。这一点很关键：如果把整行都算进去，那么
   * 「新增了一列」会让每一行的指纹都变，LCS 就一行都认不出来，结果
   * 满屏飘红 —— 明明只是加了一列而已。
   *
   * @param cells  这一行的格子
   * @param cols   列配对结果；side 取 'a' 或 'b' 决定读哪一侧的列号
   */
  function rowKey(cells, cols, side) {
    if (!cells) return '';
    var idx;
    if (cols && cols.length) {
      idx = cols.filter(function (c) { return c.kind === 'same'; })
                .map(function (c) { return c[side]; });
      if (!idx.length) idx = cells.map(function (_, i) { return i; });   // 没有共有列，退回整行
    } else {
      idx = cells.map(function (_, i) { return i; });
    }
    return idx.map(function (i) {
      return String(cells[i] == null ? '' : cells[i]).replace(/[*_`~\s]/g, '').toLowerCase();
    }).join('\u0001');
  }

  function lcs(a, b) {
    var n = a.length, m = b.length, i, j;
    if (!n || !m || n * m > LCS_CAP) return [];
    var dp = [];
    for (i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = []; i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return out;
  }

  /**
   * 把新旧两张表的行排成一个序列。
   * 每一项是 { kind: 'same'|'mod'|'add'|'del', a: 旧行, b: 新行, ai, bi }
   */
  function alignRows(A, B, cols) {
    var ka = A.rows.map(function (r) { return rowKey(r, cols, 'a'); });
    var kb = B.rows.map(function (r) { return rowKey(r, cols, 'b'); });
    var pairs = lcs(ka, kb).concat([[ka.length, kb.length]]);
    var out = [], ai = 0, bi = 0;

    pairs.forEach(function (p) {
      var ga = p[0] - ai, gb = p[1] - bi;
      var common = Math.min(ga, gb), k;

      // 缺口里能一一对上的，算「这一行被改了」
      for (k = 0; k < common; k++) {
        out.push({ kind: 'mod', a: A.rows[ai + k], b: B.rows[bi + k], ai: ai + k, bi: bi + k });
      }
      // 新表多出来的行 → 新增
      for (k = common; k < gb; k++) {
        out.push({ kind: 'add', a: null, b: B.rows[bi + k], ai: -1, bi: bi + k });
      }
      // 旧表多出来的行 → 删除
      for (k = common; k < ga; k++) {
        out.push({ kind: 'del', a: A.rows[ai + k], b: null, ai: ai + k, bi: -1 });
      }
      // 哨兵不算一行真实数据
      if (p[0] < ka.length && p[1] < kb.length) {
        out.push({ kind: 'same', a: A.rows[p[0]], b: B.rows[p[1]], ai: p[0], bi: p[1] });
      }
      ai = p[0] + 1; bi = p[1] + 1;
    });

    return out;
  }

  /* -------------------------------------------------------- 列的配对 */

  /**
   * 列也可能增删。按表头名字配对，配不上的按位置兜底。
   * 返回 { cols: [{a, b, kind}], added: n, removed: n }
   */
  function alignCols(A, B) {
    var ha = (A.head || []).map(function (h) { return String(h).trim().toLowerCase(); });
    var hb = (B.head || []).map(function (h) { return String(h).trim().toLowerCase(); });

    // 表头全空或全同名，退回按位置对
    var distinct = new Set(hb).size === hb.length && hb.every(Boolean);
    if (!distinct) {
      var n = Math.max(ha.length, hb.length), cols = [];
      for (var i = 0; i < n; i++) {
        cols.push({
          a: i < ha.length ? i : -1,
          b: i < hb.length ? i : -1,
          kind: i >= ha.length ? 'add' : (i >= hb.length ? 'del' : 'same'),
        });
      }
      return { cols: cols, added: Math.max(0, hb.length - ha.length), removed: Math.max(0, ha.length - hb.length) };
    }

    var pairs = lcs(ha, hb).concat([[ha.length, hb.length]]);
    var out = [], ai = 0, bi = 0, added = 0, removed = 0;
    pairs.forEach(function (p) {
      var k;
      for (k = ai; k < p[0]; k++) { out.push({ a: k, b: -1, kind: 'del' }); removed++; }
      for (k = bi; k < p[1]; k++) { out.push({ a: -1, b: k, kind: 'add' }); added++; }
      if (p[0] < ha.length && p[1] < hb.length) out.push({ a: p[0], b: p[1], kind: 'same' });
      ai = p[0] + 1; bi = p[1] + 1;
    });
    return { cols: out, added: added, removed: removed };
  }

  /* ---------------------------------------------------------- 渲染 */

  function cellText(row, i) {
    if (!row || i < 0 || i >= row.length) return '';
    return String(row[i] == null ? '' : row[i]).trim();
  }

  /** 单元格里的字级差异，交给主逻辑提供的 inlineWordDiff。 */
  function cellDiffHtml(oldText, newText, wordDiff) {
    if (oldText === newText) return esc(newText);
    if (typeof wordDiff === 'function') {
      try { return wordDiff(oldText, newText); } catch (e) {}
    }
    return '<del class="w-del">' + esc(oldText) + '</del> <ins class="w-ins">' + esc(newText) + '</ins>';
  }

  /**
   * 生成审阅视图。
   * @param oldRaw  改之前的表格源码
   * @param newRaw  现在的表格源码
   * @param opts    { wordDiff, onlyChanged }
   * @returns {null|{html, stat}} null 表示这不是能比对的表格，交回给调用方走老路
   */
  function review(oldRaw, newRaw, opts) {
    opts = opts || {};
    var A = parse(oldRaw), B = parse(newRaw);
    if (!A || !B) return null;

    var cellCount = (A.rows.length + 1) * (A.head.length || 1)
                  + (B.rows.length + 1) * (B.head.length || 1);
    if (cellCount > MAX_CELLS) return null;

    var colInfo = alignCols(A, B);
    var rowSeq = alignRows(A, B, colInfo.cols);   // 行配对要避开新增/删除的列，否则全乱
    var wordDiff = opts.wordDiff;

    var stat = { rowAdd: 0, rowDel: 0, cellMod: 0, colAdd: colInfo.added, colDel: colInfo.removed };

    /* --- 表头 --- */
    var thead = colInfo.cols.map(function (c) {
      var oldH = cellText(A.head, c.a), newH = cellText(B.head, c.b);
      var cls = 'tv-th';
      var inner;
      if (c.kind === 'add') { cls += ' tv-col-add'; inner = esc(newH) + '<i class="tv-flag">新列</i>'; }
      else if (c.kind === 'del') { cls += ' tv-col-del'; inner = '<s>' + esc(oldH) + '</s><i class="tv-flag">已删</i>'; }
      else if (oldH !== newH) { cls += ' tv-cell-mod'; inner = cellDiffHtml(oldH, newH, wordDiff); stat.cellMod++; }
      else inner = esc(newH);
      return '<th class="' + cls + '">' + inner + '</th>';
    }).join('');

    /* --- 表体 --- */
    var body = [];
    rowSeq.forEach(function (r) {
      if (r.kind === 'add') stat.rowAdd++;
      if (r.kind === 'del') stat.rowDel++;

      var tds = colInfo.cols.map(function (c) {
        var oldV = r.a ? cellText(r.a, c.a) : '';
        var newV = r.b ? cellText(r.b, c.b) : '';
        var align = B.align[c.b >= 0 ? c.b : 0] || '';
        var style = align ? ' style="text-align:' + align + '"' : '';

        if (r.kind === 'del') return '<td class="tv-td"' + style + '><s>' + esc(oldV) + '</s></td>';
        if (r.kind === 'add') return '<td class="tv-td"' + style + '>' + esc(newV) + '</td>';
        if (c.kind === 'add') return '<td class="tv-td tv-col-add"' + style + '>' + esc(newV) + '</td>';
        if (c.kind === 'del') return '<td class="tv-td tv-col-del"' + style + '><s>' + esc(oldV) + '</s></td>';

        if (oldV !== newV) {
          stat.cellMod++;
          return '<td class="tv-td tv-cell-mod"' + style + '>' + cellDiffHtml(oldV, newV, wordDiff) + '</td>';
        }
        return '<td class="tv-td"' + style + '>' + esc(newV) + '</td>';
      }).join('');

      var rowCls = 'tv-tr tv-row-' + r.kind;
      var changed = r.kind !== 'same'
        || colInfo.cols.some(function (c) {
             return c.kind === 'same' && cellText(r.a, c.a) !== cellText(r.b, c.b);
           });
      if (!changed) rowCls += ' tv-quiet';

      var gutter = '<td class="tv-gut" aria-hidden="true">'
        + (r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : (changed ? '·' : ''))
        + '</td>';

      body.push('<tr class="' + rowCls + '">' + gutter + tds + '</tr>');
    });

    var total = stat.rowAdd + stat.rowDel + stat.cellMod + stat.colAdd + stat.colDel;
    if (!total) return { html: '', stat: stat, empty: true };

    var summary = [];
    if (stat.rowAdd) summary.push('新增 ' + stat.rowAdd + ' 行');
    if (stat.rowDel) summary.push('删除 ' + stat.rowDel + ' 行');
    if (stat.colAdd) summary.push('新增 ' + stat.colAdd + ' 列');
    if (stat.colDel) summary.push('删除 ' + stat.colDel + ' 列');
    if (stat.cellMod) summary.push('改动 ' + stat.cellMod + ' 格');

    var html =
      '<div class="tv-wrap cd-detail-table" data-only="' + (opts.onlyChanged ? '1' : '0') + '">' +
        '<div class="tv-bar">' +
          '<span class="tv-sum">' + summary.join(' · ') + '</span>' +
          '<button type="button" class="tv-toggle" data-tv="only">' +
            (opts.onlyChanged ? '显示整张表' : '只看改动的行') +
          '</button>' +
        '</div>' +
        '<div class="tv-scroll"><table class="tv-table">' +
          '<thead><tr><th class="tv-gut" aria-hidden="true"></th>' + thead + '</tr></thead>' +
          '<tbody>' + body.join('') + '</tbody>' +
        '</table></div>' +
        '<div class="tv-legend">' +
          '<span><i class="tv-k tv-k-add"></i>新增</span>' +
          '<span><i class="tv-k tv-k-del"></i>删除</span>' +
          '<span><i class="tv-k tv-k-mod"></i>改动</span>' +
        '</div>' +
      '</div>';

    return { html: html, stat: stat, empty: false };
  }

  /** 给「只看改动的行」按钮接上开关。调用方在插入 DOM 后调一次。 */
  function bind(root) {
    if (!root) return;
    root.querySelectorAll('[data-tv="only"]').forEach(function (btn) {
      if (btn._tvBound) return;
      btn._tvBound = true;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var wrap = btn.closest('.tv-wrap');
        if (!wrap) return;
        var on = wrap.dataset.only === '1';
        wrap.dataset.only = on ? '0' : '1';
        btn.textContent = on ? '只看改动的行' : '显示整张表';
        if (w.DSPrefs) w.DSPrefs.set('table-review-only-changed', !on);
      });
    });
  }

  w.DSTableDiff = { parse: parse, review: review, bind: bind };
})(window);
