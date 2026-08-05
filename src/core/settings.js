/* =====================================================================
 * Docsmith · 设置（全应用唯一一份）
 * ---------------------------------------------------------------------
 * 之前有三处设置：外壳一个、文件库一个、Markdown 工作台一个。外观开关
 * 在三处各有一套，云存储配置在两处各有一份，用户根本不知道该去哪儿改。
 *
 * 根因是 iframe：每个页面是独立文档，只能各自带一套设置界面。这是单页
 * 应用时代不得已的做法 —— 扩展里所有页面同源，这个约束早就没有了。
 *
 * 现在设置是**一份数据**，在一个面板里呈现，按"用户想改什么"分区，
 * 而不是按"这个开关的代码写在哪个文件里"分区。
 *
 * 加设置项 = 在这里加一条。不用碰界面代码。
 * ===================================================================== */

/* 设置值存在哪：
 *   prefs      → core/prefs.js（大多数偏好）
 *   appearance → 主题与强调色（要在首帧前生效，单独存）
 *   storage    → 云存储配置（含凭据，单独存，导出时会被剔除）
 *   action     → 不是值，是一个动作按钮
 */

/* 分组：左边导航按这三组分段。
   为什么要分：原来九个分区平铺在一列，「外观」「云存储」「数据与备份」
   混在一起 —— 想调字号的人要从一串名词里挑，而「清空数据」这种不可逆的
   操作和「换个强调色」长得一样重。
   分组之后，最常用的在最上面，危险动作在最下面，找东西的路径短一截。
   group 值对应下面 SECTION_GROUPS 里的 id；漏写的会归到最后一组。 */
export const SECTION_GROUPS = [
  { id: 'basic', title: '常用' },
  { id: 'files', title: '文件与云' },
  { id: 'advanced', title: '进阶' },
];

export const SECTIONS = [
  {
    id: 'appearance',
    group: 'basic',
    title: '外观',
    icon: '◐',
    desc: '整个应用一起变',
    fields: [
      {
        key: 'theme', store: 'appearance', type: 'segment', label: '主题', default: 'light',
        options: [
          { value: 'light', label: '亮' },
          { value: 'dark', label: '暗' },
          { value: 'auto', label: '跟随系统' },
        ],
      },
      { key: 'accent', store: 'appearance', type: 'swatches', label: '强调色', default: 'blue' },
    ],
  },

  {
    id: 'reading',
    group: 'basic',
    title: '阅读',
    icon: 'Aa',
    desc: '打开文档时的排版',
    fields: [
      {
        /* 默认黑体 —— 必须和 workspace.js 里 settings.font 的默认值保持一致。
           改这里记得同时改那边。
           三档都必须在 doc.css 里有对应的 .doc.font-* 那一支，否则就是个
           「选了没反应」的假选项（见 [[docsmith-phantom-ui-options]]）。 */
        key: 'reading.font', type: 'segment', label: '正文字体', default: 'sans',
        options: [
          { value: 'sans', label: '黑体', hint: '屏幕上更清晰' },
          { value: 'round', label: '圆体', hint: '笔画柔和，看久了眼睛最松' },
          { value: 'serif', label: '衬线', hint: '像纸书，长文更耐读' },
        ],
      },
      { key: 'reading.size', type: 'slider', label: '字号', default: 18, min: 14, max: 24, step: 1, unit: 'px' },
      { key: 'reading.width', type: 'slider', label: '每行宽度', default: 860, min: 620, max: 1200, step: 20, unit: 'px',
        help: '一行 30 到 40 个汉字读起来最省力。' },
      { key: 'reading.customCss', type: 'textarea', label: '自定义样式', placeholder: '.doc h1 { color: #333 }',
        help: '懂 CSS 的话可以微调排版。留空即可。' },
    ],
  },

  {
    /* 快捷键说明。放在「常用」里、而且紧跟阅读之后 —— 这些键大多是读文档
       时用的，用户翻设置的时候顺手就看见了。
       清单本身在 core/shortcuts.js（那里有「改绑定要回来改说明」的提醒），
       渲染在 app/main.js 的 mountShortcutsPanel。 */
    id: 'shortcuts',
    group: 'basic',
    title: '快捷键',
    icon: '⌘',
    desc: '按键位分组列出来。键位按你的系统显示（Windows 是 Ctrl，Mac 是 ⌘）',
    fields: [
      { key: '__shortcuts__', type: 'shortcuts' },
    ],
  },

  {
    id: 'storage',
    group: 'files',
    title: '云存储',
    icon: '☁',
    desc: '文件传到你自己的空间，生成分享链接',
    fields: [
      { key: '__storage__', type: 'storage-form' },
    ],
  },

  {
    id: 'upload',
    group: 'files',
    title: '上传与分享',
    icon: '⤴',
    fields: [
      { key: 'files.autoCopy', type: 'toggle', label: '传完自动复制链接', default: true,
        help: '省掉一次点击。关掉的话可以在记录里手动复制。' },
      {
        key: 'files.concurrency', type: 'segment', label: '同时上传几个', default: 2,
        options: [
          { value: 1, label: '1', hint: '网络不稳时更可靠' },
          { value: 2, label: '2' },
          { value: 4, label: '4' },
          { value: 6, label: '6', hint: '快，但可能被限流' },
        ],
        help: '传大量小文件时调大会明显变快；传大文件建议保持 2。',
      },
      {
        key: 'share.format', type: 'select', label: '分享文案格式', default: 'name_url',
        options: [
          { value: 'name_url', label: '文件名 + 换行 + 链接', hint: '发微信、钉钉最清楚' },
          { value: 'inline', label: '文件名 — 链接', hint: '一行放得下' },
          { value: 'markdown', label: 'Markdown 链接', hint: '粘进文档里可点击' },
          { value: 'url', label: '只要链接', hint: '贴进表格或代码里' },
        ],
      },
      { key: 'files.fixMojibake', type: 'toggle', label: '自动修复乱码文件名', default: true,
        help: '从 Windows 压缩包解出来的中文名常是乱码，会自动还原。' },
    ],
  },

  {
    id: 'download',
    group: 'files',
    title: '下载时默认转成',
    icon: '↓',
    desc: '也能在下载那一刻单独选',
    fields: [
      {
        /* 这里只列真的转得出来的格式。原来还有一个「转成网页」——
           下载器里从来没有对应的转换函数，dlPref() 又会把认不出的值
           当成「没设默认」悄悄丢掉：选了它既不报错也不生效，纯粹是个
           空按钮。要加回来，得先有 md → html 的转换。 */
        key: 'files.dlMarkdown', type: 'select', label: 'Markdown 文件', default: 'original',
        options: [
          { value: 'original', label: '保持原样 .md' },
          { value: 'docx', label: '转成 Word' },
          { value: 'pdf', label: '转成 PDF' },
        ],
        help: 'PDF 转换组件体积太大，没有随包附带：选了会提示改走 Markdown 工作台的「导出 → PDF」，那条路不用装任何东西。',
      },
      {
        key: 'files.dlPptx', type: 'select', label: 'PowerPoint 文件', default: 'original',
        options: [
          { value: 'original', label: '保持原样 .pptx' },
          { value: 'pdf', label: '转成 PDF' },
        ],
        help: 'PPT 转 PDF 同样需要没随包附带的组件，目前会按原样下载。',
      },
    ],
  },

  {
    id: 'menu',
    group: 'advanced',
    title: '菜单',
    icon: '☰',
    desc: '拖动调顺序，用不上的可以藏起来',
    fields: [
      { key: '__menu__', type: 'menu-editor' },
    ],
  },

  {
    id: 'window',
    group: 'advanced',
    title: '打开方式',
    icon: '⤢',
    fields: [
      {
        /* 默认整页。这个插件主要用来读文档、看图表、导出 —— 侧边栏只有
           300–400px 宽，一张流程图得缩到 0.05 倍才塞得进去。要一边看网页
           一边传文件的人可以自己切回侧边栏，但那不该是第一次打开的样子。 */
        key: 'ui.openMode', type: 'segment', label: '点工具栏图标时', default: 'tab',
        options: [
          { value: 'tab', label: '整页', hint: '读长文档、看图表更舒服' },
          { value: 'panel', label: '侧边栏', hint: '一边看网页一边用' },
        ],
      },
    ],
  },

  {
    id: 'memory',
    group: 'advanced',
    title: '记住了我什么',
    icon: '⟲',
    desc: '这些都存在你自己的电脑上，没有上传。想清哪一项就点旁边的「忘掉」',
    fields: [
      { key: '__memory__', type: 'memory' },
    ],
  },

  {
    id: 'data',
    group: 'advanced',
    title: '数据与备份',
    icon: '⛁',
    desc: '所有东西都存在这台电脑上，没有上传到任何地方',
    fields: [
      { key: '__components__', type: 'components' },
      { key: '__export__', type: 'action', label: '导出配置',
        help: '换电脑时带走菜单、分类和偏好。密钥不会被导出。' },
      { key: '__import__', type: 'action', label: '导入配置' },
      { key: '__forgetUsage__', type: 'action', label: '清除使用统计',
        help: '清掉「你最常导出成什么」这类推断，回到出厂默认。' },
      { key: '__clearHistory__', type: 'action', label: '清空上传记录', danger: true,
        help: '只清本地列表 —— 云上的文件不会删，已发出去的链接照样能打开。' },
    ],
  },
];

/** 摊平成 { key: 默认值 }，只含存进 prefs 的项。 */
export function defaults() {
  const out = {};
  for (const sec of SECTIONS) {
    for (const f of sec.fields) {
      if (f.default !== undefined && !f.key.startsWith('__') && f.store !== 'appearance') {
        out[f.key] = f.default;
      }
    }
  }
  return out;
}

export function fieldOf(key) {
  for (const sec of SECTIONS) {
    const f = sec.fields.find((x) => x.key === key);
    if (f) return f;
  }
  return null;
}

/** 把存进来的值收敛成合法值。早期版本把布尔和数字都存成了字符串。 */
export function coerce(key, value) {
  const f = fieldOf(key);
  if (!f) return value;
  switch (f.type) {
    case 'toggle':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'slider':
      return Math.min(f.max, Math.max(f.min, Number.isFinite(+value) ? +value : f.default));
    case 'segment':
    case 'select': {
      const hit = (f.options || []).find((o) => String(o.value) === String(value));
      return hit ? hit.value : f.default;
    }
    default:
      return value ?? f.default;
  }
}
