/* =====================================================================
 * Docsmith · 甘特图
 * ---------------------------------------------------------------------
 * 两种时间轴都要支持，因为实际文档里两种都在用：
 *   dateFormat YYYY-MM-DD   真实日期，任务写 `名称 :id, 起始, 5d`
 *   dateFormat X            纯数字（比如毫秒预算），任务写 `名称 :0, 500`
 *
 * 还要支持 `after a1` 这种相对依赖 —— 项目排期里几乎每条都这么写。
 * 解析时先建一遍任务表，再解一次依赖，因为 after 可能引用后面定义的任务。
 * ===================================================================== */
import {
  cleanLines, esc, textWidth, svgOpen, rect, line, text, round, uid, seriesClass,
} from './base.js';
import { inlineStyle } from './theme.js';

const DAY = 86400000;

function parseDate(s, fmt) {
  const t = String(s).trim();
  if (fmt === 'X' || /^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(t);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

/** `5d` `3w` `12h` `500`（数值轴时按原样） */
function parseDuration(s, numeric) {
  const t = String(s).trim();
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (numeric) return n;
  switch ((m[2] || 'd').toLowerCase()) {
    case 'h': return n * 3600000;
    case 'w': return n * 7 * DAY;
    case 'ms': return n;
    case 'm': return n * 60000;
    default: return n * DAY;
  }
}

export function parse(src) {
  const lines = cleanLines(src);
  let title = '';
  let fmt = 'YYYY-MM-DD';
  let section = '';
  const tasks = [];
  const sections = [];

  for (let i = 1; i < lines.length; i += 1) {
    const ln = lines[i].trim();

    let m;
    if ((m = /^title\s+(.+)$/i.exec(ln))) { title = m[1].trim(); continue; }
    if ((m = /^dateFormat\s+(.+)$/i.exec(ln))) { fmt = m[1].trim(); continue; }
    if (/^(axisFormat|excludes|todayMarker|tickInterval|weekday)\b/i.test(ln)) continue;
    if ((m = /^section\s+(.+)$/i.exec(ln))) {
      section = m[1].trim();
      sections.push(section);
      continue;
    }

    // 名称 :[标记,] [id,] 起始, 长度
    const tm = /^(.+?)\s*:\s*(.+)$/.exec(ln);
    if (!tm) continue;
    const name = tm[1].trim();
    const parts = tm[2].split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;

    const flags = [];
    while (parts.length && /^(done|active|crit|milestone)$/i.test(parts[0])) {
      flags.push(parts.shift().toLowerCase());
    }

    let id = null;
    // 有三段说明第一段是 id；两段则是「起始, 长度」
    if (parts.length >= 3) id = parts.shift();
    else if (parts.length === 2 && !/^(after\s|\d)/i.test(parts[0]) && !/^\d{4}-/.test(parts[0])) {
      id = parts.shift();
    }

    tasks.push({
      name, section, id, flags,
      rawStart: parts[0] ?? null,
      rawLen: parts[1] ?? parts[0] ?? null,
      twoPart: parts.length >= 2,
    });
  }

  if (!tasks.length) throw new Error('甘特图里没有任务');

  /* ---- 解时间：先算绝对起点的，再迭代解 after 依赖 ---- */
  const numeric = fmt === 'X' || fmt === 'x';
  const byId = new Map();
  tasks.forEach((t) => { if (t.id) byId.set(t.id, t); });

  const resolve = (t, depth = 0) => {
    if (t.start != null || depth > 40) return;
    const after = /^after\s+(.+)$/i.exec(t.rawStart || '');
    if (after) {
      const deps = after[1].split(/\s+/).map((d) => byId.get(d)).filter(Boolean);
      deps.forEach((d) => resolve(d, depth + 1));
      const ends = deps.map((d) => (d.start ?? 0) + (d.len ?? 0));
      t.start = ends.length ? Math.max(...ends) : 0;
    } else {
      const s = parseDate(t.rawStart, numeric ? 'X' : fmt);
      t.start = s == null ? 0 : s;
    }
    const len = parseDuration(t.twoPart ? t.rawLen : t.rawLen, numeric);
    t.len = len == null ? (numeric ? 1 : DAY) : len;
    if (t.flags.includes('milestone')) t.len = 0;
  };
  tasks.forEach((t) => resolve(t));

  return { title, tasks, sections: sections.length ? sections : [''], numeric, fmt };
}

export function render(src) {
  const g = parse(src);
  const tasks = g.tasks;

  const min = Math.min(...tasks.map((t) => t.start));
  const max = Math.max(...tasks.map((t) => t.start + t.len));
  const span = (max - min) || 1;

  const ROW = 30;
  const PAD = 18;
  const LABEL_W = Math.min(240, Math.max(120,
    Math.max(...tasks.map((t) => textWidth(t.name, 12))) + 26));
  const CHART_W = 620;
  const TOP = g.title ? 58 : 30;

  // 有几个分节标题，就多几行
  const rows = [];
  let lastSec = null;
  for (const t of tasks) {
    if (t.section !== lastSec && t.section) { rows.push({ sec: t.section }); lastSec = t.section; }
    rows.push({ task: t });
  }

  const W = PAD * 2 + LABEL_W + CHART_W;
  const H = TOP + rows.length * ROW + PAD + 24;
  const x0 = PAD + LABEL_W;
  const scale = (v) => x0 + ((v - min) / span) * CHART_W;

  const out = [svgOpen(W, H, 'dg-gantt'), inlineStyle()];

  if (g.title) {
    out.push(text(W / 2, 26, g.title, 'dg-title'));
  }

  /* 时间刻度：数值轴标数字，日期轴标月/日 */
  const TICKS = 6;
  for (let i = 0; i <= TICKS; i += 1) {
    const v = min + (span * i) / TICKS;
    const x = scale(v);
    out.push(line(x, TOP - 8, x, H - PAD - 18, 'dg-grid'));
    const label = g.numeric
      ? String(Math.round(v))
      : new Date(v).toISOString().slice(5, 10).replace('-', '/');
    out.push(text(x, H - PAD - 4, label, 'dg-axis'));
  }

  let y = TOP;
  let colorIdx = -1;
  let curSec = null;

  for (const r of rows) {
    if (r.sec) {
      colorIdx += 1;
      curSec = r.sec;
      out.push(text(PAD, y + 19, r.sec, 'dg-gantt-section', 'start'));
      y += ROW;
      continue;
    }
    const t = r.task;
    out.push(text(PAD + LABEL_W - 12, y + 20, t.name, 'dg-gantt-label', 'end'));

    const bx = scale(t.start);
    const bw = Math.max(t.len ? (t.len / span) * CHART_W : 0, t.len ? 4 : 0);

    if (!t.len) {
      // 里程碑画成菱形
      const cy = y + 15;
      out.push(`<polygon points="${round(bx)},${round(cy - 8)} ${round(bx + 8)},${round(cy)} ${round(bx)},${round(cy + 8)} ${round(bx - 8)},${round(cy)}" class="dg-milestone"/>`);
    } else {
      let cls = `dg-bar ${seriesClass(Math.max(0, colorIdx))}`;
      if (t.flags.includes('done')) cls += ' done';
      if (t.flags.includes('crit')) cls += ' crit';
      if (t.flags.includes('active')) cls += ' active';
      out.push(rect(bx, y + 6, bw, 19, 4, cls));
      // 条足够宽就把时长写在里面
      const dur = g.numeric ? String(Math.round(t.len)) : `${Math.round(t.len / DAY)}d`;
      if (bw > textWidth(dur, 10.5) + 14) {
        out.push(text(bx + bw / 2, y + 19.5, dur, 'dg-bar-text'));
      }
    }
    y += ROW;
  }

  out.push('</svg>');
  return out.join('');
}
