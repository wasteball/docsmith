/* =====================================================================
 * Docsmith · 图文卡片：界面接线
 * ---------------------------------------------------------------------
 * 排版逻辑全在 renderer.js（window.DSCards），这里只管三件事：
 *   · 把面板上的控件读成一个 opts 对象
 *   · 防抖地重画预览
 *   · 导出（复制首图 / 打包下载）
 *
 * ⚠ 取节点一律从**本能力的容器**里找，不用 document.getElementById。
 *   三个能力合并进同一个文档后 id 是会撞车的（文件库和工作台都有
 *   #status、#settingsBtn 之类），getElementById 返回的是 DOM 里靠前那个。
 *   这个坑在 library.js 里踩过好几次，别再踩第四次。
 * ===================================================================== */
import { toShell } from '../../core/bus.js';

/* 本能力的根容器。独立打开这一页时是 body；被外壳挂进来时是标了
   data-ds-host="cards" 的那个 div。 */
function root() {
  return document.querySelector('[data-ds-host="cards"]') || document.body;
}
function el(id) { return root().querySelector('#' + id); }

/* ------------------------------------------------------------- toast */
function toast(msg, kind, ms) {
  const box = el('cd-toasts') || document.getElementById('cd-toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'cd-toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), ms || 2400);
}

/* ------------------------------------------------------------- 状态 */
const state = {
  /* 'auto'   = 粘一篇长文，工具按内容分页
     'manual' = 用户自己决定分几页、每页写什么、每页用什么背景
     两种模式各存各的内容，来回切不会互相冲掉。 */
  mode: 'auto',
  ratio: '3:4',
  scale: 1,
  background: 'paper',
  bgImage: null,        // 自定义背景（ImageBitmap / Image）
  blur: 18,
  fontScale: 1,
  wmText: '',
  wmImage: null,
  wmPos: 'br',
  wmOpacity: 0.55,
  pageNo: true,
  cover: false,
  /* 手动模式的页列表。每项 { text, background? } ——
     background 为空表示「跟随全局」，这样改全局背景时这些页会跟着变。 */
  pages: [{ text: '' }]
};

let rendered = [];      // 当前画出来的 canvas 列表
let renderSeq = 0;      // 防止慢的那一轮盖掉快的那一轮
let overflows = [];     // 手动模式下装不下的页序号（0-based，含封面偏移）

/* ------------------------------------------------------- 控件：分段选择 */
function buildSeg(host, items, get, set) {
  if (!host) return;
  host.innerHTML = items.map((it) => {
    const sw = it.swatch ? `<span class="cd-swatch" style="background:${it.swatch}"></span>` : '';
    return `<button type="button" data-v="${it.v}" title="${it.hint || ''}">${sw}${it.label}</button>`;
  }).join('');
  host.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    set(b.dataset.v);
    sync();
    schedule();
  });
  host._sync = () => {
    host.querySelectorAll('button[data-v]').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === String(get()));
    });
  };
}

function sync() {
  root().querySelectorAll('.cd-seg').forEach((s) => { if (s._sync) s._sync(); });
  const r = (window.DSCards.RATIOS.find((x) => x.id === state.ratio) || {});
  const hint = el('cd-ratio-hint');
  if (hint) hint.textContent = r.hint || '';
  const sv = el('cd-scale-val');
  if (sv) sv.textContent = r.w ? `${Math.round(r.w * state.scale)}×${Math.round(r.h * state.scale)}` : '';
  const bv = el('cd-blur-val'); if (bv) bv.textContent = state.blur + ' px';
  const fv = el('cd-font-val'); if (fv) fv.textContent = Math.round(state.fontScale * 100) + '%';
  const ov = el('cd-wm-op-val'); if (ov) ov.textContent = Math.round(state.wmOpacity * 100) + '%';
  const bf = el('cd-blur-field'); if (bf) bf.hidden = !state.bgImage;
  const bc = el('cd-bgclear'); if (bc) bc.hidden = !state.bgImage;
  const wc = el('cd-wmclear'); if (wc) wc.hidden = !state.wmImage;
}

/* ------------------------------------------------- 逐页编辑：页列表 UI

   每页一个卡片：序号、警告、上移/下移/复制/删除、单独换背景、文字框。

   ⚠ 重画整个列表会把焦点弄丢 —— 用户正在第 3 页打字，列表一重建光标就跑了。
   所以打字（input）**不重建列表**，只更新那一页的数据并重画预览；
   只有增删/排序这类结构变化才重建。 */
function renderPageList() {
  const host = el('cd-pages');
  if (!host) return;
  const D = window.DSCards;
  const bgOptions = ['<option value="">跟随全局背景</option>']
    .concat((D.BACKGROUNDS || []).map((b) =>
      `<option value="${b.id}">${b.name}</option>`)).join('');

  host.innerHTML = state.pages.map((pg, i) => `
    <div class="cd-page" data-i="${i}">
      <div class="cd-page-head">
        <span class="cd-page-no">${i + 1}</span>
        <span class="cd-page-warn" data-warn hidden>内容超出这一张，建议拆开</span>
        <span class="cd-page-tools">
          <button type="button" data-act="up" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-act="down" title="下移" ${i === state.pages.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-act="dup" title="复制这一页">⎘</button>
          <button type="button" data-act="del" class="danger" title="删除这一页"
            ${state.pages.length <= 1 ? 'disabled' : ''}>✕</button>
        </span>
      </div>
      <div class="cd-page-bg">
        <label>这一页的背景</label>
        <select data-act="bg">${bgOptions}</select>
      </div>
      <textarea data-act="text" spellcheck="false"
        placeholder="第 ${i + 1} 张卡片的内容…">${escapeHtml(pg.text || '')}</textarea>
    </div>`).join('');

  // select 的选中值不能靠字符串拼（值里可能有引号），逐个赋
  host.querySelectorAll('.cd-page').forEach((box, i) => {
    const sel = box.querySelector('[data-act="bg"]');
    if (sel) sel.value = state.pages[i].background || '';
  });

  const cnt = el('cd-page-count');
  if (cnt) cnt.textContent = String(state.pages.length);
  markOverflow();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 把「这一页装不下」标到对应的编辑框上。 */
function markOverflow() {
  const host = el('cd-pages');
  if (!host) return;
  const offset = state.cover ? 1 : 0;      // 封面占了预览里的第 0 张
  host.querySelectorAll('.cd-page').forEach((box, i) => {
    const bad = overflows.indexOf(i + offset) >= 0;
    box.classList.toggle('over', bad);
    const w = box.querySelector('[data-warn]');
    if (w) w.hidden = !bad;
  });
}

function bindPageList() {
  const host = el('cd-pages');
  if (!host) return;

  /* 结构性操作（增删移）→ 改数据、重建列表、重画预览 */
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const box = btn.closest('.cd-page');
    const i = +box.dataset.i;
    const act = btn.dataset.act;
    if (act === 'up' && i > 0) {
      const t = state.pages[i]; state.pages[i] = state.pages[i - 1]; state.pages[i - 1] = t;
    } else if (act === 'down' && i < state.pages.length - 1) {
      const t = state.pages[i]; state.pages[i] = state.pages[i + 1]; state.pages[i + 1] = t;
    } else if (act === 'dup') {
      state.pages.splice(i + 1, 0, { text: state.pages[i].text, background: state.pages[i].background });
    } else if (act === 'del' && state.pages.length > 1) {
      state.pages.splice(i, 1);
    } else return;
    renderPageList();
    draw();
  });

  /* 打字：只改数据 + 防抖重画，**不重建列表**（否则光标会跳走） */
  host.addEventListener('input', (e) => {
    const ta = e.target.closest('textarea[data-act="text"]');
    if (!ta) return;
    const i = +ta.closest('.cd-page').dataset.i;
    state.pages[i].text = ta.value;
    schedule();
  });

  host.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-act="bg"]');
    if (!sel) return;
    const i = +sel.closest('.cd-page').dataset.i;
    /* 空字符串 = 跟随全局。存 undefined 而不是 ''，好让 renderPages 里的
       `if (pg.background)` 判断走对分支。 */
    if (sel.value) state.pages[i].background = sel.value;
    else delete state.pages[i].background;
    draw();
  });
}

/** 切模式。auto → manual 时把自动分页的结果拆进来，用户不用从零敲。 */
function setMode(mode) {
  if (mode !== 'auto' && mode !== 'manual') return;
  if (state.mode === mode) return;
  if (mode === 'manual') {
    const src = el('cd-src');
    const text = src ? src.value : '';
    /* 只有「手动页还是空的」才自动导入 —— 用户上次编辑过的手动内容不能被冲掉。 */
    const blank = state.pages.length === 1 && !String(state.pages[0].text || '').trim();
    if (blank && text.trim()) {
      const cut = window.DSCards.splitToPages(text, optsNow());
      if (cut.length) state.pages = cut.map((t) => ({ text: t }));
      toast(`已按自动分页拆成 ${state.pages.length} 页，可以逐页改了`, 'ok', 3000);
    }
    renderPageList();
  }
  state.mode = mode;
  const ap = el('cd-auto-pane'), mp = el('cd-manual-pane');
  if (ap) ap.hidden = mode !== 'auto';
  if (mp) mp.hidden = mode !== 'manual';
  sync();
  draw();
}

/* ------------------------------------------------------------- 渲染 */
let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(draw, 260);      // 打字时别每个键都重画
}

function optsNow() {
  return {
    ratio: state.ratio,
    scale: state.scale,
    background: state.background,
    image: state.bgImage,
    blur: state.blur,
    fontScale: state.fontScale,
    pageNo: state.pageNo,
    watermark: {
      text: state.wmText,
      image: state.wmImage,
      position: state.wmPos,
      opacity: state.wmOpacity
    }
  };
}

/** 封面标题取第一个标题；没有标题就用第一段的前 24 个字。 */
function coverTitle(text) {
  const blocks = window.DSCards.parseBlocks(text);
  const h = blocks.find((b) => b.type === 'heading');
  if (h) return h.text;
  const p = blocks.find((b) => b.type === 'p');
  if (!p) return '';
  return p.text.length > 24 ? p.text.slice(0, 24) + '…' : p.text;
}

function draw() {
  const src = el('cd-src');
  const text = src ? src.value : '';
  const cards = el('cd-cards');
  const empty = el('cd-empty');
  const status = el('cd-status');
  const count = el('cd-count');
  const manual = state.mode === 'manual';

  if (count) count.textContent = String(text.replace(/\s/g, '').length);

  /* 有没有东西可画。自动模式看那一个大文本框；手动模式只要**任意一页**
     有字就算有（其余页是空卡片，那是用户故意留的，不该整体清空）。 */
  const hasContent = manual
    ? state.pages.some((p) => String(p.text || '').trim())
    : !!text.trim();

  if (!hasContent) {
    rendered = []; overflows = [];
    closeLightbox();          // 内容清空了，大图里那张也不该还留着
    if (cards) cards.innerHTML = '';
    if (empty) empty.hidden = false;
    if (status) status.textContent = '';
    if (manual) markOverflow();
    setBusy(false);
    return;
  }
  if (empty) empty.hidden = true;

  const seq = ++renderSeq;
  const opts = optsNow();
  if (state.cover) {
    /* 封面标题：自动模式取全文第一个标题；手动模式取第一页的 —— 那才是
       用户心里的"开头"。 */
    opts.title = coverTitle(manual ? (state.pages[0] && state.pages[0].text) || '' : text);
  }

  /* 渲染是同步的（canvas 画完就返回），但可能要几百毫秒 —— 先让状态文字
     更新出去，再用一个宏任务错开，避免界面卡住不给任何反馈。 */
  if (status) status.innerHTML = '<span class="cd-busy"><span class="cd-spin"></span>正在排版…</span>';

  setTimeout(() => {
    if (seq !== renderSeq) return;         // 期间又改了参数，这一轮作废
    let out;
    try {
      out = manual
        ? window.DSCards.renderPages(state.pages, opts)
        : window.DSCards.render(text, opts);
    } catch (e) {
      if (status) status.textContent = '';
      toast('排版出错：' + (e && e.message ? e.message : '未知错误'), 'err', 4000);
      return;
    }
    if (seq !== renderSeq) return;
    rendered = out.canvases;
    overflows = out.overflows || [];
    if (manual) markOverflow();
    /* 大图开着的时候重画了（用户在旁边改了参数）→ 让它跟着更新，
       别继续显示一张已经被丢掉的旧 canvas。张数变少时收敛到最后一张。 */
    if (lbIndex >= 0) {
      if (!rendered.length) closeLightbox();
      else { lbIndex = Math.min(lbIndex, rendered.length - 1); paintLightbox(); }
    }

    cards.innerHTML = '';
    out.canvases.forEach((c, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'cd-card';
      wrap.appendChild(c);
      // 点图看原尺寸 —— 缩略图太小，判断不了效果
      c.addEventListener('click', () => openLightbox(i));
      c.title = '点击看原尺寸';
      const no = document.createElement('span');
      no.className = 'cd-card-no';
      no.textContent = (i + 1) + ' / ' + out.canvases.length;
      wrap.appendChild(no);
      const save = document.createElement('button');
      save.className = 'cd-card-save';
      save.type = 'button';
      save.textContent = '保存这张';
      save.addEventListener('click', (ev) => { ev.stopPropagation(); saveOne(i); });
      wrap.appendChild(save);
      cards.appendChild(wrap);
    });

    if (status) {
      var msg = `${out.canvases.length} 张 · ${out.meta.width}×${out.meta.height}`;
      /* 有页装不下就直说是哪几页 —— 静默溢出会让用户以为字丢了。
         注意这里报的是**预览里的张号**（含封面），和左边编辑框的编号
         可能差一，所以文案里说「第 N 张」而不是「第 N 页」。 */
      if (overflows.length) {
        msg += ` · ⚠ 第 ${overflows.map((i) => i + 1).join('、')} 张装不下`;
      }
      status.textContent = msg;
    }
  }, 0);
}

function setBusy(on) {
  const zip = el('cd-zip');
  if (zip) { zip.disabled = !!on; zip.classList.toggle('busy', !!on); }
}

/* --------------------------------------------------------- 看大图
   预览只有 208px 宽，用户判断不了效果（他的原话：「预览图不可用放大，
   用户都看不到效果啊」）。点一下看原尺寸，← → 翻页，Esc 关。

   ⚠ 显隐一律用 hidden 属性，不要自己改 display。
   core/tokens.css 有一条 [hidden]{display:none!important}，就是为了压住
   .cd-lightbox 自己的 display:flex —— 少了它，hidden 会失效，留下一个
   铺满屏幕的透明层吃掉所有点击（项目里记着的「卡死，只能刷新」那个 bug）。 */
let lbIndex = -1;

function lbEls() {
  return {
    box: el('cd-lightbox'), stage: el('cd-lb-stage'), no: el('cd-lb-no'),
    prev: el('cd-lb-prev'), next: el('cd-lb-next'), save: el('cd-lb-save')
  };
}

function openLightbox(i) {
  const e = lbEls();
  if (!e.box || !rendered[i]) return;
  lbIndex = i;
  paintLightbox();
  e.box.hidden = false;
}

/** 把第 lbIndex 张画进大图区。
    这里放的是**副本**，不是预览里那个 canvas 本身 —— 直接搬走的话，
    预览格子里就空了一个（DOM 节点只能有一个父节点）。 */
function paintLightbox() {
  const e = lbEls();
  const src = rendered[lbIndex];
  if (!e.stage || !src) return;
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  e.stage.innerHTML = '';
  e.stage.appendChild(c);
  if (e.no) e.no.textContent = (lbIndex + 1) + ' / ' + rendered.length;
  if (e.prev) e.prev.disabled = lbIndex <= 0;
  if (e.next) e.next.disabled = lbIndex >= rendered.length - 1;
}

function closeLightbox() {
  const e = lbEls();
  if (!e.box) return;
  e.box.hidden = true;
  if (e.stage) e.stage.innerHTML = '';    // 别留着一张全尺寸 canvas 占内存
  lbIndex = -1;
}

function stepLightbox(d) {
  if (lbIndex < 0) return;
  const n = lbIndex + d;
  if (n < 0 || n >= rendered.length) return;
  lbIndex = n;
  paintLightbox();
}

function bindLightbox() {
  const e = lbEls();
  if (!e.box) return;
  if (e.prev) e.prev.addEventListener('click', () => stepLightbox(-1));
  if (e.next) e.next.addEventListener('click', () => stepLightbox(1));
  if (e.save) e.save.addEventListener('click', () => { if (lbIndex >= 0) saveOne(lbIndex); });
  const close = el('cd-lb-close');
  if (close) close.addEventListener('click', closeLightbox);
  /* 点背景关闭，点图不关。要求「按下和松开都在背景上」——
     否则在图上拖一下、手滑到背景才松手，就会意外关掉。 */
  let downOnBackdrop = false;
  e.box.addEventListener('pointerdown', (ev) => { downOnBackdrop = ev.target === e.box; });
  e.box.addEventListener('click', (ev) => {
    if (ev.target === e.box && downOnBackdrop) closeLightbox();
    downOnBackdrop = false;
  });
  /* 键盘。挂在 window 上，所以必须先问「现在轮到我了吗」——
     三个能力共用一个 window，不问的话在别的能力页按 ← → 也会翻这里的图。
     （见 views/shared/active.js 的说明。） */
  window.addEventListener('keydown', (ev) => {
    if (lbIndex < 0) return;
    const A = window.DSActive;
    if (A && A.isActive && !A.isActive(root())) return;
    if (ev.key === 'Escape') { ev.preventDefault(); closeLightbox(); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepLightbox(-1); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); stepLightbox(1); }
  });
}

/* ------------------------------------------------------------- 导出 */
function baseName() {
  /* 手动模式下要取**第一页**的标题，不是那个（可能空着的）自动输入框 ——
     否则文件名会变成「图文卡片」这种兜底值。 */
  const src = el('cd-src');
  const text = state.mode === 'manual'
    ? ((state.pages[0] && state.pages[0].text) || '')
    : (src ? src.value : '');
  const t = coverTitle(text) || '图文卡片';
  /* Windows 文件名禁用字符要清掉，否则下载会失败或被改名 */
  return t.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 40) || '图文卡片';
}

function canvasToBlob(c) {
  return new Promise((res, rej) => {
    c.toBlob((b) => (b ? res(b) : rej(new Error('图片生成失败（可能尺寸过大）'))), 'image/png');
  });
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveOne(i) {
  if (!rendered[i]) return;
  try {
    const blob = await canvasToBlob(rendered[i]);
    download(`${baseName()}-${String(i + 1).padStart(2, '0')}.png`, blob);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function zipAll() {
  if (!rendered.length) { toast('还没有卡片'); return; }
  if (!window.DSZip) { toast('打包组件没加载成功', 'err'); return; }
  setBusy(true);
  const status = el('cd-status');
  try {
    const entries = [];
    for (let i = 0; i < rendered.length; i++) {
      if (status) status.innerHTML = `<span class="cd-busy"><span class="cd-spin"></span>生成第 ${i + 1}/${rendered.length} 张…</span>`;
      const blob = await canvasToBlob(rendered[i]);
      entries.push({
        path: `${baseName()}-${String(i + 1).padStart(2, '0')}.png`,
        data: await blob.arrayBuffer()
      });
    }
    if (status) status.innerHTML = '<span class="cd-busy"><span class="cd-spin"></span>正在打包…</span>';
    const zip = await window.DSZip.createZip(entries);
    download(`${baseName()}.zip`, zip);
    toast(`已打包 ${entries.length} 张图`, 'ok');
    if (status) status.textContent = `${rendered.length} 张`;
  } catch (e) {
    toast('打包失败：' + (e && e.message ? e.message : '未知错误'), 'err', 4000);
    if (status) status.textContent = '';
  } finally {
    setBusy(false);
  }
}

/* 复制图片到剪贴板。
   ⚠ 这里有个真实的坑（workspace.js 里记着）：在嵌入的文档里，
   navigator.clipboard.write 要求**同步**拿到一个真 Blob，
   延迟形式（ClipboardItem(Promise)）常被 Chromium 拒掉。
   所以先把 Blob 备好，再在同一个手势里写。写不进去就退成下载。 */
let warmBlob = null;
async function warmFirst() {
  if (!rendered.length) { warmBlob = null; return; }
  try { warmBlob = await canvasToBlob(rendered[0]); } catch (e) { warmBlob = null; }
}
function copyFirst() {
  if (!rendered.length) { toast('还没有卡片'); return; }
  const fallback = () => {
    if (warmBlob) { download(`${baseName()}-01.png`, warmBlob); toast('当前环境不允许写入图片剪贴板，已保存为图片', 'err', 3600); }
    else saveOne(0);
  };
  if (!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) || !warmBlob) {
    fallback(); return;
  }
  try {
    navigator.clipboard.write([new ClipboardItem({ 'image/png': warmBlob })])
      .then(() => toast('首图已复制，去小红书粘贴即可', 'ok'), fallback);
  } catch (e) { fallback(); }
}

/* --------------------------------------------------- 读一张用户选的图片
   用 createImageBitmap 而不是 <img src=blobURL>：少一次 URL 生命周期管理，
   而且拿到的位图可以直接 drawImage。老浏览器兜底走 Image。 */
async function readImage(file) {
  if (!file) return null;
  if (!/^image\//.test(file.type)) throw new Error('这不是图片文件');
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch (e) { /* 退到下面 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('这张图片读不出来'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

/* ------------------------------------------------------------- 接线 */
function bind() {
  const D = window.DSCards;
  if (!D) { toast('排版引擎没加载成功', 'err', 5000); return; }

  buildSeg(el('cd-ratio'),
    D.RATIOS.map((r) => ({ v: r.id, label: r.name, hint: r.hint })),
    () => state.ratio, (v) => { state.ratio = v; });

  buildSeg(el('cd-bg'),
    D.BACKGROUNDS.map((b) => ({ v: b.id, label: b.name, swatch: swatchOf(b.id) })),
    () => state.background, (v) => { state.background = v; });

  // scale / wmPos / mode 的按钮是写死在 HTML 里的，只补 sync + 点击
  [['cd-scale', 'scale', (v) => +v], ['cd-wm-pos', 'wmPos', (v) => v]].forEach(([id, key, cast]) => {
    const host = el(id);
    if (!host) return;
    host.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      state[key] = cast(b.dataset.v);
      sync(); schedule();
    });
    host._sync = () => host.querySelectorAll('button[data-v]').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === String(state[key]));
    });
  });

  /* 模式切换单独接：它不只是改一个值，还要显隐两个面板、可能导入页列表。 */
  const modeHost = el('cd-mode');
  if (modeHost) {
    modeHost.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) setMode(b.dataset.v);
    });
    modeHost._sync = () => modeHost.querySelectorAll('button[data-v]').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === state.mode);
    });
  }

  bindPageList();
  const addPage = el('cd-add-page');
  if (addPage) addPage.addEventListener('click', () => {
    state.pages.push({ text: '' });
    renderPageList();
    draw();
    /* 加完把光标送进新那一页 —— 用户点「加一页」就是想马上写。 */
    const boxes = el('cd-pages').querySelectorAll('textarea[data-act="text"]');
    const last = boxes[boxes.length - 1];
    if (last) last.focus();
  });
  const fromAuto = el('cd-from-auto');
  if (fromAuto) fromAuto.addEventListener('click', () => {
    const src = el('cd-src');
    const text = src ? src.value : '';
    if (!text.trim()) { toast('自动分页那边还没有内容', 'err'); return; }
    const cut = window.DSCards.splitToPages(text, optsNow());
    if (!cut.length) { toast('没能拆出内容', 'err'); return; }
    state.pages = cut.map((t) => ({ text: t }));
    renderPageList();
    draw();
    toast(`已拆成 ${state.pages.length} 页`, 'ok');
  });

  const src = el('cd-src');
  if (src) src.addEventListener('input', schedule);

  const clear = el('cd-clear');
  if (clear) clear.addEventListener('click', () => { if (src) { src.value = ''; draw(); src.focus(); } });

  /* 「取当前文档」—— 这是这个能力最有价值的入口：文档已经在手上，
     不用复制粘贴。MDW 是 Markdown 工作台挂在 window 上的 API；
     合并模式下同一个文档里就有，独立打开这一页时没有。 */
  const pull = el('cd-pull');
  if (pull) pull.addEventListener('click', () => {
    const mdw = window.MDW;
    const doc = mdw && typeof mdw.getDoc === 'function' ? mdw.getDoc() : null;
    if (!doc || !doc.text) {
      toast('Markdown 工作台里还没打开文档', 'err', 3200);
      /* 顺手把用户送过去，别让他自己找 */
      try { toShell('switch', { tab: 'markdown' }); } catch (e) {}
      return;
    }
    if (src) { src.value = doc.text; }
    /* 手动模式下光填那个隐藏的输入框等于什么都没发生 —— 直接拆成每一页。 */
    if (state.mode === 'manual') {
      const cut = window.DSCards.splitToPages(doc.text, optsNow());
      if (cut.length) { state.pages = cut.map((t) => ({ text: t })); renderPageList(); }
      draw();
      toast(`已取来《${doc.name}》，拆成 ${state.pages.length} 页`, 'ok', 3000);
      return;
    }
    draw();
    toast(`已取来《${doc.name}》`, 'ok');
  });

  const range = (id, key, cast) => {
    const r = el(id);
    if (!r) return;
    r.addEventListener('input', () => { state[key] = cast(r.value); sync(); schedule(); });
  };
  range('cd-blur', 'blur', (v) => +v);
  range('cd-font', 'fontScale', (v) => +v / 100);
  range('cd-wm-op', 'wmOpacity', (v) => +v / 100);

  const wmText = el('cd-wm-text');
  if (wmText) wmText.addEventListener('input', () => { state.wmText = wmText.value.trim(); schedule(); });

  const pageNo = el('cd-pageno');
  if (pageNo) pageNo.addEventListener('change', () => { state.pageNo = pageNo.checked; schedule(); });
  const cover = el('cd-cover');
  if (cover) cover.addEventListener('change', () => { state.cover = cover.checked; schedule(); });

  // 背景图
  const bgPick = el('cd-bgpick'), bgFile = el('cd-bgfile');
  if (bgPick && bgFile) {
    bgPick.addEventListener('click', () => bgFile.click());
    bgFile.addEventListener('change', async () => {
      const f = bgFile.files && bgFile.files[0];
      bgFile.value = '';
      if (!f) return;
      try {
        state.bgImage = await readImage(f);
        bgPick.textContent = '换一张背景图（' + f.name.slice(0, 18) + '）';
        sync(); draw();
      } catch (e) { toast(e.message, 'err'); }
    });
  }
  const bgClear = el('cd-bgclear');
  if (bgClear) bgClear.addEventListener('click', () => {
    state.bgImage = null;
    if (bgPick) bgPick.textContent = '＋ 选一张图片';
    sync(); draw();
  });

  // logo
  const wmPick = el('cd-wmpick'), wmFile = el('cd-wmfile');
  if (wmPick && wmFile) {
    wmPick.addEventListener('click', () => wmFile.click());
    wmFile.addEventListener('change', async () => {
      const f = wmFile.files && wmFile.files[0];
      wmFile.value = '';
      if (!f) return;
      try {
        state.wmImage = await readImage(f);
        wmPick.textContent = '换一个 logo（' + f.name.slice(0, 16) + '）';
        sync(); draw();
      } catch (e) { toast(e.message, 'err'); }
    });
  }
  const wmClear = el('cd-wmclear');
  if (wmClear) wmClear.addEventListener('click', () => {
    state.wmImage = null;
    if (wmPick) wmPick.textContent = '＋ 选一张 logo';
    sync(); draw();
  });

  const zip = el('cd-zip');
  if (zip) zip.addEventListener('click', zipAll);
  const copy = el('cd-copy');
  if (copy) {
    /* 指针一到就把 PNG 备好，好让点击那一刻能同步写剪贴板 */
    copy.addEventListener('pointerover', warmFirst);
    copy.addEventListener('pointerdown', warmFirst);
    copy.addEventListener('click', copyFirst);
  }

  bindLightbox();
  /* 先把页列表建出来。虽然手动面板默认是藏着的，但用户一切过去就得有东西，
     而且 renderPageList 会顺手把「几页」那个计数填上。 */
  renderPageList();
  sync();
  draw();
}

/** 色板小方块的颜色：和 renderer.js 里那几个背景对得上就行。
    新增背景时记得在这里补一条，否则色块是灰的（功能不受影响，但看着像坏的）。 */
function swatchOf(id) {
  return ({
    paper: '#fcfcfb',
    ink: '#14171f',
    warm: 'linear-gradient(135deg,#fdf3e3,#f7e3cb)',
    mint: 'linear-gradient(135deg,#e8f5ef,#cfe8dd)',
    dusk: 'linear-gradient(135deg,#2b2350,#4a3b7a)',
    ocean: 'linear-gradient(135deg,#0f2027,#2c5364)',
    sunset: 'linear-gradient(135deg,#ff9a6c,#c44fa0)',
    peach: 'linear-gradient(135deg,#ffe8e0,#fcc5d8)',
    sky: 'linear-gradient(135deg,#e0f2fe,#b8d8f8)',
    forest: 'linear-gradient(135deg,#13291f,#2d6a4f)',
    grape: 'linear-gradient(135deg,#4c1d95,#a21caf)',
    coffee: 'linear-gradient(135deg,#f5ece1,#dcc3a5)',
    night: 'radial-gradient(circle at 40% 34%,#1e3a5f,#0b1220)',
    aurora: 'linear-gradient(135deg,#0f2027,#22c1a4)',
    blush: 'radial-gradient(circle at 40% 34%,#fdf0f4,#f3d9e4)'
  })[id] || '#ccc';
}

/* 启动。合并模式下脚本是在外壳跑起来之后注入的，那时 readyState 已经是
   complete，**load 事件永远不会再来** —— 这个坑 workspace.js 里记着，
   所以这里按当前状态分两种情形，别无条件等 load。 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bind);
} else {
  setTimeout(bind, 0);
}
