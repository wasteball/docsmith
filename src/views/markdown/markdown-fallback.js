/* =====================================================================
 * Docsmith · 内置 Markdown 渲染器
 * ---------------------------------------------------------------------
 * 为什么会有这个文件：
 *
 * Chrome 禁止插件在运行时从网上加载代码，所以渲染 Markdown 用的组件必须
 * 打包时就放进文件夹。可是打包环境不一定能联网 —— 那样做出来的包装上去
 * 就是一片白，用户根本不知道发生了什么。
 *
 * 所以这里自带一套。它只在检测到外部组件缺席时接管，接口和 marked 保持
 * 一致（parse / parseInline / lexer / use），工作台那边一行都不用改。
 *
 * 它能做到：标题、段落、列表、任务列表、表格、引用、代码块、分隔线、
 * 链接、图片、粗体斜体删除线、行内代码、脚注引用、HTML 块。
 * 做不到的：语法配色、数学公式、流程图 —— 那些交给可选组件，缺了就
 * 老实显示成纯文本，不会假装。
 *
 * 一并自带一个内容净化器（对应 DOMPurify）。别人发来的 Markdown 里可能
 * 夹带脚本，这一层用白名单把不认识的标签和属性全部剔掉。
 * ===================================================================== */
(function (w) {
  'use strict';

  if (w.marked && w.DOMPurify) return;   // 外部组件都在，用它们的

  /* ================================================== 工具 */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ================================================== 净化器 */

  /* button 必须在白名单里。代码块 / 图表块的「复制」「看源码」「复制图片」
     都是 <button>，以前它被当成未知标签剥掉，只留下里面的文字 —— 屏幕上
     看到三个词挤在一起，点了没有任何反应。那不是按钮坏了，是按钮根本不存在。 */
  var ALLOWED_TAGS = ('a abbr b blockquote br button caption code col colgroup dd del details dfn div dl dt em '
    + 'figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp section small span '
    + 'strong sub summary sup table tbody td tfoot th thead tr u ul svg path g circle rect line polyline '
    + 'polygon text tspan defs marker ellipse foreignObject').split(' ');

  var ALLOWED_ATTR = ('href src alt title class id colspan rowspan align start reversed type checked '
    + 'disabled open width height viewBox d fill stroke stroke-width stroke-dasharray stroke-linecap '
    + 'stroke-linejoin marker-end marker-start preserveAspectRatio opacity text-anchor font-size '
    + 'transform x y x1 y1 x2 y2 cx cy r rx ry refX refY orient markerWidth markerHeight '
    + 'points style role target rel loading spellcheck').split(' ');

  /* data-* 与 aria-* 一律放行：它们是惰性属性，不会执行任何东西，
     而白名单一条条列反而漏得快（data-view 漏一个，看图/看源码就废了）。 */
  var INERT_ATTR = /^(?:data|aria)-[a-z0-9_.:-]+$/;

  var TAG_OK = {};
  ALLOWED_TAGS.forEach(function (t) { TAG_OK[t] = 1; });
  /* 键一律转小写存。比对时也转小写 —— 表里写着 viewBox / preserveAspectRatio
     这些驼峰名，而比对的是小写化之后的 attribute 名，两边对不上，
     结果就是 SVG 的 viewBox 被当成野属性剥掉，图跟着变形。
     这个坑在改按钮白名单时被回归测试撞出来，属于一直存在的老问题。 */
  var ATTR_OK = {};
  ALLOWED_ATTR.forEach(function (a) { ATTR_OK[String(a).toLowerCase()] = 1; });

  /* 这两个判断单独拎出来命名，是为了能被直接测到。
     它们是这一层唯一的安全边界，"漏一个标签"和"多剥一个属性"的后果
     一个是被注入、一个是按钮消失 —— 两种都发生过，值得单独盯。 */
  function tagAllowed(tag) { return !!TAG_OK[String(tag).toLowerCase()]; }

  function attrAllowed(name) {
    var n = String(name).toLowerCase();
    if (n.indexOf('on') === 0) return false;          // 事件处理器，最常见的注入手法
    return !!ATTR_OK[n] || INERT_ATTR.test(n);        // data-* / aria-* 是惰性的，放行
  }

  /* 只允许安全的协议。javascript: 和 data:（图片除外）一律拦掉。 */
  function safeUrl(url, isImage) {
    var u = String(url || '').trim().replace(/[\u0000-\u001f]/g, '');
    if (/^(https?:|mailto:|tel:|#|\/|\.)/i.test(u)) return u;
    if (isImage && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(u)) return u;
    if (/^blob:/i.test(u)) return u;
    return '';
  }

  function sanitize(html, opts) {
    var doc = new DOMParser().parseFromString('<div id="__r">' + html + '</div>', 'text/html');
    var root = doc.getElementById('__r');
    if (!root) return '';

    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    var kill = [];
    var node;
    while ((node = walker.nextNode())) {
      var tag = node.tagName.toLowerCase();
      if (!tagAllowed(tag)) { kill.push(node); continue; }

      for (var i = node.attributes.length - 1; i >= 0; i--) {
        var at = node.attributes[i];
        var name = at.name.toLowerCase();
        if (!attrAllowed(name)) { node.removeAttribute(at.name); continue; }
        if (name === 'href' || name === 'src') {
          var ok = safeUrl(at.value, tag === 'img');
          if (!ok) node.removeAttribute(at.name);
          else node.setAttribute(at.name, ok);
        }
        if (name === 'style' && /expression|javascript:|url\s*\(/i.test(at.value)) {
          node.removeAttribute(at.name);
        }
      }
      if (tag === 'a' && node.getAttribute('target') === '_blank') {
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
    // 不认识的标签：删掉标签本身，但把里面的文字留下，免得内容凭空消失
    kill.forEach(function (el) {
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.parentNode.removeChild(el);
    });
    return root.innerHTML;
  }

  /* ================================================== 扩展注册 */

  var opts = { gfm: true, breaks: false };
  var inlineExts = [];
  var blockExts = [];
  var rendererOverride = {};

  function use(cfg) {
    if (!cfg) return;
    Object.keys(cfg).forEach(function (k) {
      if (k !== 'extensions' && k !== 'renderer') opts[k] = cfg[k];
    });
    (cfg.extensions || []).forEach(function (e) {
      if (!e || !e.name) return;
      (e.level === 'block' ? blockExts : inlineExts).push(e);
    });
    if (cfg.renderer) {
      Object.keys(cfg.renderer).forEach(function (k) { rendererOverride[k] = cfg.renderer[k]; });
    }
  }

  /* 扩展的 tokenizer/renderer 里会调用 this.lexer / this.parser，
     这里提供它们期望的最小上下文。 */
  var extCtx = {
    lexer: { inlineTokens: function (s) { return [{ __raw: s }]; } },
    parser: { parseInline: function (toks) {
      return toks.map(function (t) { return t.__raw != null ? inline(t.__raw) : ''; }).join('');
    } },
  };

  /* ================================================== 块级词法 */

  var RE = {
    fence: /^ {0,3}(`{3,}|~{3,})([^\n]*)\n(?:([\s\S]*?)\n)? {0,3}\1[ \t]*(?:\n|$)/,
    heading: /^ {0,3}(#{1,6})[ \t]+([^\n]*?)[ \t]*#*[ \t]*(?:\n|$)/,
    setext: /^([^\n]+)\n {0,3}(=+|-+)[ \t]*(?:\n|$)/,
    hr: /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})(?:\n|$)/,
    blockquote: /^(?: {0,3}>[^\n]*(?:\n|$))+/,
    listItem: /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/,
    def: /^ {0,3}\[([^\]\n][^\]\n]*)\]:[ \t]*[^\n]+(?:\n|$)/,
    fnDef: /^ {0,3}\[\^([^\]]+)\]:[ \t]*[^\n]*(?:\n(?: {2,}[^\n]*|)(?=\n|$))*(?:\n|$)/,
    htmlBlock: /^ {0,3}<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[\s\S]*?(?:\n{2,}|$)/,
    tableRow: /^ {0,3}\|?[^\n]*\|[^\n]*(?:\n|$)/,
    space: /^(?:[ \t]*\n)+/,
  };

  function isTableStart(src) {
    var lines = src.split('\n');
    if (lines.length < 2) return false;
    if (lines[0].indexOf('|') < 0) return false;
    return /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|?[ \t]*$/.test(lines[1]) && lines[1].indexOf('|') >= 0;
  }

  function lexer(src) {
    src = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var toks = [];
    var rest = src;
    var guard = 0;

    while (rest.length && guard++ < 100000) {
      var m;

      if ((m = RE.space.exec(rest))) { toks.push({ type: 'space', raw: m[0] }); rest = rest.slice(m[0].length); continue; }

      // 自定义块级扩展优先（数学公式块、TOC 标记等）
      var handled = false;
      for (var bi = 0; bi < blockExts.length; bi++) {
        var be = blockExts[bi];
        var tk = null;
        try { tk = be.tokenizer.call(extCtx, rest); } catch (e) {}
        if (tk && tk.raw) {
          toks.push({ type: be.name, raw: tk.raw, __ext: be, __tok: tk });
          rest = rest.slice(tk.raw.length);
          handled = true;
          break;
        }
      }
      if (handled) continue;

      if ((m = RE.fence.exec(rest))) { toks.push({ type: 'code', raw: m[0], lang: (m[2] || '').trim(), text: m[3] || '' }); rest = rest.slice(m[0].length); continue; }
      if ((m = RE.heading.exec(rest))) { toks.push({ type: 'heading', raw: m[0], depth: m[1].length, text: m[2] }); rest = rest.slice(m[0].length); continue; }
      if ((m = RE.hr.exec(rest))) { toks.push({ type: 'hr', raw: m[0] }); rest = rest.slice(m[0].length); continue; }
      if ((m = RE.fnDef.exec(rest))) { toks.push({ type: 'def', raw: m[0] }); rest = rest.slice(m[0].length); continue; }
      if ((m = RE.def.exec(rest))) { toks.push({ type: 'def', raw: m[0] }); rest = rest.slice(m[0].length); continue; }
      if ((m = RE.blockquote.exec(rest))) { toks.push({ type: 'blockquote', raw: m[0], text: m[0].replace(/^ {0,3}> ?/gm, '') }); rest = rest.slice(m[0].length); continue; }

      if (isTableStart(rest)) {
        var tl = rest.split('\n');
        var take = 0;
        while (take < tl.length && tl[take].indexOf('|') >= 0 && tl[take].trim()) take++;
        var raw = tl.slice(0, take).join('\n');
        if (rest.length > raw.length) raw += '\n';
        toks.push({ type: 'table', raw: raw });
        rest = rest.slice(raw.length);
        continue;
      }

      if (RE.listItem.test(rest)) {
        var lraw = takeList(rest);
        toks.push({ type: 'list', raw: lraw });
        rest = rest.slice(lraw.length);
        continue;
      }

      if (/^ {0,3}</.test(rest) && (m = RE.htmlBlock.exec(rest))) {
        toks.push({ type: 'html', raw: m[0] });
        rest = rest.slice(m[0].length);
        continue;
      }

      if ((m = RE.setext.exec(rest)) && m[1].trim() && !RE.listItem.test(m[1])) {
        toks.push({ type: 'heading', raw: m[0], depth: m[2][0] === '=' ? 1 : 2, text: m[1].trim() });
        rest = rest.slice(m[0].length);
        continue;
      }

      // 段落：吃到空行或下一个块级结构为止
      var plines = rest.split('\n');
      var n = 0;
      while (n < plines.length) {
        var line = plines[n];
        if (n > 0 && (!line.trim() || RE.listItem.test(line) || RE.heading.test(line + '\n')
          || RE.hr.test(line + '\n') || /^ {0,3}(`{3,}|~{3,})/.test(line) || /^ {0,3}>/.test(line))) break;
        n++;
      }
      if (n === 0) n = 1;
      var praw = plines.slice(0, n).join('\n');
      if (rest.length > praw.length) praw += '\n';
      toks.push({ type: 'paragraph', raw: praw, text: praw.trim() });
      rest = rest.slice(praw.length);
    }
    return toks;
  }

  /* 列表要连着缩进的续行一起吃掉，否则多行列表项会被拆散。
     但空行之后如果换了标记类型（- 变成 1.），那是另一张列表，不能吞进来 ——
     否则有序列表会被并进前面的无序列表，序号全丢。 */
  function markerKind(line) {
    var m = /^(\s*)(?:([-*+])|(\d{1,9})[.)])[ \t]/.exec(line);
    if (!m) return null;
    return { indent: m[1].length, ordered: !!m[3] };
  }

  function takeList(src) {
    var lines = src.split('\n');
    var first = markerKind(lines[0]);
    var out = [];
    var blanks = 0;

    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];

      if (!l.trim()) {
        blanks++;
        if (blanks > 1) break;          // 连续两个空行，列表结束
        out.push(l);
        continue;
      }

      if (i > 0) {
        var k = markerKind(l);
        if (k) {
          // 顶格的、且标记类型变了 → 是另一张列表
          if (blanks && k.indent === 0 && first && k.ordered !== first.ordered) break;
        } else if (blanks) {
          break;                        // 空行之后不是列表项，也不是缩进续行
        } else if (!/^ {1,}/.test(l) && !/^\t/.test(l)) {
          break;                        // 顶格的普通文字，列表结束
        }
      }
      blanks = 0;
      out.push(l);
    }

    while (out.length && !out[out.length - 1].trim()) out.pop();
    var raw = out.join('\n');
    return src.length > raw.length ? raw + '\n' : raw;
  }

  /* ================================================== 行内 */

  function inline(src) {
    var out = '';
    var rest = String(src == null ? '' : src);
    var guard = 0;

    outer:
    while (rest.length && guard++ < 200000) {
      // 自定义行内扩展优先（==高亮==、上下标、行内公式等）
      for (var i = 0; i < inlineExts.length; i++) {
        var ex = inlineExts[i];
        if (ex.start) {
          var at;
          try { at = ex.start.call(extCtx, rest); } catch (e) { at = undefined; }
          if (at !== 0) continue;
        }
        var tk = null;
        try { tk = ex.tokenizer.call(extCtx, rest); } catch (e) {}
        if (tk && tk.raw) {
          var html = '';
          try { html = ex.renderer.call(extCtx, tk); } catch (e) { html = esc(tk.raw); }
          out += html;
          rest = rest.slice(tk.raw.length);
          continue outer;
        }
      }

      var m;
      if ((m = /^\\([\\`*_{}\[\]()#+\-.!>~|])/.exec(rest))) { out += esc(m[1]); rest = rest.slice(m[0].length); continue; }
      if ((m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) { out += '<code>' + esc(m[2].trim()) + '</code>'; rest = rest.slice(m[0].length); continue; }
      if ((m = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"([^"]*)")?\)/.exec(rest))) {
        var isrc = safeUrl(m[2], true);
        out += '<img src="' + esc(isrc) + '" alt="' + esc(m[1]) + '"' + (m[3] ? ' title="' + esc(m[3]) + '"' : '') + ' loading="lazy">';
        rest = rest.slice(m[0].length); continue;
      }
      if ((m = /^\[\^([^\]]+)\]/.exec(rest))) {
        out += '<sup class="fn-ref"><a id="fnref-' + esc(m[1]) + '" href="#fn-' + esc(m[1]) + '">' + esc(m[1]) + '</a></sup>';
        rest = rest.slice(m[0].length); continue;
      }
      if ((m = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"([^"]*)")?\)/.exec(rest))) {
        var href = safeUrl(m[2]);
        out += '<a href="' + esc(href) + '"' + (m[3] ? ' title="' + esc(m[3]) + '"' : '')
             + (/^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + inline(m[1]) + '</a>';
        rest = rest.slice(m[0].length); continue;
      }
      if ((m = /^<((?:https?|mailto):[^\s>]+)>/.exec(rest))) {
        out += '<a href="' + esc(safeUrl(m[1])) + '" target="_blank" rel="noopener noreferrer">' + esc(m[1]) + '</a>';
        rest = rest.slice(m[0].length); continue;
      }
      if ((m = /^\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/.exec(rest))) { out += '<strong><em>' + inline(m[1]) + '</em></strong>'; rest = rest.slice(m[0].length); continue; }
      if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) { out += '<strong>' + inline(m[2]) + '</strong>'; rest = rest.slice(m[0].length); continue; }
      if ((m = /^(\*|_)(?=\S)([\s\S]*?\S)\1/.exec(rest))) { out += '<em>' + inline(m[2]) + '</em>'; rest = rest.slice(m[0].length); continue; }
      if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) { out += '<del>' + inline(m[1]) + '</del>'; rest = rest.slice(m[0].length); continue; }
      if ((m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*)?)>/.exec(rest))) { out += m[0]; rest = rest.slice(m[0].length); continue; }
      if ((m = /^ {2,}\n/.exec(rest))) { out += '<br>\n'; rest = rest.slice(m[0].length); continue; }
      if (rest[0] === '\n') { out += opts.breaks ? '<br>\n' : '\n'; rest = rest.slice(1); continue; }

      out += esc(rest[0]);
      rest = rest.slice(1);
    }
    return out;
  }

  /* ================================================== 块级渲染 */

  function renderToken(t) {
    switch (t.type) {
      case 'space': return '';
      case 'def': return '';
      case 'hr': return '<hr>';
      case 'html': return t.raw;

      case 'heading':
        if (rendererOverride.heading) return rendererOverride.heading(inline(t.text), t.depth);
        return '<h' + t.depth + '>' + inline(t.text) + '</h' + t.depth + '>';

      case 'code':
        if (rendererOverride.code) return rendererOverride.code(t.text, t.lang);
        return '<pre><code' + (t.lang ? ' class="language-' + esc(t.lang) + '"' : '') + '>' + esc(t.text) + '</code></pre>';

      case 'blockquote':
        return '<blockquote>' + parse(t.text) + '</blockquote>';

      case 'table': return renderTable(t.raw);
      case 'list': return renderList(t.raw);

      case 'paragraph': {
        var body = inline(t.text);
        return body.trim() ? '<p>' + body + '</p>' : '';
      }
      default:
        // 自定义块级扩展
        if (t.__ext && t.__ext.renderer) {
          try { return t.__ext.renderer.call(extCtx, t.__tok); } catch (e) { return esc(t.raw); }
        }
        return '<p>' + inline(t.raw.trim()) + '</p>';
    }
  }

  function splitCells(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    var cells = [];
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  function renderTable(raw) {
    var lines = raw.split('\n').filter(function (l) { return l.trim(); });
    if (lines.length < 2) return '<p>' + inline(raw) + '</p>';
    var head = splitCells(lines[0]);
    var aligns = splitCells(lines[1]).map(function (c) {
      if (/^:.*:$/.test(c)) return 'center';
      if (/:$/.test(c)) return 'right';
      if (/^:/.test(c)) return 'left';
      return '';
    });
    var html = '<table><thead><tr>' + head.map(function (c, i) {
      return '<th' + (aligns[i] ? ' align="' + aligns[i] + '"' : '') + '>' + inline(c) + '</th>';
    }).join('') + '</tr></thead><tbody>';
    for (var r = 2; r < lines.length; r++) {
      var cells = splitCells(lines[r]);
      html += '<tr>' + head.map(function (_, i) {
        return '<td' + (aligns[i] ? ' align="' + aligns[i] + '"' : '') + '>' + inline(cells[i] || '') + '</td>';
      }).join('') + '</tr>';
    }
    return html + '</tbody></table>';
  }

  function renderList(raw) {
    var lines = raw.split('\n');
    var items = [];
    var cur = null;

    lines.forEach(function (line) {
      var m = /^(\s*)(?:([-*+])|(\d{1,9})[.)])[ \t]+([\s\S]*)$/.exec(line);
      if (m) {
        if (cur) items.push(cur);
        cur = {
          indent: m[1].replace(/\t/g, '    ').length,
          ordered: !!m[3],
          num: m[3] ? parseInt(m[3], 10) : null,
          text: m[4],
          children: [],
        };
      } else if (cur != null) {
        // 续行：去掉一层缩进后并进当前项
        cur.text += '\n' + line.replace(/^ {1,4}/, '');
      }
    });
    if (cur) items.push(cur);
    if (!items.length) return '<p>' + inline(raw) + '</p>';

    return renderLevel(nest(items), /\n[ \t]*\n/.test(raw));
  }

  /* 扁平的项按缩进折成树 */
  function nest(items) {
    var root = [];
    var stack = [{ indent: -1, children: root }];
    items.forEach(function (it) {
      while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
      stack[stack.length - 1].children.push(it);
      stack.push(it);
    });
    return root;
  }

  function renderLevel(items, loose) {
    if (!items.length) return '';
    var html = '';
    var i = 0;
    // 同一层里可能既有无序又有有序，按类型分段各起一个列表
    while (i < items.length) {
      var ordered = items[i].ordered;
      var run = [];
      while (i < items.length && items[i].ordered === ordered) { run.push(items[i]); i++; }

      var tag = ordered ? 'ol' : 'ul';
      var start = ordered && run[0].num && run[0].num !== 1 ? ' start="' + run[0].num + '"' : '';
      html += '<' + tag + start + '>';

      run.forEach(function (it) {
        var text = it.text;
        var task = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(text);
        var cls = '';
        var box = '';
        if (task) {
          cls = ' class="task-list-item"';
          box = '<input type="checkbox" disabled' + (task[1].toLowerCase() === 'x' ? ' checked' : '') + '> ';
          text = task[2];
        }
        var body = (loose && !task) ? parse(text) : inline(text.trim());
        html += '<li' + cls + '>' + box + body + renderLevel(it.children, loose) + '</li>';
      });

      html += '</' + tag + '>';
    }
    return html;
  }

  /* ================================================== 对外 */

  function parse(src) {
    try {
      return lexer(src).map(renderToken).join('\n');
    } catch (e) {
      console.error('[docsmith] 内置渲染器出错，退回纯文本', e);
      return '<pre>' + esc(src) + '</pre>';
    }
  }

  function parseInline(src) {
    try { return inline(src); } catch (e) { return esc(src); }
  }

  if (!w.marked) {
    var api = function (s) { return parse(s); };
    api.parse = parse;
    api.parseInline = parseInline;
    api.lexer = lexer;
    api.use = use;
    api.setOptions = use;
    api.__builtin = true;
    w.marked = api;
  }

  if (!w.DOMPurify) {
    w.DOMPurify = { sanitize: sanitize, __builtin: true };
  }

  w.DocsmithBuiltinRenderer = {
    parse: parse, parseInline: parseInline, lexer: lexer, sanitize: sanitize,
    tagAllowed: tagAllowed, attrAllowed: attrAllowed,   // 供回归测试直接验证
  };
})(window);
