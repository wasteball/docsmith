/* =====================================================================
 * Docsmith · 快捷键清单
 * ---------------------------------------------------------------------
 * 这份清单是「说明」，不是「实现」—— 真正的绑定分散在各处：
 *   · Markdown 工作台主键位   views/markdown/workspace.js（keyGate 那两块）
 *   · 命令面板 ⌘K             views/markdown/palette.js
 *   · 逐处审阅 Alt+R / Alt+↑↓  views/markdown/revision.js、workspace.js
 *   · 文件库                   views/files/library.js、files/wire-up.js
 *   · 外壳（切能力、设置）      app/main.js、core/settings-panel.js
 *   · 图表画布内               workspace.js 的 createPanZoom
 *   · 打开插件 Alt+D           manifest.json 的 commands
 *
 * ⚠ 改了任何一处绑定，记得回来改这里。两边不一致比没有说明更糟 ——
 *   用户会按着写出来的键去试，发现没反应就不再相信这个面板。
 *
 * 键位写法：一律用 "Mod" 表示「Windows 上是 Ctrl、Mac 上是 ⌘」，
 * 由 fmtKey() 按当前系统翻译。写死 ⌘ 是不行的：这个插件的用户基本都在
 * Windows 上，看到 ⌘ 只会困惑（命令面板里原来就写死了 ⌘，是个小毛病）。
 * ===================================================================== */

/** 当前系统是 Mac 吗。userAgentData 是新接口，platform 是老的兜底。 */
export const IS_MAC = (() => {
  try {
    const p = navigator.userAgentData?.platform || navigator.platform || '';
    return /mac/i.test(p);
  } catch (e) { return false; }
})();

/** 把 "Mod+⇧+E" 这样的写法翻译成当前系统的样子，返回按键数组。 */
export function fmtKey(spec) {
  return String(spec).split('+').map((k) => {
    if (k === 'Mod') return IS_MAC ? '⌘' : 'Ctrl';
    if (k === 'Alt') return IS_MAC ? '⌥' : 'Alt';
    if (k === 'Shift') return '⇧';
    return k;
  });
}

/* where：这个键在哪儿管用。用户最容易困惑的就是「我按了没反应」，
   多半是因为当前不在那个界面里 —— 所以每一条都标出来。 */
export const SHORTCUT_GROUPS = [
  {
    title: '随时可用',
    note: '不管你正在看哪个界面',
    items: [
      { keys: 'Alt+D', name: '打开 / 关闭 Docsmith',
        desc: '在任何网页上按都行。这个键可以在 Chrome 的「扩展程序 → 键盘快捷键」里改' },
      { keys: 'Mod+,', name: '打开设置' },
      { keys: '1', name: '切换到第 1 个能力',
        desc: '2、3…以此类推，按侧栏里的顺序' },
      { keys: 'Esc', name: '关掉当前的弹层', desc: '设置、命令面板、查找栏、全屏看图，都是这个键' },
    ],
  },
  {
    title: 'Markdown 工作台',
    note: '读文档、改文档的时候',
    items: [
      { keys: 'Mod+K', name: '命令面板', desc: '记不住键位就按这个 —— 所有功能都能在里面搜到' },
      { keys: 'Mod+O', name: '打开文件' },
      { keys: 'Mod+Shift+O', name: '打开整个文件夹' },
      { keys: 'Mod+S', name: '保存到本地' },
      { keys: 'Mod+E', name: '进入 / 退出编辑', desc: '在排好版的界面上直接改字' },
      { keys: 'Mod+Shift+E', name: '看 Markdown 原文' },
      { keys: 'Mod+F', name: '查找' },
      { keys: 'Mod+H', name: '查找并替换' },
      { keys: 'Mod+G', name: '跳到下一个匹配', desc: '加 ⇧ 是上一个。F3 也一样' },
      { keys: 'Mod+B', name: '收起 / 展开左边的侧栏' },
      { keys: 'Mod+Z', name: '撤销', desc: '编辑模式下才有用' },
      { keys: 'Mod+Shift+Z', name: '重做' },
    ],
  },
  {
    title: '看改动',
    note: '和「打开这篇时」相比改了什么',
    items: [
      { keys: 'Alt+R', name: '逐处审阅', desc: '表格能按单元格对比，每一处都可以单独接受或还原' },
      { keys: 'Alt+↓', name: '跳到下一处改动', desc: 'Alt+↑ 是上一处' },
      { keys: 'Mod+Shift+D', name: '打开未保存改动的清单' },
    ],
  },
  {
    title: '图表',
    note: '鼠标先移到图上，或者点一下图让它拿到焦点',
    items: [
      { keys: '滚轮', name: '放大 / 缩小', desc: '鼠标停在图上滚就行，不用按住别的键' },
      { keys: '拖动', name: '平移', desc: '按住左键拖' },
      { keys: '双击', name: '在「适应画布」和「原始大小」之间切换', desc: '图缩得很小时，双击直接开全屏' },
      { keys: '+', name: '放大', desc: '按 = 也一样' },
      { keys: '-', name: '缩小' },
      { keys: '0', name: '适应画布' },
      { keys: '1', name: '原始大小（100%）' },
      { keys: '↑ ↓ ← →', name: '平移', desc: '按住 ⇧ 走得更快' },
    ],
  },
  {
    title: '文件库',
    note: '上传、拿链接的那个界面',
    items: [
      { keys: '/', name: '跳到搜索框' },
      { keys: ',', name: '打开云存储设置' },
      { keys: 'Mod+O', name: '选文件上传' },
      { keys: 'Mod+V', name: '粘贴上传', desc: '复制了文件或截图之后直接粘进来' },
      { keys: 'Mod+Enter', name: '开始下载', desc: '光标在「粘贴链接」框里时' },
    ],
  },
];
