/* =====================================================================
 * Docsmith · Markdown 文档图片适配器
 * ---------------------------------------------------------------------
 * 把已经由工作台净化、排版完成的 <article class="doc"> 变成一张 PNG。
 * 超长文档只在内部按连续纵向条带栅格化，再把像素流写进同一个 PNG；条带不是
 * 页面、文件或分享链接。这里统一处理图片固化、尺寸门禁和临时 DOM 生命周期，
 * 导出与分享只消费最终 Blob，不能各自再实现一套截图逻辑。
 *
 * 第三方 modern-screenshot 只藏在本适配器后面。它生成的 foreignObject SVG 是
 * 一次性的栅格化中间产物，从不进入文档 DOM、独立 HTML 或云端成品。
 * ===================================================================== */
(function (w) {
  'use strict';

  var VERSION = 'doc-image-v2';
  var MAX_SIDE = 8192;
  var MAX_PIXELS = 26e6;
  var DEFAULT_SCALE = 2;
  var RESOURCE_TIMEOUT = 30000;
  var URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  var CSS_IMAGE_PROPS = [
    'backgroundImage', 'borderImageSource', 'listStyleImage', 'maskImage',
    'webkitMaskImage', 'content'
  ];

  function emit(input, stage, current, total, message) {
    if (!input || typeof input.onProgress !== 'function') return;
    try {
      input.onProgress({
        stage: stage,
        current: current || 0,
        total: total || 0,
        message: message || ''
      });
    } catch (e) {}
  }

  function safeBaseName(value) {
    var name = String(value || 'document')
      .replace(/\.(?:md|markdown|mkd|mdx)$/i, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/, '')
      .slice(0, 120);
    return name || 'document';
  }

  function makeError(message, code, details) {
    var e = new Error(message);
    e.code = code || 'DOCUMENT_IMAGE_FAILED';
    if (details) e.details = details;
    return e;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () {
        reject(makeError('图片字节无法读取', 'ASSET_READ_FAILED'));
      };
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(value) {
    var match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(String(value || ''));
    if (!match) throw makeError('图片 data URL 无效', 'ASSET_DECODE_FAILED');
    var mime = match[1] || 'application/octet-stream';
    var raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(makeError((label || '资源') + '读取超时', 'ASSET_TIMEOUT'));
      }, ms || RESOURCE_TIMEOUT);
      Promise.resolve(promise).then(function (value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      }, function (reason) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(reason);
      });
    });
  }

  function decodeDataUrl(data, label) {
    return withTimeout(new Promise(function (resolve, reject) {
      var img = new Image();
      img.decoding = 'sync';
      img.onload = function () {
        if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) {
          reject(makeError((label || '图片') + '没有有效尺寸', 'ASSET_DECODE_FAILED'));
          return;
        }
        resolve();
      };
      img.onerror = function () {
        reject(makeError((label || '图片') + '无法解码', 'ASSET_DECODE_FAILED'));
      };
      img.src = data;
    }), RESOURCE_TIMEOUT, label || '图片');
  }

  function absoluteUrl(raw) {
    try { return new URL(raw, document.baseURI).href; }
    catch (e) { return String(raw || ''); }
  }

  function createAssetReader() {
    var cache = new Map();
    var failures = [];

    function rememberFailure(url, reason) {
      var message = (reason && reason.message) || String(reason || '读取失败');
      if (!failures.some(function (item) {
        return item.url === url && item.reason === message;
      })) failures.push({ url: url, reason: message });
    }

    async function read(rawUrl) {
      var url = absoluteUrl(rawUrl);
      if (!url) throw makeError('图片地址为空', 'ASSET_READ_FAILED');
      if (cache.has(url)) return cache.get(url);
      var task = (async function () {
        try {
          if (/^data:/i.test(url)) {
            var local = dataUrlToBlob(url);
            if (!/^image\//i.test(local.type || '')) {
              throw makeError('资源不是图片（' + (local.type || 'unknown') + '）', 'ASSET_TYPE_INVALID');
            }
            await decodeDataUrl(url, rawUrl);
            /* 浏览器会把相对 data: 中的 # 当作当前文档 fragment。读取结果统一
               转成 canonical data URL，避免 CSS url(data:image/svg+xml,...#...) 被
               absoluteUrl() 改写后内容或缓存键发生歧义。 */
            return blobToDataUrl(local);
          }
          var response = await withTimeout(fetch(url, {
            cache: 'force-cache',
            redirect: 'follow'
          }), RESOURCE_TIMEOUT, rawUrl);
          if (!response.ok) {
            throw makeError('图片请求失败（HTTP ' + response.status + '）', 'ASSET_HTTP_FAILED');
          }
          var blob = await response.blob();
          var type = String(blob.type || '').toLowerCase();
          if (!/^image\//.test(type)) {
            throw makeError('资源不是图片（' + (type || 'unknown') + '）', 'ASSET_TYPE_INVALID');
          }
          var data = await blobToDataUrl(blob);
          await decodeDataUrl(data, rawUrl);
          return data;
        } catch (reason) {
          rememberFailure(url, reason);
          throw reason;
        }
      })();
      cache.set(url, task);
      return task;
    }

    return { read: read, cache: cache, failures: failures };
  }

  function cssUrls(value) {
    var out = [];
    var match;
    URL_RE.lastIndex = 0;
    while ((match = URL_RE.exec(String(value || '')))) {
      var url = String(match[2] || '').trim();
      if (url && out.indexOf(url) < 0) out.push(url);
    }
    return out;
  }


  async function preflightCssImages(root, assets) {
    var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    var urls = [];
    var seen = new Set();
    nodes.forEach(function (node) {
      ['', '::before', '::after'].forEach(function (pseudo) {
        var style;
        try { style = getComputedStyle(node, pseudo || null); }
        catch (e) { return; }
        CSS_IMAGE_PROPS.forEach(function (prop) {
          cssUrls(style[prop]).forEach(function (url) {
            var abs = absoluteUrl(url);
            if (seen.has(abs)) return;
            seen.add(abs);
            urls.push(abs);
          });
        });
      });
    });
    var settled = await Promise.allSettled(urls.map(function (url) {
      return assets.read(url);
    }));
    if (settled.some(function (result) { return result.status === 'rejected'; })) {
      throw resourceError(assets.failures);
    }
  }

  function resourceError(failures) {
    var unique = [];
    failures.forEach(function (item) {
      if (!unique.some(function (known) { return known.url === item.url; })) unique.push(item);
    });
    var sample = unique.slice(0, 3).map(function (item) {
      var short = item.url.length > 100 ? item.url.slice(0, 97) + '…' : item.url;
      return short + '（' + item.reason + '）';
    }).join('；');
    var more = unique.length > 3 ? '；另有 ' + (unique.length - 3) + ' 项' : '';
    return makeError(
      '有 ' + unique.length + ' 张图片无法读取：' + sample + more,
      'ASSET_READ_FAILED',
      unique
    );
  }

  function scrub(root) {
    root.querySelectorAll('script,iframe,object,embed,link[rel="import"],meta[http-equiv]')
      .forEach(function (node) { node.remove(); });
    [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')))
      .forEach(function (node) {
        Array.prototype.slice.call(node.attributes || []).forEach(function (attr) {
          var name = attr.name.toLowerCase();
          var value = String(attr.value || '').trim();
          if (/^on/.test(name) || name === 'srcdoc') node.removeAttribute(attr.name);
          else if ((name === 'href' || name === 'src' || name === 'xlink:href')
              && /^(?:javascript|vbscript|data:text\/html)/i.test(value)) node.removeAttribute(attr.name);
          else if (name === 'style' && /url\(\s*['"]?(?:javascript|vbscript|data:text\/html)/i.test(value)) {
            node.removeAttribute(attr.name);
          }
        });
      });
  }

  function normalizeDiagrams(root) {
    root.querySelectorAll('.diagram-block').forEach(function (block) {
      block.dataset.view = 'diagram';
      var source = block.querySelector('.diagram-source');
      if (source) source.style.display = 'none';
      var render = block.querySelector('.diagram-render');
      if (render) render.style.display = 'block';
      var viewport = block.querySelector('.mm-viewport');
      var stage = block.querySelector('.mm-stage');
      var svg = stage && stage.querySelector('svg');
      if (viewport) {
        viewport.style.overflow = 'visible';
        viewport.style.height = 'auto';
        viewport.style.cursor = 'default';
      }
      if (stage) {
        stage.style.transform = 'none';
        stage.style.width = '100%';
        stage.classList.remove('is-interacting');
      }
      if (svg) {
        svg.style.display = 'block';
        svg.style.width = 'auto';
        svg.style.height = 'auto';
        svg.style.maxWidth = '100%';
        svg.style.margin = '0 auto';
      }
    });
  }

  function createHost(root, width) {
    var host = document.createElement('div');
    host.className = 'doc-image-capture';
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    host.style.width = Math.max(1, Number(width) || 860) + 'px';
    root.appendChild(host);
    return host;
  }

  function prepareArticle(article, input) {
    article.classList.add('doc-image-article');
    article.style.width = Math.max(1, Number(input.width) || 860) + 'px';
    article.style.maxWidth = 'none';
    article.style.margin = '0';
    article.style.minHeight = '0';
    article.style.background = input.background;
    normalizeDiagrams(article);
    scrub(article);
  }

  function articleHeight(article) {
    return Math.max(
      article.scrollHeight,
      article.getBoundingClientRect().height
    );
  }

  function createStrip(article, host, width, top, height, background) {
    var strip = document.createElement('div');
    strip.className = 'doc-image-strip';
    strip.style.width = width + 'px';
    strip.style.height = height + 'px';
    strip.style.background = background;
    strip.style.position = 'relative';
    strip.style.overflow = 'hidden';

    article.style.position = 'absolute';
    article.style.left = '0';
    article.style.top = (-top) + 'px';
    strip.appendChild(article);
    host.appendChild(strip);
    return strip;
  }

  function crcTable() {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  }

  var CRC_TABLE = crcTable();

  function crc32(parts) {
    var crc = 0xffffffff;
    parts.forEach(function (part) {
      for (var i = 0; i < part.length; i++) {
        crc = CRC_TABLE[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
      }
    });
    return (crc ^ 0xffffffff) >>> 0;
  }

  function ascii(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i);
    return out;
  }

  function pngChunk(type, data) {
    var kind = ascii(type);
    var out = new Uint8Array(12 + data.length);
    var view = new DataView(out.buffer);
    view.setUint32(0, data.length, false);
    out.set(kind, 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32([kind, data]), false);
    return out;
  }

  function pngHeader(width, height, scale) {
    var signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    var ihdr = new Uint8Array(13);
    var view = new DataView(ihdr.buffer);
    view.setUint32(0, width, false);
    view.setUint32(4, height, false);
    ihdr[8] = 8;   // 每通道 8 bit
    ihdr[9] = 6;   // RGBA

    var phys = new Uint8Array(9);
    var pv = new DataView(phys.buffer);
    var pixelsPerMetre = Math.round((96 * scale) / 0.0254);
    pv.setUint32(0, pixelsPerMetre, false);
    pv.setUint32(4, pixelsPerMetre, false);
    phys[8] = 1;
    return [signature, pngChunk('IHDR', ihdr), pngChunk('pHYs', phys)];
  }

  function createPngEncoder(width, height, scale) {
    var compression;
    try {
      compression = new CompressionStream('deflate');
    } catch (reason) {
      throw makeError(
        '当前浏览器不支持长图压缩，请升级 Chrome 或 Edge 后重试',
        'PNG_STREAM_UNSUPPORTED',
        reason
      );
    }
    var writer = compression.writable.getWriter();
    var reader = compression.readable.getReader();
    var compressed = [];
    var readTask = (async function () {
      while (true) {
        var item = await reader.read();
        if (item.done) break;
        if (item.value && item.value.length) compressed.push(item.value);
      }
    })();
    var rowsWritten = 0;

    async function writeRgba(rgba, rowBytes, rows) {
      if (rowBytes !== width * 4 || rgba.length !== rowBytes * rows) {
        throw makeError('内部条带像素尺寸不一致', 'STRIP_PIXEL_MISMATCH');
      }
      /* PNG 每行前面必须有一个 filter byte。这里用 None（0）：正文大面积
         同色区域仍会被 deflate 高效压缩，同时避免为上亿像素再做一轮逐字节
         滤波，降低峰值内存和生成耗时。每批只暂存约 256 KiB。 */
      var batchRows = Math.max(1, Math.floor(262144 / (rowBytes + 1)));
      for (var row = 0; row < rows; row += batchRows) {
        var count = Math.min(batchRows, rows - row);
        var batch = new Uint8Array((rowBytes + 1) * count);
        for (var local = 0; local < count; local++) {
          var source = (row + local) * rowBytes;
          var target = local * (rowBytes + 1) + 1;
          batch.set(rgba.subarray(source, source + rowBytes), target);
        }
        await writer.write(batch);
      }
      rowsWritten += rows;
    }

    async function finish() {
      await writer.close();
      await readTask;
      if (rowsWritten !== height) {
        throw makeError(
          '长图像素行不完整（' + rowsWritten + '/' + height + '）',
          'PNG_ROW_MISMATCH'
        );
      }
      var parts = pngHeader(width, height, scale);
      compressed.forEach(function (data) {
        parts.push(pngChunk('IDAT', data));
      });
      parts.push(pngChunk('IEND', new Uint8Array(0)));
      return new Blob(parts, { type: 'image/png' });
    }

    async function abort(reason) {
      try { await writer.abort(reason); } catch (e) {}
      try { await readTask; } catch (e) {}
    }

    return { writeRgba: writeRgba, finish: finish, abort: abort };
  }

  async function appendStrip(blob, width, height, encoder) {
    var bitmap;
    var canvas;
    try {
      bitmap = await createImageBitmap(blob);
      if (bitmap.width !== width || bitmap.height !== height) {
        throw makeError(
          '内部条带尺寸不一致（期望 ' + width + '×' + height
            + '，实际 ' + bitmap.width + '×' + bitmap.height + '）',
          'STRIP_SIZE_MISMATCH'
        );
      }
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      var context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw makeError('浏览器无法读取长图像素', 'CANVAS_CONTEXT_FAILED');
      context.drawImage(bitmap, 0, 0);
      var pixels = context.getImageData(0, 0, width, height);
      await encoder.writeRgba(pixels.data, width * 4, height);
    } finally {
      if (bitmap) bitmap.close();
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
  }

  function rasterOptions(assets, background, width, height, scale) {
    return {
      type: 'image/png',
      width: width,
      height: height,
      scale: scale,
      backgroundColor: background,
      maximumCanvasSize: MAX_SIDE,
      timeout: RESOURCE_TIMEOUT,
      fetchFn: function (url) { return assets.read(url); },
      fetch: {
        requestInit: { cache: 'force-cache' },
        placeholderImage: null
      },
      /* 页面已在 document.fonts.ready 后按本机真实字体完成布局。继续让
         rasterizer 重抓整份 @font-face 会连不存在的 woff/ttf 回退也排队，
         而且扩展合并模式下相对路径的基址不同。 */
      font: false,
      features: {
        copyScrollbar: false,
        restoreScrollPosition: false
      }
    };
  }

  async function digestText(text) {
    if (!(w.crypto && w.crypto.subtle && w.TextEncoder)) {
      return 'len-' + String(text || '').length;
    }
    var bytes = new TextEncoder().encode(String(text || ''));
    var hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.prototype.map.call(hash, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function validateInput(input) {
    if (!input || !input.root || !input.article) {
      throw makeError('图片生成缺少文档内容', 'NO_DOCUMENT');
    }
    if (!(w.modernScreenshot && typeof w.modernScreenshot.domToBlob === 'function')) {
      throw makeError('文档图片组件没有加载成功，其他导出格式仍可使用', 'RASTERIZER_MISSING');
    }
  }

  async function build(input) {
    validateInput(input);
    var scale = Number(input.scale) || DEFAULT_SCALE;
    if (!(scale > 0 && scale <= 2)) scale = DEFAULT_SCALE;
    var background = input.background || '#fff';
    var base = safeBaseName(input.name);
    var host = createHost(input.root, input.width);
    var article = input.article;
    var assets = createAssetReader();
    var encoder = null;
    try {
      prepareArticle(article, input);
      host.appendChild(article);
      emit(input, 'assets', 0, 0, '正在准备图片…');
      var elementImages = Array.prototype.slice.call(article.querySelectorAll('img,svg image'));
      var elementResults = await Promise.allSettled(elementImages.map(function (node) {
        var isSvgImage = node.namespaceURI === 'http://www.w3.org/2000/svg';
        var raw = isSvgImage
          ? (node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '')
          : (node.currentSrc || node.getAttribute('src') || '');
        if (!raw) return Promise.resolve();
        return assets.read(raw).then(function (data) {
          if (isSvgImage) {
            node.setAttribute('href', data);
            node.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
          } else {
            node.removeAttribute('srcset');
            node.removeAttribute('sizes');
            node.removeAttribute('loading');
            node.setAttribute('src', data);
            return decodeDataUrl(data, raw);
          }
        });
      }));
      if (elementResults.some(function (result) { return result.status === 'rejected'; })) {
        throw resourceError(assets.failures);
      }
      await preflightCssImages(article, assets);
      if (assets.failures.length) throw resourceError(assets.failures);

      /* CSS 背景图 / mask / 伪元素不会像 <img> 一样被改成 data URL。给
         rasterizer 的 fetchFn 能提供已验证字节，但要先等待所有资源 settle。 */
      var pendingAssets = await Promise.allSettled(Array.from(assets.cache.values()));
      if (pendingAssets.some(function (result) { return result.status === 'rejected'; })
          || assets.failures.length) throw resourceError(assets.failures);

      var cssWidth = Math.ceil(Math.max(
        article.scrollWidth,
        article.getBoundingClientRect().width
      ));
      var cssHeight = articleHeight(article);
      if (!(cssWidth > 0 && cssHeight > 0)) {
        throw makeError('文档尺寸无效，无法生成图片', 'INVALID_DIMENSIONS');
      }
      var outputWidth = Math.ceil(cssWidth * scale);
      var outputHeight = Math.ceil(cssHeight * scale);
      if (outputWidth > MAX_SIDE) {
        throw makeError('当前阅读宽度过大，图片会超过浏览器上限', 'DOCUMENT_TOO_WIDE');
      }
      if (outputHeight > 0x7fffffff || outputWidth * outputHeight > 500e6) {
        throw makeError('文档过长，最终图片超过 5 亿像素，无法安全生成', 'DOCUMENT_TOO_LONG');
      }
      var stripPixelHeight = Math.min(
        MAX_SIDE,
        Math.floor(MAX_PIXELS / outputWidth)
      );
      if (!(stripPixelHeight >= 200)) {
        throw makeError('当前阅读宽度下内部栅格高度不足，请调窄版心后重试', 'DOCUMENT_TOO_WIDE');
      }
      var stripCount = Math.ceil(outputHeight / stripPixelHeight);
      encoder = createPngEncoder(outputWidth, outputHeight, scale);

      for (var i = 0, pixelTop = 0; pixelTop < outputHeight; i++) {
        var pixelHeight = Math.min(stripPixelHeight, outputHeight - pixelTop);
        var cssTop = pixelTop / scale;
        var stripCssHeight = pixelHeight / scale;
        var strip = createStrip(
          article,
          host,
          cssWidth,
          cssTop,
          stripCssHeight,
          background
        );
        emit(input, 'render', i + 1, stripCount,
          '正在生成整张图片 · ' + (i + 1) + '/' + stripCount + '…');
        var raster;
        try {
          raster = await w.modernScreenshot.domToBlob(
            strip,
            rasterOptions(assets, background, cssWidth, stripCssHeight, scale)
          );
          if (!raster || raster.type !== 'image/png' || raster.size < 32) {
            throw makeError('内部条带没有生成有效像素', 'STRIP_ENCODE_FAILED');
          }
          await appendStrip(raster, outputWidth, pixelHeight, encoder);
        } catch (reason) {
          throw makeError(
            '整图第 ' + (i + 1) + '/' + stripCount + ' 段栅格化失败：'
              + ((reason && reason.message) || '未知错误'),
            'RASTERIZE_FAILED',
            reason
          );
        } finally {
          if (strip.contains(article)) strip.removeChild(article);
          strip.remove();
        }
        pixelTop += pixelHeight;
      }

      emit(input, 'assemble', stripCount, stripCount, '正在合成一张 PNG…');
      var blob = await encoder.finish();
      encoder = null;
      if (!blob || blob.type !== 'image/png' || blob.size < 32) {
        throw makeError('没有生成有效 PNG', 'PNG_ENCODE_FAILED');
      }
      var assetSignature = [];
      for (var entry of assets.cache.entries()) {
        try { assetSignature.push(entry[0] + '|' + await entry[1]); }
        catch (e) {}
      }
      return {
        blob: blob,
        width: outputWidth,
        height: outputHeight,
        filename: base + '.png',
        scale: scale,
        mode: 'single',
        warnings: [],
        assetDigest: await digestText(assetSignature.sort().join('||')),
        contractVersion: VERSION,
        maxSide: MAX_SIDE,
        maxPixels: MAX_PIXELS
      };
    } catch (reason) {
      if (encoder) await encoder.abort(reason);
      if (assets.failures.length && (!reason || reason.code !== 'ASSET_READ_FAILED')) {
        throw resourceError(assets.failures);
      }
      throw reason;
    } finally {
      try { host.remove(); } catch (e) {}
    }
  }

  w.DocsmithDocumentImage = {
    version: VERSION,
    build: build,
    safeBaseName: safeBaseName,
    limits: {
      maxSide: MAX_SIDE,
      maxPixels: MAX_PIXELS,
      scale: DEFAULT_SCALE
    }
  };
})(window);
