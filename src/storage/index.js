/* =====================================================================
 * Docsmith · 云存储
 * ---------------------------------------------------------------------
 * 上层代码只认识三个东西：
 *   isReady()   现在能不能上传
 *   upload()    传一个文件，拿回一条链接
 *   describe()  当前连的是哪个服务（显示用）
 *
 * 具体是打到公司接口还是直传阿里云，由适配器决定，上层不关心。
 * 想支持新的云存储，照着 provider-aliyun.js 写一个文件，在下面 register
 * 一行，再去 core/config.js 描述它的表单字段 —— 完事。
 * ===================================================================== */
import { KEYS, STORAGE_PROVIDERS, DEFAULT_PROVIDER } from '../core/config.js';
import { read, write, patch, subscribe } from '../core/store.js';
import * as gateway from './provider-gateway.js';
import * as aliyun from './provider-aliyun.js';

const REGISTRY = new Map();
export function register(mod) { REGISTRY.set(mod.id, mod); }
register(gateway);
register(aliyun);

/* --------------------------------------------------------------- 配置 *
 * 支持多套「环境」：比如个人的一套、公司的一套，随时切换。
 * 结构： { active: 'default', profiles: { default: { provider, ...字段 } } }
 * ------------------------------------------------------------------ */

function blank() {
  return { active: 'default', profiles: { default: { provider: DEFAULT_PROVIDER } } };
}

export function readConfig() {
  const c = read(KEYS.storage, blank());
  if (!c.profiles || typeof c.profiles !== 'object' || !Object.keys(c.profiles).length) {
    return blank();
  }
  if (!c.profiles[c.active]) c.active = Object.keys(c.profiles)[0];
  return c;
}

export function writeConfig(next) { return write(KEYS.storage, next); }

/** 当前生效的那套配置。 */
export function current() {
  const c = readConfig();
  return { name: c.active, ...(c.profiles[c.active] || { provider: DEFAULT_PROVIDER }) };
}

export function listProfiles() {
  return Object.keys(readConfig().profiles);
}

export function switchProfile(name) {
  const c = readConfig();
  if (!c.profiles[name]) return false;
  c.active = name;
  writeConfig(c);
  return true;
}

export function saveProfile(name, cfg) {
  const c = readConfig();
  c.profiles[name] = { ...(c.profiles[name] || {}), ...cfg };
  writeConfig(c);
  return c.profiles[name];
}

export function addProfile(name, provider = DEFAULT_PROVIDER) {
  const c = readConfig();
  if (c.profiles[name]) throw new Error(`已经有一套叫「${name}」的配置了，换个名字。`);
  c.profiles[name] = { provider };
  c.active = name;
  writeConfig(c);
  return c.profiles[name];
}

export function removeProfile(name) {
  const c = readConfig();
  if (Object.keys(c.profiles).length <= 1) throw new Error('至少要留一套配置。');
  delete c.profiles[name];
  if (c.active === name) c.active = Object.keys(c.profiles)[0];
  writeConfig(c);
}

export function renameProfile(from, to) {
  const c = readConfig();
  if (!c.profiles[from]) return;
  if (c.profiles[to]) throw new Error(`已经有一套叫「${to}」的配置了。`);
  c.profiles[to] = c.profiles[from];
  delete c.profiles[from];
  if (c.active === from) c.active = to;
  writeConfig(c);
}

export function onConfigChange(fn) { return subscribe(KEYS.storage, fn); }

/* ------------------------------------------------------------- 可用性 */

export function providerMeta(providerId) {
  return STORAGE_PROVIDERS.find((p) => p.id === providerId) || STORAGE_PROVIDERS[0];
}

/**
 * 配置完整吗？
 * @returns {null|string} null 表示可用；否则是一句给用户看的话
 */
export function checkReady(cfg = current()) {
  const mod = REGISTRY.get(cfg.provider);
  if (!mod) return '还没选择要用哪种云存储。';
  return mod.validate ? mod.validate(cfg) : null;
}

export function isReady(cfg = current()) { return checkReady(cfg) == null; }

/** 状态栏 / 设置页显示用的一句话。 */
export function describe() {
  const cfg = current();
  const meta = providerMeta(cfg.provider);
  const problem = checkReady(cfg);
  return {
    provider: cfg.provider,
    providerName: meta.name,
    profile: cfg.name,
    ready: problem == null,
    problem,
    detail: cfg.provider === 'aliyun'
      ? [cfg.bucket, cfg.region].filter(Boolean).join(' · ')
      : (cfg.apiUrl || '').replace(/^https?:\/\//, '').slice(0, 48),
  };
}

/* --------------------------------------------------------------- 上传 */

/**
 * 上传一个文件。
 * @param {File|Blob} file
 * @param {Object} opts { fileName, relPath, onProgress, signal }
 * @returns {Promise<{url, key, size}>}
 */
export async function upload(file, opts = {}) {
  const cfg = current();
  const problem = checkReady(cfg);
  if (problem) {
    const e = new Error(problem);
    e.needsSetup = true;
    throw e;
  }
  const mod = REGISTRY.get(cfg.provider);
  return mod.upload(file, { ...opts, cfg });
}

/** 把一段文本当成文件上传（用于分享 HTML / Markdown）。 */
export async function uploadText(text, fileName, mime = 'text/html;charset=utf-8', opts = {}) {
  let file;
  try {
    file = new File([text], fileName, { type: mime });
  } catch (e) {
    file = new Blob([text], { type: mime });
  }
  return upload(file, { ...opts, fileName });
}

/** 私有存储的链接会过期，用这个换一条新的。 */
export async function refreshUrl(key) {
  const cfg = current();
  const mod = REGISTRY.get(cfg.provider);
  if (!mod?.refreshUrl) return key;
  return mod.refreshUrl(cfg, key);
}

/** 设置界面要用：这个 provider 有哪些字段。 */
export function fieldsOf(providerId) {
  return providerMeta(providerId).fields || [];
}

/** 导出配置时要抹掉的敏感字段路径。 */
export function secretPaths() {
  const out = [];
  for (const p of STORAGE_PROVIDERS) {
    for (const f of p.fields || []) {
      if (f.secret) out.push(`${KEYS.storage}.profiles.*.${f.key}`);
    }
  }
  return [...new Set(out)];
}
