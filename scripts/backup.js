/* =====================================================================
 * Docsmith · 备份与还原（给不敲命令的人用）
 * ---------------------------------------------------------------------
 * 为什么要有这个文件：
 * 这个项目没有构建系统，所有代码都是直接改、直接生效。好处是简单，
 * 坏处是**改坏了没有退路** —— 用户明确提过这个担心：
 * 「避免改动代码导致之前的代码改错了回不去」。
 *
 * 两层保护，各管一件事：
 *
 *   第一层 · Git（精确，但要敲命令）
 *     项目里已经 git init 过了。它能回退**单个文件**、能看每次改了哪几行。
 *     出问题时最好用它。常用三条写在 docs/03-备份与还原.md 里。
 *
 *   第二层 · 这个脚本（傻瓜式，双击就行）
 *     把整个项目打包成一个带日期的 .zip，放到项目**外面**的
 *     `_docsmith 备份/` 里。不依赖 git、不依赖网络，出事了解压覆盖就回去了。
 *
 * 用法（Windows，双击 backup.cmd 即可，或者在命令行里）：
 *     node scripts/backup.js            备份一份
 *     node scripts/backup.js --list     看有哪些备份
 *
 * 刻意不做的事：
 *   · 不自动删旧备份。磁盘几 MB 的事，宁可留着。要清就自己去文件夹删。
 *   · 不写还原功能。还原就是「解压 → 覆盖」，用资源管理器做比脚本可靠，
 *     而且不会因为脚本有 bug 把好文件也冲掉。
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
/* 备份放项目外面 —— 放里面的话，下一次备份会把上一次的包也打进去，
   越备越大；而且删项目文件夹时会把备份一起删掉。 */
const OUT_DIR = path.join(path.dirname(ROOT), '_docsmith 备份');

/* 不进备份包的东西。vendor 要留着（那是运行必需的库，1.5MB 而已），
   .git 不留（它自己就是历史，而且体积会越来越大）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '_docsmith 备份']);
const SKIP_FILE = (rel) =>
  /(^|[\\/])__.*\.html$/.test(rel) ||        // 测试探针页
  /\.zip$/i.test(rel) ||
  /(^|[\\/])(Thumbs\.db|desktop\.ini|\.DS_Store)$/i.test(rel);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version || '0.0.0';
  } catch (e) { return '0.0.0'; }
}

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(base, abs);
    let st;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(abs, base, out);
    } else if (st.isFile() && !SKIP_FILE(rel)) {
      out.push(rel);
    }
  }
  return out;
}

function list() {
  if (!fs.existsSync(OUT_DIR)) { console.log('还没有任何备份。'); return; }
  const items = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.zip')).sort().reverse();
  if (!items.length) { console.log('备份文件夹是空的。'); return; }
  console.log(`备份都在这里：${OUT_DIR}\n`);
  for (const f of items) {
    const kb = Math.round(fs.statSync(path.join(OUT_DIR, f)).size / 1024);
    console.log(`  ${f}   ${kb} KB`);
  }
  console.log(`\n共 ${items.length} 份。要还原：解压其中一个，把里面的文件覆盖回项目文件夹。`);
}

/* WSL 里跑的时候，Node 看到的是 /mnt/e/… 这种路径，而 PowerShell 是
   **Windows 进程**，它只认 E:\… —— 直接把 WSL 路径传过去会报
   「找不到路径」。用 wslpath 转一下。
   在真 Windows 上（不是 WSL）没有 wslpath，也不需要转，原样返回。 */
function toWin(p) {
  if (!/^\/mnt\/[a-z]\//.test(p)) return p;
  try {
    return execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
  } catch (e) {
    // 兜底：/mnt/e/foo → E:\foo
    return p.replace(/^\/mnt\/([a-z])\//, (m, d) => d.toUpperCase() + ':\\').replace(/\//g, '\\');
  }
}

function backup() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = walk(ROOT, ROOT, []);
  const name = `docsmith_v${version()}_${stamp()}.zip`;
  const dest = path.join(OUT_DIR, name);

  /* ⚠ 这一段踩过两个坑，都是"不验证就发现不了"的那种，别改回去：

     坑一：`Compress-Archive -LiteralPath <一串文件>` 会把文件**拍平**塞进包
     根目录 —— 103 个条目全在根上，`src/app/main.js` 和另外几个同名的
     main.js 互相覆盖，解压回去项目结构就砸了。它不报错。

     坑二：改成先复制到临时目录再整目录打包，结构是对了，但
     Compress-Archive 写出来的条目名用的是**反斜杠**（`src\\app\\index.html`）。
     ZIP 规范要求用正斜杠。Windows 资源管理器能容忍，但 Python 的 zipfile、
     很多解压工具、以及别的系统都不认 —— 表现是"解压后目录是空的"，
     文件明明在包里却出不来。备份最怕的就是这个：出事那天才发现解不开。

     所以现在自己写 ZIP：只用「存储」（不压缩）+ 正斜杠路径 + UTF-8 标记。
     不压缩换来的是零依赖、零歧义 —— 这个项目 2.8MB，包大一点无所谓，
     解得开才是第一位的。（项目里那个 zip-writer.js 是给浏览器用的，
     依赖 CompressionStream，Node 里不能直接复用。） */
  try {
    writeStoredZip(dest, ROOT, files);
  } catch (e) {
    console.error('打包失败了。');
    console.error(String(e.message).slice(0, 800));
    console.error('\n退一步的办法：直接把整个项目文件夹复制一份，改名带上日期。一样管用。');
    process.exit(1);
  }

  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log('备份好了。\n');
  console.log(`  文件：${name}`);
  console.log(`  位置：${OUT_DIR}`);
  console.log(`  大小：${kb} KB（${files.length} 个文件）\n`);
  console.log('要还原的话：解压这个包，把里面的文件覆盖回项目文件夹就行。');
}

/* ---------------------------------------------------------------- ZIP
   最小可用的 ZIP 写入器：method 0（只存不压）。
   格式就是「每个文件一个本地头 + 原始字节」，最后跟一份中央目录。
   刻意不压缩：省掉 zlib 依赖和一切参数，出来的包任何工具都解得开。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
}

function writeStoredZip(dest, root, relFiles) {
  const now = new Date();
  const tm = dosTime(now), dt = dosDate(now);
  const parts = [], central = [];
  let offset = 0;

  for (const rel of relFiles) {
    /* ZIP 里的路径**必须**用正斜杠（规范 4.4.17.1）。这也是上面坑二的修法。 */
    const nameBuf = Buffer.from(rel.split(path.sep).join('/').replace(/\\/g, '/'), 'utf8');
    const data = fs.readFileSync(path.join(root, rel));
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // 本地头签名
    lh.writeUInt16LE(20, 4);           // 需要的版本
    lh.writeUInt16LE(0x0800, 6);       // bit 11 = 文件名是 UTF-8（中文名靠它）
    lh.writeUInt16LE(0, 8);            // method 0 = 只存不压
    lh.writeUInt16LE(tm, 10);
    lh.writeUInt16LE(dt, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // 中央目录签名
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(tm, 12);
    ch.writeUInt16LE(dt, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(relFiles.length, 8);
  end.writeUInt16LE(relFiles.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(dest, Buffer.concat([Buffer.concat(parts), centralBuf, end]));
}

if (process.argv.includes('--list')) list();
else backup();
