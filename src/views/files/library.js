
const STORAGE_KEY = 'docsmith:library';

/* 这里没有任何默认的服务器地址或账号 —— 云存储的配置由用户在设置里填，
   存在他自己的电脑上。文件库只管记录和展示。 */
const defaultPreset = () => ({
  autoCopy: 'true',
  concurrency: '2',
});

const UNCAT = '__uncat__';

/* 找不到节点时返回它：吸收掉所有读写，不抛异常。
   为什么需要 —— 设置抽屉已经搬进统一的设置面板，这个文件里还有几十处
   代码在给那些节点赋值。一处漏判就中断整个初始化。 */
const NOOP_EL = new Proxy({
  classList: { add() {}, remove() {}, toggle: () => false, contains: () => false },
  dataset: {}, style: {}, children: [], options: [], files: [],
  value: '', textContent: '', innerHTML: '', checked: false, disabled: false, hidden: false,
  __missing__: true,
}, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'symbol') return undefined;
    return () => NOOP_EL;
  },
  set(t, k, v) { t[k] = v; return true; },
});

/* 全文件统一用它取节点。
   ⚠ 从**文件库自己的根容器**里找，不用 document.getElementById ——
   外壳也有一个 id="toasts"（它自己的 toast 容器），而 getElementById 返回
   文档里先出现的那一个。合并进外壳后 el('toasts') 会拿到外壳那个，
   于是上传进度条跑到外壳的 toast 区去了，样式还是文件库的，看着就是错位。
   独立打开这一页时 libRoot() 就是 body，行为和原来一致。 */
function el(id) {
  return libRoot().querySelector('#' + id) || NOOP_EL;
}

/* 本能力的根容器 —— 既用来限定上面 el() 的查找范围，也用来回答
   「文件库现在是不是显示着的那个」（window 级快捷键靠它决定要不要响应，
   见 bind() 里的 active()，以及 views/shared/active.js）。
   独立打开这一页时就是 <body>；被外壳合并进来时是标了
   data-ds-host="files" 的那个容器。 */
function libRoot() {
  return document.querySelector('[data-ds-host="files"]') || document.body;
}

/* 有些界面节点已经随设置抽屉一起删掉了，但旧代码还在给它们赋值。
   在迁移彻底完成之前，用这个函数挡一道 —— 节点不在就什么都不做，
   而不是抛异常把后面的初始化全带崩。 */
function safeSet(id, prop, value) {
  const el = document.getElementById(id);
  if (el) el[prop] = value;
  return value;
}

/* 上传相关的三项设置 —— 传完自动复制、同时上传几个、分享文案格式 ——
   现在统一归全局设置面板管（core/prefs.js，存在 docsmith:prefs）。文件库
   只读取，不再自己存一份。用户在设置里一改，DSPrefs 的缓存会被 storage
   事件冲掉，这里下次读就是新值，不存在两套设置各说各话的老问题。 */
function pref(key, fallback) {
  return (window.DSPrefs && typeof window.DSPrefs.get === 'function')
    ? window.DSPrefs.get(key, fallback) : fallback;
}
function prefConcurrency() {
  const n = parseInt(pref('files.concurrency', 2), 10);
  return (n >= 1 && n <= 12) ? n : 2;
}
function prefAutoCopy() {
  const v = pref('files.autoCopy', true);
  return v === true || v === 'true' || v === 1 || v === '1';
}

const defaultCategories = () => ([{ id: UNCAT, name: '未分类' }]);

/* ===== Auto file-kind detection (attribute tags, derived from extension) =====
   区别于用户手动指定的「分类」，这些是根据文件后缀自动识别的属性标签，用于快速过滤。 */
const FILE_KINDS = [
  { id: 'image',   label: '图片',   exts: ['jpg','jpeg','png','gif','webp','bmp','svg','ico','tiff','tif','heic','heif','avif','raw'] },
  { id: 'doc',     label: '文档',   exts: ['doc','docx','pdf','txt','md','markdown','rtf','odt','pages','wps','tex','epub'] },
  { id: 'sheet',   label: '表格',   exts: ['xls','xlsx','xlsm','csv','tsv','ods','numbers'] },
  { id: 'slide',   label: '演示',   exts: ['ppt','pptx','pps','ppsx','key','odp'] },
  { id: 'video',   label: '视频',   exts: ['mp4','mov','avi','mkv','webm','flv','wmv','m4v','mpeg','mpg','3gp','ts'] },
  { id: 'audio',   label: '音频',   exts: ['mp3','wav','flac','aac','ogg','m4a','wma','opus','aiff','amr'] },
  { id: 'archive', label: '压缩包', exts: ['zip','rar','7z','tar','gz','bz2','xz','tgz','z'] },
  { id: 'code',    label: '代码',   exts: ['js','mjs','ts','jsx','tsx','py','java','c','cpp','cc','h','hpp','go','rs','rb','php','swift','kt','html','htm','css','scss','less','json','xml','yml','yaml','toml','ini','sh','bat','ps1','sql','vue','r','lua','pl','dart'] },
];
const EXT_TO_KIND = {};
FILE_KINDS.forEach(k => k.exts.forEach(e => { EXT_TO_KIND[e] = k.id; }));
const KIND_LABEL = { other: '其他' };
FILE_KINDS.forEach(k => { KIND_LABEL[k.id] = k.label; });
const KIND_COLOR = {
  image: '#10b981', doc: '#3b82f6', sheet: '#22c55e', slide: '#f97316',
  video: '#8b5cf6', audio: '#ec4899', archive: '#eab308', code: '#06b6d4', other: '#8e8e98',
};
const KIND_IDS = new Set(['all', 'other', ...FILE_KINDS.map(k => k.id)]);
function fileKind(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i < 0) return 'other';
  return EXT_TO_KIND[s.slice(i + 1).toLowerCase()] || 'other';
}

let state = {
  presets: { default: defaultPreset() },
  activePreset: 'default',
  history: [],
  categories: defaultCategories(), // [{id, name}] — first is the locked "未分类"
  historyFilter: 'all',            // 'all' | categoryId
  typeFilter: 'all',               // 'all' | kindId (auto-detected file kind)
  uploadCategory: UNCAT,           // category assigned to newly uploaded files
  // theme / accent 已迁出 —— 见顶部 Appearance 模块（docsmith:appearance）。
  // 曾经它们住在这里，于是任何一次 saveState() 都会把别的工具刚切好的主题
  // 用本页的旧快照覆盖回去，再经 storage 事件广播成一次全局闪屏。
  shareFormat: 'name_url',// name_url | markdown | inline | url
  searchQuery: '',        // 搜索框里的字（只在内存里，不持久化 —— 下次打开该看全部）
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch (e) {}
  delete state.theme; delete state.accent;   // 外观不再进内存 state，避免旧值回写
  state.searchQuery = '';                    // 每次打开都从「显示全部」开始
  if (!state.presets || !Object.keys(state.presets).length) {
    state.presets = { default: defaultPreset() };
    state.activePreset = 'default';
  }
  if (!state.presets[state.activePreset]) state.activePreset = Object.keys(state.presets)[0];
  Object.keys(state.presets).forEach(k => {
    state.presets[k] = { ...defaultPreset(), ...state.presets[k] };
  });

  // ---- categories migration ----
  if (!Array.isArray(state.categories) || !state.categories.length) {
    state.categories = defaultCategories();
  }
  // ensure the locked "未分类" always exists and sits first
  if (!state.categories.some(c => c.id === UNCAT)) {
    state.categories.unshift({ id: UNCAT, name: '未分类' });
  }
  const catIds = new Set(state.categories.map(c => c.id));
  if (!catIds.has(state.uploadCategory)) state.uploadCategory = UNCAT;
  if (state.historyFilter !== 'all' && !catIds.has(state.historyFilter)) state.historyFilter = 'all';
  if (!KIND_IDS.has(state.typeFilter)) state.typeFilter = 'all';
  // backfill category on existing history records
  state.history.forEach(h => { if (!h.category || !catIds.has(h.category)) h.category = UNCAT; });

  migratePrefsOnce();
}

/* 一次性搬家：上传偏好（自动复制、并发数、分享格式）以前存在本页的
   docsmith:library 里，现在归全局设置面板（docsmith:prefs）。老用户升级后
   第一次打开，把他们原来的选择搬过去，之后就只认全局那份。
   只在全局那项还没被显式设过时才搬，绝不覆盖用户后来在面板里改的值。 */
function migratePrefsOnce() {
  const P = window.DSPrefs;
  if (!P || !P.get || !P.set) return;
  const done = P.get('files.migratedFromLibrary', false);
  if (done) return;

  const preset = state.presets[state.activePreset] || {};
  if (P.get('files.autoCopy', undefined) === undefined && preset.autoCopy !== undefined) {
    P.set('files.autoCopy', preset.autoCopy === 'true' || preset.autoCopy === true);
  }
  if (P.get('files.concurrency', undefined) === undefined && preset.concurrency) {
    const n = parseInt(preset.concurrency, 10);
    if (n >= 1 && n <= 12) P.set('files.concurrency', n);
  }
  if (P.get('share.format', undefined) === undefined && state.shareFormat) {
    P.set('share.format', state.shareFormat);
  }
  // 老的下载格式偏好 state.dlPrefs → files.dlMarkdown / files.dlPptx
  const dl = state.dlPrefs || {};
  if (P.get('files.dlMarkdown', undefined) === undefined && dl.md) P.set('files.dlMarkdown', dl.md);
  if (P.get('files.dlPptx', undefined) === undefined && dl.ppt) P.set('files.dlPptx', dl.ppt);

  P.set('files.migratedFromLibrary', true);
}

function catName(id) {
  const c = (state.categories || []).find(x => x.id === id);
  return c ? c.name : '未分类';
}
function catUid() { return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
/* 三个筛选条件叠在一起：分类、类型、搜索词。
   搜索按「文件名 + 所在目录」匹配，不区分大小写 —— 记录攒到几十条以后
   靠分类翻找就慢了，直接打几个字最快。
   注意 searchQuery 由 wire-up.js 写入（搜索框在那边绑的），所以文件末尾
   必须把 state 挂到 window 上，否则那边写的是另一个不存在的对象。 */
function visibleHistory() {
  let arr = state.history;
  if (state.historyFilter !== 'all') arr = arr.filter(h => (h.category || UNCAT) === state.historyFilter);
  if (state.typeFilter && state.typeFilter !== 'all') arr = arr.filter(h => fileKind(h.fileName) === state.typeFilter);
  const q = String(state.searchQuery || '').trim().toLowerCase();
  if (q) {
    arr = arr.filter(h =>
      String(h.fileName || '').toLowerCase().includes(q)
      || String(h.relPath || '').toLowerCase().includes(q));
  }
  return arr;
}

/* 读-合-写。两层保险：
   ① 先把磁盘上的最新值读回来再叠加本页 state —— 不会抹掉别的工具（Markdown
      工作台 / 外壳）在本页加载之后写入的字段；
   ② theme / accent 连带剔除 —— 它们已迁到 docsmith:appearance。 */
function saveState() {
  try {
    let disk = {};
    try { disk = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (e) {}
    const mine = { ...state };
    delete mine.theme; delete mine.accent;
    /* 搜索词不落盘：它是「此刻正在找什么」，不是偏好。存下来的话，
       下次打开文件库会莫名只显示一部分文件，而搜索框看着是空的。 */
    delete mine.searchQuery;
    delete disk.theme; delete disk.accent; delete disk.searchQuery;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...disk, ...mine }));
    flashSaveIndicator();
  } catch (e) { toast('保存失败: ' + e.message, 'error'); }
}

/* Pull history/categories back in when another tab (e.g. the Markdown→Word tool,
   same origin, shared localStorage) writes new records. Config/presets untouched
   so in-progress edits and uploads aren't disturbed. */
function syncFromStorage() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { return; }
  if (!s || typeof s !== 'object') return;

  let changed = false;
  if (Array.isArray(s.categories) &&
      JSON.stringify(s.categories) !== JSON.stringify(state.categories)) {
    state.categories = s.categories; changed = true;
  }
  if (Array.isArray(s.history)) {
    const a = state.history, b = s.history;
    const diff = a.length !== b.length || (b[0] ? (!a[0] || a[0].id !== b[0].id) : !!a[0]);
    if (diff) { state.history = b; changed = true; }
  }
  if (!changed) return;

  // light re-validation, mirroring loadState's category backfill
  if (!state.categories.some(c => c.id === UNCAT)) state.categories.unshift({ id: UNCAT, name: '未分类' });
  const catIds = new Set(state.categories.map(c => c.id));
  state.history.forEach(h => { if (!h.category || !catIds.has(h.category)) h.category = UNCAT; });
  if (state.historyFilter !== 'all' && !catIds.has(state.historyFilter)) state.historyFilter = 'all';

  renderCatFilter();
  renderUploadCategorySelect();
  renderBatchMoveSelect();
  renderHistory();
}

function cfg() { return state.presets[state.activePreset]; }

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}
function fmtTime(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fileExt(n) {
  const i = n.lastIndexOf('.');
  return i < 0 ? 'FILE' : n.slice(i + 1).toUpperCase().slice(0, 4);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function isConfigIncomplete() {
  return !DSCloud.ready();
}

/* 注意这里的局部变量**不能**叫 el —— 文件级有个 el(id) 取节点的函数，
   同名局部 const 会把它在整个函数体里遮蔽掉，于是上一行的 el('toasts')
   撞进 TDZ，抛 ReferenceError。而 toast 本身正是各处 catch 用来报错的出口，
   它一抛，错误就再也没人看得见了。 */
function toast(msg, type = 'info', duration = 2400) {
  const c = el('toasts');
  const box = document.createElement('div');
  box.className = 'toast ' + type;
  box.textContent = msg;
  c.appendChild(box);
  setTimeout(() => {
    box.classList.add('fading');
    setTimeout(() => box.remove(), 200);
  }, duration);
}

let saveIndicatorTimer;
/* 同上：局部变量别叫 el。这个函数是 saveState() 的最后一步，它一抛错，
   调用方后面的 renderCatFilter() / renderHistory() 就全都执行不到 ——
   表现就是「分类和类型筛选点了没反应」（状态其实改了也存了，
   刷新页面就能看到筛选生效，这正是当时的诊断线索）。 */
function flashSaveIndicator() {
  const node = el('save-indicator');
  if (!node) return;
  node.classList.add('show');
  clearTimeout(saveIndicatorTimer);
  saveIndicatorTimer = setTimeout(() => node.classList.remove('show'), 1200);
}

function modalPrompt(title, defaultValue = '') {
  return new Promise(resolve => {
    const m = el('modal');
    el('modal-title').textContent = title;
    const input = el('modal-input');
    input.value = defaultValue;
    m.classList.add('show');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const ok = el('modal-ok');
    const cancel = el('modal-cancel');
    const cleanup = () => { m.classList.remove('show'); ok.onclick = null; cancel.onclick = null; input.onkeydown = null; };
    ok.onclick = () => { const v = input.value.trim(); cleanup(); resolve(v || null); };
    cancel.onclick = () => { cleanup(); resolve(null); };
    input.onkeydown = e => { if (e.key === 'Enter') ok.onclick(); if (e.key === 'Escape') cancel.onclick(); };
  });
}

function copyText(text, silent = false) {
  const done = () => { if (!silent) toast('已复制', 'success', 1500); };
  const fail = () => toast('复制失败', 'error');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text) ? done() : fail());
  } else {
    fallbackCopy(text) ? done() : fail();
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  return ok;
}

/* ===== Download (fetch → blob → save, with CORS fallback) ===== */
// 是否运行在外壳 iframe 里（独立打开时为 false）
const _INSHELL = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
const _pendingSaves = {};

function _saveBlobLocal(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename || 'download';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function saveBlob(blob, filename) {
  const name = filename || 'download';
  // 嵌入外壳时，iframe 内直接触发 <a download> 会被浏览器限流/拦截，
  // 改为把文件交给顶层外壳去保存；若 1.5s 内没有回执（比如被嵌在别处），则本地兜底。
  if (_INSHELL) {
    try {
      const id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      _pendingSaves[id] = setTimeout(() => {
        delete _pendingSaves[id];
        _saveBlobLocal(blob, name);
      }, 1500);
      window.parent.postMessage(
        { ns: 'docsmith', type: 'saveBlob', id, name, mime: blob.type || 'application/octet-stream', blob },
        '*'
      );
      return;
    } catch (e) { /* 落到本地下载 */ }
  }
  _saveBlobLocal(blob, name);
}

async function downloadMany(items) {
  items = (items || []).filter(i => i && i.downUrl);
  if (!items.length) { toast('没有可下载的文件', 'warn'); return; }
  if (items.length > 1) toast(`开始逐个下载 ${items.length} 个文件…`, 'info', 1600);
  for (const it of items) {
    await downloadFile(it.downUrl, it.fileName);
  }
}

/* ===== ZIP batch download —— 按分类归集到文件夹 =====

   打包用的是自带的 zip-writer.js（window.DSZip），不再从 cdnjs 拉 JSZip。
   原来那句 <script src="https://cdnjs…/jszip.min.js"> 在扩展里必然失败：
   MV3 不允许加载远端代码，manifest 的 CSP 也只写了 script-src 'self'。
   失败提示还是「检查网络」，把人往错方向引 —— 换网络也修不好。
   现在压缩走浏览器自带的 CompressionStream，离线也能打包。 */

// 文件名/文件夹名清洗，去掉 ZIP 里非法的路径字符
function zipSafeName(s) {
  return String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '').replace(/\s+$/, '').trim() || '未命名';
}

async function downloadZip(items) {
  items = (items || []).filter(i => i && i.downUrl);
  if (!items.length) { toast('没有可下载的文件', 'warn'); return; }

  if (!(window.DSZip && window.DSZip.createZip)) {
    toast('打包组件没加载好，刷新一下页面再试；也可以用「逐个」下载。', 'error');
    return;
  }

  // 进度提示（复用下载 toast 样式）
  const container = el('toasts');
  const box = document.createElement('div');
  box.className = 'dl-toast';
  box.innerHTML =
    '<div class="dl-toast-name">🗜 正在打包 ' + items.length + ' 个文件…</div>' +
    '<div class="dl-toast-bar"><div class="dl-toast-fill"></div></div>' +
    '<div class="dl-toast-meta"><span class="dl-pct">0%</span><span class="dl-stage">准备中…</span></div>';
  container.appendChild(box);
  const fill = box.querySelector('.dl-toast-fill');
  const pctEl = box.querySelector('.dl-pct');
  const stageEl = box.querySelector('.dl-stage');
  const setPct = (p, stage) => { fill.style.width = p + '%'; pctEl.textContent = Math.round(p) + '%'; if (stage) stageEl.textContent = stage; };

  const zipEntries = [];
  const usedPaths = new Set();
  const failed = [];

  // 分类内文件夹路径 + 同名去重
  function placePath(it) {
    const folder = zipSafeName(catName(it.category || UNCAT));
    // 保留文件夹上传时的相对子目录（若有）
    let inner;
    if (it.relPath && it.relPath.includes('/')) {
      inner = it.relPath.split('/').map(zipSafeName).join('/');
    } else {
      inner = zipSafeName(it.fileName || 'download');
    }
    let path = folder + '/' + inner;
    if (usedPaths.has(path)) {
      const dot = inner.lastIndexOf('.');
      const stem = dot > 0 ? inner.slice(0, dot) : inner;
      const ext = dot > 0 ? inner.slice(dot) : '';
      let n = 2;
      while (usedPaths.has(folder + '/' + stem + ' (' + n + ')' + ext)) n++;
      path = folder + '/' + stem + ' (' + n + ')' + ext;
    }
    usedPaths.add(path);
    return path;
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const base = 5 + (i / items.length) * 65;   // 5% → 70% 抓取阶段
    setPct(base, `抓取 ${i + 1}/${items.length}：${it.fileName || ''}`);
    try {
      const r = resolveRealUrl(it.downUrl || '');
      const url = (r.real && isUrl(r.real)) ? r.real : (it.downUrl || '');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      zipEntries.push({ path: placePath(it), data: buf });
    } catch (err) {
      failed.push({ item: it, err });
    }
  }

  const ok = items.length - failed.length;
  if (!ok) {
    box.classList.add('err');
    box.innerHTML =
      '<div class="dl-toast-name">✗ 打包失败：所有文件都抓取不到</div>' +
      '<div class="dl-toast-meta" style="color:var(--text-dim);margin-bottom:2px">多为跨域 CORS 限制，可改用「逐个」并在失败时新标签打开另存</div>' +
      '<div class="dl-toast-actions"><button data-act="close">关闭</button></div>';
    box.querySelector('[data-act="close"]').onclick = () => { box.classList.add('fading'); setTimeout(() => box.remove(), 200); };
    return;
  }

  setPct(78, '压缩中…');
  let zipBlob;
  try {
    zipBlob = await window.DSZip.createZip(zipEntries, (done, total) => {
      setPct(78 + (total ? done / total : 1) * 20, '压缩中…');
    });
  } catch (err) {
    box.classList.add('err');
    box.innerHTML =
      '<div class="dl-toast-name">✗ 压缩失败：' + escapeHtml(err.message || String(err)) + '</div>' +
      '<div class="dl-toast-actions"><button data-act="close">关闭</button></div>';
    box.querySelector('[data-act="close"]').onclick = () => { box.classList.add('fading'); setTimeout(() => box.remove(), 200); };
    return;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const zipName = `docsmith-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;

  setPct(100, '完成'); box.classList.add('done');
  box.querySelector('.dl-toast-name').textContent =
    failed.length ? `🗜 已打包 ${ok} 个（${failed.length} 个抓取失败）` : `🗜 已打包 ${ok} 个文件`;
  saveBlob(zipBlob, zipName);
  setTimeout(() => { box.classList.add('fading'); setTimeout(() => box.remove(), 200); }, 3000);

  if (failed.length) {
    toast(`${failed.length} 个文件因跨域等原因未打入，可用「逐个」重试`, 'warn', 3600);
  }
}

/* ===== 主题 =====
   文件库不再自带任何外观入口。主题和强调色统一由外壳管：
     · 切主题 → 外壳侧栏底部那颗（三态：亮 / 暗 / 跟随系统）
     · 换强调色 → 设置面板的「外观」分区
   这里只剩一件事：**别人**改了外观，本页跟着重新套用。
   走的是 Appearance.onChange，不依赖任何按钮，所以外壳、别的标签页、
   系统主题变化都能同步过来。

   删掉的东西（都是设置抽屉时代的遗留，抽屉和按钮都已不存在）：
     ACCENTS 色板、setTheme/setAccent/resolveTheme、renderThemeControls
     （它去找 #theme-seg 和 #accent-swatches，那两个元素早就不在 html 里了）。 */
function applyTheme() {
  Appearance.apply();
}
Appearance.onChange(applyTheme);

/* ===== Share (filename + link) ===== */
function shareFmt() { return pref('share.format', 'name_url'); }
function formatShare(name, url) {
  switch (shareFmt()) {
    case 'markdown': return `[${name}](${url})`;
    case 'inline':   return `${name} — ${url}`;
    case 'url':      return url;
    case 'name_url':
    default:         return `${name}\n${url}`;
  }
}
function buildShareText(items) {
  const sep = shareFmt() === 'name_url' ? '\n\n' : '\n';
  return items.map(it => formatShare(it.fileName, it.downUrl)).join(sep);
}
function shareItems(items) {
  items = (items || []).filter(it => it && it.downUrl);
  if (!items.length) { toast('没有可分享的内容', 'warn'); return; }
  copyText(buildShareText(items), true);
  const n = items.length;
  toast(n === 1 ? `已复制 · 可粘贴到 IM：${items[0].fileName}` : `已复制 ${n} 条 · 可直接粘贴到 IM`, 'success');
}
/* 分享文案的预览已并入设置面板。 */
function renderSharePreview() {}

function renderPresetChip() {
  const chip = el('preset-chip');
  const sel = el('preset-select');
  const names = Object.keys(state.presets);
  sel.innerHTML = '';
  names.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    if (n === state.activePreset) o.selected = true;
    sel.appendChild(o);
  });
  chip.classList.toggle('visible', names.length > 1);
}

/* 配置组（环境）的切换已搬进设置面板的「云存储」分区。
   这里原本要往设置抽屉里画一排标签，抽屉已经不存在了。
   保留空实现是因为还有调用点，等 library.js 迁到 domain 层时一起清掉。 */
function renderPresetTabs() {}

async function showPresetMenu(name) {
  const choice = await modalPrompt(`操作环境 "${name}" - 输入 rename 或 delete`, '');
  if (!choice) return;
  if (choice === 'rename') {
    const newName = await modalPrompt('重命名为', name);
    if (!newName || newName === name) return;
    if (state.presets[newName]) { toast('已存在同名', 'error'); return; }
    state.presets[newName] = state.presets[name];
    delete state.presets[name];
    if (state.activePreset === name) state.activePreset = newName;
    saveState(); renderAll();
    toast(`已重命名为 ${newName}`, 'success');
  } else if (choice === 'delete') {
    if (Object.keys(state.presets).length <= 1) { toast('至少保留一个环境', 'warn'); return; }
    delete state.presets[name];
    if (state.activePreset === name) state.activePreset = Object.keys(state.presets)[0];
    saveState(); renderAll();
    toast('已删除', 'success');
  }
}

function switchPreset(name) {
  if (!state.presets[name]) return;
  state.activePreset = name;
  saveState();
  renderConfig();
  renderPresetTabs();
  renderPresetChip();
  checkFirstUse();
  toast(`切换到 ${name}`, 'info', 1200);
}

/* ===== Categories ===== */
function renderUploadCategorySelect() {
  const sel = el('upload-category');
  if (!sel) return;
  sel.innerHTML = '';
  state.categories.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    if (c.id === state.uploadCategory) o.selected = true;
    sel.appendChild(o);
  });
}

function renderCatFilter() {
  const wrap = el('cat-filter');
  if (!wrap) return;
  wrap.innerHTML = '';

  const counts = {};
  state.history.forEach(h => { const k = h.category || UNCAT; counts[k] = (counts[k] || 0) + 1; });

  const mkChip = (id, label, count) => {
    const chip = document.createElement('div');
    chip.className = 'cat-chip' + (state.historyFilter === id ? ' active' : '');
    const deletable = (id !== 'all' && id !== UNCAT);
    chip.innerHTML = `<span>${escapeHtml(label)}</span>` +
      (count != null ? `<span class="cat-num">${count}</span>` : '') +
      (deletable ? `<span class="cat-del" title="删除该分类">×</span>` : '');
    chip.onclick = (e) => {
      if (e.target.classList.contains('cat-del')) return; // handled below
      state.historyFilter = id; saveState(); renderCatFilter(); renderHistory();
    };
    if (deletable) {
      chip.title = '双击重命名';
      chip.ondblclick = (e) => { e.preventDefault(); renameCategory(id); };
      chip.querySelector('.cat-del').onclick = (e) => { e.stopPropagation(); deleteCategory(id); };
    }
    return chip;
  };

  wrap.appendChild(mkChip('all', '全部', state.history.length));
  state.categories.forEach(c => wrap.appendChild(mkChip(c.id, c.name, counts[c.id] || 0)));

  const add = document.createElement('button');
  add.className = 'cat-chip-add';
  add.textContent = '+ 分类';
  add.onclick = addCategory;
  wrap.appendChild(add);
}

/* Auto type-tag filter bar. Counts respect the currently-selected category,
   so the two filters compose. Hidden when there's nothing meaningful to filter. */
function renderKindFilter() {
  const wrap = el('kind-filter');
  if (!wrap) return;

  const scope = state.historyFilter === 'all'
    ? state.history
    : state.history.filter(h => (h.category || UNCAT) === state.historyFilter);

  const counts = {};
  scope.forEach(h => { const k = fileKind(h.fileName); counts[k] = (counts[k] || 0) + 1; });

  // drop a stale active filter if that kind is no longer present in scope
  if (state.typeFilter !== 'all' && !counts[state.typeFilter]) state.typeFilter = 'all';

  const distinct = Object.keys(counts).length;
  // nothing to filter if the scope is empty or has a single kind
  if (!scope.length || distinct <= 1) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }

  wrap.style.display = 'flex';
  wrap.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'kf-label';
  label.textContent = '类型';
  wrap.appendChild(label);

  const mkChip = (id, text, count, color) => {
    const chip = document.createElement('div');
    chip.className = 'kind-chip' + (state.typeFilter === id ? ' active' : '');
    if (color) chip.style.setProperty('--k-color', color);
    chip.innerHTML =
      (id === 'all' ? '' : '<span class="kc-dot"></span>') +
      `<span>${escapeHtml(text)}</span>` +
      (count != null ? `<span class="cat-num">${count}</span>` : '');
    chip.onclick = () => { state.typeFilter = id; saveState(); renderHistory(); };
    return chip;
  };

  wrap.appendChild(mkChip('all', '全部', scope.length, null));
  FILE_KINDS.forEach(k => { if (counts[k.id]) wrap.appendChild(mkChip(k.id, k.label, counts[k.id], KIND_COLOR[k.id])); });
  if (counts.other) wrap.appendChild(mkChip('other', KIND_LABEL.other, counts.other, KIND_COLOR.other));
}

function renderBatchMoveSelect() {
  const sel = el('batch-move');
  if (!sel) return;
  sel.innerHTML = '<option value="" disabled selected>移动到…</option>';
  state.categories.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    sel.appendChild(o);
  });
}

async function addCategory() {
  const name = await modalPrompt('新分类名称（如 图片 / 文档 / 项目A）');
  if (!name) return;
  if (state.categories.some(c => c.name === name)) { toast('已存在同名分类', 'warn'); return; }
  const id = catUid();
  state.categories.push({ id, name });
  state.uploadCategory = id;
  saveState();
  renderCategoryControls();
  toast(`已创建分类「${name}」`, 'success');
}

async function renameCategory(id) {
  if (id === UNCAT) { toast('「未分类」不可修改', 'warn'); return; }
  const cat = state.categories.find(c => c.id === id);
  if (!cat) return;
  const newName = await modalPrompt('重命名分类', cat.name);
  if (!newName || newName === cat.name) return;
  if (state.categories.some(c => c.name === newName)) { toast('已存在同名分类', 'error'); return; }
  cat.name = newName;
  saveState(); renderCategoryControls(); renderHistory();
  toast(`已重命名为「${newName}」`, 'success');
}

function deleteCategory(id) {
  if (id === UNCAT) { toast('「未分类」不可删除', 'warn'); return; }
  const cat = state.categories.find(c => c.id === id);
  if (!cat) return;
  const n = state.history.filter(h => (h.category || UNCAT) === id).length;
  const msg = n
    ? `删除分类「${cat.name}」？该分类下的 ${n} 个文件会移回「未分类」（不会删除文件本身）。`
    : `删除分类「${cat.name}」？`;
  if (!confirm(msg)) return;
  state.history.forEach(h => { if ((h.category || UNCAT) === id) h.category = UNCAT; });
  state.categories = state.categories.filter(c => c.id !== id);
  if (state.uploadCategory === id) state.uploadCategory = UNCAT;
  if (state.historyFilter === id) state.historyFilter = 'all';
  saveState(); renderCategoryControls(); renderHistory();
  toast(`已删除分类「${cat.name}」`, 'success');
}

function assignCategory(historyId, catId) {
  const it = state.history.find(h => h.id === historyId);
  if (!it) return;
  it.category = catId;
  saveState();
  renderCatFilter();
  // if a filter is active and item moved out of view, re-render list
  if (state.historyFilter !== 'all') renderHistory();
  toast(`已移动到「${catName(catId)}」`, 'success', 1300);
}

function renderCategoryControls() {
  renderUploadCategorySelect();
  renderCatFilter();
  renderBatchMoveSelect();
}

function renderConfig() {
  // 上传偏好（自动复制、并发数、分享格式）已归全局设置面板，这里不再画。
  // 存储表单现在长在设置面板里，面板没打开时节点不存在 —— 不是错误
  try { window.DSStorageForm?.render(); } catch (e) {}
}

function renderHeaders() {
  // 请求头现在属于「通用上传接口」这一种服务的字段，由 storage-form.js 负责
}

function bindAutoSave() {
  document.querySelectorAll('[data-cfg]').forEach(el => {
    const key = el.dataset.cfg;
    const handler = () => {
      cfg()[key] = el.value;
      saveState();
      checkFirstUse();
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  });
}

function checkFirstUse() {
  const incomplete = isConfigIncomplete();
  el('first-use-banner').classList.toggle('show', incomplete);
  /* 原来还会给 #btn-settings 加个 .alert 小红点。那颗齿轮已经删掉了
     （外壳侧栏底部有唯一的一颗），所以这里不再有对象可标。
     「还没配置好」的提示由上面那条 first-use-banner 承担，够醒目。 */
}

/* 局部变量别叫 el（会遮蔽文件级的 el(id)，下面三行就全废了）。
   这个函数每次上传成功后都会跑，抛错的话「最近上传」那一栏永远不出现。 */
function showLatest(fileName, url, autoCopied) {
  const box = el('latest');
  el('latest-name').textContent = fileName;
  el('latest-url-input').value = url;
  el('auto-copied-tag').style.display = autoCopied ? '' : 'none';
  box.classList.add('show');
}

/* ===== Selection model ===== */
const selected = new Set();
function pruneSelection() {
  const ids = new Set(state.history.map(h => h.id));
  [...selected].forEach(id => { if (!ids.has(id)) selected.delete(id); });
}
function getSelectedItems() { return state.history.filter(h => selected.has(h.id)); }
function checkSvg() {
  return '<svg viewBox="0 0 12 12" fill="none"><path d="M2.5 6.4l2.4 2.4 4.6-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function updateBatchBar() {
  const count = selected.size;
  el('batch-bar').classList.toggle('show', count > 0);
  el('batch-count').textContent = count + ' selected';
  const allCheck = el('select-all-check');
  const vis = visibleHistory();
  const allSelected = vis.length > 0 && vis.every(h => selected.has(h.id));
  allCheck.classList.toggle('checked', allSelected);
  allCheck.innerHTML = allSelected ? checkSvg() : '';
}
function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  const row = document.getElementById('h-' + id);
  if (row) {
    const on = selected.has(id);
    row.classList.toggle('selected', on);
    const chk = row.querySelector('.hist-check');
    if (chk) { chk.classList.toggle('checked', on); chk.innerHTML = on ? checkSvg() : ''; }
  }
  updateBatchBar();
}
function setSelectAll() {
  const vis = visibleHistory();
  const allSelected = vis.length > 0 && vis.every(h => selected.has(h.id));
  if (allSelected) vis.forEach(h => selected.delete(h.id));
  else vis.forEach(h => selected.add(h.id));
  renderHistory();
}
function clearSelection() { selected.clear(); renderHistory(); }

function renderHistory() {
  pruneSelection();
  renderKindFilter();
  const list = el('history-list');
  el('history-count').textContent = state.history.length;

  const items = visibleHistory();

  if (!state.history.length) {
    list.innerHTML = '<div class="empty-state">// no uploads yet</div>';
    updateBatchBar();
    return;
  }
  if (!items.length) {
    list.innerHTML = `<div class="empty-state">// 「${escapeHtml(catName(state.historyFilter))}」下暂无文件</div>`;
    updateBatchBar();
    return;
  }

  list.innerHTML = '';
  items.forEach(item => {
    const on = selected.has(item.id);
    const row = document.createElement('div');
    row.className = 'history-item' + (on ? ' selected' : '');
    row.id = 'h-' + item.id;

    const catOptions = state.categories.map(c =>
      `<option value="${c.id}"${(item.category || UNCAT) === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
    ).join('');

    const kind = fileKind(item.fileName);
    const kindTag = `<span class="kind-tag" style="--k-color:${KIND_COLOR[kind]}" title="自动识别：${escapeHtml(KIND_LABEL[kind])}"><span class="kc-dot"></span>${escapeHtml(KIND_LABEL[kind])}</span>`;
    const srcTag = item.source === 'md2docx' ? `<span class="src-tag" title="由 Markdown 转换后存入">↳ 转换</span>` : '';
    const dir = relDir(item.relPath || '');
    const dirLine = dir ? `<div class="history-path" title="${escapeHtml(item.relPath)}">📁 ${escapeHtml(dir)}/</div>` : '';

    row.innerHTML = `
      <button class="hist-check ${on ? 'checked' : ''}" data-check="${item.id}" title="选择">${on ? checkSvg() : ''}</button>
      <div class="file-icon">${escapeHtml(fileExt(item.fileName))}</div>
      <div class="history-info">
        <div class="history-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</div>
        ${dirLine}
        <div class="history-meta">
          ${kindTag}
          ${srcTag}
          <span>${fmtSize(item.size)}</span>
          <span>·</span>
          <span>${escapeHtml(item.bucket || '-')}</span>
          <span>·</span>
          <span>${fmtTime(item.timestamp)}</span>
        </div>
      </div>
      <select class="cat-badge" data-cat="${item.id}" title="所属分类（可更改）">${catOptions}</select>
      <div class="history-actions-row">
        <button class="mini-btn" data-rename="${item.id}" title="重命名">rename</button>
        <button class="mini-btn dl" data-dl="${item.id}" title="下载文件">↓</button>
        <button class="mini-btn share" data-share="${item.id}">share</button>
        <button class="mini-btn" data-copy="${escapeHtml(item.downUrl)}">copy</button>
        <button class="mini-btn" data-open="${escapeHtml(item.downUrl)}">open</button>
        <button class="mini-btn danger" data-del="${item.id}">×</button>
      </div>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('[data-check]').forEach(b => b.onclick = () => toggleSelect(b.dataset.check));
  list.querySelectorAll('[data-cat]').forEach(sel => {
    sel.onchange = () => assignCategory(sel.dataset.cat, sel.value);
    // prevent the row-select click bleeding through
    sel.onclick = (e) => e.stopPropagation();
  });
  list.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => renameHistoryItem(b.dataset.rename));
  list.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => {
    const it = state.history.find(h => h.id === b.dataset.dl);
    if (it) downloadFile(it.downUrl, it.fileName);
  });
  list.querySelectorAll('[data-share]').forEach(b => b.onclick = () => {
    const it = state.history.find(h => h.id === b.dataset.share);
    if (it) shareItems([it]);
  });
  list.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copyText(b.dataset.copy));
  list.querySelectorAll('[data-open]').forEach(b => b.onclick = () => window.open(b.dataset.open, '_blank'));
  list.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    selected.delete(b.dataset.del);
    state.history = state.history.filter(h => h.id !== b.dataset.del);
    saveState(); renderCatFilter(); renderHistory();
  });
  updateBatchBar();
}

function renameHistoryItem(id) {
  const it = state.history.find(h => h.id === id);
  if (!it) return;
  modalPrompt('重命名（仅修改本地记录与分享显示名）', it.fileName).then(newName => {
    if (!newName || newName === it.fileName) return;
    it.fileName = newName;
    saveState(); renderHistory();
    toast('已重命名', 'success', 1300);
  });
}

const queue = [];
let active = 0;

/* ---- path helpers for folder uploads ---- */
function topFolder(relPath) {           // "a/b/c.png" -> "a"
  if (!relPath) return '';
  const i = relPath.indexOf('/');
  return i > 0 ? relPath.slice(0, i) : '';
}
function relDir(relPath) {              // "a/b/c.png" -> "a/b"
  if (!relPath) return '';
  const i = relPath.lastIndexOf('/');
  return i > 0 ? relPath.slice(0, i) : '';
}
function validUploadCat() {
  const catIds = new Set(state.categories.map(x => x.id));
  return catIds.has(state.uploadCategory) ? state.uploadCategory : UNCAT;
}
// For every distinct top-level folder in this batch, find or create a same-named
// category and return { folderName: categoryId }.
function resolveFolderCategories(pairs) {
  const map = {};
  const tops = [...new Set(pairs.map(p => topFolder(p.relPath)).filter(Boolean))];
  if (!tops.length) return map;
  tops.forEach(name => {
    let cat = state.categories.find(c => c.id !== UNCAT && c.name === name);
    if (!cat) { cat = { id: catUid(), name }; state.categories.push(cat); }
    map[name] = cat.id;
  });
  saveState();
  return map;
}

// Public entry for File lists (native input / paste / plain drop).
function addToQueue(files) {
  enqueuePairs([...files].map(f => ({ file: f, relPath: f.webkitRelativePath || '' })));
}

// Core enqueue for {file, relPath} pairs.
function enqueuePairs(pairs) {
  pairs = (pairs || []).filter(p => p && p.file);
  if (!pairs.length) return;
  if (isConfigIncomplete()) {
    toast('请先完成配置', 'warn');
    openDrawer();
    return;
  }

  const folderCat = resolveFolderCategories(pairs);
  const folderCount = Object.keys(folderCat).length;

  pairs.forEach(({ file, relPath }) => {
    const top = topFolder(relPath);
    const category = top ? folderCat[top] : validUploadCat();
    const item = { id: uid(), file, relPath: relPath || '', category, status: 'pending', progress: 0, error: null, result: null };
    queue.push(item);
    renderQueueItem(item);
  });

  el('queue').classList.add('has-items');
  if (folderCount) {
    renderCatFilter(); renderUploadCategorySelect(); renderBatchMoveSelect();
    const names = Object.keys(folderCat);
    toast(`已按文件夹自动分类：${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}`, 'info', 2200);
  }
  processQueue();
}

/* ---- recursive folder traversal for drag-and-drop (webkitGetAsEntry) ---- */
function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const step = () => reader.readEntries(batch => {
      if (!batch.length) return resolve(all);
      all.push(...batch); step();
    }, reject);
    step();
  });
}
async function traverseEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    await new Promise(res => entry.file(
      f => { out.push({ file: f, relPath: prefix + entry.name }); res(); },
      () => res()
    ));
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader());
    for (const ch of children) await traverseEntry(ch, prefix + entry.name + '/', out);
  }
}

/* 「这次 Ctrl+V 不该被当成上传」。

   ⚠ 这里**不能**写成 `if (el('drawer').classList.contains('show')) return;`。
   那是原来的写法，而设置抽屉 #drawer 早就从 index.html 删掉了（设置统一收到
   外壳那一个面板）。el() 找不到节点时返回 NOOP_EL，它的 contains() 恒为 false
   —— 于是这道守卫静默失效，不报任何错。
   用户看到的现象：**在配置云存储的时候，剪贴板里的截图被直接传上了云**，
   文件库里凭空多出几条 image.png。已用真实 Chrome 复现（配好 OSS + 打开设置
   面板 + 一次 paste = 队列里多一个文件）。

   现在按「粘贴的目标是谁」判断，节点缺失时一律走**安全**那一侧：
     · 正在输入框 / 文本域 / 可编辑区里打字 → 用户是想粘文字，不是要上传
     · 设置面板（.set-root）开着 → 他在配置，不是在传文件
     · 命令面板、任何模态弹层开着 → 同理
   只有「真的在文件库界面上、没有任何输入焦点」时，才当成上传。 */
function pasteBlocked(e) {
  const t = e && e.target;
  if (t && t.closest) {
    if (t.closest('input, textarea, select, [contenteditable=""], [contenteditable=true]')) return true;
    if (t.closest('.set-root, .cp-root, .modal, .drawer')) return true;
  }
  const a = document.activeElement;
  if (a && a !== document.body) {
    const tag = a.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable) return true;
    if (a.closest && a.closest('.set-root, .cp-root, .modal, .drawer')) return true;
  }
  /* 设置面板/命令面板是「开着就铺满屏幕」的浮层，它们开着就说明用户的注意力
     不在文件库的拖拽区上。用 checkVisibility 而不是看某个 class ——
     面板的显隐方式改过好几次（hidden / display / visibility），
     盯具体实现只会再坏一次。 */
  for (const sel of ['.set-root', '.cp-root']) {
    const p = document.querySelector(sel);
    if (!p) continue;
    const vis = typeof p.checkVisibility === 'function'
      ? p.checkVisibility({ checkVisibilityCSS: true })
      : (!p.hidden && p.offsetParent !== null);
    if (vis) return true;
  }
  return false;
}

function renderQueueItem(item) {
  /* 局部变量叫 row，不叫 el —— 文件级有个 el(id) 取节点的函数，
     同名局部变量会把它遮蔽掉，第一行的 el('queue') 就会撞进 TDZ。 */
  const q = el('queue');
  let row = document.getElementById('q-' + item.id);
  if (!row) {
    row = document.createElement('div');
    row.id = 'q-' + item.id;
    q.appendChild(row);
    item.row = row;
  }
  row.className = 'queue-item ' + item.status;
  const statusText = {
    pending: '等待中...',
    uploading: Math.round(item.progress * 100) + '%',
    error: item.error || '失败'
  }[item.status] || '';

  row.innerHTML = `
    <div class="file-icon">${escapeHtml(fileExt(item.file.name))}</div>
    <div class="queue-info">
      <div class="queue-name" title="${escapeHtml(item.relPath || item.file.name)}">${escapeHtml(item.file.name)}</div>
      ${item.relPath && item.relPath.includes('/') ? `<div class="queue-path">📁 ${escapeHtml(relDir(item.relPath))}/</div>` : ''}
      <div class="queue-meta">
        <span>${fmtSize(item.file.size)}</span>
        <span>·</span>
        <span class="status ${item.status}">${escapeHtml(statusText)}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${item.progress * 100}%"></div></div>
    </div>
    <div style="display: flex; gap: 4px;">
      ${item.status === 'pending' ? `<button class="icon-btn retry" data-edit="${item.id}" title="重命名">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 1.8l2.2 2.2M2 10l.5-2 6-6 1.5 1.5-6 6-2 .5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>
      </button>` : ''}
      ${item.status === 'error' ? `<button class="icon-btn retry" data-retry="${item.id}" title="重试">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 4A4 4 0 103 6.8M10 4V1.5M10 4H7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </button>` : ''}
      <button class="icon-btn" data-remove="${item.id}" title="移除">
        <svg width="11" height="11" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
  `;

  row.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => renameQueueItem(b.dataset.edit));
  row.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => {
    const it = queue.find(q => q.id === b.dataset.retry);
    if (it) { it.status = 'pending'; it.progress = 0; it.error = null; renderQueueItem(it); processQueue(); }
  });
  row.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => removeQueueItem(b.dataset.remove));
}

function renameQueueItem(id) {
  const it = queue.find(q => q.id === id);
  if (!it || it.status !== 'pending') return;
  modalPrompt('重命名文件（含扩展名，将作为上传的文件名）', it.file.name).then(newName => {
    if (!newName || newName === it.file.name) return;
    try {
      it.file = new File([it.file], newName, {
        type: it.file.type,
        lastModified: it.file.lastModified,
      });
    } catch (e) {
      // Fallback for environments without the File constructor
      const blob = it.file.slice(0, it.file.size, it.file.type);
      blob.name = newName;
      it.file = blob;
    }
    renderQueueItem(it);
    toast('已重命名，将以新名称上传', 'success', 1300);
  });
}

function removeQueueItem(id) {
  const idx = queue.findIndex(q => q.id === id);
  if (idx < 0) return;
  if (queue[idx].status === 'uploading' && queue[idx].xhr) queue[idx].xhr.abort();
  /* 局部变量别叫 el，否则最后一行的 el('queue') 撞 TDZ，
     队列清空后那个 has-items 的样式就永远摘不掉。
     属性名跟着 renderQueueItem 一起改成 row。 */
  const row = queue[idx].row;
  queue.splice(idx, 1);
  if (row) row.remove();
  if (!queue.length) el('queue').classList.remove('has-items');
}

function processQueue() {
  const max = prefConcurrency();
  while (active < max) {
    const next = queue.find(q => q.status === 'pending');
    if (!next) break;
    uploadItem(next);
  }
}

function uploadItem(item) {
  active++;
  item.status = 'uploading';
  renderQueueItem(item);

  const ctrl = new AbortController();
  item.abort = () => ctrl.abort();

  DSCloud.rawUpload(item.file, {
    fileName: item.file.name,
    relPath: item.relPath || '',
    signal: ctrl.signal,
    onProgress: (p) => { item.progress = p; renderQueueItem(item); },
  }).then((res) => {
    active--;
    item.result = res.url;
    const catIds = new Set(state.categories.map(x => x.id));
    const cat = catIds.has(item.category) ? item.category
              : (catIds.has(state.uploadCategory) ? state.uploadCategory : UNCAT);
    state.history.unshift({
      id: uid(),
      fileName: item.file.name,
      relPath: item.relPath || '',
      size: item.file.size,
      downUrl: res.url,
      objectKey: res.key || '',
      timestamp: Date.now(),
      provider: DSCloud.describe().provider,
      profile: state.activePreset,
      category: cat,
    });
    if (state.history.length > 300) state.history.length = 300;
    saveState();
    renderCatFilter();
    renderHistory();

    const autoCopy = prefAutoCopy();
    if (autoCopy) copyText(res.url, true);
    showLatest(item.file.name, res.url, autoCopy);

    removeQueueItem(item.id);
    toast(`${item.file.name} 已上传${autoCopy ? '，链接已复制' : ''}`, 'success');
    processQueue();
  }).catch((e) => {
    active--;
    if (e && e.message === '已取消') { processQueue(); return; }
    item.status = 'error';
    item.error = e.message;
    renderQueueItem(item);
    toast(`${item.file.name}：${e.message}`, 'error');
    processQueue();
  });
}

/* 这个页面不再有自己的设置抽屉。齿轮按钮请外壳打开那唯一的设置面板。 */
function openDrawer() {
  try { window.parent.postMessage({ ns: 'docsmith', type: 'open-settings', section: 'storage' }, '*'); }
  catch (e) {}
}
function closeDrawer() {}

function renderAll() {
  applyTheme();
  renderSharePreview();
  renderPresetChip();
  renderPresetTabs();
  renderConfig();
  renderCategoryControls();
  renderHistory();
  checkFirstUse();
}

function bind() {
  /* 「文件库现在是不是显示着的那个」。
     合并进外壳后三个能力共用一个 window，所有 window 级监听（快捷键、
     粘贴、拖放）都得先问这一句，否则一个动作两处响应。
     定义放在 bind() 最前面 —— 下面好几处回调都用它。 */
  const active = () => !window.DSActive || window.DSActive.isActive(libRoot());

  /* 这里原来有 el('btn-settings').onclick = openDrawer。那颗齿轮已从
     index.html 删掉（外壳侧栏底部有唯一的一颗，同一件事不留两个入口），
     所以这一行现在打在 NOOP_EL 上，什么都不做。删掉更诚实。
     页面里仍然可以按 , 打开设置 —— 见下面 keydown 那段，它直接调
     openDrawer()，不经过任何按钮。 */

  // let vertical mouse-wheel scroll the single-row filter bars horizontally
  /* 这里的局部变量也避开 el 这个名字。它在箭头函数自己的作用域里，
     其实碰不到外面的 el(id)，但同一个文件里同名同用途太容易看错 ——
     前面已经有五处因为这个遮蔽抛了 ReferenceError。 */
  ['cat-filter', 'kind-filter'].forEach(idv => {
    const bar = document.getElementById(idv);
    if (!bar) return;
    bar.addEventListener('wheel', (e) => {
      if (e.deltaY === 0) return;
      if (bar.scrollWidth <= bar.clientWidth) return; // nothing to scroll
      e.preventDefault();
      bar.scrollLeft += e.deltaY;
    }, { passive: false });
  });
  /* 这个按钮随设置抽屉一起删了，绑定不再需要 */
  el('first-use-banner').onclick = openDrawer;
  el('preset-select').onchange = (e) => switchPreset(e.target.value);

  // upload-target category + management
  el('upload-category').onchange = (e) => {
    state.uploadCategory = e.target.value; saveState();
  };
  el('btn-manage-cats').onclick = addCategory;

  /* 这个按钮随设置抽屉一起删了，绑定不再需要 */

  /* 这个按钮随设置抽屉一起删了，绑定不再需要 */

  /* 这个按钮随设置抽屉一起删了，绑定不再需要 */

  const dz = el('dropzone');
  const fi = el('file-input');
  const folderInput = el('folder-input');
  dz.onclick = () => fi.click();
  fi.onchange = () => { if (fi.files.length) { addToQueue(fi.files); fi.value = ''; } };

  const pickFolderBtn = el('pick-folder');
  if (pickFolderBtn) pickFolderBtn.onclick = (e) => { e.stopPropagation(); folderInput.click(); };
  if (folderInput) folderInput.onchange = () => { if (folderInput.files.length) { addToQueue(folderInput.files); folderInput.value = ''; } };

  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); dz.classList.add('dragging');
  }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation();
    if (ev === 'dragleave' && e.target !== dz) return;
    dz.classList.remove('dragging');
  }));
  dz.addEventListener('drop', async e => {
    const dt = e.dataTransfer;
    if (!dt) return;
    // 同步抓取普通文件列表作为兜底：dt.files / dt.items 会在 await 之后（或事件结束后）被浏览器清空。
    // 顶层页面与 iframe 里 entry.file() 的时机不同，独立态偶发读取失败——兜底可保证两种形态都能上传。
    const plainFiles = dt.files ? Array.prototype.slice.call(dt.files) : [];
    // Prefer entry API so dropped folders are read recursively.
    const items = dt.items;
    if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
      const entries = [];
      for (const it of items) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) entries.push(en); }
      if (entries.length) {
        if (entries.some(en => en.isDirectory)) toast('正在读取文件夹…', 'info', 1400);
        const pairs = [];
        for (const en of entries) await traverseEntry(en, '', pairs);
        if (pairs.length) { enqueuePairs(pairs); return; }
        // entry API 拿到了条目却没读出文件（某些环境 entry.file() 失败）→ 回退到同步抓取的普通文件列表；
        // 若拖入的全是（空）文件夹，则如实提示。
        if (entries.some(en => en.isFile) && plainFiles.length) { addToQueue(plainFiles); return; }
        toast('未读取到文件', 'warn');
        return;
      }
    }
    if (plainFiles.length) addToQueue(plainFiles);
    else toast('未读取到文件', 'warn');
  });

  // 文件被误拖到拖拽框以外时，浏览器默认会打开该文件、令页面导航丢失状态。
  // 仅对「拖着文件、且落点不在拖拽框内」的情况 preventDefault（不处理、不影响文本拖放）。
  /* ⚠ 也要先看文件库是不是当前显示的那个。合并进外壳后 window 是共用的：
     不判断的话，用户往 Markdown 工作台拖一个 .md 文件想打开它，这里会先
     preventDefault 掉，工作台的「拖进来就能读」就失效了 —— 而且看不出
     是谁拦的。工作台自己也在 window 上听 drop（它那边有 keyGate 之外的
     dropZone 判断），两边各管自己的界面。 */
  ['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => {
    if (!active()) return;
    const types = (e.dataTransfer && e.dataTransfer.types) || [];
    const hasFiles = Array.prototype.indexOf.call(types, 'Files') !== -1;
    if (hasFiles && !(e.target && e.target.closest && e.target.closest('#dropzone'))) e.preventDefault();
  }));

  /* 粘贴上传，同样只在文件库显示着时响应 —— 否则用户在工作台里截个图
     想粘进文档，文件库会把它当成上传，悄悄传到云上去。
     （active() 是 const 箭头函数，定义在本函数下方；这里在回调里调用，
       执行时早已求值完成，拿得到。） */
  window.addEventListener('paste', e => {
    if (!active()) return;
    if (pasteBlocked(e)) return;
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) addToQueue(files);
  });

  el('latest-copy').onclick = () => {
    copyText(el('latest-url-input').value);
  };
  el('latest-open').onclick = () => {
    window.open(el('latest-url-input').value, '_blank');
  };
  el('latest-download').onclick = () => {
    downloadFile(
      el('latest-url-input').value,
      el('latest-name').textContent
    );
  };
  el('latest-url-input').onclick = (e) => e.target.select();
  el('latest-share').onclick = () => {
    shareItems([{
      fileName: el('latest-name').textContent,
      downUrl: el('latest-url-input').value,
    }]);
  };

  /* 主题切换的入口也删了（外壳侧栏底部那颗是唯一入口，三态循环：
     亮 / 暗 / 跟随系统，比这里原来的两态切换更全）。
     applyTheme() 仍然保留 —— 外壳或别的标签页改了主题，本页要跟着变，
     那条路走的是 Appearance.onChange，不依赖任何按钮。
     #theme-seg 是设置抽屉里的分段控件，抽屉早删了，这里一并去掉。 */

  // 分享文案格式已移到全局设置面板（share.format），这里不再自带下拉

  // batch actions
  el('select-all-check').onclick = () => setSelectAll();
  el('batch-share').onclick = () => shareItems(getSelectedItems());
  el('batch-download').onclick = () => downloadMany(getSelectedItems());
  el('batch-zip').onclick = () => downloadZip(getSelectedItems());
  el('batch-move').onchange = (e) => {
    const catId = e.target.value;
    const items = getSelectedItems();
    e.target.selectedIndex = 0; // reset back to placeholder
    if (!catId || !items.length) return;
    items.forEach(it => { it.category = catId; });
    saveState();
    renderCatFilter();
    renderHistory();
    toast(`已移动 ${items.length} 个文件到「${catName(catId)}」`, 'success');
  };
  el('batch-copy').onclick = () => {
    const items = getSelectedItems();
    if (!items.length) return;
    copyText(items.map(i => i.downUrl).join('\n'), true);
    toast(`已复制 ${items.length} 条链接`, 'success');
  };
  el('batch-delete').onclick = () => {
    const items = getSelectedItems();
    if (!items.length) return;
    if (!confirm(`删除选中的 ${items.length} 条记录？`)) return;
    const del = new Set(selected);
    state.history = state.history.filter(h => !del.has(h.id));
    selected.clear(); saveState(); renderHistory();
    toast('已删除', 'success');
  };
  el('batch-clear').onclick = () => clearSelection();

  el('btn-clear-history').onclick = () => {
    if (!state.history.length) return;
    if (!confirm('确定清空所有历史？')) return;
    selected.clear();
    state.history = []; saveState(); renderHistory();
    toast('已清空', 'success');
  };
  el('btn-export-history').onclick = () => {
    if (!state.history.length) { toast('历史为空', 'warn'); return; }
    const blob = new Blob([JSON.stringify(state.history, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'oss-upload-history.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出', 'success');
  };

  /* 这些快捷键只在文件库正显示着时生效。合并进外壳后三个能力共用一个
     window：不设闸的话在 Markdown 工作台里按 Ctrl+O，工作台弹一个「选文件」，
     文件库再弹一个，两个框一起冒出来；按 , 也会莫名跳出云存储设置。
     active() 定义在 bind() 开头，DSActive 见 views/shared/active.js。 */
  window.addEventListener('keydown', e => {
    if (!active()) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (el('modal').classList.contains('show')) return;
      closeDrawer();
    }
    if (!typing && e.key === ',') { e.preventDefault(); openDrawer(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      el('file-input').click();
    }
  });
}

loadState();
renderAll();
bindAutoSave();
bind();

// keep in sync with the Markdown tool (same origin / shared storage — works across iframes too)
window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY) syncFromStorage(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFromStorage(); });
window.addEventListener('focus', syncFromStorage);

/* Reveal & flash a specific history row (used by deep-link and shell hand-off). */
function focusRecord(id) {
  if (!id) return;
  if (!state.history.some(h => h.id === id)) syncFromStorage();
  if (!state.history.some(h => h.id === id)) return;
  if (state.historyFilter !== 'all' || state.typeFilter !== 'all') {
    state.historyFilter = 'all'; state.typeFilter = 'all'; saveState();
    renderCatFilter(); renderHistory();
  }
  /* 从**本能力的容器**里找，不用 document.getElementById —— 合并进外壳后
     同一个文档里可能有同名 id（见文件顶部 el() 的说明）。 */
  const row = libRoot().querySelector('#h-' + (window.CSS && CSS.escape ? CSS.escape(id) : id));
  if (row) {
    scrollRowIntoView(row);
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }
}

/* 把某一行滚进视野。

   ⚠ 这里**不能**用 row.scrollIntoView()。

   外壳的 body 是 `height:100%; overflow:hidden`（见 app/shell.css），而文件库
   这一页自己是「靠 body 滚」的布局（.app 只有 min-height:100vh）。合并之后
   文件库的内容比视口高，却没有任何一层是真正的滚动容器。
   于是 scrollIntoView 会去滚**文档本身** —— overflow:hidden 只是不给滚动条，
   并不阻止脚本滚动。结果：整个外壳被向下推了几百像素，侧栏和导航跑出视口，
   而且没有滚动条能滚回来，页面看着错位、点什么都不对位。
   用户报的「分享文件后跳转到文件里变成这样了，同时无法操作了」就是这个
   （实测从 Markdown 分享完点「在文件库中查看」，document 被滚到 699px）。

   现在的做法：自己找那个**真正可滚动的祖先**，只滚它；一个都没有就什么都不做
   （这一行本来就在视口里，硬滚只会把外壳弄坏）。
   顺手把被滚跑的文档拉回原点 —— 万一别处还有代码滚了它，界面不至于一直歪着。 */
function scrollRowIntoView(row) {
  const scroller = (() => {
    for (let p = row.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return null;
  })();
  if (scroller) {
    const r = row.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const delta = (r.top + r.height / 2) - (s.top + s.height / 2);
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: 'smooth' });
  }
  /* 文档级滚动一律归零：外壳布局假定它永远是 0。 */
  const doc = document.scrollingElement || document.documentElement;
  if (doc && doc.scrollTop) doc.scrollTop = 0;
  if (document.body && document.body.scrollTop) document.body.scrollTop = 0;
}
function focusFromHash() {
  const m = /[#&]file=([^&]+)/.exec(location.hash || '');
  if (m) focusRecord(decodeURIComponent(m[1]));
}
focusFromHash();
window.addEventListener('hashchange', focusFromHash);

/* ===== 给 wire-up.js 的窗口出口 =============================================
   wire-up.js 是 ES module，跟本文件不共享作用域，只能经 window 通信。
   而本文件顶层的 `let state` 是**词法**声明 —— classic script 里这种声明进的是
   全局词法环境，不会挂到 window 上。于是 wire-up.js 里那句
       if (!window.state) return;
   永远为真，搜索框每敲一个字都在第一行就返回了，什么都没发生。
   （函数声明反而会挂 window，所以 renderHistory 那几个一直是好的 ——
     这也是为什么问题只表现在搜索上，格外难查。）

   这里显式挂一次。挂的位置在 loadState()（上面第 1420 行左右）之后，
   所以拿到的已经是加载完的那个对象；之后 syncFromStorage() 只改 state 的字段、
   不替换整个对象引用，两边看到的始终是同一份数据。 */
window.state = state;
window.visibleHistory = visibleHistory;
window.saveState = saveState;
window.toast = toast;
window.processQueue = processQueue;

/* ===== Unified-shell integration (when embedded in an iframe) ===== */
/* ⚠ 这个判断只认「我在 iframe 里」，而内置能力**已经不在 iframe 里了** ——
   它们直接注入外壳文档，window.self === window.top，于是 IN_SHELL 是 false，
   下面那一整块（focusFile 监听、saveBlobAck）在合并模式下一次都不注册。
   后果：从 Markdown 分享完点「在文件库中查看」，文件库根本收不到那条消息，
   目标那一行不会被滚进视野、也不会闪一下 —— 看着就是「跳过来了但什么都没发生」。

   所以判据改成「有没有外壳在」而不是「我是不是 iframe」：
     · 真外壳合并模式 → 有 [data-ds-host] 容器，同一个 window，postMessage
       发给自己也收得到（外壳的 toFrame 对内置能力就是就地分派，见 core/bus.js）
     · 仍然是 iframe 的场景（用户自建能力）→ window.self !== window.top
     · 独立打开这一页 → 两个都不成立，跳过，行为和以前一致 */
const IN_SHELL = (() => {
  try { if (window.self !== window.top) return true; } catch (e) { return true; }
  return !!document.querySelector('[data-ds-host="files"]');
})();
if (IN_SHELL) {
  // parent asks us to reveal a file after a hand-off from the Markdown tool
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.ns !== 'docsmith') return;
    if (d.type === 'focusFile') { syncFromStorage(); focusRecord(d.id); }
    // 外壳已接管本次下载 → 取消本地兜底，避免重复下载
    else if (d.type === 'saveBlobAck' && d.id && _pendingSaves[d.id]) {
      clearTimeout(_pendingSaves[d.id]); delete _pendingSaves[d.id];
    }
  });
  // our "MD 转换" link switches the shell tab instead of navigating away
  const mdLink = el('md-convert-link');
  if (mdLink) mdLink.addEventListener('click', (e) => {
    e.preventDefault();
    try { window.parent.postMessage({ ns: 'docsmith', type: 'switch', tab: 'markdown' }, '*'); } catch (err) {}
  });
}
