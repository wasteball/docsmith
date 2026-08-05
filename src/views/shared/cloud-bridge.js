/* =====================================================================
 * Docsmith · 云桥接
 * ---------------------------------------------------------------------
 * 两个能力页（Markdown 工作台、文件库）都要做同一件事：把东西传上云，
 * 拿回链接，往文件库的记录里写一条。这些逻辑集中在这里，页面代码只调用
 * window.DSCloud，不关心底下连的是哪家云。
 *
 * 之所以挂在 window 上而不是 export：能力页的主逻辑是一大段普通脚本风格
 * 的代码，让它 import 一堆东西不如给它一个现成的全局对象干净。
 * ===================================================================== */
import * as cloud from '../../storage/index.js';
import { KEYS } from '../../core/config.js';
import { read, write } from '../../core/store.js';
import { toShell } from '../../core/bus.js';

const UNCAT = '__uncat__';
const MAX_HISTORY = 300;

function library() {
  const st = read(KEYS.library, {});
  if (!Array.isArray(st.history)) st.history = [];
  if (!Array.isArray(st.categories) || !st.categories.length) {
    st.categories = [{ id: UNCAT, name: '未分类' }];
  }
  return st;
}

function saveLibrary(st) { write(KEYS.library, st); }

/** 分享文本的排版方式，用户在文件库设置里选。 */
function formatShare(name, url) {
  switch (library().shareFormat || 'name_url') {
    case 'markdown': return `[${name}](${url})`;
    case 'inline': return `${name} — ${url}`;
    case 'url': return url;
    default: return `${name}\n${url}`;
  }
}

/** 往文件库写一条记录，返回记录 id（用于「在文件库中查看」）。 */
function recordHistory(rec) {
  const st = library();
  const ids = new Set(st.categories.map((c) => c.id));
  const category = ids.has(rec.category) ? rec.category
    : (ids.has(st.uploadCategory) ? st.uploadCategory : UNCAT);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  st.history.unshift({
    id,
    fileName: rec.fileName,
    relPath: rec.relPath || '',
    size: rec.size || 0,
    downUrl: rec.downUrl,
    objectKey: rec.objectKey || '',
    timestamp: Date.now(),
    provider: rec.provider || cloud.current().provider,
    profile: rec.profile || cloud.current().name,
    category,
    source: rec.source || '',
  });
  if (st.history.length > MAX_HISTORY) st.history.length = MAX_HISTORY;
  saveLibrary(st);
  return id;
}

function hasUrl(url) {
  return library().history.some((h) => h && h.downUrl === url);
}

window.DSCloud = {
  UNCAT,

  /* --- 状态 ------------------------------------------------------- */
  ready: () => cloud.isReady(),
  problem: () => cloud.checkReady(),
  describe: () => cloud.describe(),

  /* --- 记录 ------------------------------------------------------- */
  library,
  saveLibrary,
  recordHistory,
  hasUrl,
  formatShare,
  autoCopy: () => library().autoCopy !== false,

  /** 只上传，不写记录。文件库自己管记录，用这个。 */
  async rawUpload(file, opts = {}) {
    const problem = cloud.checkReady();
    if (problem) {
      const e = new Error(problem);
      e.needsSetup = true;
      throw e;
    }
    return cloud.upload(file, opts);
  },

  /**
   * 上传一个 Blob，成功后自动写入文件库记录。
   * @returns {Promise<{url,id,name,size,autoCopy}>}
   */
  async upload(blob, filename, onProgress) {
    const problem = cloud.checkReady();
    if (problem) {
      const e = new Error(problem);
      e.needsSetup = true;
      throw e;
    }
    const res = await cloud.upload(
      toFile(blob, filename),
      {
        fileName: filename,
        onProgress: onProgress ? (p) => onProgress(Math.round(p * 100)) : undefined,
      },
    );
    const id = recordHistory({
      fileName: filename,
      size: blob.size,
      downUrl: res.url,
      objectKey: res.key,
      source: 'markdown',
    });
    return { url: res.url, id, name: filename, size: blob.size, autoCopy: this.autoCopy() };
  },

  /* --- 导航 ------------------------------------------------------- */
  /** 切到文件库，可选定位到某条记录。 */
  gotoFiles(fileId) { toShell('switch', { tab: 'files', file: fileId || null }); },
  /** 请外壳打开云存储设置。 */
  openSettings() { toShell('open-settings', { section: 'storage' }); },
};

function toFile(blob, filename) {
  if (blob instanceof File) return blob;
  try {
    return new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  } catch (e) {
    return blob;
  }
}
