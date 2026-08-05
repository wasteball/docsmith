/* =====================================================================
 * Docsmith · 「我现在是不是那个在前台的能力」
 * ---------------------------------------------------------------------
 * 为什么需要这个东西：
 *
 * 三个能力页原来各占一个 iframe，键盘事件天然被 iframe 边界挡住 ——
 * Markdown 工作台在 window 上绑 Ctrl+O，文件库也在 window 上绑 Ctrl+O，
 * 两边互不干扰，因为那是两个不同的 window。
 *
 * 内置能力合并进外壳后，只有一个 window。所有监听同时在线：
 *   · Ctrl+O  → 工作台弹「选文件」，文件库也弹「选文件」，两个框一起冒出来
 *   · /       → 文件库抢去聚焦搜索框，在工作台里按 / 也被抢
 *   · ,       → 文件库开设置，在工作台里按 , 也开
 *   · Alt+R / Ctrl+K / Ctrl+Shift+D → 工作台的功能在文件库界面上照样触发
 *
 * 所以每个 window 级快捷键在动手之前，得先问一句「这会儿轮到我了吗」。
 *
 * 判断方式刻意选了「看得见就算活跃」，而不是让外壳去通知每个能力：
 *   · 不需要外壳和能力之间再加一套约定，少一处能不同步的地方；
 *   · 外壳藏起非活跃能力的手段（opacity/visibility/display）全都覆盖到了；
 *   · 独立打开某个能力页时（root 就是 body）永远算活跃，行为和以前一样。
 *
 * checkVisibility 是 Chrome 105+ 的能力，这个扩展本来就只跑在 Chrome 上；
 * 万一没有，退回 hidden + offsetParent 的老办法。
 * ===================================================================== */
(function () {
  'use strict';

  function isActive(root) {
    // 没给根、或根就是 body → 独立页面，永远是前台
    if (!root || root === document.body) return true;

    if (typeof root.checkVisibility === 'function') {
      /* 刻意**不传** checkOpacity。
         外壳藏能力用的是 visibility + opacity，还带 transition:opacity .2s ——
         切换的那 200 毫秒里 opacity 是 0 到 1 之间的中间值。把 opacity 也算进
         「可见」的判据，就等于说「淡入淡出期间这个能力不存在」：刚点完导航
         立刻按快捷键会没反应，而且时快时慢，像随机失灵。
         visibility 没有中间态（transition 只跟 opacity 走），拿它判断即可：
         非活跃能力始终是 visibility:hidden，一切换就立刻翻过来。 */
      return root.checkVisibility({ checkVisibilityCSS: true });
    }
    return !root.hidden && root.offsetParent !== null;
  }

  /* 刻意只导出 isActive，不导出一个「帮你包好监听器」的 gate()。
     包装式写法必须在绑定那一刻就读到 window.DSActive —— 而这个文件是 defer，
     调用方里有 ES module，module 可能先执行。那一刻读到 undefined 就等于把
     闸门永久关掉：iframe 模式下毫无症状（本来没有可抢的对象），合并之后才
     发现快捷键根本没隔离，且不报任何错。
     所以约定统一成「在按键触发那一刻现问一次」：

         window.addEventListener('keydown', (e) => {
           const A = window.DSActive;
           if (A?.isActive && !A.isActive(myRoot)) return;
           …
         });

     代价只是一次属性查找，换来的是不依赖脚本先后顺序。 */
  window.DSActive = { isActive: isActive };
})();
