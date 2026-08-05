/* =====================================================================
 * Docsmith · 外观（主题 / 强调色）
 * ---------------------------------------------------------------------
 * 这个文件是普通脚本，不是 module —— 因为它必须在页面画第一帧之前执行完，
 * 否则暗色模式下会先闪一下白底。module 会被推迟到解析完成之后，来不及。
 *
 * 每个页面 <head> 的第一行就引它。它做四件事：
 *   1. 首帧前把 data-theme / data-accent 写到 <html>
 *   2. 暴露 window.Appearance 给页面代码用
 *   3. 别的标签页改了外观 → 本页跟着变
 *   4. 选了「跟随系统」时，系统换主题 → 本页跟着变
 * ===================================================================== */
(function (w, d) {
  var KEY = 'docsmith:appearance';
  var DEF = { theme: 'light', accent: 'blue' };   // 阅读为主，白底更耐看
  var THEMES = { dark: 1, light: 1, auto: 1 };
  var ACCENTS = { amber: 1, blue: 1, green: 1, violet: 1, pink: 1, cyan: 1 };

  function read() {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
    return {
      theme: THEMES[o.theme] ? o.theme : DEF.theme,
      accent: ACCENTS[o.accent] ? o.accent : DEF.accent,
    };
  }

  function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }

  function resolve(t) {
    if (t === 'auto') return w.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return t === 'light' ? 'light' : 'dark';
  }

  function apply() {
    var a = read();
    d.documentElement.dataset.theme = resolve(a.theme);
    d.documentElement.dataset.accent = a.accent;
    return a;
  }

  function emit() {
    try { w.dispatchEvent(new CustomEvent('docsmith:appearance', { detail: read() })); } catch (e) {}
  }

  /* 读 → 合 → 写：只改自己关心的字段，不会覆盖别处刚写进去的值 */
  function write(patch) {
    var cur = read();
    if (patch && THEMES[patch.theme]) cur.theme = patch.theme;
    if (patch && ACCENTS[patch.accent]) cur.accent = patch.accent;
    save(cur); apply(); emit();
    return cur;
  }

  w.Appearance = {
    read: read,
    write: write,
    apply: apply,
    resolve: resolve,
    theme: function () { return read().theme; },
    accent: function () { return read().accent; },
    resolved: function () { return resolve(read().theme); },
    toggle: function () { return write({ theme: resolve(read().theme) === 'dark' ? 'light' : 'dark' }); },
    onChange: function (fn) { w.addEventListener('docsmith:appearance', function (e) { fn(e.detail); }); },
  };

  apply();

  w.addEventListener('storage', function (e) { if (e.key === KEY) { apply(); emit(); } });
  try {
    w.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
      if (read().theme === 'auto') { apply(); emit(); }
    });
  } catch (e) {}
})(window, document);
