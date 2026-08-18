/* 回归：图表内容必须完全落在 SVG 自己的 viewBox 之内。

   这条测试守的是一个真实事故：Mermaid 的 setupViewPortForSVG() 拿「布局那一刻」
   的 getBBox() 写 viewBox，等 SVG 挂进工作台、字体落地、doc.css 生效之后，
   文本度量变了，内容会长到 viewBox 外面（实测中文流程图右 +55、下 +64 user unit）。
   viewBox 对最外层 <svg> 是硬裁剪边界，而 svgDims() 又只按 viewBox 算容器尺寸，
   于是 fit() 以为"刚好装下"，用户看到的却是缺一截的图。

   判定只用 viewBox 与 getBBox —— 两者同处 SVG user space，跟 CSS transform、
   rAF 时机、devicePixelRatio 都无关，所以在无头浏览器里也不会出现假阴/假阳。 */
const source = `# 图表不允许被自身 viewBox 裁掉

\`\`\`mermaid
flowchart TD
  subgraph S["当前交付模式"]
    direction TB
    A["客户需求"] --> B["排队等专家"]
    B --> C["专家全程手工<br/>清洗→建模→偏移→报告"]
    C --> D["交付方案"]
  end
  S --> E["需求排队积压"]
  S --> G["分公司无法自助<br/>只能上交总部"]
  S --> H["口径不一<br/>质量参差"]
  E --> F["交付慢<br/>无法规模化"]
  G --> F
  H --> F
  F --> I["定性为<br/>「无财务收益的<br/>技术能力建设」"]
  I --> J["无需做收益测算"]
  J --> K["无需建立<br/>业务基线"]
  K --> L["验收标准只能<br/>从技术侧找<br/>「上线了、跑通了」"]
  L --> M["无法回答<br/>值不值得投"]
\`\`\`

\`\`\`mermaid
flowchart LR
${Array.from({ length: 10 }, (_, i) => `  W${i}["环节 ${i + 1}<br/>补充说明文字"] --> W${i + 1}["环节 ${i + 2}"]`).join('\n')}
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant 客户 as 分公司客户
  participant 台 as 交付平台
  participant 家 as 总部专家
  客户->>台: 提交需求与原始数据
  台->>家: 排队等待专家介入
  家-->>台: 手工清洗与建模结果
  台-->>客户: 输出交付方案与报告
  Note over 客户,家: 全流程依赖专家排期，无法规模化
\`\`\`

\`\`\`mermaid
gantt
  title 交付平台建设节奏
  dateFormat YYYY-MM-DD
  section 第一阶段
  需求澄清与基线确认 :done, a1, 2026-01-05, 20d
  自助建模能力开发   :active, a2, after a1, 35d
  section 第二阶段
  分公司试点与回收反馈 : a3, after a2, 30d
\`\`\``;

const fail = (message) => {
  window.__viewboxSmoke = { error: String(message) };
  document.body.dataset.rendered = 'error';
  document.title = String(message);
};

const frame = document.createElement('iframe');
frame.id = 'workspace';
frame.src = '../src/views/markdown/index.html';
frame.addEventListener('load', () => {
  const win = frame.contentWindow, doc = frame.contentDocument, started = Date.now();
  (function wait() {
    if (win.MDW && win.DocsmithDiagrams) { run(); return; }
    if (Date.now() - started > 20000) return fail('工作台没有启动');
    setTimeout(wait, 60);
  })();

  async function run() {
    try {
      win.MDW.setText(source);
      const ready = await win.MDW.whenDiagramsReady({ timeout: 40000, requireSuccess: true });
      if (!ready.ready) throw new Error('图表没有全部渲染完成');

      const blocks = [...doc.querySelectorAll('.diagram-block')];
      if (blocks.length !== 4) throw new Error(`期望 4 张图，实际 ${blocks.length}`);

      const EPSILON = 2;   // 抗亚像素抖动，和 diagram-browser-geometry.html 的 insideViewBox 一致
      const results = blocks.map((block, i) => {
        const svg = block.querySelector('.mm-stage > svg');
        if (!svg) throw new Error(`第 ${i + 1} 张图没有挂载 SVG`);
        const vb = svg.viewBox.baseVal;
        if (!vb || !vb.width) throw new Error(`第 ${i + 1} 张图没有 viewBox`);
        const bb = svg.getBBox();
        const outside = {
          left: +(vb.x - bb.x).toFixed(1),
          top: +(vb.y - bb.y).toFixed(1),
          right: +((bb.x + bb.width) - (vb.x + vb.width)).toFixed(1),
          bottom: +((bb.y + bb.height) - (vb.y + vb.height)).toFixed(1),
        };
        const worst = Math.max(outside.left, outside.top, outside.right, outside.bottom);
        if (worst > EPSILON) {
          throw new Error(`第 ${i + 1} 张图（${svg.getAttribute('aria-roledescription') || '未知'}）`
            + `内容超出自身 viewBox：左 ${outside.left} / 上 ${outside.top} / 右 ${outside.right} / 下 ${outside.bottom}`);
        }
        /* 容器高度必须按「装得下缩放后的图」来定，而不是比图还矮。
           setHeight 分支里 boxH = d.h * k + PAD*2，所以这条同时守住 fit() 的算术。 */
        const vp = block.querySelector('.mm-viewport');
        const pz = vp && vp.__pz;
        if (!pz) throw new Error(`第 ${i + 1} 张图没有 pan/zoom 实例`);
        const scale = pz.scale;
        if (!(scale > 0)) throw new Error(`第 ${i + 1} 张图缩放比非法：${scale}`);
        const boxH = vp.getBoundingClientRect().height;
        const needH = bb.height * scale;
        if (needH - boxH > EPSILON + 28) {   // 28 = 上下各 14 的 MM_PAD
          throw new Error(`第 ${i + 1} 张图容器装不下缩放后的内容：需要 ${needH.toFixed(1)}，容器 ${boxH.toFixed(1)}`);
        }
        return {
          kind: svg.getAttribute('aria-roledescription') || 'diagram',
          outside, scale: +scale.toFixed(4), boxH: Math.round(boxH),
        };
      });

      /* 导出的离线 HTML 里有一份独立的 setup()/fit() 实现（EXPORT_JS），
         它当年也只读 viewBox。这里确认导出件同样带上了扩框逻辑。 */
      const html = await win.MDW.buildStandaloneHtml();
      if (!/getBBox\(\)/.test(html)) throw new Error('导出的 HTML 没有把 viewBox 扩到实际内容框');

      const result = { ready: true, diagrams: results.length, cases: results, standaloneWidensViewBox: true };
      window.__viewboxSmoke = result;
      document.body.dataset.rendered = 'true';
      document.title = JSON.stringify(result);
    } catch (err) {
      fail((err && err.message) || err);
    }
  }
});
document.querySelector('#mount').append(frame);
