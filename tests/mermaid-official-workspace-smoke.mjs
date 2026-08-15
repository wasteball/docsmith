import { colorEncodingGallery, flowchartSixSiblingSubgraphs } from './fixtures/mermaid-cases.mjs';

const source = `# 官方 Mermaid 与本地增强回归

\`\`\`mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  CUSTOMER {
    string name
    string email
  }
\`\`\`

\`\`\`mermaid
${colorEncodingGallery.journey}
\`\`\`

\`\`\`mermaid
${colorEncodingGallery.pie}
\`\`\`

\`\`\`mermaid
${colorEncodingGallery.git}
\`\`\`

\`\`\`mermaid
${colorEncodingGallery.xy}
\`\`\`

\`\`\`mermaid
${colorEncodingGallery.sankey}
\`\`\`

\`\`\`mermaid
${colorEncodingGallery.gantt}
\`\`\`

\`\`\`mermaid
${colorEncodingGallery.state}
\`\`\`

\`\`\`mermaid
${flowchartSixSiblingSubgraphs}
\`\`\`

\`\`\`infographic
infographic list-row-horizontal-icon-arrow
data
  title 客户增长引擎
  items
    - label 线索获取
      value 18.6
      icon rocket-launch
    - label 转化提效
      value 12.4
      icon progress-check
\`\`\``;

const mount = document.querySelector('#mount');
const fail = (message) => { window.__officialMermaidSmoke = { error: String(message) }; document.body.dataset.rendered = 'error'; document.title = String(message); };
const frame = document.createElement('iframe'); frame.id = 'workspace'; frame.src = '../src/views/markdown/index.html';
frame.addEventListener('load', () => {
  const win = frame.contentWindow, doc = frame.contentDocument, started = Date.now();
  (function wait() {
    if (win.MDW && win.DocsmithDiagrams) { run(); return; }
    if (Date.now() - started > 15000) return fail('工作台没有启动');
    setTimeout(wait, 60);
  })();

  async function run() {
    try {
      if (!win.DocsmithDiagrams.hasOfficialMermaid || win.mermaid?.__docsmith) throw new Error('官方 Mermaid 没有启用');
      win.MDW.setText(source);
      const ready = await win.MDW.whenDiagramsReady({ timeout: 30000, requireSuccess: true });
      const blocks = [...doc.querySelectorAll('.diagram-block')];
      const svgs = blocks.map((block) => block.querySelector('.mm-stage > svg'));
      if (blocks.length !== 10 || svgs.some((svg) => !svg)) throw new Error(`混合文档没有生成十张图：${blocks.length}`);
      if (blocks.some((block) => block.dataset.diagramState !== 'ready')) throw new Error('图表 readiness 状态错误');

      const [er, journey, pie, git, xy, sankey, gantt, state, architecture, infographic] = svgs;
      if (!er.classList.contains('erDiagram') || !er.textContent.includes('CUSTOMER')) throw new Error('ER 图没有走官方 Mermaid');
      if (journey.classList.contains('dg') || !journey.textContent.includes('客户服务旅程')) throw new Error('Journey 图没有走官方 Mermaid');
      if (!pie.textContent.includes('渠道构成') || !git.textContent.includes('发布') || !xy.textContent.includes('Contact trend')) throw new Error('彩色数据图 gallery 渲染不完整');
      if (!sankey.textContent.includes('Leads') || !gantt.textContent.includes('关键任务') || !state.textContent.includes('处理中')) throw new Error('Sankey / Gantt / State gallery 渲染不完整');

      function visibleFills(svg, selector) {
        return new Set([...svg.querySelectorAll(selector)].map((node) => win.getComputedStyle(node).fill)
          .filter((fill) => fill && fill !== 'none' && fill !== 'rgba(0, 0, 0, 0)'));
      }
      const identityColors = {
        journey: visibleFills(journey, 'rect.task'),
        pie: visibleFills(pie, '.pieCircle'),
        git: visibleFills(git, '.commit'),
        xy: new Set([...xy.querySelectorAll('rect,line,path')].map((node) => win.getComputedStyle(node).fill + '|' + win.getComputedStyle(node).stroke)),
        sankey: visibleFills(sankey, 'rect'),
      };
      for (const [kind, colors] of Object.entries(identityColors)) {
        if (colors.size < 2) throw new Error(`${kind} 没有保留 Mermaid 官方身份色：${[...colors].join(', ')}`);
      }
      const stateFills = visibleFills(state, '.stateGroup rect,.stateGroup circle,.stateGroup path');
      if (stateFills.size > 3) throw new Error('结构型 State 图被无意义彩虹化');
      const ganttColors = new Set([...gantt.querySelectorAll('.task,.task2,.task3,.task4')].map((node) => win.getComputedStyle(node).fill));
      if (ganttColors.size < 2) throw new Error('Gantt 完成/关键状态色丢失');

      const architectureGroups = architecture.querySelectorAll('.cluster').length;
      const architectureNodes = architecture.querySelectorAll('.node').length;
      if (architecture.classList.contains('dg') || architecture.dataset.flowView || blocks[8].querySelector('.mm-flow-mode')) throw new Error('大型流程图仍被 Docsmith 自研概览接管');
      if (architectureGroups !== 6 || architectureNodes !== 24) throw new Error(`官方 Mermaid 架构图结构错误：${architectureGroups} 个子图 / ${architectureNodes} 个节点`);
      if (!['运营配置后台', '会话编排引擎', '短信与企业微信'].every((text) => architecture.textContent.includes(text))) throw new Error('官方 Mermaid 架构图关键文本丢失');
      const architectureFills = visibleFills(architecture, '.node rect,.node polygon,.node path');
      if (architectureFills.size !== 1) throw new Error('结构型 Flowchart 被彩色主题串色');
      if (blocks[9].dataset.diagramLanguage !== 'infographic' || !infographic.textContent.includes('客户增长引擎')) throw new Error('Infographic 渲染丢失');

      const html = await win.MDW.buildStandaloneHtml();
      const embedded = (html.match(/<div class="diagram-block"/g) || []).length;
      if (embedded !== 10 || html.includes('mermaid.min.js') || html.includes('正在画图')) throw new Error('独立 HTML 没有完整内嵌混合图表');
      const exported = new win.DOMParser().parseFromString(html, 'text/html');
      const inlineScript = [...exported.scripts].map((script) => script.textContent).join('\n');
      if (!inlineScript.includes('function setup(vp)') || !inlineScript.includes('function boot()')) throw new Error('独立 HTML 缺少交互启动脚本');

      const result = {
        ready: ready.ready,
        official: true,
        diagrams: blocks.length,
        erClass: er.getAttribute('class'),
        journeyText: journey.textContent.includes('客户服务旅程'),
        identityColors: Object.fromEntries(Object.entries(identityColors).map(([kind, colors]) => [kind, colors.size])),
        ganttStatusColors: ganttColors.size,
        structuralFlowFills: architectureFills.size,
        architectureEngine: 'official-mermaid',
        architectureGroups,
        architectureNodes,
        infographic: infographic.textContent.includes('客户增长引擎'),
        standaloneEmbedded: embedded,
      };
      window.__officialMermaidSmoke = result; document.body.dataset.rendered = 'true'; document.title = JSON.stringify(result);
    } catch (error) { fail(error.message); }
  }
});
mount.append(frame);
