/* =====================================================================
 * Docsmith · 云存储设置表单
 * ---------------------------------------------------------------------
 * 表单不是写死的 —— 它读 core/config.js 里 STORAGE_PROVIDERS 的字段描述，
 * 现场生成。所以「支持一种新的云存储」这件事，界面这边一行都不用改。
 *
 * 字段类型：text（默认）/ password / select / kv（一行一个键值对）
 * ===================================================================== */
import { STORAGE_PROVIDERS } from '../../core/config.js';
import * as cloud from '../../storage/index.js';

const $ = (s, r = document) => r.querySelector(s);

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** kv 字段在界面上是一段文本，一行一条 `键 = 值`。 */
function kvToText(v) {
  if (!v) return '';
  const list = Array.isArray(v) ? v : Object.entries(v).map(([key, value]) => ({ key, value }));
  return list.filter((p) => p && p.key).map((p) => `${p.key} = ${p.value ?? ''}`).join('\n');
}

function textToKv(text) {
  return String(text || '').split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('=');
      if (i < 0) return { key: line, value: '' };
      return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
    })
    .filter((p) => p.key);
}

function fieldNode(f, value) {
  const wrap = el('div', 'field');
  wrap.dataset.field = f.key;
  wrap.appendChild(el('label', null, esc(f.label)));

  let input;
  if (f.type === 'select') {
    input = el('select');
    for (const o of f.options || []) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      input.appendChild(opt);
    }
    input.value = value ?? f.default ?? '';
  } else if (f.type === 'kv') {
    input = el('textarea');
    input.rows = 3;
    input.placeholder = f.placeholder || '键 = 值';
    input.value = kvToText(value);
  } else {
    input = el('input');
    input.type = f.secret ? 'password' : 'text';
    input.placeholder = f.placeholder || '';
    input.value = value ?? f.default ?? '';
    if (f.secret) input.autocomplete = 'off';
  }
  input.id = `sf-${f.key}`;
  input.dataset.key = f.key;
  input.dataset.kind = f.type || 'text';
  wrap.appendChild(input);

  if (f.help) wrap.appendChild(el('div', 'cfg-help', esc(f.help)));
  return wrap;
}

/** 某些字段只在别的字段取特定值时才有意义（比如链接有效期）。 */
function applyConditions(root, cfg) {
  root.querySelectorAll('.field[data-field]').forEach((w) => {
    const meta = currentFields().find((f) => f.key === w.dataset.field);
    if (!meta?.showIf) return;
    const other = root.querySelector(`[data-key="${meta.showIf.key}"]`);
    const val = other ? other.value : cfg[meta.showIf.key];
    w.hidden = val !== meta.showIf.value;
  });
}

function currentFields() {
  return cloud.fieldsOf(cloud.current().provider);
}

/** 把界面上的值收回配置对象。 */
function collect(root) {
  const out = {};
  root.querySelectorAll('[data-key]').forEach((input) => {
    out[input.dataset.key] = input.dataset.kind === 'kv' ? textToKv(input.value) : input.value.trim();
  });
  return out;
}

function renderStatus() {
  const box = $('#provider-status');
  if (!box) return;
  const d = cloud.describe();
  box.className = `cfg-status ${d.ready ? 'ok' : 'warn'}`;
  box.textContent = d.ready
    ? `可以上传了 · ${d.providerName}${d.detail ? ` · ${d.detail}` : ''}`
    : d.problem;
}

/** 重画整个云存储区块。 */
export function render() {
  const sel = $('#cfg-provider');
  const host = $('#provider-fields');
  // 这个表单现在长在设置面板里，面板没打开时节点就不存在 —— 直接返回，
  // 不是错误。以前它固定长在文件库抽屉里，才可以假定节点一定在。
  if (!sel || !host) return;

  const cfg = cloud.current();

  if (!sel.options.length) {
    for (const p of STORAGE_PROVIDERS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      cloud.saveProfile(cloud.current().name, { provider: sel.value });
      render();
    });
  }
  sel.value = cfg.provider;

  const meta = cloud.providerMeta(cfg.provider);
  const summary = $('#provider-summary');
  if (summary) summary.textContent = meta.summary || '';

  host.innerHTML = '';
  /* 把字段分成两拨：必填的直接摆出来，标了 advanced 的收进一个可展开的
     「高级选项」里。普通用户配一次云存储，实际只需要面对两三个框；
     以前十个框一起铺开，光看字段名就把人劝退了（用户原话：普通人真看不懂）。
     已经填过值的高级项默认展开 —— 否则用户会以为自己的配置丢了。 */
  const fields = meta.fields || [];
  const basic = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);

  for (const f of basic) host.appendChild(fieldNode(f, cfg[f.key]));

  if (advanced.length) {
    const filled = advanced.some((f) => {
      const v = cfg[f.key];
      return Array.isArray(v) ? v.length : (v != null && v !== '' && v !== f.default);
    });
    const box = el('details', 'cfg-advanced');
    if (filled) box.open = true;
    const sum = el('summary', null, '高级选项');
    sum.title = '公司接口有特殊要求时才需要动这里';
    box.appendChild(sum);
    for (const f of advanced) box.appendChild(fieldNode(f, cfg[f.key]));
    host.appendChild(box);
  }

  // 边填边存，不用按保存键
  host.querySelectorAll('[data-key]').forEach((input) => {
    const save = () => {
      cloud.saveProfile(cloud.current().name, collect(host));
      applyConditions(host, cloud.current());
      renderStatus();
      flashSaved();
    };
    input.addEventListener('change', save);
    input.addEventListener('blur', save);
  });

  applyConditions(host, cfg);
  renderStatus();
}

function flashSaved() {
  const ind = $('#save-indicator');
  if (!ind) return;
  ind.classList.add('show');
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => ind.classList.remove('show'), 1200);
}

/* ------------------------------------------------------------- 连通性测试 */

/** 传一个几十字节的小文件上去，再把它的链接读回来。 */
export async function test(onMessage = () => {}) {
  const problem = cloud.checkReady();
  if (problem) { onMessage(problem, 'warn'); return false; }

  onMessage('正在上传一个测试文件…', 'busy');
  const stamp = new Date().toISOString();
  const blob = new Blob([`Docsmith 连接测试\n${stamp}\n`], { type: 'text/plain;charset=utf-8' });
  try {
    const res = await cloud.upload(blob, { fileName: `docsmith-test-${Date.now()}.txt` });
    onMessage(`成功。文件已经在你的云上了：${res.url}`, 'ok');
    return res.url;
  } catch (e) {
    onMessage(e.message, 'error');
    return false;
  }
}

/** 挂上「测试一下」按钮。 */
export function bindTestButton() {
  const btn = document.getElementById('btn-test-storage');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const box = document.getElementById('provider-status');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '测试中…';
    await test((msg, kind) => {
      if (!box) return;
      box.className = `cfg-status ${kind === 'ok' ? 'ok' : kind === 'error' ? 'err' : 'warn'}`;
      box.textContent = msg;
    });
    btn.disabled = false;
    btn.textContent = original;
    setTimeout(renderStatus, 6000);
  });
}

window.DSStorageForm = { render, test, bindTestButton };
