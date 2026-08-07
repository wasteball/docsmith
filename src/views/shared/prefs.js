/* =====================================================================
 * Docsmith · 记住用户的习惯
 * ---------------------------------------------------------------------
 * 好用的工具应该越用越顺手：你上次把字号调大了，这次打开还是大的；你
 * 习惯开着大纲，它就一直开着；你上回读到一半，回来还在那个位置。
 *
 * 这些都不值得让用户去设置里翻，应该自动记住。这个文件就管这件事。
 *
 * 两类东西，存法不同：
 *   偏好（prefs）    —— 长期有效，换文档也保留。字号、主题、面板开合
 *   会话（session）  —— 只在这次插件开着的时候有用，纯放内存，不落盘
 *
 * 「上次读到哪儿」这类和某份文档绑定的滚动位置，现在只在插件开着、文件
 * 正加载在插件里的时候记着（见 core/prefs.js 的内存 Map），不写进浏览器
 * 长期存储 —— 早先它连同一份 docsmith:doc-state 落盘，几十份文档累起来
 * 也占地方，不值当。
 *
 * 不记录任何和内容有关的东西 —— 不上传，不统计，纯粹为了顺手。
 * ===================================================================== */
(function (w) {
  'use strict';

  var PREF_KEY = 'docsmith:prefs';

  /* ------------------------------------------------------------ 底层 */

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function save(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); return true; }
    catch (e) { return false; }   // 空间满了就静默放弃，记不住总比崩了强
  }

  function notifyChrome(key, obj) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && chrome.storage.local.set) {
        var data = {}; data[key] = obj;
        var p = chrome.storage.local.set(data);
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {}
  }

  var cache = null;
  function prefs() {
    if (!cache) cache = load(PREF_KEY);
    return cache;
  }

  var writeTimer = null;
  function flush() {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(function () {
      var current = prefs();
      save(PREF_KEY, current);
      notifyChrome(PREF_KEY, current);
    }, 200);
  }

  /* ------------------------------------------------------------ 偏好 */

  /** 读一个偏好，没存过就返回默认值。 */
  function get(key, fallback) {
    var v = prefs()[key];
    return v === undefined ? fallback : v;
  }

  /** 存一个偏好。写盘会攒一下批量做，连续拖滑块不会写几十次。 */
  function set(key, value) {
    if (prefs()[key] === value) return value;
    prefs()[key] = value;
    flush();
    try {
      w.dispatchEvent(new CustomEvent('docsmith:pref', { detail: { key: key, value: value } }));
    } catch (e) {}
    return value;
  }

  /** 订阅某个偏好的变化（含其他标签页改的）。 */
  function watch(key, fn) {
    var h = function (e) { if (e.detail && e.detail.key === key) fn(e.detail.value); };
    w.addEventListener('docsmith:pref', h);
    return function () { w.removeEventListener('docsmith:pref', h); };
  }

  /**
   * 把一个控件和一个偏好绑起来：初值从记忆里取，用户一改就记住。
   * 省掉每处都写一遍「读→设→监听→存」。
   *
   * @param el      input / select / checkbox
   * @param key     偏好名
   * @param opts    { event, parse, format, apply }
   */
  function bind(el, key, opts) {
    if (!el) return;
    opts = opts || {};
    var isCheck = el.type === 'checkbox';
    var evt = opts.event || (isCheck || el.tagName === 'SELECT' ? 'change' : 'input');

    var stored = get(key, undefined);
    if (stored !== undefined) {
      if (isCheck) el.checked = !!stored;
      else el.value = opts.format ? opts.format(stored) : stored;
      if (opts.apply) opts.apply(stored);
    }

    el.addEventListener(evt, function () {
      var v = isCheck ? el.checked : (opts.parse ? opts.parse(el.value) : el.value);
      set(key, v);
      if (opts.apply) opts.apply(v);
    });
  }

  /* --------------------------------------------------------- 跨标签页 */

  w.addEventListener('storage', function (e) {
    if (e.key !== PREF_KEY) return;
    cache = null;                 // 别的标签页改了，下次读取重新拿
    try { w.dispatchEvent(new CustomEvent('docsmith:prefs-reload')); } catch (err) {}
  });

  /* 老版本把每份文档的滚动位置落进 docsmith:doc-state（最多 60 份）。
     现在滚动位置只在内存里记（core/prefs.js），这份长期存储不再需要，
     顺手清掉，释放浏览器空间。removeItem / remove 对不存在的键是空操作。 */
  try { localStorage.removeItem('docsmith:doc-state'); } catch (e) {}
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && chrome.storage.local.remove) {
      chrome.storage.local.remove('docsmith:doc-state');
    }
  } catch (e) {}

  /* ------------------------------------------------------------ 导出 */

  w.DSPrefs = {
    get: get,
    set: set,
    watch: watch,
    bind: bind,
    all: function () { return Object.assign({}, prefs()); },
    reset: function () { cache = {}; save(PREF_KEY, {}); notifyChrome(PREF_KEY, {}); },
  };
})(window);
