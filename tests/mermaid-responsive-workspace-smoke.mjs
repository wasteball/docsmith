import {
  flowchartResponsiveDisplay,
  flowchartRoleReadingGuide,
} from './fixtures/mermaid-cases.mjs';

const source = `# Mermaid 显示器响应式回归

\`\`\`mermaid
${flowchartResponsiveDisplay}
\`\`\`

\`\`\`mermaid
${flowchartRoleReadingGuide}
\`\`\``;
const mount = document.querySelector('#mount');
const fail = (message) => {
  window.__responsiveMermaidSmoke = { error: String(message) };
  document.body.dataset.rendered = 'error';
  document.title = String(message);
};
const nextPaint = (target = window) => new Promise((resolve) =>
  target.requestAnimationFrame(() => target.requestAnimationFrame(resolve)));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = document.createElement('iframe');
frame.id = 'workspace';
frame.src = '../src/views/markdown/index.html';

frame.addEventListener('load', () => {
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  const started = Date.now();
  (function ready() {
    if (win.MDW && win.DocsmithDiagrams) { run(); return; }
    if (Date.now() - started > 15000) { fail('响应式测试工作台没有启动'); return; }
    setTimeout(ready, 60);
  })();

  function diagram(index = 0) {
    const block = doc.querySelectorAll('.diagram-block')[index];
    return {
      block,
      vp: block?.querySelector('.mm-viewport'),
      stage: block?.querySelector('.mm-stage'),
      svg: block?.querySelector('.mm-stage > svg'),
    };
  }

  function exactDiagram() { return diagram(1); }

  function approx(a, b, tolerance, message) {
    if (Math.abs(a - b) > tolerance) throw new Error(`${message}：${a} / ${b}`);
  }

  function assertViewportContained(label, vp, graphic, expectedMode = 'auto-fit') {
    if (!vp || !graphic || !vp.__pz?.state) throw new Error(`${label}：图表画布/API 缺失`);
    vp.__pz.flush();
    const state = vp.__pz.state();
    if (!state.ready || vp.dataset.fitState !== 'ready') throw new Error(`${label}：画布仍为 pending`);
    if (expectedMode && state.mode !== expectedMode) throw new Error(`${label}：模式为 ${state.mode}`);
    const vr = vp.getBoundingClientRect(), sr = graphic.getBoundingClientRect(), eps = 1.2;
    if (sr.left < vr.left - eps || sr.right > vr.right + eps || sr.top < vr.top - eps || sr.bottom > vr.bottom + eps) {
      throw new Error(`${label}：SVG 超出视口 ${JSON.stringify({
        viewport: [vr.left, vr.top, vr.right, vr.bottom],
        svg: [sr.left, sr.top, sr.right, sr.bottom], state,
      })}`);
    }
    approx((sr.left + sr.right) / 2, (vr.left + vr.right) / 2, 1.1, `${label}：横向未居中`);
    approx((sr.top + sr.bottom) / 2, (vr.top + vr.bottom) / 2, 1.1, `${label}：纵向未居中`);
    if (expectedMode === 'auto-fit') {
      approx(state.scale, state.baseScale, 0.0001, `${label}：scale/base 不一致`);
      approx(state.x, state.baseX, 0.2, `${label}：x/base 不一致`);
      approx(state.y, state.baseY, 0.2, `${label}：y/base 不一致`);
    }
    return { width: vr.width, height: vr.height, scale: state.scale, dpr: state.layout?.dpr };
  }

  function assertContained(label, expectedMode = 'auto-fit', index = 0) {
    const { vp, svg } = diagram(index);
    return assertViewportContained(label, vp, svg, expectedMode);
  }

  function assertExactContained(label, expectedMode = 'auto-fit') {
    return assertContained(label, expectedMode, 1);
  }

  function assertSvgStructure() {
    const { vp, svg } = exactDiagram();
    if (!svg || svg.classList.contains('dg')) throw new Error('精确样例没有走官方 Mermaid');
    const text = svg.textContent;
    const expected = ['研发', '测试', '算法', '业务方', '新任 PM', '状态机', '异常矩阵', '选址', '用户任务', '配套学习材料'];
    if (!expected.every((value) => text.includes(value))) throw new Error('精确样例关键文本丢失');
    const nodes = [...svg.querySelectorAll('.node')];
    const labels = [...svg.querySelectorAll('.node > .label')];
    const boldLabels = labels.filter((label) => label.querySelector('tspan[font-weight="700"]'));
    const rows = [...svg.querySelectorAll('.node > .label tspan.text-outer-tspan.row')];
    if (nodes.length !== 10 || labels.length !== 10 || boldLabels.length !== 5 || rows.length !== 20) {
      throw new Error(`精确样例结构不完整：${nodes.length} nodes / ${boldLabels.length} bold / ${rows.length} rows`);
    }
    const findNode = (id) => [...svg.querySelectorAll('.node')].find((node) => node.id.includes(`-flowchart-${id}-`));
    const rightColumn = ['P1', 'P2', 'P3', 'P4', 'P5'].map(findNode);
    if (rightColumn.some((node) => !node)) throw new Error('右列 P1–P5 节点缺失');
    const vr = vp.getBoundingClientRect(), eps = 1.2;
    rightColumn.forEach((node, index) => {
      const nr = node.getBoundingClientRect();
      if (nr.left < vr.left - eps || nr.right > vr.right + eps || nr.top < vr.top - eps || nr.bottom > vr.bottom + eps) {
        throw new Error(`右列 P${index + 1} 被裁剪`);
      }
    });
    const r5 = findNode('R5');
    const r5Shape = r5?.querySelector('rect,polygon,path');
    const r5Style = r5Shape && win.getComputedStyle(r5Shape);
    const color = document.createElement('span');
    color.style.color = '#e8f4ff';
    doc.body.append(color);
    const expectedFill = win.getComputedStyle(color).color;
    color.remove();
    if (!r5Style || r5Style.fill !== expectedFill || !r5Style.stroke || r5Style.stroke === 'none') {
      throw new Error(`R5 作者配色丢失：${r5Style?.fill} / ${r5Style?.stroke}`);
    }
    const vb = svg.viewBox.baseVal, bb = svg.getBBox(), bboxEps = 1;
    if (bb.x < vb.x - bboxEps || bb.y < vb.y - bboxEps || bb.x + bb.width > vb.x + vb.width + bboxEps || bb.y + bb.height > vb.y + vb.height + bboxEps) {
      throw new Error('Mermaid viewBox 没有包住完整绘图 bbox');
    }
  }

  function sameView(a, b) {
    return ['scale', 'x', 'y', 'baseScale', 'baseX', 'baseY', 'mode'].every((key) => a[key] === b[key]);
  }

  function wheel(vp, init = {}) {
    const rect = vp.getBoundingClientRect();
    const event = new win.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -1000,
      clientX: rect.left + rect.width * 0.7,
      clientY: rect.top + rect.height / 2,
      ...init,
    });
    const propagated = vp.dispatchEvent(event);
    vp.__pz.flush();
    return { propagated, defaultPrevented: event.defaultPrevented, state: vp.__pz.state() };
  }

  function assertInlineWheelPolicy() {
    const { vp } = exactDiagram();
    const before = vp.__pz.state();
    for (let index = 0; index < 3; index += 1) {
      const plain = wheel(vp);
      if (!plain.propagated || plain.defaultPrevented) throw new Error('行内普通滚轮被错误拦截');
      if (!sameView(before, plain.state)) throw new Error('行内普通滚轮错误改变了图表视角');
    }
    assertExactContained('办公电脑普通滚动后精确 LR');

    const ctrl = wheel(vp, { deltaY: -160, ctrlKey: true });
    if (ctrl.propagated || !ctrl.defaultPrevented || ctrl.state.mode !== 'user-view' || ctrl.state.scale <= before.scale) {
      throw new Error('行内 Ctrl + 滚轮没有缩放图表');
    }
    vp.__pz.fit(); vp.__pz.flush();

    const meta = wheel(vp, { deltaY: -160, metaKey: true });
    if (meta.propagated || !meta.defaultPrevented || meta.state.mode !== 'user-view' || meta.state.scale <= meta.state.baseScale) {
      throw new Error('行内 ⌘ + 滚轮没有缩放图表');
    }
    vp.__pz.fit(); vp.__pz.flush();
    assertExactContained('修饰键缩放复位后精确 LR');
    return { plainScroll: true, ctrlZoom: true, metaZoom: true, containedAfterScroll: true };
  }

  async function resizeFrame(width, height, label) {
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    mount.style.width = `${width}px`;
    mount.style.height = `${height}px`;
    await win.MDW.refreshDiagramLayout(label);
    await wait(160);
    await win.MDW.refreshDiagramLayout(`${label}-settled`);
    const primary = assertContained(label);
    assertExactContained(`${label} 精确 LR`);
    return primary;
  }

  async function assertRevealAfterZeroWidth() {
    const { vp } = diagram();
    const block = diagram().block;
    const prior = block.style.display;
    block.style.display = 'none';
    vp.__pz.zoomAt(2); vp.__pz.flush();
    if (vp.__pz.state().mode !== 'user-view') throw new Error('隐藏前没有建立用户视角');
    frame.style.width = '820px'; frame.style.height = '680px';
    mount.style.width = '820px'; mount.style.height = '680px';
    await win.MDW.refreshDiagramLayout('hidden-zero-width');
    block.style.display = prior;
    await win.MDW.refreshDiagramLayout('revealed');
    const result = assertContained('隐藏后恢复');
    if (vp.__pz.state().mode !== 'auto-fit') throw new Error('隐藏后恢复仍保留旧 transform');
    return result;
  }

  async function assertFullscreenResponsive() {
    const button = diagram().block.querySelector('[data-z="full"]');
    if (!button) throw new Error('全屏按钮缺失');
    button.click();
    await wait(80); await win.MDW.refreshDiagramLayout('fullscreen-test');
    const overlay = doc.querySelector('#overlay');
    const vp = overlay?.querySelector('.mm-viewport');
    const svg = vp?.querySelector('svg');
    if (!overlay?.classList.contains('open')) throw new Error('全屏画布没有打开');
    const initial = assertViewportContained('全屏初始', vp, svg);
    const beforeWheel = vp.__pz.state();
    const plainWheel = wheel(vp, { deltaY: -160 });
    if (plainWheel.propagated || !plainWheel.defaultPrevented || plainWheel.state.mode !== 'user-view' || plainWheel.state.scale <= beforeWheel.scale) {
      throw new Error('全屏普通滚轮没有缩放图表');
    }
    vp.__pz.zoomAt(2); vp.__pz.flush();
    const zoomed = vp.__pz.state();
    if (zoomed.mode !== 'user-view') throw new Error('全屏缩放没有进入 user-view');
    frame.style.width = '760px'; frame.style.height = '640px';
    mount.style.width = '760px'; mount.style.height = '640px';
    await wait(180); await win.MDW.refreshDiagramLayout('fullscreen-resize');
    const resized = assertViewportContained('全屏 resize', vp, svg);
    if (vp.__pz.state().mode !== 'auto-fit') throw new Error('全屏 resize 后没有恢复 auto-fit');
    overlay.querySelector('.overlay-close').click();
    return { initial, resizeAfterZoom: resized };
  }

  async function assertPrintGeometry() {
    const { vp, svg } = diagram();
    const original = {
      viewport: vp.getAttribute('style'),
      stage: vp.querySelector('.mm-stage').getAttribute('style'),
      svg: svg.getAttribute('style'),
      fitState: vp.dataset.fitState,
    };
    const style = doc.createElement('style');
    style.id = 'responsive-print-probe';
    style.textContent = '.doc .mm-viewport{overflow:visible!important;height:auto!important}.doc .mm-stage{transform:none!important;visibility:visible!important}.doc .mm-stage svg{width:100%!important;height:auto!important;max-width:100%!important;max-height:245mm!important;object-fit:contain;margin:0 auto!important}';
    vp.dataset.fitState = 'pending';
    doc.head.append(style);
    await nextPaint(win);
    try {
      const vr = vp.getBoundingClientRect(), sr = svg.getBoundingClientRect();
      const stageStyle = win.getComputedStyle(vp.querySelector('.mm-stage'));
      if (!sr.width || !sr.height || sr.width > vr.width + 1.2) throw new Error(`打印图表横向溢出：${sr.width} / ${vr.width}`);
      if (stageStyle.transform !== 'none') throw new Error('打印图表仍带工作台 transform');
      if (stageStyle.visibility !== 'visible') throw new Error('打印图表仍被 pending 状态隐藏');
      return { viewportWidth: vr.width, svgWidth: sr.width, transform: 'none', visibility: 'visible' };
    } finally {
      style.remove();
      vp.dataset.fitState = original.fitState;
      const stage = vp.querySelector('.mm-stage');
      const restore = (el, value) => value == null ? el.removeAttribute('style') : el.setAttribute('style', value);
      restore(vp, original.viewport); restore(stage, original.stage); restore(svg, original.svg);
      await win.MDW.refreshDiagramLayout('print-probe-restored');
    }
  }

  async function assertExportResponsive() {
    const html = await win.MDW.buildStandaloneHtml();
    const exported = document.createElement('iframe');
    exported.style.cssText = 'position:fixed;left:-3000px;top:0;width:920px;height:760px;border:0';
    const loaded = new Promise((resolve) => exported.addEventListener('load', resolve, { once: true }));
    exported.srcdoc = html;
    document.body.append(exported);
    await loaded;
    await nextPaint(exported.contentWindow);
    try {
      const evp = exported.contentDocument.querySelector('.mm-viewport');
      const esvg = evp?.querySelector('svg');
      if (!evp?.__pz?.state || !esvg) throw new Error('独立 HTML 响应式 API 缺失');
      const check = (label) => {
        evp.__pz.flush();
        const vr = evp.getBoundingClientRect(), sr = esvg.getBoundingClientRect(), state = evp.__pz.state(), eps = 1.2;
        if (!state.ready || sr.left < vr.left - eps || sr.right > vr.right + eps || sr.top < vr.top - eps || sr.bottom > vr.bottom + eps) {
          throw new Error(`${label}：独立 HTML 图表超出视口`);
        }
        return state;
      };
      const exportBefore = check('独立 HTML 初始');
      const er = evp.getBoundingClientRect();
      const exportWheel = (init = {}) => {
        const event = new exported.contentWindow.WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaY: -160,
          clientX: er.left + er.width / 2, clientY: er.top + er.height / 2,
          ...init,
        });
        const propagated = evp.dispatchEvent(event);
        evp.__pz.flush();
        return { propagated, defaultPrevented: event.defaultPrevented, state: evp.__pz.state() };
      };
      const exportPlain = exportWheel();
      if (!exportPlain.propagated || exportPlain.defaultPrevented || !sameView(exportBefore, exportPlain.state)) {
        throw new Error('独立 HTML 普通滚轮错误缩放图表');
      }
      const exportCtrl = exportWheel({ ctrlKey: true });
      if (exportCtrl.propagated || !exportCtrl.defaultPrevented || exportCtrl.state.mode !== 'user-view' || exportCtrl.state.scale <= exportBefore.scale) {
        throw new Error('独立 HTML Ctrl + 滚轮没有缩放图表');
      }
      evp.__pz.zoomAt(2); evp.__pz.flush();
      if (evp.__pz.state().mode !== 'user-view') throw new Error('独立 HTML 未进入 user-view');
      exported.style.width = '560px'; exported.style.height = '520px';
      await wait(240); await nextPaint(exported.contentWindow);
      const resized = check('独立 HTML resize');
      if (resized.mode !== 'auto-fit') throw new Error('独立 HTML resize 后没有恢复 auto-fit');
      return { initial: true, resizeAfterZoom: true, mode: resized.mode };
    } finally { exported.remove(); }
  }

  async function run() {
    try {
      win.MDW.applyReadingSetting('width', 860);
      win.MDW.setText(source);
      await win.MDW.whenDiagramsReady({ timeout: 30000, requireSuccess: true });
      assertSvgStructure();
      const initial = assertContained('初始');
      assertExactContained('初始精确 LR');

      /* 办公电脑约为 1280×720 CSS px / DPR 1.5。静态 fit 本来就正确；
         关键是普通页面滚轮绝不能把它悄悄变成被裁剪的 user-view。 */
      const workComputer = await resizeFrame(1280, 720, '办公电脑 1920x1080@150%');
      const wheelPolicy = assertInlineWheelPolicy();

      const sizes = [];
      sizes.push(await resizeFrame(800, 600, '800x600'));
      sizes.push(await resizeFrame(1024, 768, '1024x768'));
      sizes.push(await resizeFrame(1280, 720, '1280x720'));
      sizes.push(await resizeFrame(1512, 900, '1512x900'));
      sizes.push(await resizeFrame(1705, 1414, '1705x1414'));
      sizes.push(await resizeFrame(1920, 1080, '1920x1080'));
      sizes.push(await resizeFrame(2560, 1440, '2560x1440'));

      /* 相同布局下保留用户视角；实质 resize 后必须丢弃旧 transform 并重新适配。 */
      const { vp } = diagram();
      vp.__pz.zoomAt(2); vp.__pz.flush();
      const zoomed = vp.__pz.state();
      if (zoomed.mode !== 'user-view' || zoomed.scale <= zoomed.baseScale) throw new Error('用户缩放状态没有建立');
      await win.MDW.refreshDiagramLayout('same-layout');
      if (vp.__pz.state().mode !== 'user-view') throw new Error('相同布局错误清除了用户视角');
      await resizeFrame(930, 720, 'resize-after-zoom');
      if (vp.__pz.state().mode !== 'auto-fit') throw new Error('布局改变后仍保留旧用户 transform');

      /* 阅读宽度会改变 .doc 和 viewport 宽度，必须重新计算 base。 */
      const beforeWidth = vp.__pz.state().layout.width;
      win.MDW.applyReadingSetting('width', 560);
      await wait(160); await win.MDW.refreshDiagramLayout('reading-width');
      const narrowReading = assertContained('阅读宽度 560');
      if (vp.__pz.state().layout.width >= beforeWidth - 10) throw new Error('阅读宽度变化没有进入布局签名');
      win.MDW.applyReadingSetting('width', 1200);
      await wait(160); await win.MDW.refreshDiagramLayout('reading-width-wide');
      assertContained('阅读宽度 1200');

      /* 工作台侧栏的 grid 过渡会连续改变正文宽度，静止后必须以最终尺寸适配。 */
      doc.querySelector('#sideToggle').click();
      await wait(260); await win.MDW.refreshDiagramLayout('sidebar-toggle');
      assertContained('侧栏切换');
      doc.querySelector('#sideToggle').click();
      await wait(260); await win.MDW.refreshDiagramLayout('sidebar-restore');
      assertContained('侧栏恢复');

      /* source 隐藏 viewport，再切回 diagram，应以当前几何恢复。 */
      const toggle = diagram().block.querySelector('.mm-toggle');
      toggle.click();
      if (diagram().block.dataset.view !== 'source') throw new Error('没有切到源码视图');
      toggle.click();
      await win.MDW.refreshDiagramLayout('diagram-view');
      assertContained('源码切回图表');

      const revealAfterZeroWidth = await assertRevealAfterZeroWidth();
      const fullscreen = await assertFullscreenResponsive();
      const print = await assertPrintGeometry();
      const standalone = await assertExportResponsive();
      const result = {
        ready: true,
        official: true,
        structure: { nodes: 10, boldLabels: 5, rows: 20, rightColumnVisible: true, r5Style: true },
        initial,
        workComputer,
        wheelPolicy,
        sizes,
        interactionMigration: true,
        readingWidth: narrowReading,
        sidebar: true,
        sourceToggle: true,
        revealAfterZeroWidth,
        fullscreen,
        print,
        standalone,
      };
      window.__responsiveMermaidSmoke = result;
      document.body.dataset.rendered = 'true';
      document.title = JSON.stringify(result);
    } catch (error) { fail(error.message); }
  }
});
mount.append(frame);
