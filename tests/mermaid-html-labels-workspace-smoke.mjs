import { flowchartRoleReadingGuide } from './fixtures/mermaid-cases.mjs';

const source = `# Mermaid HTML 标签回归

\`\`\`mermaid
${flowchartRoleReadingGuide}
\`\`\``;
const mount = document.querySelector('#mount');
const fail = (message) => {
  window.__htmlLabelsSmoke = { error: String(message) };
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
    if (Date.now() - started > 15000) { fail('工作台没有启动'); return; }
    setTimeout(wait, 60);
  })();

  async function run() {
    try {
      win.MDW.setText(source);
      await win.MDW.whenDiagramsReady({ timeout: 30000, requireSuccess: true });
      const block = doc.querySelector('.diagram-block');
      const svg = block?.querySelector('.mm-stage > svg');
      if (!svg) throw new Error('精确样例没有生成图表');
      const labels = [...svg.querySelectorAll('.node > .label')];
      const bold = [...svg.querySelectorAll('.node > .label tspan[font-weight="700"]')];
      const boldLabels = labels.filter((label) => label.querySelector('tspan[font-weight="700"]'));
      const rows = [...svg.querySelectorAll('.node > .label tspan.text-outer-tspan.row')];
      if (labels.length !== 10) throw new Error(`节点标签数量错误：${labels.length}`);
      if (boldLabels.length !== 5) throw new Error(`节点加粗没有完整保留：${boldLabels.length}`);
      if (rows.length !== 20) throw new Error(`节点换行没有完整保留：${rows.length}`);
      if (!bold.length || !bold.every((node) => Number.parseInt(win.getComputedStyle(node).fontWeight, 10) >= 600)) {
        throw new Error('节点加粗样式没有生效');
      }
      if (!['研发', '测试', '算法', '业务方', '新任 PM'].every((text) => svg.textContent.includes(text))) {
        throw new Error('节点文本丢失');
      }

      const html = await win.MDW.buildStandaloneHtml();
      const exported = new win.DOMParser().parseFromString(html, 'text/html');
      const exportedLabels = [...exported.querySelectorAll('.node > .label')];
      if (exportedLabels.filter((label) => label.querySelector('tspan[font-weight="700"]')).length !== 5 ||
          exported.querySelectorAll('.node > .label tspan.text-outer-tspan.row').length !== 20) {
        throw new Error('独立 HTML 没有保留节点富文本');
      }

      const result = {
        ready: true,
        official: win.DocsmithDiagrams.hasOfficialMermaid,
        labels: labels.length,
        boldLabels: boldLabels.length,
        rows: rows.length,
        standaloneBoldLabels: 5,
      };
      window.__htmlLabelsSmoke = result;
      document.body.dataset.rendered = 'true';
      document.title = JSON.stringify(result);
    } catch (error) { fail(error.message); }
  }
});
mount.append(frame);
