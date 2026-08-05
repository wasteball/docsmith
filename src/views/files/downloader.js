
/* =====================================================================
   Integrated downloader engine — paste link → detect → download/convert
   (md → Word/PDF, ppt → PDF) with transit-page resolution + prefs.
   Appended after the main script so downloadFile() below overrides the
   simple version, giving history + batch downloads format-conversion too.
===================================================================== */

const TYPE_FORMATS = {
  md: [
    { id: 'original', main: '原文件', sub: '.md' },
    { id: 'docx',     main: 'Word',   sub: '.docx' },
    { id: 'pdf',      main: 'PDF',    sub: '.pdf' },
  ],
  ppt: [
    { id: 'original', main: '原文件', sub: '.pptx' },
    { id: 'pdf',      main: 'PDF',    sub: '.pdf', exp: true },
  ],
};
const EXT_TO_TYPE = { md: 'md', markdown: 'md', ppt: 'ppt', pptx: 'ppt' };
const TYPE_LABEL  = { md: 'Markdown', ppt: 'PowerPoint' };
const TYPE_ICON   = { md: 'MD', ppt: 'PP' };

/* 「下载时默认转成什么」这项偏好现在归全局设置面板管：
   Markdown → files.dlMarkdown，PowerPoint → files.dlPptx（存在 docsmith:prefs）。
   下载器只读它、也往它里写，不再自己存一份 state.dlPrefs —— 面板和这里
   下方「记住该类型的格式偏好」勾选框读写的是同一个值，永远一致。 */
const DL_PREF_KEY = { md: 'files.dlMarkdown', ppt: 'files.dlPptx' };
function dlPref(type) {
  const key = DL_PREF_KEY[type];
  if (!key || !(window.DSPrefs && window.DSPrefs.get)) return null;
  const v = window.DSPrefs.get(key, 'original');
  // 面板里 'original' = 保持原样、也就是"没设默认"，回落到每次手动选。
  // 后面那个 some() 还兼一个作用：老版本里存过 'html'（一个从来没实现过的
  // 转换，已从面板删掉），认不出的值一律当作未设置。
  if (!v || v === 'original') return null;
  return (TYPE_FORMATS[type] || []).some(o => o.id === v) ? v : null;
}
function setDlPref(type, fmt) {
  const key = DL_PREF_KEY[type];
  if (key && window.DSPrefs && window.DSPrefs.set) window.DSPrefs.set(key, fmt || 'original');
}
function clearDlPref(type) { setDlPref(type, 'original'); }

const isUrl = s => /^https?:\/\//i.test((s || '').trim());
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

/* Repair "mojibake": a UTF-8 byte sequence that was mis-read as Latin-1.
   HTTP header values are exposed to JS as Latin-1, so a UTF-8 Chinese filename
   in Content-Disposition comes back looking like "ä¸­æ–‡". This re-interprets
   those bytes as UTF-8 when it produces valid text, otherwise returns as-is. */
function fixMojibake(s) {
  if (!s) return s;
  // no high-range Latin-1 bytes → nothing to repair
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  // already contains CJK / Kana → looks correct, don't touch it
  if (/[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (decoded && !decoded.includes('\ufffd')) return decoded;
  } catch (e) {}
  return s;
}

/* Robustly extract a filename from a Content-Disposition header.
   Prefers RFC 5987 `filename*=UTF-8''...` (percent-decoded) and falls back to
   the plain `filename=` value with mojibake repair. */
function parseContentDisposition(cd) {
  if (!cd) return '';
  // RFC 5987: filename*=charset'lang'percent-encoded
  let m = cd.match(/filename\*\s*=\s*([\w-]+)?'[^']*'([^;]+)/i);
  if (m) {
    let val = m[2].trim().replace(/^["']|["']$/g, '');
    try { return decodeURIComponent(val); } catch (e) { return fixMojibake(val); }
  }
  // Plain: filename="..." / filename='...' / filename=...
  m = cd.match(/filename\s*=\s*("([^"]*)"|'([^']*)'|([^;]+))/i);
  if (m) {
    let val = (m[2] || m[3] || m[4] || '').trim();
    if (/%[0-9a-f]{2}/i.test(val)) { try { val = decodeURIComponent(val); } catch (e) {} }
    return fixMojibake(val);
  }
  return '';
}

function dlBasename(u) {
  let n = String(u).split('#')[0].split('?')[0].split('/').pop() || 'download';
  return fixMojibake(safeDecode(n)) || 'download';
}
function dlStripExt(name) { return String(name).replace(/\.[a-z0-9]+$/i, ''); }
function dlGetExt(url) {
  try { const p = new URL(url).pathname; const m = p.match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ''; }
  catch { const m = String(url).split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ''; }
}
const WRAP_PARAMS = ['file_path', 'filepath', 'url', 'fileUrl', 'target', 'src'];
function resolveRealUrl(raw) {
  raw = (raw || '').trim();
  if (!raw) return { real: '', wrapped: false, param: null };
  let real = raw, wrapped = false, param = null;
  try {
    const u = new URL(raw);
    for (const p of WRAP_PARAMS) {
      const v = u.searchParams.get(p);
      if (v && isUrl(v)) { real = v; wrapped = true; param = p; break; }
    }
  } catch {}
  if (!wrapped) {
    for (const p of WRAP_PARAMS) {
      const key = p + '=';
      const i = raw.indexOf(key);
      if (i >= 0) { let v = safeDecode(raw.slice(i + key.length)); if (isUrl(v)) { real = v; wrapped = true; param = p; break; } }
    }
  }
  return { real, wrapped, param };
}

async function convert(type, fmt, blob, baseName, onProgress) {
  if (type === 'md' && fmt === 'docx') return await mdToDocx(blob, baseName, onProgress);
  if (type === 'md' && fmt === 'pdf')  return await mdToPdf(blob, baseName, onProgress);
  if (type === 'ppt' && fmt === 'pdf') return await pptToPdf(blob, baseName, onProgress);
  throw new Error('不支持的转换路径');
}

// ────────────────────────────────────────────────────────────────
//   MD → DOCX (handcrafted docx.js,样式完整)
// ────────────────────────────────────────────────────────────────
async function mdToDocx(blob, baseName, onProgress) {
  onProgress?.(10, '读取 Markdown…');
  const md = await blob.text();
  onProgress?.(25, '解析结构…');

  const D = window.docx;
  const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel,
    AlignmentType, LineRuleType, Table, TableRow, TableCell, WidthType,
    BorderStyle, ShadingType, LevelFormat, PageNumber, Footer, PageOrientation } = D;

  const FONT       = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '微软雅黑', cs: 'Calibri' };
  const FONT_MONO  = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: '微软雅黑', cs: 'Consolas' };
  const FONT_SERIF = { ascii: 'Cambria',  hAnsi: 'Cambria',  eastAsia: '微软雅黑', cs: 'Cambria' };
  const C = { ink:'1B1815',ink2:'4A4239',ink3:'8A7E6E',rule:'C9BCA3',accent:'B8451F',
    codeBg:'F0E9DA',codeFg:'7A2E1D',quoteBg:'F4E4D7',hRowBg:'F2ECDF',zebraBg:'FBF6EE' };
  const H_SIZE = {1:36,2:30,3:26,4:24,5:22,6:20};
  const H_SP = {1:{before:360,after:200},2:{before:320,after:160},3:{before:280,after:140},
                4:{before:240,after:120},5:{before:200,after:100},6:{before:180,after:100}};
  const decodeE = s => !s ? '' : s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ');

  function inlineRuns(tokens, opts = {}) {
    const out = []; if (!tokens) return out;
    for (const t of tokens) {
      if (t.type === 'text') {
        if (t.tokens?.length) out.push(...inlineRuns(t.tokens, opts));
        else out.push(new TextRun({
          text: decodeE(t.text),
          bold: opts.bold || false, italics: opts.italic || false,
          strike: opts.strike || false, underline: opts.underline ? {} : undefined,
          color: opts.color || C.ink, size: opts.size || 22, font: opts.font || FONT,
        }));
      } else if (t.type === 'strong') out.push(...inlineRuns(t.tokens, {...opts, bold:true}));
      else if (t.type === 'em')      out.push(...inlineRuns(t.tokens, {...opts, italic:true}));
      else if (t.type === 'del')     out.push(...inlineRuns(t.tokens, {...opts, strike:true}));
      else if (t.type === 'codespan') out.push(new TextRun({
        text: decodeE(t.text), font: FONT_MONO, size: 20, color: C.codeFg,
        shading: { type: ShadingType.SOLID, color: C.codeBg, fill: C.codeBg },
      }));
      else if (t.type === 'link') out.push(new ExternalHyperlink({
        link: t.href,
        children: inlineRuns(t.tokens, {...opts, color: '0066CC', underline: true}),
      }));
      else if (t.type === 'br') out.push(new TextRun({ break: 1 }));
      else if (t.type === 'image') out.push(new TextRun({
        text: `[image: ${t.text || t.href}]`, italics: true, color: C.ink3, size: 20, font: FONT,
      }));
      else if (t.type === 'html') {
        const s = (t.text || '').replace(/<[^>]+>/g, '');
        if (s.trim()) out.push(new TextRun({ text: s, font: FONT, size: opts.size||22 }));
      } else if (t.type === 'escape') {
        out.push(new TextRun({ text: t.text, font: FONT, size: opts.size||22 }));
      } else if (t.text) {
        out.push(new TextRun({ text: decodeE(t.text), font: FONT, size: opts.size||22 }));
      }
    }
    return out;
  }

  function headingPara(token) {
    const d = token.depth, sz = H_SIZE[d], sp = H_SP[d];
    return new Paragraph({
      heading: HeadingLevel[`HEADING_${d}`],
      children: inlineRuns(token.tokens, { bold:true, size:sz, color:C.ink, font:FONT_SERIF }),
      spacing: { ...sp, line: 300, lineRule: LineRuleType.AUTO },
      border: d === 1 ? { bottom:{style:BorderStyle.SINGLE,size:12,color:C.ink,space:6} } : undefined,
      keepNext: true,
    });
  }
  function paraInline(tokens, extra={}) {
    return new Paragraph({
      children: inlineRuns(tokens),
      spacing: { after:160, line:320, lineRule:LineRuleType.AUTO, ...(extra.spacing||{}) },
      ...extra,
    });
  }
  function codeBlock(token) {
    const lines = (token.text || '').split(/\r?\n/);
    return lines.map((line, i) => new Paragraph({
      children: [new TextRun({ text: line || ' ', font: FONT_MONO, size: 19, color: C.ink2 })],
      spacing: { before: i===0?120:0, after: i===lines.length-1?160:0, line:280, lineRule:LineRuleType.AUTO },
      indent: { left: 240, right: 240 },
      shading: { type: ShadingType.SOLID, color: C.codeBg, fill: C.codeBg },
      border: {
        left:   { style: BorderStyle.SINGLE, size: 18, color: C.accent, space: 8 },
        top:    i===0 ? { style: BorderStyle.SINGLE, size: 4, color: C.rule, space: 4 } : undefined,
        bottom: i===lines.length-1 ? { style: BorderStyle.SINGLE, size: 4, color: C.rule, space: 4 } : undefined,
        right:  { style: BorderStyle.SINGLE, size: 4, color: C.rule, space: 4 },
      },
    }));
  }
  function quoteBlock(token) {
    const out = [];
    for (const sub of token.tokens) {
      if (sub.type === 'paragraph') out.push(new Paragraph({
        children: inlineRuns(sub.tokens, { color: C.ink2, italic: true }),
        spacing: { before:100, after:100, line:300, lineRule:LineRuleType.AUTO },
        indent: { left: 360, right: 240 },
        shading: { type: ShadingType.SOLID, color: C.quoteBg, fill: C.quoteBg },
        border: {
          left:   { style: BorderStyle.SINGLE, size: 18, color: C.accent, space: 8 },
          top:    { style: BorderStyle.SINGLE, size: 2, color: C.quoteBg, space: 4 },
          bottom: { style: BorderStyle.SINGLE, size: 2, color: C.quoteBg, space: 4 },
          right:  { style: BorderStyle.SINGLE, size: 2, color: C.quoteBg, space: 4 },
        },
      })); else out.push(...dispatch(sub));
    }
    return out;
  }
  function listBlocks(token, depth=0) {
    const out = [];
    for (const item of token.items) {
      const isTask = item.task === true;
      const checked = item.checked === true;
      const checkPrefix = isTask
        ? new TextRun({ text: (checked?'☑ ':'☐ '), font: FONT, size: 22, color: checked?C.accent:C.ink2 })
        : null;
      let first = false;
      for (const sub of item.tokens) {
        if (sub.type === 'list') out.push(...listBlocks(sub, depth+1));
        else if (sub.type === 'text' || sub.type === 'paragraph') {
          const subTokens = sub.tokens || [{ type:'text', text:sub.text }];
          const runs = inlineRuns(subTokens);
          if (!first && checkPrefix) runs.unshift(checkPrefix);
          const opts = {
            children: runs,
            spacing: { after:80, line:300, lineRule:LineRuleType.AUTO },
          };
          if (!first) {
            if (token.ordered) opts.numbering = { reference:'ol-num', level: Math.min(depth,2) };
            else opts.bullet = { level: Math.min(depth,2) };
          } else opts.indent = { left: 720 + depth*360 };
          out.push(new Paragraph(opts));
          first = true;
        } else out.push(...dispatch(sub));
      }
    }
    return out;
  }
  function tableBlock(token) {
    const al = a => a==='center'?AlignmentType.CENTER : a==='right'?AlignmentType.RIGHT : AlignmentType.LEFT;
    const cellPara = (cell, isH) => [new Paragraph({
      children: inlineRuns(cell.tokens || [{type:'text',text:cell.text||''}],
        { bold:isH, size:20, color:isH?C.ink:C.ink2 }),
      spacing: { line:280, lineRule:LineRuleType.AUTO, before:40, after:40 },
      alignment: al(cell.align),
    })];
    const head = new TableRow({
      tableHeader: true,
      children: token.header.map(h => new TableCell({
        children: cellPara(h, true),
        shading: { type: ShadingType.SOLID, color: C.hRowBg, fill: C.hRowBg },
        margins: { top:80, bottom:80, left:100, right:100 },
      })),
    });
    const rows = token.rows.map((r,i) => new TableRow({
      children: r.map(c => new TableCell({
        children: cellPara(c, false),
        shading: i%2===1 ? { type: ShadingType.SOLID, color: C.zebraBg, fill: C.zebraBg } : undefined,
        margins: { top:60, bottom:60, left:100, right:100 },
      })),
    }));
    return new Table({
      rows: [head, ...rows],
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top:    { style: BorderStyle.SINGLE, size: 4, color: C.rule },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: C.rule },
        left:   { style: BorderStyle.SINGLE, size: 4, color: C.rule },
        right:  { style: BorderStyle.SINGLE, size: 4, color: C.rule },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: C.rule },
        insideVertical:   { style: BorderStyle.SINGLE, size: 2, color: C.rule },
      },
    });
  }
  function dispatch(t) {
    switch (t.type) {
      case 'heading':    return [headingPara(t)];
      case 'paragraph':  return [paraInline(t.tokens)];
      case 'code':       return codeBlock(t);
      case 'blockquote': return quoteBlock(t);
      case 'list':       return listBlocks(t, 0);
      case 'table':      return [tableBlock(t), new Paragraph({ children: [], spacing: { after: 120 } })];
      case 'hr':         return [new Paragraph({
        children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.rule, space: 4 } },
        spacing: { before: 200, after: 200 },
      })];
      case 'space':      return [];
      case 'html': {
        const s = (t.text||'').replace(/<[^>]+>/g,'').trim();
        return s ? [paraInline([{type:'text',text:s}])] : [];
      }
      default: return t.tokens ? [paraInline(t.tokens)] : [];
    }
  }

  const tokens = marked.lexer(md);
  const blocks = [];
  for (const t of tokens) blocks.push(...dispatch(t));
  if (!blocks.length) blocks.push(new Paragraph({ children:[new TextRun({text:'(空文档)',font:FONT,color:C.ink3})] }));

  onProgress?.(60, '生成 Docx…');
  const doc = new Document({
    creator: 'OSS Downloader', title: baseName,
    styles: {
      default: {
        document: { run: { font:FONT, size:22, color:C.ink }, paragraph: { spacing:{ line:320, lineRule:LineRuleType.AUTO, after:160 } } },
        heading1: { run:{ font:FONT_SERIF, size:H_SIZE[1], bold:true, color:C.ink } },
        heading2: { run:{ font:FONT_SERIF, size:H_SIZE[2], bold:true, color:C.ink } },
        heading3: { run:{ font:FONT_SERIF, size:H_SIZE[3], bold:true, color:C.ink } },
        heading4: { run:{ font:FONT_SERIF, size:H_SIZE[4], bold:true, color:C.ink } },
        heading5: { run:{ font:FONT_SERIF, size:H_SIZE[5], bold:true, color:C.ink2 } },
        heading6: { run:{ font:FONT_SERIF, size:H_SIZE[6], bold:true, color:C.ink2 } },
      },
    },
    numbering: {
      config: [{
        reference: 'ol-num',
        levels: [
          { level:0, format:LevelFormat.DECIMAL,      text:'%1.', alignment:AlignmentType.START, style:{paragraph:{indent:{left:720,hanging:360}}} },
          { level:1, format:LevelFormat.LOWER_LETTER, text:'%2.', alignment:AlignmentType.START, style:{paragraph:{indent:{left:1440,hanging:360}}} },
          { level:2, format:LevelFormat.LOWER_ROMAN,  text:'%3.', alignment:AlignmentType.START, style:{paragraph:{indent:{left:2160,hanging:360}}} },
        ],
      }],
    },
    sections: [{
      properties: { page: { margin:{top:1440,right:1440,bottom:1440,left:1440}, size:{ orientation: PageOrientation.PORTRAIT } } },
      footers: { default: new Footer({ children:[new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ children:[PageNumber.CURRENT], font:FONT, size:18, color:C.ink3 }),
          new TextRun({ text:'  /  ', font:FONT, size:18, color:C.ink3 }),
          new TextRun({ children:[PageNumber.TOTAL_PAGES], font:FONT, size:18, color:C.ink3 }),
        ],
      })] }) },
      children: blocks,
    }],
  });

  onProgress?.(85, '打包 Docx…');
  const outBlob = await Packer.toBlob(doc);
  return { blob: outBlob, filename: baseName + '.docx', size: outBlob.size };
}

// ────────────────────────────────────────────────────────────────
//   MD → PDF (marked → 隐藏 HTML 容器 → html2pdf)
// ────────────────────────────────────────────────────────────────
async function mdToPdf(blob, baseName, onProgress) {
  /* html2pdf 这个库没有随包附带（2MB+，而且这条路本来就只有文件库的
     「转换成 PDF 再下载」用得到）。不先挡一下的话，下面那句 html2pdf()
     会抛一个赤裸的 ReferenceError，用户看到的是一串英文报错。
     换成一句人话，并且指一条真的走得通的路：Markdown 工作台里的
     「导出 → PDF」不依赖任何第三方库，它走的是浏览器自己的打印。 */
  if (typeof html2pdf === 'undefined') {
    throw new Error('这个版本没有带 PDF 转换组件。把文件下载成 .md，'
      + '再到 Markdown 工作台里用「导出 → PDF」，效果一样。');
  }
  onProgress?.(10, '读取 Markdown…');
  const md = await blob.text();
  onProgress?.(25, '渲染 HTML…');
  const html = marked.parse(md);

  const host = document.getElementById('renderHost');
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = `width:794px;padding:56px 64px;background:#fff;color:#1a1a1a;
    font-family:'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif;
    font-size:14px;line-height:1.7;box-sizing:border-box;`;
  wrap.innerHTML = `
    <style>
      .pdf-doc h1,.pdf-doc h2,.pdf-doc h3,.pdf-doc h4,.pdf-doc h5,.pdf-doc h6{
        font-family:'Cambria','Times New Roman',serif;color:#1B1815;font-weight:600;
        margin:1.6em 0 .5em;line-height:1.3;
      }
      .pdf-doc h1{font-size:26px;border-bottom:2px solid #1B1815;padding-bottom:.2em;margin-top:0}
      .pdf-doc h2{font-size:21px}
      .pdf-doc h3{font-size:18px}
      .pdf-doc h4{font-size:15.5px}
      .pdf-doc h5{font-size:14px;color:#4A4239}
      .pdf-doc h6{font-size:13px;color:#4A4239;text-transform:uppercase;letter-spacing:.06em}
      .pdf-doc p{margin:0 0 .85em}
      .pdf-doc strong{font-weight:600}
      .pdf-doc em{font-style:italic}
      .pdf-doc a{color:#B8451F;text-decoration:underline}
      .pdf-doc code{font-family:Consolas,'Courier New',monospace;background:#F0E9DA;color:#7A2E1D;
        padding:1px 6px;border-radius:3px;font-size:.88em}
      .pdf-doc pre{background:#F2ECDF;border-left:3px solid #B8451F;border:1px solid #C9BCA3;
        border-radius:3px;padding:12px 16px;overflow:hidden;margin:1em 0;page-break-inside:avoid}
      .pdf-doc pre code{background:transparent;color:#1B1815;padding:0;font-size:12.5px;line-height:1.55}
      .pdf-doc blockquote{border-left:3px solid #B8451F;background:#F4E4D7;margin:1em 0;
        padding:8px 16px;color:#4A4239;font-style:italic;page-break-inside:avoid}
      .pdf-doc blockquote p:last-child{margin:0}
      .pdf-doc ul,.pdf-doc ol{padding-left:1.6em;margin:0 0 1em}
      .pdf-doc li{margin:.2em 0}
      .pdf-doc li::marker{color:#B8451F}
      .pdf-doc hr{border:none;border-top:1px solid #C9BCA3;margin:1.4em 0}
      .pdf-doc table{border-collapse:collapse;width:100%;margin:1em 0;font-size:12.5px;page-break-inside:avoid}
      .pdf-doc th,.pdf-doc td{border:1px solid #C9BCA3;padding:6px 10px;text-align:left}
      .pdf-doc th{background:#F2ECDF;font-weight:600}
      .pdf-doc tr:nth-child(even) td{background:#FBF6EE}
      .pdf-doc img{max-width:100%}
    </style>
    <div class="pdf-doc">${html}</div>
  `;
  host.appendChild(wrap);

  onProgress?.(55, '生成 PDF…');
  const opt = {
    margin: [12, 12, 14, 12],   // mm
    filename: baseName + '.pdf',
    image: { type: 'jpeg', quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
    pagebreak: { mode: ['css', 'legacy', 'avoid-all'] },
  };
  const pdfBlob = await html2pdf().set(opt).from(wrap).outputPdf('blob');
  host.innerHTML = '';
  onProgress?.(95, '完成 PDF…');
  return { blob: pdfBlob, filename: baseName + '.pdf', size: pdfBlob.size };
}

// ────────────────────────────────────────────────────────────────
//   PPT → PDF (pptx-preview → html2canvas → jsPDF) · 实验性
// ────────────────────────────────────────────────────────────────
async function pptToPdf(blob, baseName, onProgress) {
  if (!window.pptxPreviewer) throw new Error('PPT 预览库未加载,请检查网络');
  if (!window.html2pdf || !window.jspdf) throw new Error('PDF 库未加载,请检查网络');

  onProgress?.(8, '读取 PPTX…');
  const ab = await blob.arrayBuffer();

  // 隐藏容器
  const host = document.getElementById('renderHost');
  host.innerHTML = '';
  const container = document.createElement('div');
  const SLIDE_W = 960, SLIDE_H = 540;
  container.style.cssText = `width:${SLIDE_W}px;background:#fff`;
  host.appendChild(container);

  onProgress?.(20, '渲染幻灯片…');
  const previewer = window.pptxPreviewer.init(container, { width: SLIDE_W, height: SLIDE_H });
  await previewer.preview(ab);
  // 给渲染一点缓冲(图片/字体加载)
  await new Promise(r => setTimeout(r, 600));

  // 找到所有 slide 元素 —— 兼容不同版本的 class 命名
  let slides = container.querySelectorAll('.pptx-preview-wrapper > section, .pptx-preview-wrapper section.slide, section.slide');
  if (!slides.length) slides = container.querySelectorAll('.pptx-preview-wrapper > div');
  if (!slides.length) slides = container.children[0]?.children || [];
  const slideEls = Array.from(slides).filter(el => el.offsetWidth > 100 && el.offsetHeight > 60);
  if (!slideEls.length) {
    host.innerHTML = '';
    throw new Error('未能从 PPTX 中提取到幻灯片(可能是不支持的版式)');
  }

  onProgress?.(35, `捕获 ${slideEls.length} 张幻灯片…`);
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [SLIDE_W, SLIDE_H] });

  for (let i = 0; i < slideEls.length; i++) {
    const el = slideEls[i];
    // eslint-disable-next-line no-undef
    const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    if (i > 0) pdf.addPage([SLIDE_W, SLIDE_H], 'landscape');
    pdf.addImage(imgData, 'JPEG', 0, 0, SLIDE_W, SLIDE_H);
    const stagePct = 35 + Math.round((i + 1) / slideEls.length * 55);
    onProgress?.(stagePct, `捕获幻灯片 ${i + 1} / ${slideEls.length}…`);
  }

  onProgress?.(95, '打包 PDF…');
  const pdfBlob = pdf.output('blob');
  host.innerHTML = '';
  return { blob: pdfBlob, filename: baseName + '.pdf', size: pdfBlob.size };
}

/* ===== Upgraded download: original OR converted, with progress + CORS fallback ===== */
async function downloadFile(rawUrl, fileName, opts) {
  const r = resolveRealUrl(rawUrl || '');
  const url = (r.real && isUrl(r.real)) ? r.real : (rawUrl || '');
  if (!isUrl(url)) { toast('无有效链接', 'warn'); return; }

  const inputName = (fileName || '').trim();
  const autoName = dlBasename(url);
  const ext = dlGetExt(url) || dlGetExt(inputName || autoName);
  const type = EXT_TO_TYPE[ext] || null;
  let fmt = (opts && opts.fmt) ? opts.fmt
          : (type && dlPref(type)) ? dlPref(type)
          : 'original';
  if (fmt !== 'original' && !type) fmt = 'original';

  const displayName = inputName || autoName;
  /* 进度条要挂进**文件库自己的** toast 容器。
     外壳也有一个 id="toasts"，document.getElementById 返回文档里先出现的
     那一个（合并后是外壳的）—— 进度条会跑到外壳的 toast 区去，样式还是
     文件库的，看着就是错位。library.js 的 el() 已经限定在容器内，用它。 */
  const container = el('toasts');
  const box = document.createElement('div');
  box.className = 'dl-toast';
  box.innerHTML =
    '<div class="dl-toast-name" title="' + escapeHtml(displayName) + '">↓ ' + escapeHtml(displayName) +
      (fmt !== 'original' ? ' <span style="color:var(--accent)">→ ' + fmt.toUpperCase() + '</span>' : '') + '</div>' +
    '<div class="dl-toast-bar"><div class="dl-toast-fill"></div></div>' +
    '<div class="dl-toast-meta"><span class="dl-pct">0%</span><span class="dl-stage">连接中…</span></div>';
  container.appendChild(box);
  const fill = box.querySelector('.dl-toast-fill');
  const pctEl = box.querySelector('.dl-pct');
  const stageEl = box.querySelector('.dl-stage');
  const setPct = (p, stage) => { fill.style.width = p + '%'; pctEl.textContent = Math.round(p) + '%'; if (stage) stageEl.textContent = stage; };
  const fade = (d = 2600) => setTimeout(() => { box.classList.add('fading'); setTimeout(() => box.remove(), 200); }, d);
  const closeBtn = () => { box.classList.add('fading'); setTimeout(() => box.remove(), 200); };

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const total = parseInt(resp.headers.get('content-length') || '0', 10);
    const cd = resp.headers.get('content-disposition');
    const serverName = parseContentDisposition(cd);

    let blob;
    if (resp.body && resp.body.getReader) {
      const reader = resp.body.getReader(); const chunks = []; let rec = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); rec += value.length;
        const p = total ? Math.min(60, rec / total * 60) : 30;
        setPct(p, '下载 ' + fmtSize(rec) + (total ? ' / ' + fmtSize(total) : ''));
      }
      blob = new Blob(chunks);
    } else { setPct(40, '下载中…'); blob = await resp.blob(); }

    setPct(60, fmt === 'original' ? '保存文件…' : '转换中…');
    const baseName = inputName ? dlStripExt(inputName) : (serverName ? dlStripExt(serverName) : dlStripExt(autoName));

    if (fmt === 'original' || !type) {
      const outName = inputName ? inputName : (baseName + (ext ? '.' + ext : ''));
      setPct(100, '完成'); box.classList.add('done');
      saveBlob(blob, outName); fade();
    } else {
      const out = await convert(type, fmt, blob, baseName, (p, msg) => setPct(60 + p * 0.38, msg));
      setPct(100, '完成'); box.classList.add('done');
      saveBlob(out.blob, out.filename); fade();
    }
  } catch (err) {
    box.classList.add('err');
    if (err instanceof TypeError) {
      const curl = "curl -L -o '" + displayName.replace(/'/g, "'\\''") + "' '" + url.replace(/'/g, "'\\''") + "'";
      box.innerHTML =
        '<div class="dl-toast-name">✗ 抓取失败（多为跨域 CORS 限制）</div>' +
        '<div class="dl-toast-meta" style="color:var(--text-dim);margin-bottom:2px">静态页面无法绕过，可改用：</div>' +
        '<div class="dl-toast-actions">' +
          '<button data-act="open">新标签打开另存</button>' +
          '<button data-act="curl">复制 curl</button>' +
          '<button data-act="close">关闭</button>' +
        '</div>';
      box.querySelector('[data-act="open"]').onclick = () => window.open(url, '_blank', 'noopener');
      box.querySelector('[data-act="curl"]').onclick = (e) => { copyText(curl, true); e.target.textContent = '✓ 已复制'; };
      box.querySelector('[data-act="close"]').onclick = closeBtn;
    } else {
      box.innerHTML =
        '<div class="dl-toast-name">✗ 失败：' + escapeHtml(err.message || String(err)) + '</div>' +
        '<div class="dl-toast-actions"><button data-act="close">关闭</button></div>';
      box.querySelector('[data-act="close"]').onclick = closeBtn;
    }
  }
}

/* ===== Dedicated "download / convert" panel ===== */
let dlCurType = null, dlCurExt = '', dlCurFmt = 'original', dlBusy = false;

function dlUpdatePreview() {
  const raw = document.getElementById('dl-input').value.trim();
  const pv = document.getElementById('dl-preview');
  const fmtBlock = document.getElementById('dl-fmt');
  if (!raw) { pv.classList.remove('show'); fmtBlock.classList.remove('show'); dlCurType = null; return; }

  const r = resolveRealUrl(raw);
  dlCurExt = dlGetExt(r.real || raw);
  const type = EXT_TO_TYPE[dlCurExt] || null;
  dlCurType = type;

  let html = '';
  if (r.wrapped) html += '<b>✓ 已识别中转页</b>（参数 ' + r.param + '）<br><span class="u">' + escapeHtml(r.real) + '</span>';
  else if (isUrl(raw)) html += '<b>✓ 直接链接</b>';
  else {
    pv.classList.add('show');
    pv.innerHTML = '<span style="color:var(--error)">⚠ 不是有效的 http(s) 链接</span>';
    fmtBlock.classList.remove('show'); return;
  }
  if (dlCurExt) {
    html += '<span class="ext-tag">.' + dlCurExt + '</span>';
    if (type) html += ' <span style="color:var(--accent)">→ ' + TYPE_LABEL[type] + '</span>';
  }
  pv.classList.add('show'); pv.innerHTML = html;
  if (type) dlRenderFmt(type); else fmtBlock.classList.remove('show');
}

function dlRenderFmt(type) {
  const block = document.getElementById('dl-fmt');
  const seg = document.getElementById('dl-seg');
  const opts = TYPE_FORMATS[type];
  seg.innerHTML = '';
  const saved = dlPref(type);
  const hasSaved = saved && opts.some(o => o.id === saved);
  dlCurFmt = hasSaved ? saved : opts[0].id;
  document.getElementById('dl-auto-tag').classList.toggle('show', !!hasSaved);
  document.getElementById('dl-remember').checked = !!hasSaved;

  opts.forEach(o => {
    const el = document.createElement('div');
    el.className = 'seg-fmt-opt' + (o.id === dlCurFmt ? ' active' : '') + (o.exp ? ' exp' : '');
    el.dataset.id = o.id;
    el.innerHTML = '<span class="seg-fmt-main">' + o.main + '</span><span class="seg-fmt-sub">' + o.sub + '</span>';
    el.onclick = () => {
      dlCurFmt = o.id;
      seg.querySelectorAll('.seg-fmt-opt').forEach(x => x.classList.toggle('active', x.dataset.id === o.id));
      document.getElementById('dl-auto-tag').classList.remove('show');
    };
    seg.appendChild(el);
  });
  block.classList.add('show');
}

async function dlRun() {
  if (dlBusy) return;
  const raw = document.getElementById('dl-input').value.trim();
  if (!raw) { toast('请先粘贴链接', 'warn'); return; }
  const r = resolveRealUrl(raw);
  if (!r.real || !isUrl(r.real)) { toast('请输入有效的 http(s) 链接', 'error'); return; }

  const type = EXT_TO_TYPE[dlGetExt(r.real)] || null;
  const fmt = type ? dlCurFmt : 'original';
  const fname = document.getElementById('dl-fname').value.trim();

  if (type && document.getElementById('dl-remember').checked) {
    setDlPref(type, dlCurFmt); renderDlPrefs();
  }

  dlBusy = true;
  const btn = document.getElementById('dl-run');
  btn.disabled = true; btn.textContent = '处理中…';
  try { await downloadFile(raw, fname, { fmt }); }
  finally { dlBusy = false; btn.disabled = false; btn.textContent = '下载文件'; }
}

/* ===== Download-format preferences (in settings drawer) ===== */
function renderDlPrefs() {
  const wrap = document.getElementById('dlpref-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  Object.keys(TYPE_FORMATS).forEach(k => {
    const opt = TYPE_FORMATS[k].find(o => o.id === dlPref(k));
    const row = document.createElement('div');
    row.className = 'dlpref-row';
    row.innerHTML =
      '<div class="dlpref-key"><span class="pk">' + TYPE_ICON[k] + '</span>' + TYPE_LABEL[k] + '</div>' +
      '<div class="dlpref-val">' + (opt
        ? '默认 → <span class="v">' + opt.main + '</span> <span style="color:var(--text-mute)">(' + opt.sub + ')</span>'
        : '<span style="color:var(--text-mute)">未设置 · 每次手动选择</span>') + '</div>' +
      (opt ? '<button class="dlpref-clear" data-k="' + k + '">清除</button>' : '');
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('.dlpref-clear').forEach(b => b.onclick = () => {
    clearDlPref(b.dataset.k); renderDlPrefs();
    if (dlCurType === b.dataset.k) dlRenderFmt(dlCurType);
  });
}

function bindDownloadPanel() {
  const panel = document.getElementById('dl-panel');
  document.getElementById('dl-panel-head').onclick = () => panel.classList.toggle('open');
  const input = document.getElementById('dl-input');
  input.addEventListener('input', dlUpdatePreview);
  input.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') dlRun(); });
  document.getElementById('dl-run').onclick = dlRun;
}

bindDownloadPanel();
renderDlPrefs();

