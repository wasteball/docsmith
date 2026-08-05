/* =====================================================================
 * Docsmith · 本地数据
 * ---------------------------------------------------------------------
 * 扩展里所有页面同源，localStorage 天然互通 —— 侧栏和各个能力页读到的
 * 是同一份数据，不需要任何跨窗口协议。
 *
 * 同时把数据镜像一份到 chrome.storage.local：localStorage 会被「清除浏览
 * 数据」误删，chrome.storage 不会。启动时若发现 localStorage 空而镜像还
 * 在，自动恢复。用户不需要知道这件事，它只是不丢东西而已。
 * ===================================================================== */

const listeners = new Map();   // key -> Set<fn>

function raw(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

/** 读一个 JSON 值，坏数据不会让页面崩掉，只会拿到 fallback。 */
export function read(key, fallback = {}) {
  const s = raw(key);
  if (s == null) return structuredCloneSafe(fallback);
  try {
    const v = JSON.parse(s);
    return (v && typeof v === 'object') ? v : structuredCloneSafe(fallback);
  } catch (e) {
    return structuredCloneSafe(fallback);
  }
}

/** 整体写入。会通知本页监听者，其他页面靠 storage 事件收到。 */
export function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // 配额满了：这是唯一值得打扰用户的存储错误
    console.warn('[docsmith] 本地空间不足，这次改动没能保存：', key, e);
    throw new Error('本机存储空间不足。到文件库设置里导出一份配置备份，再清理一些历史记录。');
  }
  mirror(key, value);
  notify(key, value);
  return value;
}

/** 读 → 合并 → 写。只碰自己关心的字段，不会覆盖别人刚写进去的值。 */
export function patch(key, part, fallback = {}) {
  const cur = read(key, fallback);
  return write(key, Object.assign(cur, part));
}

/** 订阅某个键的变化（本页改动 + 其他页面改动都会触发）。 */
export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key)?.delete(fn);
}

function notify(key, value) {
  listeners.get(key)?.forEach((fn) => { try { fn(value); } catch (e) { console.error(e); } });
}

function structuredCloneSafe(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}

/* ------------------------------------------------------------ 跨页同步 */
window.addEventListener('storage', (e) => {
  if (!e.key || !listeners.has(e.key)) return;
  notify(e.key, read(e.key));
});

/* ------------------------------------------------- chrome.storage 镜像 */
const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage?.local;
let mirrorTimer = null;
const mirrorQueue = {};

function mirror(key, value) {
  if (!hasChromeStorage) return;
  mirrorQueue[key] = value;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    const batch = { ...mirrorQueue };
    for (const k of Object.keys(mirrorQueue)) delete mirrorQueue[k];
    // 这是延时回调 —— 400 毫秒后 chrome API 可能已经不可用了（页面正在
    // 卸载、或者根本不在扩展环境里）。备份失败不影响任何功能，静默即可。
    try {
      chrome?.storage?.local?.set(batch)?.catch?.(() => {});
    } catch (e) { /* 镜像只是保险，主数据在 localStorage 里 */ }
  }, 400);
}

/** 启动时调用一次：localStorage 被清空过就从镜像里捞回来。 */
export async function restoreIfEmpty(keys) {
  if (!hasChromeStorage) return false;
  const missing = keys.filter((k) => raw(k) == null);
  if (!missing.length) return false;
  let restored = false;
  try {
    const backup = await chrome.storage.local.get(missing);
    for (const k of missing) {
      if (backup[k] != null) {
        localStorage.setItem(k, JSON.stringify(backup[k]));
        restored = true;
      }
    }
  } catch (e) { /* 镜像不可用就算了，不影响使用 */ }
  return restored;
}

/* ---------------------------------------------------------- 备份 / 恢复 */

/** 打包成一个对象，用于「导出配置」。secretKeys 里的字段会被剔除。 */
export function exportAll(keys, { includeSecrets = false, secretPaths = [] } = {}) {
  const out = { _docsmith: 1, exportedAt: new Date().toISOString(), data: {} };
  for (const k of keys) {
    const v = read(k, null);
    if (v != null) out.data[k] = v;
  }
  if (!includeSecrets) stripPaths(out.data, secretPaths);
  return out;
}

/** 从「导出配置」生成的对象里恢复。返回恢复了几个键。 */
export function importAll(payload) {
  if (!payload || !payload.data || typeof payload.data !== 'object') {
    throw new Error('这个文件不是 Docsmith 的配置备份。请选择由「导出配置」生成的 .json 文件。');
  }
  let n = 0;
  for (const [k, v] of Object.entries(payload.data)) {
    write(k, v);
    n += 1;
  }
  return n;
}

function stripPaths(obj, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let node = obj;
    for (let i = 0; i < parts.length - 1 && node; i += 1) {
      node = parts[i] === '*' ? node : node[parts[i]];
      if (parts[i] === '*') break;
    }
    if (!node) continue;
    const last = parts[parts.length - 1];
    if (parts.includes('*')) {
      // 形如 docsmith:storage.profiles.*.accessKeySecret
      const idx = parts.indexOf('*');
      let base = obj;
      for (let i = 0; i < idx && base; i += 1) base = base[parts[i]];
      if (base && typeof base === 'object') {
        for (const child of Object.values(base)) {
          let t = child;
          for (let i = idx + 1; i < parts.length - 1 && t; i += 1) t = t[parts[i]];
          if (t && typeof t === 'object') delete t[last];
        }
      }
    } else {
      delete node[last];
    }
  }
}
