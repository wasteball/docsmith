/* =====================================================================
 * Docsmith · 图文卡片：排版引擎
 * ---------------------------------------------------------------------
 * 把一段文字排成若干张图（小红书 / 抖音那种图文卡片）。
 *
 * 为什么自己算排版，不把 HTML 塞进 SVG 的 foreignObject：
 * 那条路能省掉重写样式的功夫（直接复用 doc.css），我实测也确实能用。
 * 但它有一个致命短板 —— **分页位置算不准**。foreignObject 里面的内容是
 * 浏览器自己排的，我们拿不到「第 7 行的基线在哪」，只能按像素高度硬切，
 * 于是标题会落单在上一张图的末尾、一行字被劈成两半。
 * 而卡片这个东西，分页切得难看就等于白做。
 *
 * 所以这里逐字量、逐行排、按语义分页。代价是加粗、行内代码这些行内样式
 * 要自己实现（见 tokenizeInline），换来的是每一张图都切在该切的地方。
 *
 * 不依赖任何第三方库：只用 canvas 的 measureText / fillText。
 * （项目铁律：绝不在运行时加载远程代码。）
 * ===================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 尺寸

     比例给的是「像素」而不是纯比例，因为各平台对最小边长有要求，
     而且我们要保证在 canvas 上限内（PNG_MAX_SIDE 8192 / 26e6 像素）。
     实测这几档在 2 倍图下仍然安全（3:4 的 2× 是 2484×3312 ≈ 8.2MP）。 */
  var RATIOS = [
    { id: '3:4',  name: '3:4',  w: 1242, h: 1656, hint: '小红书主推 · 竖版最占屏' },
    { id: '1:1',  name: '1:1',  w: 1080, h: 1080, hint: '方图 · 稳妥不出错' },
    { id: '9:16', name: '9:16', w: 1080, h: 1920, hint: '抖音 / 视频封面' },
    { id: '4:3',  name: '4:3',  w: 1440, h: 1080, hint: '横版 · 朋友圈、微博' }
  ];

  /* ---------------------------------------------------------------- 字体
     和 doc.css 同一套取向：西文在前、中文紧跟，各自取各自最合适的那款。
     这里必须写成一个字符串给 canvas 的 ctx.font 用。 */
  var FONT_STACKS = {
    sans: '"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei",'
        + '"Source Han Sans SC","Noto Sans CJK SC",system-ui,sans-serif',
    serif: '"Source Han Serif SC","Noto Serif CJK SC","Songti SC","SimSun",Georgia,serif',
    rounded: '"PingFang SC","HarmonyOS Sans SC","Source Han Sans SC","YouYuan","幼圆",'
           + '"Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif'
  };
  var FONT_MONO = 'ui-monospace,"SFMono-Regular","JetBrains Mono",Menlo,Consolas,'
                + '"Microsoft YaHei UI",monospace';

  /* 消费级样式目录。界面从这里生成控件，排版引擎也从这里校验 id，避免两边
     各抄一份后慢慢走岔。主题只是若干具体参数的快捷组合，不是另一套渲染模式。 */
  var FONTS = [
    { id: 'sans', name: '现代黑体' },
    { id: 'serif', name: '书刊宋体' },
    { id: 'rounded', name: '圆润字体' }
  ];
  var ACCENT_COLORS = [
    { id: 'auto', name: '自动搭配', color: '' },
    { id: '#315b8a', name: '靛蓝', color: '#315b8a' },
    { id: '#e66b58', name: '珊瑚', color: '#e66b58' },
    { id: '#d59618', name: '琥珀', color: '#d59618' },
    { id: '#398565', name: '松绿', color: '#398565' },
    { id: '#177c82', name: '深青', color: '#177c82' },
    { id: '#8b5278', name: '梅紫', color: '#8b5278' }
  ];
  var HEADING_STYLES = [
    { id: 'center-rule', name: '居中短线' },
    { id: 'left-rule', name: '左对齐短线' },
    { id: 'left-bar', name: '左侧色条' }
  ];
  var CODE_STYLES = [
    { id: 'soft', name: '柔和' },
    { id: 'terminal', name: '终端' },
    { id: 'minimal', name: '极简' }
  ];
  var THEMES = [
    { id: 'clean', name: '清爽白', values: { background: 'paper', fontFamily: 'sans', accentColor: 'auto', headingStyle: 'center-rule', codeStyle: 'terminal', macDots: true } },
    { id: 'cream', name: '奶油手账', values: { background: 'warm', fontFamily: 'rounded', accentColor: '#c56a3d', headingStyle: 'left-rule', codeStyle: 'soft', macDots: true } },
    { id: 'mint-note', name: '清新笔记', values: { background: 'mint', fontFamily: 'sans', accentColor: '#2f8f6b', headingStyle: 'left-bar', codeStyle: 'minimal', macDots: true } },
    { id: 'night-magazine', name: '深夜杂志', values: { background: 'ink', fontFamily: 'serif', accentColor: '#4fc3d7', headingStyle: 'left-bar', codeStyle: 'terminal', macDots: true } }
  ];

  function enumValue(list, value, fallback) {
    for (var i = 0; i < list.length; i++) if (list[i].id === value) return value;
    return fallback;
  }
  function normalizeHex(value) {
    var s = String(value || '').trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map(function (c) { return c + c; }).join('');
    return /^#[0-9a-f]{6}$/.test(s) ? s : 'auto';
  }
  function normalizeOptions(opts) {
    opts = opts || {};
    var out = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) out[k] = opts[k];
    out.ratio = enumValue(RATIOS, out.ratio, '3:4');
    out.scale = Math.max(1, Math.min(2, +out.scale || 1));
    out.background = out.background || 'paper';
    out.blur = Math.max(0, Math.min(60, +out.blur || 0));
    out.fontScale = Math.max(.8, Math.min(1.3, +out.fontScale || 1));
    out.fontFamily = enumValue(FONTS, out.fontFamily, 'sans');
    out.accentColor = out.accentColor === 'auto' ? 'auto' : normalizeHex(out.accentColor);
    out.headingStyle = enumValue(HEADING_STYLES, out.headingStyle, 'center-rule');
    out.codeStyle = enumValue(CODE_STYLES, out.codeStyle, 'terminal');
    out.macDots = out.macDots === undefined ? true : !!out.macDots;
    return out;
  }

  /* ------------------------------------------------------- 极简 Markdown
     卡片不需要完整的 Markdown 支持 —— 它需要的是「标题、正文、列表、
     引用、代码」这几种**视觉分层**。所以这里自己按行解析，不拉 marked
     进来：卡片能力要能独立于 Markdown 工作台使用（用户可能直接粘一段文字）。

     刻意不支持的：表格、图片、脚注。它们在窄长的卡片里本来就不适合读，
     强行塞进去只会挤成一团。表格遇到了就按原文当代码块展示，信息不丢。 */
  function parseBlocks(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var blocks = [], i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块：整块收走，内部不解析
      var fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
      if (fence) {
        var mark = fence[1][0], body = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + mark + '{3,}\\s*$').test(lines[i])) {
          body.push(lines[i]); i++;
        }
        i++;   // 吃掉收尾的围栏
        blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
        continue;
      }

      if (!line.trim()) { i++; continue; }

      // 分割线
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

      // 标题
      var h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
        i++; continue;
      }

      // 引用：连续的 > 行合成一段。行内的换行保留（见段落那段的说明）
      if (/^\s*>/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*>\s?/, '')); i++;
        }
        blocks.push({ type: 'quote', text: q.join('\n').trim() });
        continue;
      }

      // 列表项（有序 / 无序）。每一项自己是一个块，好让分页能在项之间切。
      var li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        var ordered = /\d/.test(li[1]);
        var num = ordered ? parseInt(li[1], 10) : 0;
        var txt = li[2];
        i++;
        // 续行（缩进的接着上一项）
        while (i < lines.length && lines[i].trim()
               && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
               && !/^\s*#{1,6}\s+/.test(lines[i])
               && /^\s{2,}/.test(lines[i])) {
          txt += ' ' + lines[i].trim(); i++;
        }
        blocks.push({ type: 'li', ordered: ordered, num: num, text: txt.trim() });
        continue;
      }

      /* 段落：直到空行或下一个块级标记。

         ⚠ 下面用 '\n' 拼，**不是** ' '。
         标准 Markdown 里段落内的单个换行算「软换行」，要合成一行 ——
         那是给网页排版定的规则。但这个工具的输入是**用户自己排好的文字**：
         他敲了两行「你好」，就是想要两行。按 Markdown 规矩合成一行，
         用户看到的就是「我明明换行了，图上却并成一行」（实测就是这么发现的）。
         所以这里尊重用户的换行；真想合并，他不换行就行。 */
      var p = [];
      while (i < lines.length && lines[i].trim()
             && !/^\s*#{1,6}\s+/.test(lines[i])
             && !/^\s*>/.test(lines[i])
             && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
             && !/^\s*(`{3,}|~{3,})/.test(lines[i])
             && !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])) {
        p.push(lines[i].trim()); i++;
      }
      if (p.length) blocks.push({ type: 'p', text: p.join('\n') });
      else i++;    // 兜底：别在任何情况下空转
    }
    return blocks;
  }

  /* ---------------------------------------------------------- 行内样式
     只做三种：**加粗**、`行内代码`、~~删除线~~。
     它们是卡片里真正影响阅读的那几个；其余（链接、斜体嵌套）拆掉标记
     保留文字 —— 卡片上点不了链接，留个下划线只是噪音。 */
  function tokenizeInline(text) {
    var s = String(text == null ? '' : text);
    // 先把不打算渲染的标记去掉，只留文字
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')      // 图片 → alt
         .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');      // 链接 → 文字
    var runs = [], re = /(\*\*|__)(.+?)\1|`([^`]+)`|~~(.+?)~~/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) runs.push({ text: s.slice(last, m.index), bold: false, code: false });
      if (m[2] != null) runs.push({ text: m[2], bold: true, code: false });
      else if (m[3] != null) runs.push({ text: m[3], bold: false, code: true });
      else if (m[4] != null) runs.push({ text: m[4], bold: false, code: false, del: true });
      last = re.lastIndex;
    }
    if (last < s.length) runs.push({ text: s.slice(last), bold: false, code: false });
    // 剩下的单星号斜体标记去掉（不渲染斜体，但也不该露出星号）
    runs.forEach(function (r) { r.text = r.text.replace(/(\*|_)(?=\S)([^*_]*)\1/g, '$2'); });
    return runs.filter(function (r) { return r.text !== ''; });
  }

  /* ------------------------------------------------------------ 断行
     中日韩逐字断，拉丁按词断 —— 和 diagrams/base.js 的 wrap() 同一个取向，
     但这里必须用 canvas 真实测量（卡片是要给人看的成品，估算不够）。 */
  var CJK = /[⺀-鿿＀-￯぀-ヿ가-힯]/;
  /* 不能断在行首的标点（避免「，」出现在下一行开头） */
  var NO_LINE_START = '，。、；：？！）】》」』…％,.;:?!)]}>';

  function splitToUnits(text) {
    /* 切成「最小不可分单元」：一个汉字算一个，一串拉丁字母/数字算一个。
       换行符单独成一个单元 '\n' —— 它不是空白，是「这里必须断行」的指令
       （用户敲的换行要保留，见 parseBlocks 里段落那段的说明）。 */
    var units = [], buf = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\n') {
        if (buf) { units.push(buf); buf = ''; }
        units.push('\n');
      } else if (CJK.test(ch)) {
        if (buf) { units.push(buf); buf = ''; }
        units.push(ch);
      } else if (/\s/.test(ch)) {
        if (buf) { units.push(buf); buf = ''; }
        units.push(' ');
      } else {
        buf += ch;
      }
    }
    if (buf) units.push(buf);
    return units;
  }

  /**
   * 把若干 run 排成行。
   * @returns [{ pieces:[{text,bold,code,del,w}], w }]
   */
  function layoutRuns(ctx, runs, maxW, style, fontFamily) {
    var lines = [], cur = [], curW = 0;

    function fontFor(run) {
      var weight = run.bold ? '700' : String(style.weight || '400');
      var fam = run.code ? FONT_MONO : (FONT_STACKS[fontFamily] || FONT_STACKS.sans);
      var size = run.code ? Math.round(style.size * 0.92) : style.size;
      return weight + ' ' + size + 'px ' + fam;
    }
    /* push() 默认只在有内容时才产出一行；force=true 用于「用户敲的空行」
       —— 那种情况要真的留出一个空行，不能被当成没内容跳过。 */
    function push(force) {
      if (cur.length || force) { lines.push({ pieces: cur, w: curW }); cur = []; curW = 0; }
    }

    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      ctx.font = fontFor(run);
      var units = splitToUnits(run.text);
      var piece = { text: '', bold: run.bold, code: run.code, del: run.del, w: 0 };

      for (var u = 0; u < units.length; u++) {
        var unit = units[u];

        /* 用户敲的换行：无条件断在这里。
           这是「硬换行」，和下面因为宽度不够而折的行不一样 —— 它必须发生，
           哪怕当前这一行只有两个字。 */
        if (unit === '\n') {
          if (piece.text) { cur.push(piece); curW += piece.w; }
          push(true);
          piece = { text: '', bold: run.bold, code: run.code, del: run.del, w: 0 };
          continue;
        }

        var uw = ctx.measureText(unit).width;

        // 行首不要空格
        if (unit === ' ' && !cur.length && !piece.text) continue;

        if (curW + piece.w + uw > maxW && (cur.length || piece.text)) {
          /* 换行。若下一个单元是「不能放行首的标点」，让它跟着留在本行 ——
             宁可这一行略微超出，也不要让句子以逗号开头。 */
          if (unit.length === 1 && NO_LINE_START.indexOf(unit) >= 0) {
            piece.text += unit; piece.w += uw; continue;
          }
          if (piece.text) { cur.push(piece); curW += piece.w; }
          push();
          piece = { text: '', bold: run.bold, code: run.code, del: run.del, w: 0 };
          if (unit === ' ') continue;      // 换行后丢掉这个空格
        }
        piece.text += unit; piece.w += uw;
      }
      if (piece.text) { cur.push(piece); curW += piece.w; }
    }
    push();
    return lines;
  }

  /* --------------------------------------------------------- 视觉规格
     字号跟着卡片宽度缩放：同一套参数在 1080 和 1440 宽下观感一致。
     基准宽度取 1242（3:4 主推档）。

     排版取向参考了 md.doocs.org（公众号排版工具）—— 它的东西在手机上读
     特别舒服，值得学的是这几条，都落在下面的参数和 drawPage 里：
       · **标题居中 + 下方一道短横线**。长文里标题居中会显得散，但卡片是
         一屏一个主题，居中反而像杂志内页，层级也更清楚。
       · **行高给足**（正文 1.8）。中文没有词间空格，靠行距分行，
         手机上小屏尤其需要。
       · **段间距大于行距**。段落之间要能"喘口气"，读者扫得快。
       · **引用块带左边条 + 淡底色**，不只是一根线 —— 手机上一根细线不够显眼。
       · **代码块带标题栏**（显示语言名），和正文明确分开。 */
  function specOf(W, H, scale, opts) {
    opts = opts || {};
    var k = (W / 1242) * (scale || 1);
    var padX = Math.round(W * 0.098);          // 左右留白约 10%
    return {
      fontFamily: opts.fontFamily || 'sans',
      headingStyle: opts.headingStyle || 'center-rule',
      codeStyle: opts.codeStyle || 'terminal',
      macDots: opts.macDots === undefined ? true : !!opts.macDots,
      fontStack: FONT_STACKS[opts.fontFamily] || FONT_STACKS.sans,
      k: k,
      padX: padX,
      padTop: Math.round(H * 0.085),
      padBottom: Math.round(H * 0.075),
      maxW: W - padX * 2,
      /* 卡片要在手机上看清，也要装得下一段完整观点。参考成熟排版工具的层级，
         但按 3:4 卡片重新收紧字号、行距和段距，不照搬窄长网页。 */
      body:    { size: Math.round(43 * k), line: 1.70, weight: 400 },
      h1:      { size: Math.round(67 * k), line: 1.30, weight: 700 },
      h2:      { size: Math.round(52 * k), line: 1.34, weight: 700 },
      h3:      { size: Math.round(47 * k), line: 1.38, weight: 600 },
      quote:   { size: Math.round(40 * k), line: 1.62, weight: 400 },
      code:    { size: Math.round(34 * k), line: 1.58, weight: 400 },
      caption: { size: Math.round(28 * k), line: 1.35, weight: 400 },
      gap:     Math.round(29 * k),
      gapTight: Math.round(12 * k),         // 标题和它下面那段之间
      /* 标题下面那道短横线（Doocs 的标志性细节） */
      hrule:   { w: Math.round(W * 0.11), h: Math.max(3, Math.round(5 * k)), gap: Math.round(18 * k) }
    };
  }

  function styleOfBlock(b, sp) {
    if (b.type === 'heading') return b.level <= 1 ? sp.h1 : (b.level === 2 ? sp.h2 : sp.h3);
    if (b.type === 'quote') return sp.quote;
    if (b.type === 'code') return sp.code;
    return sp.body;
  }

  /* --------------------------------------------------- 量：块 → 行 + 高
     分页要在「行」这个粒度上做，所以先把每个块拆成行，并记住每行多高。 */
  function measureBlocks(ctx, blocks, sp) {
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], style = styleOfBlock(b, sp);
      var item = { block: b, style: style, lines: [], lineH: Math.round(style.size * style.line) };

      if (b.type === 'hr') {
        item.lines = [{ pieces: [], w: 0, rule: true }];
        item.lineH = Math.round(sp.gap * 1.4);
      } else if (b.type === 'code') {
        /* 代码不折行——折了就读不懂了。超宽的话后面按比例缩字号；
           这里先按原样切行，量出最长那行。 */
        var codeLines = b.text.split('\n');
        ctx.font = '400 ' + style.size + 'px ' + FONT_MONO;
        item.lines = codeLines.map(function (t) {
          return { pieces: [{ text: t, bold: false, code: true, w: ctx.measureText(t).width }],
                   w: ctx.measureText(t).width, pre: true };
        });
        item.pad = Math.round(sp.gap * 0.82);
        item.chrome = sp.macDots ? Math.round(50 * sp.k) : 0;
      } else if (b.type === 'li') {
        var marker = b.ordered ? (b.num + '. ') : '· ';
        ctx.font = '400 ' + style.size + 'px ' + sp.fontStack;
        item.indent = ctx.measureText(b.ordered ? '99. ' : '· ').width;
        item.marker = marker;
        item.lines = layoutRuns(ctx, tokenizeInline(b.text), sp.maxW - item.indent, style, sp.fontFamily);
      } else {
        item.lines = layoutRuns(ctx, tokenizeInline(b.text || ''), sp.maxW - (b.type === 'heading' && sp.headingStyle === 'left-bar' ? Math.round(28 * sp.k) : 0), style, sp.fontFamily);
      }
      /* 标题下面那道短横线要占高度，否则它会压到下一段上（学 Doocs 的样式，
         但必须把它算进布局里，不然分页就算错了）。
         只给 h1/h2 加 —— h3 已经很小，再加线就碎了。 */
      if (b.type === 'heading' && b.level <= 2 && sp.headingStyle !== 'left-bar') {
        item.rule = sp.hrule.gap + sp.hrule.h;
      }
      item.height = item.lines.length * item.lineH + (item.pad ? item.pad * 2 : 0)
                  + (item.rule || 0) + (item.chrome || 0);
      out.push(item);
    }
    return out;
  }

  /* ----------------------------------------------------------- 分页
     这是整个引擎里最要紧的一段。规则（按重要性排）：

       1. 标题不许落单 —— 一个标题后面至少要跟着 2 行正文，否则它跟着
          下一页走。这是最常见的难看情形。
       2. 代码块 / 引用尽量不拆。整块放不下一页时才拆，且拆的时候至少留 2 行。
       3. 一行都不许被劈开（这是逐行排版换来的，天然成立）。
       4. 段落被拆时，孤儿/寡妇行不少于 2 行。

     切出来的每一页是 [{item, from, to}]，指「这一页要画某个块的第 from 到
     第 to 行」。这样同一个块可以跨页，而且画的时候不用重新量。 */
  function paginate(measured, avail, sp) {
    var pages = [], cur = [], used = 0;
    var MIN_ORPHAN = 2;

    function flush() { if (cur.length) { pages.push(cur); cur = []; used = 0; } }
    function remain() { return avail - used; }

    for (var i = 0; i < measured.length; i++) {
      var it = measured[i];
      var gap = cur.length ? (isHeading(measured[i - 1]) ? sp.gapTight : sp.gap) : 0;
      var lineH = it.lineH;
      var padded = (it.pad ? it.pad * 2 : 0) + (it.chrome || 0);

      // 标题：得确认它后面还能跟下至少 2 行，否则整个挪到下一页
      if (isHeading(it)) {
        /* it.rule = 标题下那道短横线占的高（含它上面的间距）。
           必须算进来，否则分页会以为这一页还塞得下，画的时候就溢出。 */
        var ruleH = it.rule || 0;
        var need = gap + it.lines.length * lineH + ruleH;
        var next = measured[i + 1];
        if (next) need += sp.gapTight + Math.min(MIN_ORPHAN, next.lines.length) * next.lineH;
        if (need > remain() && cur.length) { flush(); gap = 0; }
        used += gap + it.lines.length * lineH + ruleH;
        cur.push({ item: it, from: 0, to: it.lines.length });
        continue;
      }

      // 整块放得下 → 直接放
      var whole = gap + it.lines.length * lineH + padded;
      if (whole <= remain()) {
        used += whole;
        cur.push({ item: it, from: 0, to: it.lines.length });
        continue;
      }

      // 放不下：代码块和引用优先「整块挪到下一页」
      var atomic = (it.block.type === 'code' || it.block.type === 'quote');
      if (atomic && it.lines.length * lineH + padded <= avail && cur.length) {
        flush();
        used += it.lines.length * lineH + padded;
        cur.push({ item: it, from: 0, to: it.lines.length });
        continue;
      }

      // 只能拆。逐页填，保证每片至少 MIN_ORPHAN 行（除非它本来就更短）
      var from = 0;
      while (from < it.lines.length) {
        var space = remain() - (cur.length ? gap : 0) - (from === 0 ? padded : 0);
        var fit = Math.floor(space / lineH);
        var left = it.lines.length - from;

        if (fit < Math.min(MIN_ORPHAN, left)) {     // 这一页塞不下有意义的量
          if (!cur.length) { fit = Math.max(1, Math.floor(avail / lineH)); }  // 空页也塞不下 → 硬放
          else { flush(); gap = 0; continue; }
        }
        var take = Math.min(fit, left);
        // 别留一个孤儿行到下一页
        if (left - take === 1 && take > MIN_ORPHAN) take -= 1;

        used += (cur.length ? gap : 0) + take * lineH + (from === 0 ? padded : 0);
        cur.push({ item: it, from: from, to: from + take });
        from += take;
        gap = 0;
        if (from < it.lines.length) flush();
      }
    }
    flush();
    return pages;
  }

  function isHeading(it) { return !!it && it.block && it.block.type === 'heading'; }

  /* ==================================================================
   * 画
   * ================================================================== */

  /** 相对亮度（WCAG）。用来自动决定文字用白还是黑。 */
  function relLuminance(r, g, b) {
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrastRatio(L1, L2) {
    var hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  }
  /**
   * 看一张已经画好底的 canvas，决定文字该用白还是黑，以及要不要压一层蒙版。
   * 只采样文字会落到的那块区域（padX..W-padX），不看整张图 —— 四角的深色
   * 装饰不该影响正文的判断。
   */
  function hexRgb(hex) {
    var s = normalizeHex(hex); if (s === 'auto') return null;
    return { r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16) };
  }
  function accentFor(value, whiteText) {
    var rgb = hexRgb(value);
    if (!rgb) return whiteText ? 'rgba(120,220,232,.92)' : 'rgba(80,90,190,.88)';
    var mix = whiteText ? 0.18 : 0;
    var target = whiteText ? 255 : 0;
    var channel = function (v) { return Math.round(v + (target - v) * mix); };
    return 'rgb(' + channel(rgb.r) + ',' + channel(rgb.g) + ',' + channel(rgb.b) + ')';
  }
  function autoContrast(ctx, W, H, sp, accentColor) {
    var x = sp.padX, y = sp.padTop, w = Math.max(1, W - sp.padX * 2), h = Math.max(1, H - sp.padTop - sp.padBottom);
    var data;
    try { data = ctx.getImageData(x, y, w, h).data; }
    /* getImageData 取不到就当亮底。**必须返回和下面同一套完整字段** ——
       少一个 key 就会在画的时候变成 fillStyle=undefined，那时 canvas 会
       悄悄沿用上一次的颜色，出来一张颜色错乱的图而且不报错。 */
    catch (e) {
      return { fg: '#1b1b1f', dim: 'rgba(27,27,31,.62)', rule: 'rgba(27,27,31,.18)',
               codeBg: 'rgba(49,91,138,.075)', codeFg: '#245c91', codeBorder: 'rgba(49,91,138,.24)',
               quoteBg: 'rgba(49,91,138,.065)', quoteFg: 'rgba(27,27,31,.82)',
               accent: accentFor(accentColor, false),
               scrim: 0, scrimColor: 'rgba(255,255,255,0)', luminance: 1, contrast: 21 };
    }
    var L = 0, n = 0;
    /* 隔行隔列采样：整块逐像素在 1242×1400 上是 170 万次，没必要。 */
    var step = 4 * 7;
    for (var i = 0; i < data.length; i += step) {
      L += relLuminance(data[i], data[i + 1], data[i + 2]); n++;
    }
    var mean = n ? L / n : 1;
    var cw = contrastRatio(1.0, mean);      // 白字
    var cb = contrastRatio(0.0, mean);      // 黑字
    var white = cw >= cb;
    var best = Math.max(cw, cb);
    /* 对比度不够（低于 AA 的 4.5:1）就压一层蒙版把背景推向文字的反方向。
       蒙版透明度按差多少算，最多 0.55 —— 再多背景就没了。 */
    var scrim = best >= 4.5 ? 0 : Math.min(0.55, (4.5 - best) / 6);
    return {
      fg: white ? '#ffffff' : '#1b1b1f',
      dim: white ? 'rgba(255,255,255,.72)' : 'rgba(27,27,31,.62)',
      rule: white ? 'rgba(255,255,255,.28)' : 'rgba(27,27,31,.18)',
      codeBg: white ? 'rgba(255,255,255,.11)' : 'rgba(49,91,138,.075)',
      codeFg: white ? '#b8dcff' : '#245c91',
      codeBorder: white ? 'rgba(184,220,255,.30)' : 'rgba(49,91,138,.24)',
      quoteBg: white ? 'rgba(255,255,255,.10)' : 'rgba(49,91,138,.065)',
      quoteFg: white ? 'rgba(255,255,255,.86)' : 'rgba(27,27,31,.82)',
      /* 行内代码、引用和标题装饰都跟随同一强调色系统，不再各自冒出一种色。 */
      /* 强调色：标题下那道短横线、引用块的左边条用它。
         不用主题色（那是界面色，和卡片背景不一定搭），按底色深浅各给一个
         饱和度合适的值 —— 深底用偏亮的青，亮底用偏深的靛蓝。 */
      accent: accentFor(accentColor, white),
      scrim: scrim,
      scrimColor: white ? 'rgba(0,0,0,' + scrim.toFixed(3) + ')'
                        : 'rgba(255,255,255,' + scrim.toFixed(3) + ')',
      luminance: mean,
      contrast: +best.toFixed(2)
    };
  }

  /** 内置背景。全部用 canvas 画，不带任何图片资源（体积为零，离线可用）。
      前两个是"安静"的纯色底（适合长文），后面是渐变（适合金句、短内容）。 */
  var BACKGROUNDS = [
    { id: 'paper',  name: '纸白', paint: function (ctx, W, H) { flat(ctx, W, H, '#fcfcfb'); grain(ctx, W, H, .025); } },
    { id: 'ink',    name: '墨黑', paint: function (ctx, W, H) { flat(ctx, W, H, '#14171f'); grain(ctx, W, H, .05); } },
    { id: 'warm',   name: '暖杏', paint: function (ctx, W, H) { linear(ctx, W, H, ['#fdf3e3', '#f7e3cb']); } },
    { id: 'mint',   name: '青竹', paint: function (ctx, W, H) { linear(ctx, W, H, ['#e8f5ef', '#cfe8dd']); } },
    { id: 'dusk',   name: '暮紫', paint: function (ctx, W, H) { linear(ctx, W, H, ['#2b2350', '#4a3b7a']); } },
    { id: 'ocean',  name: '深海', paint: function (ctx, W, H) { linear(ctx, W, H, ['#0f2027', '#203a43', '#2c5364']); } },
    /* ---- 下面几个是这一轮新增的（用户说「背景没有一些渐变的背景可选吗」）----
       取色原则：亮底的明度差控制在很小的范围内（不然文字压不住），
       暗底可以拉开一点。每一个都在 autoContrast 下自动选对了文字颜色。 */
    { id: 'sunset', name: '晚霞', paint: function (ctx, W, H) { linear(ctx, W, H, ['#ff9a6c', '#ff6b9d', '#c44fa0']); } },
    { id: 'peach',  name: '蜜桃', paint: function (ctx, W, H) { linear(ctx, W, H, ['#ffe8e0', '#ffd3d8', '#fcc5d8']); } },
    { id: 'sky',    name: '晴空', paint: function (ctx, W, H) { linear(ctx, W, H, ['#e0f2fe', '#c7e4fb', '#b8d8f8']); } },
    { id: 'forest', name: '深林', paint: function (ctx, W, H) { linear(ctx, W, H, ['#13291f', '#1e4535', '#2d6a4f']); } },
    { id: 'grape',  name: '葡萄', paint: function (ctx, W, H) { linear(ctx, W, H, ['#4c1d95', '#7e22ce', '#a21caf']); } },
    { id: 'coffee', name: '奶咖', paint: function (ctx, W, H) { linear(ctx, W, H, ['#f5ece1', '#e8d5be', '#dcc3a5']); } },
    { id: 'night',  name: '午夜', paint: function (ctx, W, H) { radial(ctx, W, H, ['#1e3a5f', '#0b1220']); } },
    { id: 'aurora', name: '极光', paint: function (ctx, W, H) { linear(ctx, W, H, ['#0f2027', '#2c5364', '#22c1a4']); } },
    { id: 'blush',  name: '藕粉', paint: function (ctx, W, H) { radial(ctx, W, H, ['#fdf0f4', '#f3d9e4']); } }
  ];
  function flat(ctx, W, H, c) { ctx.fillStyle = c; ctx.fillRect(0, 0, W, H); }
  function linear(ctx, W, H, stops) {
    /* 斜向渐变（左上 → 右下偏左）。纯竖直渐变在长图上会显得单调，
       斜的能让每一张卡片的取色都略有不同。 */
    var g = ctx.createLinearGradient(0, 0, W * 0.35, H);
    stops.forEach(function (c, i) { g.addColorStop(i / (stops.length - 1), c); });
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  /** 径向渐变：亮心暗边，正文区域自然更亮，读起来最舒服。 */
  function radial(ctx, W, H, stops) {
    var g = ctx.createRadialGradient(W * 0.5, H * 0.34, Math.min(W, H) * 0.1,
                                     W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
    stops.forEach(function (c, i) { g.addColorStop(i / (stops.length - 1), c); });
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  /* 一层极轻的噪点。纯色卡片在手机屏幕上会显得"塑料"，加一点颗粒就有纸感。
     用确定性伪随机 —— 同样的输入永远出同样的图（可复现，方便测试）。 */
  function grain(ctx, W, H, alpha) {
    var seed = 20260805;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var n = Math.round((W * H) / 900);
    ctx.save();
    for (var i = 0; i < n; i++) {
      ctx.fillStyle = 'rgba(' + (rnd() > .5 ? '0,0,0,' : '255,255,255,') + (alpha * rnd()).toFixed(3) + ')';
      ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
    }
    ctx.restore();
  }
  function bgById(id) {
    for (var i = 0; i < BACKGROUNDS.length; i++) if (BACKGROUNDS[i].id === id) return BACKGROUNDS[i];
    return BACKGROUNDS[0];
  }

  /**
   * 把背景画到 ctx 上。
   * opts.image 是可选的自定义背景（HTMLImageElement / ImageBitmap / Canvas），
   * 按 cover 铺满并可模糊。
   */
  function paintBackground(ctx, W, H, opts) {
    opts = opts || {};
    if (opts.image) {
      var img = opts.image;
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      if (iw && ih) {
        var s = Math.max(W / iw, H / ih);
        /* 模糊会把边缘吸进来（透明边），所以放大一点再画，让模糊半径有料可吃 */
        var blur = Math.max(0, Math.min(60, +opts.blur || 0));
        var over = blur ? blur * 2.5 : 0;
        var dw = iw * s + over * 2, dh = ih * s + over * 2;
        ctx.save();
        if (blur && 'filter' in ctx) ctx.filter = 'blur(' + blur + 'px)';
        ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
        ctx.restore();
        return;
      }
    }
    bgById(opts.background).paint(ctx, W, H);
  }

  /* ------------------------------------------------------------- 水印
     默认右下角、半透明 —— 右下是版权标识的通用位置（视线终点），
     半透明既主张了版权又不抢正文。四角可选、透明度可调。 */
  var WM_POS = ['tl', 'tr', 'bl', 'br'];
  function drawWatermark(ctx, W, H, sp, wm, colors) {
    if (!wm || (!wm.text && !wm.image)) return;
    var op = wm.opacity == null ? 0.55 : Math.max(0.05, Math.min(1, wm.opacity));
    var pos = WM_POS.indexOf(wm.position) >= 0 ? wm.position : 'br';
    var m = Math.round(sp.padX * 0.62);          // 离边距比正文近一点
    ctx.save();
    ctx.globalAlpha = op;

    if (wm.image) {
      var img = wm.image;
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      if (iw && ih) {
        var maxW = Math.round(W * (wm.scale || 0.16));
        var s = maxW / iw, dw = maxW, dh = ih * s;
        var ix = /l$/.test(pos) ? m : W - m - dw;
        var iy = /^t/.test(pos) ? m : H - m - dh;
        ctx.drawImage(img, ix, iy, dw, dh);
      }
    }
    if (wm.text) {
      var size = Math.round(sp.caption.size * 0.95);
      ctx.font = '500 ' + size + 'px ' + sp.fontStack;
      ctx.fillStyle = colors.fg;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = /l$/.test(pos) ? 'left' : 'right';
      var tx = /l$/.test(pos) ? m : W - m;
      var ty = /^t/.test(pos) ? m + size : H - m;
      // 有 logo 图时文字挪到图下面一点
      if (wm.image) ty = /^t/.test(pos) ? ty + Math.round(H * 0.055) : ty;
      ctx.fillText(wm.text, tx, ty);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------- 页码 */
  function drawPageNo(ctx, W, H, sp, idx, total, colors) {
    if (total < 2) return;
    var size = sp.caption.size;
    ctx.save();
    ctx.font = '500 ' + size + 'px ' + sp.fontStack;
    ctx.fillStyle = colors.dim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(idx + ' / ' + total, W / 2, H - Math.round(sp.padBottom * 0.42));
    ctx.restore();
  }

  /** 画一页的正文。 */
  function drawPage(ctx, page, W, H, sp, colors) {
    var y = sp.padTop;
    for (var i = 0; i < page.length; i++) {
      var slice = page[i], it = slice.item, b = it.block;
      var prev = i ? page[i - 1].item : null;
      if (i) y += isHeading(prev) ? sp.gapTight : sp.gap;

      if (b.type === 'hr') {
        var ry = y + it.lineH / 2;
        ctx.save();
        ctx.strokeStyle = colors.rule; ctx.lineWidth = Math.max(1, Math.round(2 * sp.k));
        ctx.beginPath(); ctx.moveTo(sp.padX, ry); ctx.lineTo(W - sp.padX, ry); ctx.stroke();
        ctx.restore();
        y += it.lineH;
        continue;
      }

      var isCode = b.type === 'code', isQuote = b.type === 'quote';
      var chromeH = isCode && sp.macDots ? (it.chrome || 0) : 0;
      var blockH = (slice.to - slice.from) * it.lineH
                 + (it.pad && slice.from === 0 ? it.pad * 2 : 0) + chromeH;

      if (isCode) {
        ctx.save();
        if (sp.codeStyle === 'terminal') ctx.fillStyle = '#0f131a';
        else if (sp.codeStyle === 'minimal') ctx.fillStyle = 'rgba(0,0,0,.018)';
        else ctx.fillStyle = colors.codeBg;
        roundRect(ctx, sp.padX, y, W - sp.padX * 2, blockH, Math.round(16 * sp.k));
        ctx.fill();
        if (sp.codeStyle === 'minimal') {
          ctx.strokeStyle = colors.rule; ctx.lineWidth = Math.max(1, Math.round(1.5 * sp.k)); ctx.stroke();
        }
        if (chromeH) {
          var dotR = Math.max(4, Math.round(7 * sp.k));
          var dotY = y + Math.round(chromeH * .44), dotX = sp.padX + Math.round(28 * sp.k);
          ['#ff6b63', '#f7c24b', '#58c95b'].forEach(function (color, di) {
            ctx.beginPath(); ctx.fillStyle = color;
            ctx.arc(dotX + di * dotR * 2.8, dotY, dotR, 0, Math.PI * 2); ctx.fill();
          });
          if (b.lang) {
            ctx.font = '500 ' + Math.round(22 * sp.k) + 'px ' + FONT_MONO;
            ctx.fillStyle = sp.codeStyle === 'terminal' ? 'rgba(232,237,244,.48)' : colors.dim;
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText(String(b.lang).toUpperCase(), W - sp.padX - Math.round(24 * sp.k), dotY);
          }
        }
        ctx.restore();
      }
      if (isQuote) {
        /* 淡底色 + 左边一根粗条。原来只有那根条 —— 手机上一根细线不够显眼，
           读者扫过去分不出这是引用。Doocs 的做法是"底色 + 边条"，学它。 */
        ctx.save();
        ctx.fillStyle = colors.quoteBg;
        roundRect(ctx, sp.padX, y, W - sp.padX * 2, blockH, Math.round(10 * sp.k));
        ctx.fill();
        ctx.fillStyle = colors.accent || colors.rule;
        var bw = Math.max(4, Math.round(8 * sp.k));
        roundRect(ctx, sp.padX, y, bw, blockH, bw / 2);
        ctx.fill();
        ctx.restore();
      }

      var headingInset = b.type === 'heading' && sp.headingStyle === 'left-bar' ? Math.round(28 * sp.k) : 0;
      var textX = sp.padX
        + (isCode ? Math.round(sp.gap * 0.7) : 0)
        + (isQuote ? Math.round(sp.gap * 0.8) : 0)
        + headingInset + (it.indent || 0);
      var ty = y + (it.pad && slice.from === 0 ? it.pad : 0) + chromeH;

      for (var li = slice.from; li < slice.to; li++) {
        var line = it.lines[li];
        var baseline = ty + Math.round(it.lineH * 0.72);

        // 列表符号只画在这一项的第一行
        if (it.marker && li === 0) {
          ctx.save();
          ctx.font = '400 ' + it.style.size + 'px ' + sp.fontStack;
          ctx.fillStyle = colors.accent;
          ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
          var marker = it.marker;
          if (!b.ordered) { ctx.font = '700 ' + Math.round(it.style.size * 1.18) + 'px ' + sp.fontStack; marker = '•'; }
          ctx.fillText(marker, sp.padX, baseline);
          ctx.restore();
        }

        /* 标题居中（学 Doocs）。卡片是一屏一个主题，居中像杂志内页，
           层级也更清楚；正文仍然左对齐 —— 中文长段落居中会很难读。
           居中要按这一行的实际宽度算起点，所以先把这行总宽加出来。 */
        var x = textX;
        if (b.type === 'heading' && sp.headingStyle === 'center-rule') {
          var lineW = 0;
          for (var wi = 0; wi < line.pieces.length; wi++) lineW += line.pieces[wi].w;
          x = Math.round((W - lineW) / 2);
        }
        if (b.type === 'heading' && sp.headingStyle === 'left-bar' && li === slice.from) {
          ctx.save();
          ctx.fillStyle = colors.accent || colors.rule;
          roundRect(ctx, sp.padX, baseline - it.style.size * .86,
                    Math.max(4, Math.round(7 * sp.k)), it.style.size * 1.02, Math.round(4 * sp.k));
          ctx.fill(); ctx.restore();
        }
        for (var pi = 0; pi < line.pieces.length; pi++) {
          var p = line.pieces[pi];
          var weight = p.bold ? '700' : String(it.style.weight || '400');
          var size = p.code ? Math.round(it.style.size * 0.92) : it.style.size;
          /* 行内代码要有一小块底色，否则它和正文只差一个字体，
             在手机上缩到很小时**根本看不出来**（等宽和黑体的区别没那么明显）。
             围栏代码块自己已经有整块底色了，不需要再套一层。 */
          if (p.code && !line.pre) {
            var padH = Math.round(size * 0.26), padV = Math.round(size * 0.16);
            ctx.save();
            ctx.fillStyle = colors.codeBg;
            roundRect(ctx, x - padH, baseline - size * 0.92 - padV,
                      p.w + padH * 2, size * 1.18 + padV * 2, Math.round(size * 0.22));
            ctx.fill();
            ctx.strokeStyle = colors.codeBorder; ctx.lineWidth = Math.max(1, Math.round(1.2 * sp.k)); ctx.stroke();
            ctx.restore();
          }
          ctx.save();
          ctx.font = weight + ' ' + size + 'px ' + (p.code || line.pre ? FONT_MONO : sp.fontStack);
          ctx.fillStyle = line.pre && sp.codeStyle === 'terminal' ? '#e8edf4'
            : (isQuote ? colors.quoteFg : (p.code && !line.pre ? colors.codeFg : colors.fg));
          ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
          ctx.fillText(p.text, x, baseline);
          if (p.del) {
            ctx.strokeStyle = colors.fg; ctx.lineWidth = Math.max(1, Math.round(2 * sp.k));
            ctx.beginPath();
            ctx.moveTo(x, baseline - size * 0.28); ctx.lineTo(x + p.w, baseline - size * 0.28);
            ctx.stroke();
          }
          ctx.restore();
          x += p.w;
        }
        ty += it.lineH;
      }
      y += blockH;

      /* 标题下面那道短横线（Doocs 的标志性细节）。居中，用强调色。
         高度已经在 measureBlocks 里算进 it.rule，这里只负责画。 */
      if (it.rule) {
        var lw = sp.hrule.w, lh = sp.hrule.h;
        var ly = y + sp.hrule.gap;
        ctx.save();
        ctx.fillStyle = colors.accent || colors.rule;
        roundRect(ctx, Math.round((W - lw) / 2), ly, lw, lh, lh / 2);
        ctx.fill();
        ctx.restore();
        y += it.rule;
      }
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ==================================================================
   * 对外：把一段文字变成 N 张卡片
   * ================================================================== */

  /* ------------------------------------------------------ 画一张卡片
     抽出来单独一个函数，是因为有两种用法都要它：
       · 自动分页（render）：把长文切好，逐页调它
       · 手动分页（renderPages）：用户自己决定每一页写什么，一页调一次
     两条路共用同一套画法，卡片长相就不会因为"从哪条路来的"而不一样。

     opts.background / opts.image 可以被**每页各自**覆盖（手动模式下用户能
     给某一页单独换背景），所以这里接收的是已经合并好的 pageOpts。 */
  function paintCard(text, W, H, sp, pageOpts, no, total) {
    var probe = document.createElement('canvas').getContext('2d');
    var blocks = parseBlocks(text);
    if (!blocks.length) blocks = [{ type: 'p', text: '' }];
    var measured = measureBlocks(probe, blocks, sp);

    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    paintBackground(ctx, W, H, pageOpts);
    var colors = autoContrast(ctx, W, H, sp, pageOpts.accentColor);
    if (colors.scrim > 0) { ctx.fillStyle = colors.scrimColor; ctx.fillRect(0, 0, W, H); }

    /* 手动模式下这一页可能写多了装不下。**不静默裁掉** —— 那样用户会
       以为自己写的东西丢了。照原样画出来（超出部分自然溢出画布外），
       同时把「装不下」这个事实回报给界面，由界面明确提示。 */
    var avail = H - sp.padTop - sp.padBottom - (pageOpts.pageNo === false ? 0 : Math.round(sp.caption.size * 1.6));
    var used = 0;
    var slices = measured.map(function (it, i) {
      if (i) used += isHeading(measured[i - 1]) ? sp.gapTight : sp.gap;
      used += it.lines.length * it.lineH + (it.pad ? it.pad * 2 : 0)
            + (it.rule || 0) + (it.chrome || 0);
      return { item: it, from: 0, to: it.lines.length };
    });

    drawPage(ctx, slices, W, H, sp, colors);
    if (pageOpts.pageNo !== false) drawPageNo(ctx, W, H, sp, no, total, colors);
    drawWatermark(ctx, W, H, sp, pageOpts.watermark, colors);
    return { canvas: c, overflow: used > avail, used: Math.round(used), avail: Math.round(avail) };
  }

  /**
   * 手动分页：用户自己决定分几页、每页写什么。
   * @param {Array} pages [{ text, background?, image?, blur? }] —— 每页可单独覆盖背景
   * @param {Object} opts 同 render()，作为每页的默认值
   * @returns {{canvases, pages, overflows:number[], meta}}
   */
  function renderPages(pages, opts) {
    opts = normalizeOptions(opts);
    var dim = dimsOf(opts);
    var sp = specOf(dim.W, dim.H, opts.fontScale || 1, opts);
    var list = Array.isArray(pages) ? pages : [];
    if (!list.length) list = [{ text: '' }];

    var total = list.length + (opts.title ? 1 : 0);
    var canvases = [], overflows = [], no = 0;

    if (opts.title) {
      canvases.push(renderCover(opts.title, dim.W, dim.H, sp, opts, ++no, total));
    }
    for (var i = 0; i < list.length; i++) {
      var pg = list[i] || {};
      /* 每页的设置 = 全局设置 + 这一页的覆盖项。只有显式给了才覆盖，
         否则 undefined 会把全局值冲掉（背景变成默认那一档）。 */
      var pageOpts = {};
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) pageOpts[k] = opts[k];
      if (pg.background) pageOpts.background = pg.background;
      if (pg.image !== undefined) pageOpts.image = pg.image;
      if (pg.blur !== undefined) pageOpts.blur = pg.blur;
      var out = paintCard(pg.text || '', dim.W, dim.H, sp, pageOpts, ++no, total);
      canvases.push(out.canvas);
      if (out.overflow) overflows.push(canvases.length - 1);
    }
    return {
      canvases: canvases,
      pages: canvases.length,
      overflows: overflows,
      meta: { width: dim.W, height: dim.H, ratio: dim.ratio.id, manual: true }
    };
  }

  /** 比例 + 倍率 → 实际像素。render / renderPages 共用，避免两处算法跑偏。 */
  function dimsOf(opts) {
    var ratio = null;
    for (var i = 0; i < RATIOS.length; i++) if (RATIOS[i].id === opts.ratio) ratio = RATIOS[i];
    if (!ratio) ratio = RATIOS[0];
    var scale = Math.max(1, Math.min(3, +opts.scale || 1));
    return { W: Math.round(ratio.w * scale), H: Math.round(ratio.h * scale), ratio: ratio };
  }

  /**
   * 自动分页：把一段文字切成若干张卡片。
   * @param {string} text     Markdown 或纯文字
   * @param {Object} opts
   *   ratio      '3:4' | '1:1' | '9:16' | '4:3'（默认 3:4）
   *   scale      像素倍率，1 = 标准，2 = 视网膜（默认 1）
   *   background 内置背景 id
   *   image      自定义背景（Image / ImageBitmap / Canvas）
   *   blur       背景模糊半径 px（0-60）
   *   fontScale  字号整体缩放（默认 1）
   *   watermark  { text, image, position:'br', opacity:.55, scale:.16 }
   *   pageNo     是否画页码（默认 true）
   *   title      封面标题；给了就多出一张封面
   * @returns {{canvases: HTMLCanvasElement[], pages:number, meta:Object}}
   */
  function render(text, opts) {
    opts = normalizeOptions(opts);
    var dim = dimsOf(opts);
    var W = dim.W, H = dim.H;
    var sp = specOf(W, H, opts.fontScale || 1, opts);

    /* 量的时候需要一个 ctx，但不需要真画。用一张 1×1 的就够 —— font 和
       measureText 不依赖画布大小。 */
    var probe = document.createElement('canvas').getContext('2d');

    var blocks = parseBlocks(text);
    if (!blocks.length) blocks = [{ type: 'p', text: '（没有内容）' }];

    var measured = measureBlocks(probe, blocks, sp);
    var avail = H - sp.padTop - sp.padBottom - (opts.pageNo === false ? 0 : Math.round(sp.caption.size * 1.6));
    var pages = paginate(measured, avail, sp);

    var total = pages.length + (opts.title ? 1 : 0);
    var canvases = [], no = 0;

    if (opts.title) {
      canvases.push(renderCover(opts.title, W, H, sp, opts, ++no, total));
    }
    for (var p = 0; p < pages.length; p++) {
      var c = document.createElement('canvas');
      c.width = W; c.height = H;
      var ctx = c.getContext('2d');
      paintBackground(ctx, W, H, opts);
      var colors = autoContrast(ctx, W, H, sp, opts.accentColor);
      if (colors.scrim > 0) { ctx.fillStyle = colors.scrimColor; ctx.fillRect(0, 0, W, H); }
      drawPage(ctx, pages[p], W, H, sp, colors);
      if (opts.pageNo !== false) drawPageNo(ctx, W, H, sp, ++no, total, colors);
      drawWatermark(ctx, W, H, sp, opts.watermark, colors);
      canvases.push(c);
    }

    return {
      canvases: canvases,
      pages: canvases.length,
      meta: { width: W, height: H, ratio: dim.ratio.id, blocks: blocks.length }
    };
  }

  /**
   * 自动分页的结果**拆回文字**，一页一段 —— 「转成手动」用这个。
   * 用户不用从零敲每一页：先让工具切好，再自己微调。
   *
   * 从 measured 的 slice 反推原文：每个 block 记着自己的源文本，
   * 被拆开的段落按行取回（行里的 pieces 拼起来就是那一行的文字）。
   */
  function splitToPages(text, opts) {
    opts = normalizeOptions(opts);
    var dim = dimsOf(opts);
    var sp = specOf(dim.W, dim.H, opts.fontScale || 1, opts);
    var probe = document.createElement('canvas').getContext('2d');
    var blocks = parseBlocks(text);
    if (!blocks.length) return [''];
    var measured = measureBlocks(probe, blocks, sp);
    var avail = dim.H - sp.padTop - sp.padBottom
              - (opts.pageNo === false ? 0 : Math.round(sp.caption.size * 1.6));
    var pages = paginate(measured, avail, sp);

    return pages.map(function (page) {
      return page.map(function (slice) {
        var it = slice.item, b = it.block;
        /* 整块都在这一页 → 直接还原成源文本（保留 # / > / - 这些标记，
           这样用户在手动模式里继续编辑时，格式还是活的）。 */
        if (slice.from === 0 && slice.to === it.lines.length) return sourceOf(b);
        /* 被拆开了 → 按行取。只能拿到纯文字（行内标记在排版时已经解开），
           所以这里会丢掉这一段的加粗/代码标记 —— 但比把整段重复到两页好。 */
        var txt = [];
        for (var i = slice.from; i < slice.to; i++) {
          txt.push(it.lines[i].pieces.map(function (p) { return p.text; }).join(''));
        }
        return prefixOf(b) + txt.join('\n');
      }).join('\n\n');
    });
  }

  /** 块 → 源文本（带回 Markdown 标记）。 */
  function sourceOf(b) {
    if (b.type === 'heading') return new Array(b.level + 1).join('#') + ' ' + b.text;
    if (b.type === 'quote') return b.text.split('\n').map(function (l) { return '> ' + l; }).join('\n');
    if (b.type === 'code') return '```' + (b.lang || '') + '\n' + b.text + '\n```';
    if (b.type === 'li') return (b.ordered ? (b.num + '. ') : '- ') + b.text;
    if (b.type === 'hr') return '---';
    return b.text || '';
  }
  /** 块被拆开时，续页那部分要带的前缀（保持它还是同一种块）。 */
  function prefixOf(b) {
    if (b.type === 'quote') return '> ';
    if (b.type === 'li') return (b.ordered ? (b.num + '. ') : '- ');
    return '';
  }

  /** 封面：一张只有标题的卡片，给多图滑动时当"第一眼"。 */
  function renderCover(title, W, H, sp, opts, no, total) {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    paintBackground(ctx, W, H, opts);
    var colors = autoContrast(ctx, W, H, sp, opts.accentColor);
    if (colors.scrim > 0) { ctx.fillStyle = colors.scrimColor; ctx.fillRect(0, 0, W, H); }

    var style = { size: Math.round(sp.h1.size * 1.18), line: 1.3, weight: 700 };
    var lines = layoutRuns(ctx, tokenizeInline(title), sp.maxW, style, sp.fontFamily);
    var lineH = Math.round(style.size * style.line);
    var totalH = lines.length * lineH;
    var y = Math.max(sp.padTop, (H - totalH) / 2 - H * 0.04);

    for (var i = 0; i < lines.length; i++) {
      var x = sp.padX, baseline = y + Math.round(lineH * 0.74);
      for (var pi = 0; pi < lines[i].pieces.length; pi++) {
        var p = lines[i].pieces[pi];
        ctx.save();
        ctx.font = '700 ' + style.size + 'px ' + sp.fontStack;
        ctx.fillStyle = colors.fg;
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(p.text, x, baseline);
        ctx.restore();
        x += p.w;
      }
      y += lineH;
    }
    // 标题下面一道短线，让封面和内容页有区别
    ctx.save();
    ctx.strokeStyle = colors.rule;
    ctx.lineWidth = Math.max(2, Math.round(5 * sp.k));
    ctx.beginPath();
    ctx.moveTo(sp.padX, y + Math.round(sp.gap * 1.1));
    ctx.lineTo(sp.padX + Math.round(W * 0.16), y + Math.round(sp.gap * 1.1));
    ctx.stroke();
    ctx.restore();

    if (opts.pageNo !== false) drawPageNo(ctx, W, H, sp, no, total, colors);
    drawWatermark(ctx, W, H, sp, opts.watermark, colors);
    return c;
  }

  /** canvas → Blob（PNG）。逐张转，避免一次性占太多内存。 */
  function toBlobs(canvases, onProgress) {
    var out = [], i = 0;
    return new Promise(function (resolve, reject) {
      (function step() {
        if (i >= canvases.length) { resolve(out); return; }
        canvases[i].toBlob(function (b) {
          if (!b) { reject(new Error('第 ' + (i + 1) + ' 张图生成失败（可能是尺寸过大）')); return; }
          out.push(b);
          i++;
          if (onProgress) { try { onProgress(i, canvases.length); } catch (e) {} }
          step();
        }, 'image/png');
      })();
    });
  }

  window.DSCards = {
    RATIOS: RATIOS,
    BACKGROUNDS: BACKGROUNDS,
    THEMES: THEMES,
    FONTS: FONTS,
    ACCENT_COLORS: ACCENT_COLORS,
    HEADING_STYLES: HEADING_STYLES,
    CODE_STYLES: CODE_STYLES,
    WM_POS: WM_POS,
    parseBlocks: parseBlocks,
    render: render,
    renderPages: renderPages,
    splitToPages: splitToPages,
    toBlobs: toBlobs,
    /* 导出给测试用：这些是纯函数，值得单独验 */
    _internal: {
      tokenizeInline: tokenizeInline,
      splitToUnits: splitToUnits,
      paginate: paginate,
      measureBlocks: measureBlocks,
      specOf: specOf,
      relLuminance: relLuminance,
      contrastRatio: contrastRatio,
      autoContrast: autoContrast,
      normalizeOptions: normalizeOptions
    }
  };
})();
