import { flowchartResponsiveDisplay } from './fixtures/mermaid-cases.mjs';

const shell = document.querySelector('#shell');
const shellHtml = await fetch('../src/app/index.html').then((response) => response.text());
const projectRoot = new URL('../', location.href).href;
const bootShim = `<script>if(!chrome.runtime)Object.defineProperty(chrome,'runtime',{configurable:true,value:{getURL:(path)=>${JSON.stringify(projectRoot)}+path}});<\/script>`;
const fail = (message) => {
  window.__responsiveMermaidShellSmoke = { error: String(message) };
  document.body.dataset.rendered = 'error';
  document.title = String(message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextPaint = (win) => new Promise((resolve) =>
  win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));

/* The production shell only needs getURL during startup. This narrow test shim keeps
   the real inlineMount / bus / activation path intact when the fixture runs over HTTP. */
shell.addEventListener('load', () => {
  const win = shell.contentWindow;
  const started = Date.now();
  (function ready() {
    const doc = shell.contentDocument;
    if (win.MDW && doc.querySelector('[data-ds-host="markdown"]')) { run(); return; }
    const error = doc.querySelector('.frame-err')?.textContent;
    if (error) { fail(error); return; }
    if (Date.now() - started > 20000) { fail('真实外壳没有完成 Markdown 挂载'); return; }
    setTimeout(ready, 80);
  })();

  function diagram() {
    const doc = shell.contentDocument;
    const block = doc.querySelector('[data-ds-host="markdown"] .diagram-block');
    return { block, vp: block?.querySelector('.mm-viewport'), svg: block?.querySelector('.mm-stage > svg') };
  }

  function assertContained(label) {
    const { vp, svg } = diagram();
    if (!vp?.__pz?.state || !svg) throw new Error(`${label}：图表/API 缺失`);
    vp.__pz.flush();
    const state = vp.__pz.state(), vr = vp.getBoundingClientRect(), sr = svg.getBoundingClientRect(), eps = 1.2;
    if (!state.ready || state.mode !== 'auto-fit' || vp.dataset.fitState !== 'ready') {
      throw new Error(`${label}：图表未完成 auto-fit`);
    }
    if (sr.left < vr.left - eps || sr.right > vr.right + eps || sr.top < vr.top - eps || sr.bottom > vr.bottom + eps) {
      throw new Error(`${label}：图表超出外壳画布`);
    }
    if (Math.abs((sr.left + sr.right - vr.left - vr.right) / 2) > 1.1 ||
        Math.abs((sr.top + sr.bottom - vr.top - vr.bottom) / 2) > 1.1) {
      throw new Error(`${label}：图表没有居中`);
    }
    return { width: vr.width, height: vr.height, scale: state.scale, mode: state.mode };
  }

  async function clickCapability(id) {
    const button = shell.contentDocument.querySelector(`.cap[data-id="${id}"]`);
    if (!button) throw new Error(`能力按钮缺失：${id}`);
    button.click();
    await wait(120); await nextPaint(win);
  }

  async function run() {
    try {
      const doc = shell.contentDocument;
      win.MDW.applyReadingSetting('width', 860);
      win.MDW.setText(`# 外壳激活回归\n\n\`\`\`mermaid\n${flowchartResponsiveDisplay}\n\`\`\``);
      await win.MDW.whenDiagramsReady({ timeout: 30000, requireSuccess: true });
      const initial = assertContained('外壳初始');
      const { vp } = diagram();
      vp.__pz.zoomAt(2); vp.__pz.flush();
      if (vp.__pz.state().mode !== 'user-view') throw new Error('外壳中没有建立用户视角');

      await clickCapability('cards');
      if (!doc.querySelector('.frame[data-id="cards"].active')) throw new Error('没有切到图文卡片');
      shell.style.width = '980px'; shell.style.height = '720px';
      await wait(180);
      await clickCapability('markdown');
      await win.MDW.refreshDiagramLayout('shell-test-settled');
      const activation = assertContained('能力重新激活');

      const root = win.MDW.root();
      if (!root.classList.contains('active') || root !== doc.querySelector('.frame[data-id="markdown"]')) {
        throw new Error('Markdown 根容器没有重新激活');
      }
      const result = { ready: true, inlineMount: true, activationMessage: true, initial, activation };
      window.__responsiveMermaidShellSmoke = result;
      document.body.dataset.rendered = 'true';
      document.title = JSON.stringify(result);
    } catch (error) { fail(error.message); }
  }
});

shell.srcdoc = shellHtml.replace('<head>', '<head><base href="../src/app/">' + bootShim);
