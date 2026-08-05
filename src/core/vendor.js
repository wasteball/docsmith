/* =====================================================================
 * Docsmith · 组件检测
 * ---------------------------------------------------------------------
 * 有些功能靠第三方库实现（画流程图、写 Word、导 PDF）。如果安装时某个库
 * 没下下来，我们不让页面白屏 —— 而是把对应的按钮藏起来，并在用户真的点
 * 到相关功能时，用一句人话说清楚缺了什么、怎么补。
 * ===================================================================== */

const FEATURES = {
  markdown:  { global: 'marked',       label: 'Markdown 渲染', required: true,
               note: '这是核心组件，缺了它 Markdown 打不开。' },
  sanitize:  { global: 'DOMPurify',    label: '安全过滤',      required: true,
               note: '用来挡住文档里可能夹带的恶意代码。' },
  highlight: { global: 'hljs',         label: '代码高亮',      required: false,
               note: '缺了它代码块会以纯文本显示，内容不受影响。' },
  math:      { global: 'katex',        label: '数学公式',      required: false,
               note: '缺了它公式会显示成原始文本。' },
  diagram:   { global: 'mermaid',      label: '流程图',        required: false,
               note: '缺了它流程图会显示成代码块。' },
  word:      { global: 'docx',         label: '导出 Word',     required: false,
               note: '缺了它就没法导出 .docx，其他导出格式照常。' },
  pdf:       { global: 'html2pdf',     label: '文件库 PDF 转换', required: false,
               note: '缺了它，文件库里「下载时顺手转成 PDF」用不了；'
                   + 'Markdown 工作台的「导出 → PDF」不受影响。' },
  pptx:      { global: 'pptxPreviewer',label: 'PowerPoint 转换', required: false,
               note: '缺了它没法把 PPT 转成 PDF。' },
  zip:       { global: 'DSZip',        label: '打包下载',      required: false,
               note: '插件自带，用浏览器的压缩能力打包，不需要额外组件。' },
};

/** 某个功能现在可用吗？ */
export function has(feature) {
  const f = FEATURES[feature];
  if (!f) return false;
  return typeof window[f.global] !== 'undefined';
}

/** 用的是自带的简化版，而不是完整组件？ */
export function isBuiltin(feature) {
  const f = FEATURES[feature];
  return !!(f && window[f.global]?.__builtin);
}

/** 完整组件都到齐了吗？用于判断要不要提示"可以升级到完整版"。 */
export function fullyEquipped() {
  return Object.keys(FEATURES).every((k) => has(k) && !isBuiltin(k));
}

/* 缺失时给用户看的一段话。
   以前这里写的是"在扩展目录里运行 npm run setup" —— 对着一个只想装个插件
   读文档的人说这句话，等于没说。改成：讲清楚少了什么、现在还能怎么办，
   不要求对方去装任何开发工具。 */
const WORKAROUND = {
  highlight: '代码块会以纯文本显示，一个字都不会少，只是没有配色。',
  math: '公式会显示成原始文本，内容不受影响。',
  diagram: '插件自带的画图器已经接管，流程图照常显示。',
  word: '可以先「导出 → 网页」再用 Word 打开，或者「打印 → 另存为 PDF」。',
  pdf: '文件库里的格式转换用不了；把文件下载成 .md，再到 Markdown 工作台用「导出 → PDF」，效果一样。',
  pptx: 'PPT 会按原样下载，不做转换。',
  zip: '批量下载会变成一个一个下，文件本身没区别。',
};

export function missingMessage(feature) {
  const f = FEATURES[feature];
  if (!f) return '这个功能暂时不可用。';
  return `这个版本里没有带「${f.label}」组件。\n\n${WORKAROUND[feature] || f.note}`;
}

/** 所有必需组件都在吗？用于首屏判断。 */
export function coreReady() {
  return Object.entries(FEATURES)
    .filter(([, f]) => f.required)
    .every(([k]) => has(k));   // 自带的渲染器也算数 —— 它就是为这一刻准备的
}

/** 体检报告，设置页里显示。 */
export function report() {
  return Object.entries(FEATURES).map(([key, f]) => ({
    key,
    label: f.label,
    required: f.required,
    ok: has(key),
    builtin: isBuiltin(key),
    note: f.note,
  }));
}

/** 按功能是否可用，批量显示/隐藏界面元素。用 data-needs="word" 标记。 */
export function applyGating(root = document) {
  root.querySelectorAll('[data-needs]').forEach((el) => {
    const needed = el.dataset.needs.split(/[\s,]+/).filter(Boolean);
    const ok = needed.every((n) => has(n));
    el.hidden = !ok;
    if (!ok) el.setAttribute('aria-hidden', 'true');
  });
}
