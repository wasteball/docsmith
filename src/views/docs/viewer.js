/* =====================================================================
 * Docsmith · 说明文档查看器
 * ---------------------------------------------------------------------
 * 为什么需要这一页：
 * 以前「怎么连？看图文说明」是一个 <a href="../../../docs/xxx.md">，
 * 直接把 .md 文件丢给浏览器打开。路径和权限都没问题，但 Chrome 对 .md
 * 没有 MIME 映射，响应里也就没有 charset —— UTF-8 的中文被按单字节解码，
 * 满屏乱码。文件本身还不带 BOM，连这唯一的带内提示都没有。
 *
 * 所以改成：这一页负责 fetch 那份 .md（明确按 UTF-8 解码），用已经打包好的
 * marked 渲染，套 Markdown 工作台同一份 doc.css。用户看到的是排好版的文档，
 * 而不是一堆问号。
 *
 * 文档名走 ?doc= 参数，但只允许白名单里的文件 —— 这一页能读扩展内的任意
 * 相对路径，不做限制的话等于开了个任意文件读取的口子。
 * ===================================================================== */
(function () {
  'use strict';

  /* 允许打开的文档。加新文档时在这里登记一行。 */
  var DOCS = {
    'storage': { file: '02-连接你的云存储.md', title: '连接你的云存储' }
  };

  var docEl = document.getElementById('doc');
  var titleEl = document.getElementById('docTitle');

  function fail(msg) {
    docEl.innerHTML = '<p class="doc-err">' + msg + '</p>';
  }

  /* 代码块套上工作台那套外壳，配色才跟着 hljs 主题走 */
  function codeBlock(code, infostring) {
    var lang = (infostring || '').trim().split(/\s+/)[0];
    var hi, shown = lang || 'text';
    if (window.hljs) {
      try {
        if (lang && hljs.getLanguage(lang)) hi = hljs.highlight(code, { language: lang }).value;
        else { var r = hljs.highlightAuto(code); hi = r.value; shown = lang || r.language || 'text'; }
      } catch (e) { hi = esc(code); }
    } else hi = esc(code);
    return '<div class="code-block"><div class="cb-head"><span class="cb-lang">'
      + esc(shown) + '</span></div><pre><code class="hljs">' + hi + '</code></pre></div>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function slug(text) {
    return String(text).replace(/<[^>]*>/g, '').trim().toLowerCase()
      .replace(/[^\w一-龥\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-') || 'section';
  }

  function render(md) {
    var html;
    try {
      if (!window.marked) throw new Error('渲染组件没加载成功');
      marked.use({
        gfm: true, breaks: false, headerIds: false, mangle: false,
        renderer: {
          code: function (code, info) { return codeBlock(code, info); },
          heading: function (text, level) {
            var id = slug(text);
            return '<h' + level + ' id="' + id + '">' + text + '</h' + level + '>';
          }
        }
      });
      html = marked.parse(md);
    } catch (e) {
      // 渲染不出来也不能白屏：原文照贴，一个字都不少
      docEl.innerHTML = '<pre class="raw-fallback">' + esc(md) + '</pre>';
      return;
    }
    if (window.DOMPurify) {
      try {
        var clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target'], USE_PROFILES: { html: true } });
        if (clean && clean.trim()) html = clean;
      } catch (e) { /* 本地文档，不干净也是我们自己写的 */ }
    }
    docEl.innerHTML = html;
    // 表格套一层横向滚动容器，窄窗口下不至于把版心撑破
    docEl.querySelectorAll('table').forEach(function (t) {
      if (t.parentNode && t.parentNode.classList.contains('table-wrap')) return;
      var w = document.createElement('div'); w.className = 'table-wrap';
      t.parentNode.insertBefore(w, t); w.appendChild(t);
    });
    docEl.querySelectorAll('a[href^="http"]').forEach(function (a) {
      a.target = '_blank'; a.rel = 'noopener noreferrer';
    });
  }

  var key = new URLSearchParams(location.search).get('doc') || 'storage';
  var meta = DOCS[key];
  if (!meta) { fail('没有这份说明文档。'); return; }

  titleEl.textContent = meta.title;
  document.title = meta.title + ' · Docsmith';

  /* 关键就在这里：自己 fetch 再按 UTF-8 解码，不让浏览器去猜编码。 */
  fetch(new URL('../../../docs/' + meta.file, location.href).href)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    })
    .then(function (buf) { render(new TextDecoder('utf-8').decode(buf)); })
    .catch(function (e) {
      fail('这份说明没能打开（' + esc(e.message) + '）。<br>'
        + '文档在扩展目录的 <code>docs/' + esc(meta.file) + '</code>，可以直接用记事本打开看。');
    });

  document.getElementById('backBtn').addEventListener('click', function () {
    if (history.length > 1) history.back();
    else window.close();
  });
})();
