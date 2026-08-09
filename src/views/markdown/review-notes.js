/* =====================================================================
 * Docsmith · 评审意见
 * ---------------------------------------------------------------------
 * 本地、单人、块级。意见不写进 Markdown 正文，也不随正式文档导出。
 * 锚点保存「原文指纹 + 前后文 + 当时序号」，内容移动后仍尽量找回来；
 * 找不到就明确标成未定位，绝不静默丢意见。
 * ===================================================================== */
import { read, write, subscribe } from '../../core/store.js';
import { KEYS } from '../../core/config.js';

const MAX_BYTES = 2 * 1024 * 1024;
const listeners = new Set();

function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function hash(s) {
  s = norm(s); let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function db() { return read(KEYS.reviewNotes, { version: 1, docs: {} }); }
function save(all) {
  all.version = 1; all.docs ||= {};
  let raw = JSON.stringify(all);
  if (raw.length > MAX_BYTES) {
    const docs = Object.entries(all.docs).sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    while (raw.length > MAX_BYTES && docs.length > 1) { const [key] = docs.shift(); delete all.docs[key]; raw = JSON.stringify(all); }
  }
  // store.write 会通过 subscribe 同步通知本页；不要再手动 emit，否则每次
  // 修改都会重绘两遍面板和正文角标。
  write(KEYS.reviewNotes, all);
}
function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }
subscribe(KEYS.reviewNotes, emit);

export function blockAnchor(blocks, i) {
  const b = blocks[i] || {};
  return { kind: 'block', type: b.type || '', hash: hash(b.raw), quote: norm(b.raw).slice(0, 160),
    prev: i > 0 ? hash(blocks[i - 1].raw) : '', next: i + 1 < blocks.length ? hash(blocks[i + 1].raw) : '', index: i };
}
export function cellAnchor(blocks, i, row, col, cell, headers, rowLead) {
  const a = blockAnchor(blocks, i);
  return { ...a, kind: 'cell', row, col, cell: norm(cell).slice(0, 120),
    header: norm((headers || [])[col]).slice(0, 120), rowLead: norm(rowLead).slice(0, 120) };
}
export function resolve(anchor, blocks) {
  if (!anchor || !blocks?.length) return null;
  const candidates = blocks.map((b, i) => ({ b, i, h: hash(b.raw), q: norm(b.raw) }));
  let hit = candidates.find((x) => x.h === anchor.hash && (!anchor.type || x.b.type === anchor.type));
  if (!hit && anchor.prev) hit = candidates.find((x, i) => x.b.type === anchor.type && i > 0 && candidates[i - 1].h === anchor.prev);
  if (!hit && anchor.next) hit = candidates.find((x, i) => x.b.type === anchor.type && i + 1 < candidates.length && candidates[i + 1].h === anchor.next);
  if (!hit && anchor.quote) {
    const needle = norm(anchor.quote).slice(0, 48);
    hit = candidates.filter((x) => !anchor.type || x.b.type === anchor.type)
      .sort((a, b) => Math.abs(a.i - (anchor.index || 0)) - Math.abs(b.i - (anchor.index || 0)))
      .find((x) => x.q.includes(needle) || needle.includes(x.q.slice(0, 48)));
  }
  if (!hit && blocks[anchor.index] && (!anchor.type || blocks[anchor.index].type === anchor.type)) hit = candidates[anchor.index];
  return hit ? { index: hit.i, block: hit.b, row: anchor.row, col: anchor.col } : null;
}

export function list(docKey, status = 'all') {
  const notes = db().docs?.[docKey]?.notes || [];
  return notes.filter((n) => status === 'all' || n.status === status).sort((a, b) => b.createdAt - a.createdAt);
}
export function add(doc, anchor, text) {
  text = norm(text); if (!doc?.key || !text) return null;
  const all = db(); const rec = all.docs[doc.key] ||= { name: doc.name || '', updatedAt: 0, notes: [] };
  const note = { id: uid(), text, status: 'pending', createdAt: Date.now(), resolvedAt: 0, updatedAt: Date.now(), anchor, quote: anchor.quote || anchor.cell || '' };
  rec.name = doc.name || rec.name; rec.updatedAt = Date.now(); rec.notes.push(note); save(all); return note;
}
function mutate(docKey, id, fn) {
  const all = db(), rec = all.docs?.[docKey]; if (!rec) return false;
  const note = rec.notes.find((n) => n.id === id); if (!note) return false;
  fn(note, rec); rec.updatedAt = Date.now(); note.updatedAt = Date.now(); save(all); return true;
}
export function resolveNote(docKey, id) { return mutate(docKey, id, (n) => { n.status = 'resolved'; n.resolvedAt = Date.now(); }); }
export function reopen(docKey, id) { return mutate(docKey, id, (n) => { n.status = 'pending'; n.resolvedAt = 0; }); }
export function remove(docKey, id) {
  const all = db(), rec = all.docs?.[docKey]; if (!rec) return false;
  const i = rec.notes.findIndex((n) => n.id === id); if (i < 0) return false;
  rec.notes.splice(i, 1); rec.updatedAt = Date.now(); if (!rec.notes.length) delete all.docs[docKey]; save(all); return true;
}
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function exportMarkdown(docKey, title) {
  const notes = list(docKey, 'all');
  const lines = ['## ' + (title || '方案评审意见'), ''];
  notes.forEach((n) => { lines.push('- [' + (n.status === 'resolved' ? 'x' : ' ') + '] ' + n.text); if (n.quote) lines.push('  - 对应内容：' + norm(n.quote)); });
  return lines.join('\n');
}
