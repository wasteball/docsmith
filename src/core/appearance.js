/* =====================================================================
 * Docsmith · 外观（模块接口）
 * ---------------------------------------------------------------------
 * 真正的实现在 appearance-global.js —— 那个文件必须是普通脚本才能赶在首帧
 * 之前生效。这里只是把它包成 import 得到的形式，让模块化的代码写起来顺手。
 *
 * 页面里两个都要引，顺序是：先 appearance-global.js，再任何 module。
 * ===================================================================== */

function api() {
  if (!window.Appearance) {
    throw new Error('页面缺少 core/appearance-global.js，请在 <head> 最前面引入它。');
  }
  return window.Appearance;
}

export const read = (...a) => api().read(...a);
export const set = (...a) => api().write(...a);
export const apply = (...a) => api().apply(...a);
export const resolve = (...a) => api().resolve(...a);
export const resolved = (...a) => api().resolved(...a);
export const toggle = (...a) => api().toggle(...a);
export const onChange = (fn) => api().onChange(fn);
