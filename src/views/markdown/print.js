/* Extension-created blob pages cannot execute even packaged scripts under CSP.
   The packaged print page reads only a same-origin, short-lived document blob. */
(function () {
  function printWhenReady() {
    var printed = false, timer;
    function print() {
      if (printed) return;
      printed = true;
      clearTimeout(timer);
      window.print();
    }
    timer = setTimeout(print, 1200);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(print, print);
    else print();
  }
  async function prepare() {
    try {
      var source = new URLSearchParams(location.search).get('document');
      if (source) {
        var prefix = 'blob:' + location.protocol + '//' + location.host + '/';
        if (source.indexOf(prefix) !== 0) throw new Error('打印文档来源无效');
        var response = await fetch(source);
        if (!response.ok) throw new Error('打印文档已失效，请重新导出');
        var doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        var article = doc.querySelector('article.doc');
        if (!article) throw new Error('打印文档缺少正文');
        document.title = doc.title;
        document.documentElement.dataset.theme = doc.documentElement.dataset.theme;
        doc.head.querySelectorAll('style').forEach(function (style) { document.head.appendChild(style); });
        document.body.replaceChildren(article);
        await Promise.all(Array.from(document.images).map(function (image) {
          return image.decode().catch(function () { throw new Error('正文图片未能加载，请返回文档检查后重试'); });
        }));
      }
      printWhenReady();
    } catch (error) {
      document.body.textContent = '准备打印失败：' + error.message;
    }
  }
  if (document.readyState === 'complete') prepare();
  else window.addEventListener('load', prepare, { once: true });
})();
