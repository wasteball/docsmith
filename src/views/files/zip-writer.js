/* =====================================================================
   Docsmith · 自带 ZIP 打包器
   ---------------------------------------------------------------------
   为什么要自己写：批量下载原来指望 JSZip，而 JSZip 是运行时从 cdnjs 拉的
   一个 <script>。这条路在 Chrome 扩展里根本走不通 ——

     · manifest 的 CSP 写的是 script-src 'self'
     · MV3 本身就禁止加载远端代码（不是网络问题，是规则问题）

   所以那句 s.onerror 每次都会触发，用户看到的是「JSZip 加载失败（检查
   网络）」—— 网络再好也一样失败，提示还把人往错的方向引。打包按钮等于
   一直是坏的。

   docx.umd.js 里其实打包了一份 JSZip，但它没有 export 出来（footer 的
   exports 列表里没有），够不着。

   于是照着 aliyun-sign.js 的路子办：ZIP 这个格式本身很朴素，压缩交给
   浏览器自带的 CompressionStream('deflate-raw')，剩下的就是拼头部字节。
   不依赖任何第三方库，离线可用，也不碰 CSP。

   只写 ZIP，不读 ZIP。够用就行。
   ===================================================================== */
(function () {
  'use strict';

  /* ---- CRC-32（ZIP 每个条目都要带一个，用来校验解压结果） ---- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* deflate-raw 正是 ZIP 的 method 8 要的裸 deflate 流（不带 zlib 头）。
     Chrome 103+ 有；万一没有就退回 method 0「只存不压」——
     文件还是全的，只是 ZIP 体积等于原始体积。 */
  var CAN_DEFLATE = (function () {
    try { new CompressionStream('deflate-raw'); return true; }
    catch (e) { return false; }
  })();

  async function deflateRaw(u8) {
    var stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ZIP 存的是 1980 年纪元的 DOS 时间戳，得手动打包成两个 16 位数 */
  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  }
  function dosDate(d) {
    var y = d.getFullYear() < 1980 ? 1980 : d.getFullYear();
    return (((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  var MAX_U32 = 0xFFFFFFFF;
  var MAX_ENTRIES = 0xFFFF;   // 中央目录条目数是 16 位；再多就得上 ZIP64

  /**
   * entries: [{ path: 'a/b.md', data: ArrayBuffer|Uint8Array }]
   * onProgress: (done, total) => void
   * → Promise<Blob>
   */
  async function createZip(entries, onProgress) {
    entries = entries || [];
    if (entries.length > MAX_ENTRIES) {
      throw new Error('一个压缩包最多放 ' + MAX_ENTRIES + ' 个文件，请分批打包。');
    }

    var enc = new TextEncoder();
    var now = new Date();
    var tm = dosTime(now), dt = dosDate(now);

    var parts = [];      // 本地头 + 数据，按顺序拼
    var central = [];    // 中央目录，全部条目写完后追加在末尾
    var offset = 0;      // 当前条目的本地头在文件里的偏移
    var total = entries.length;

    for (var i = 0; i < total; i++) {
      var e = entries[i];
      /* 文件名一律按 UTF-8 编码，并在通用标志位上打开 bit 11（0x0800）
         告诉解压程序「名字是 UTF-8」。不打这一位，中文名在 Windows
         自带的解压里就是一堆乱码。 */
      var nameBytes = enc.encode(e.path);
      var raw = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
      var crc = crc32(raw);

      var method = 0, body = raw;
      /* 太小的文件压了往往更大（deflate 有固定开销），也就不折腾了。
         压完反而变大的同样退回存原样。 */
      if (CAN_DEFLATE && raw.length > 64) {
        try {
          var z = await deflateRaw(raw);
          if (z.length < raw.length) { method = 8; body = z; }
        } catch (err) { /* 压不动就存原样，不因为压缩失败丢文件 */ }
      }

      if (offset + 30 + nameBytes.length + body.length > MAX_U32) {
        throw new Error('压缩包超过 4GB 上限，请分批打包。');
      }

      var lh = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);   // 本地文件头签名
      lv.setUint16(4, 20, true);           // 解压所需版本 2.0
      lv.setUint16(6, 0x0800, true);       // 通用标志位：文件名是 UTF-8
      lv.setUint16(8, method, true);
      lv.setUint16(10, tm, true);
      lv.setUint16(12, dt, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, body.length, true); // 压缩后大小
      lv.setUint32(22, raw.length, true);  // 原始大小
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);           // 扩展字段长度
      lh.set(nameBytes, 30);
      parts.push(lh, body);

      var ch = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);   // 中央目录条目签名
      cv.setUint16(4, 20, true);           // 生成者版本
      cv.setUint16(6, 20, true);           // 解压所需版本
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, tm, true);
      cv.setUint16(14, dt, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, body.length, true);
      cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);           // 扩展字段
      cv.setUint16(32, 0, true);           // 注释
      cv.setUint16(34, 0, true);           // 起始磁盘号
      cv.setUint16(36, 0, true);           // 内部属性
      cv.setUint32(38, 0, true);           // 外部属性
      cv.setUint32(42, offset, true);      // 对应本地头的偏移
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + body.length;
      if (onProgress) onProgress(i + 1, total);
    }

    var cdSize = central.reduce(function (n, c) { return n + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);     // 中央目录结束记录
    ev.setUint16(4, 0, true);              // 本磁盘号
    ev.setUint16(6, 0, true);              // 中央目录起始磁盘号
    ev.setUint16(8, central.length, true); // 本磁盘条目数
    ev.setUint16(10, central.length, true);// 总条目数
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);        // 中央目录偏移
    ev.setUint16(20, 0, true);             // 注释长度

    return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
  }

  window.DSZip = { createZip: createZip, canDeflate: CAN_DEFLATE };
})();
