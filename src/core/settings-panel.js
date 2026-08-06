/* =====================================================================
 * Docsmith · 设置面板（全应用唯一一个）
 * ---------------------------------------------------------------------
 * 左边一列分区，右边内容。分区是按「用户想改什么」分的，不是按代码写在
 * 哪个文件里分的 —— 这是之前三处设置最大的问题：外观开关在三个地方各有
 * 一套，改了一个另外两个不同步，用户不知道哪个说了算。
 *
 * 没有「保存」按钮。设置页里的保存按钮是个假动作，用户改完就走，很少回头
 * 点它。改一项存一项，角落闪一下就够了。
 * ===================================================================== */
import { SECTIONS, SECTION_GROUPS, coerce, fieldOf } from './settings.js';
import * as prefs from './prefs.js';
import * as appearance from './appearance.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createSettingsPanel(ctx = {}) {
  let root = null;
  let active = SECTIONS[0].id;

  /* ------------------------------------------------------------ 取值 */

  function valueOf(f) {
    if (f.store === 'appearance') {
      const a = appearance.read();
      return f.key === 'theme' ? a.theme : a.accent;
    }
    return prefs.get(f.key);
  }

  function setValue(f, raw) {
    if (f.store === 'appearance') {
      appearance.set(f.key === 'theme' ? { theme: raw } : { accent: raw });
    } else {
      prefs.set(f.key, coerce(f.key, raw));
      ctx.onChange?.(f.key, prefs.get(f.key));
    }
    flash();
  }

  /* ------------------------------------------------------------ 渲染 */

  /* 左边导航：按 SECTION_GROUPS 分段。
     没写 group、或写了个不存在的 group 的分区，一律归到最后一组 ——
     宁可位置不理想，也不能让它从导航里消失（那就等于功能没了）。 */
  function navHtml() {
    const groups = SECTION_GROUPS.map((g) => ({ ...g, items: [] }));
    const last = groups[groups.length - 1];
    const byId = new Map(groups.map((g) => [g.id, g]));
    for (const s of SECTIONS) (byId.get(s.group) || last).items.push(s);

    return groups.filter((g) => g.items.length).map((g) => `
      <div class="set-nav-group">
        <div class="set-nav-label">${esc(g.title)}</div>
        ${g.items.map((s) => `
          <button role="tab" class="set-nav-item" data-sec="${s.id}">
            <span class="set-nav-ico">${s.icon}</span>
            <span class="set-nav-txt">${esc(s.title)}</span>
          </button>`).join('')}
      </div>`).join('');
  }

  function build() {
    root = document.createElement('div');
    root.className = 'set-root';
    root.hidden = true;
    root.innerHTML = `
      <div class="set-backdrop"></div>
      <div class="set-dialog" role="dialog" aria-modal="true" aria-label="设置">
        <header class="set-head">
          <h2>设置</h2>
          <span class="set-saved" id="set-saved">已保存</span>
          <button class="icon-btn set-close" aria-label="关闭">
            <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>
          </button>
        </header>
        <div class="set-body">
          <nav class="set-nav" role="tablist">
            ${navHtml()}
          </nav>
          <div class="set-content" id="set-content"></div>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.querySelector('.set-backdrop').addEventListener('click', close);
    root.querySelector('.set-close').addEventListener('click', close);
    root.querySelector('.set-nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sec]');
      if (b) { active = b.dataset.sec; paint(); }
    });

    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
  }

  function paint() {
    root.querySelectorAll('.set-nav-item').forEach((b) => {
      b.classList.toggle('on', b.dataset.sec === active);
      b.setAttribute('aria-selected', b.dataset.sec === active ? 'true' : 'false');
    });

    const sec = SECTIONS.find((s) => s.id === active) || SECTIONS[0];
    const host = root.querySelector('#set-content');
    host.innerHTML = `
      <h3 class="set-sec-title">${esc(sec.title)}</h3>
      ${sec.desc ? `<p class="set-sec-desc">${esc(sec.desc)}</p>` : ''}
      <div class="set-fields">${sec.fields.map(fieldHtml).join('')}</div>`;

    // 交给别处渲染的复杂区块
    host.querySelectorAll('[data-slot]').forEach((el) => {
      ctx.slots?.[el.dataset.slot]?.(el);
    });
  }

  function fieldHtml(f) {
    const v = f.key.startsWith('__') ? null : valueOf(f);

    switch (f.type) {
      case 'storage-form':
      case 'menu-editor':
      case 'components':
      case 'memory':
      case 'shortcuts':
        return `<div class="set-slot" data-slot="${f.type}"></div>`;

      case 'action':
        return `
          <div class="set-field set-action">
            <button type="button" class="btn${f.danger ? ' btn--danger' : ''}" data-act="${esc(f.key)}">${esc(f.label)}</button>
            ${f.help ? `<p class="set-help">${esc(f.help)}</p>` : ''}
          </div>`;

      case 'toggle':
        return `
          <div class="set-field set-row">
            <div class="set-main">
              <span class="set-label">${esc(f.label)}</span>
              ${f.help ? `<p class="set-help">${esc(f.help)}</p>` : ''}
            </div>
            <button type="button" role="switch" class="set-switch${v ? ' on' : ''}"
                    aria-checked="${v ? 'true' : 'false'}" data-key="${esc(f.key)}">
              <span class="set-knob"></span>
            </button>
          </div>`;

      case 'segment':
        return `
          <div class="set-field">
            <span class="set-label">${esc(f.label)}</span>
            <div class="set-seg" data-key="${esc(f.key)}">
              ${(f.options || []).map((o) => `
                <button type="button" data-value="${esc(o.value)}"
                        class="${String(o.value) === String(v) ? 'on' : ''}"
                        ${o.hint ? `title="${esc(o.hint)}"` : ''}>${esc(o.label)}</button>`).join('')}
            </div>
            ${hintOf(f, v)}
            ${f.help ? `<p class="set-help">${esc(f.help)}</p>` : ''}
          </div>`;

      case 'select':
        return `
          <div class="set-field">
            <span class="set-label">${esc(f.label)}</span>
            <select data-key="${esc(f.key)}">
              ${(f.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
            </select>
            ${hintOf(f, v)}
            ${f.help ? `<p class="set-help">${esc(f.help)}</p>` : ''}
          </div>`;

      case 'slider':
        return `
          <div class="set-field">
            <span class="set-label">${esc(f.label)}<b class="set-num">${esc(v)}${esc(f.unit || '')}</b></span>
            <input type="range" data-key="${esc(f.key)}" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${esc(v)}">
            ${f.help ? `<p class="set-help">${esc(f.help)}</p>` : ''}
          </div>`;

      case 'swatches':
        return `
          <div class="set-field">
            <span class="set-label">${esc(f.label)}</span>
            <div class="set-swatches" data-key="${esc(f.key)}">
              ${(ctx.accents || []).map((a) => `
                <button type="button" class="set-swatch${a.id === v ? ' on' : ''}"
                        data-value="${a.id}" style="background:${a.color}"
                        title="${esc(a.label)}" aria-label="${esc(a.label)}"></button>`).join('')}
            </div>
          </div>`;

      case 'textarea':
        return `
          <div class="set-field">
            <span class="set-label">${esc(f.label)}</span>
            <textarea rows="4" data-key="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}">${esc(v ?? '')}</textarea>
            ${f.help ? `<p class="set-help">${esc(f.help)}</p>` : ''}
          </div>`;

      default:
        return `
          <div class="set-field">
            <span class="set-label">${esc(f.label)}</span>
            <input type="text" data-key="${esc(f.key)}" value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}">
          </div>`;
    }
  }

  function hintOf(f, v) {
    const o = (f.options || []).find((x) => String(x.value) === String(v));
    return o?.hint ? `<p class="set-help set-opt-hint">${esc(o.hint)}</p>` : '<p class="set-help set-opt-hint"></p>';
  }

  /* ------------------------------------------------------------ 交互 */

  function onClick(e) {
    const sw = e.target.closest('.set-switch');
    if (sw) {
      const f = fieldOf(sw.dataset.key);
      const next = !sw.classList.contains('on');
      sw.classList.toggle('on', next);
      sw.setAttribute('aria-checked', String(next));
      setValue(f, next);
      return;
    }

    const segBtn = e.target.closest('.set-seg button, .set-swatch');
    if (segBtn) {
      const wrap = segBtn.parentElement;
      const f = fieldOf(wrap.dataset.key);
      [...wrap.children].forEach((b) => b.classList.toggle('on', b === segBtn));
      setValue(f, segBtn.dataset.value);
      const hint = wrap.parentElement.querySelector('.set-opt-hint');
      if (hint) {
        const o = (f.options || []).find((x) => String(x.value) === segBtn.dataset.value);
        hint.textContent = o?.hint || '';
      }
      return;
    }

    const act = e.target.closest('[data-act]');
    if (act) ctx.actions?.[act.dataset.act]?.();
  }

  function onChange(e) {
    const el = e.target.closest('[data-key]');
    if (!el || el.type === 'range') return;
    const f = fieldOf(el.dataset.key);
    if (!f) return;
    setValue(f, el.value);
    const hint = el.parentElement.querySelector('.set-opt-hint');
    if (hint) {
      const o = (f.options || []).find((x) => String(x.value) === el.value);
      hint.textContent = o?.hint || '';
    }
  }

  function onInput(e) {
    const el = e.target.closest('input[type="range"][data-key]');
    if (!el) return;
    const f = fieldOf(el.dataset.key);
    const num = el.parentElement.querySelector('.set-num');
    if (num) num.textContent = el.value + (f.unit || '');
    setValue(f, el.value);
  }

  let flashTimer = null;
  function flash() {
    const el = root?.querySelector('#set-saved');
    if (!el) return;
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('show'), 1100);
  }

  /* ------------------------------------------------------------ 生命周期 */

  function open(section) {
    if (!root) build();
    if (section && SECTIONS.some((s) => s.id === section)) active = section;
    paint();
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add('show'));
  }

  function close() {
    if (!root) return;
    root.classList.remove('show');
    setTimeout(() => { if (root) root.hidden = true; }, 180);
  }

  function isOpen() { return root && !root.hidden; }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); isOpen() ? close() : open(); }
  });

  return { open, close, isOpen, refresh: () => root && !root.hidden && paint() };
}
