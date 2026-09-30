const DEFAULT_FIXTURE = '/areas/职业发展/求职/作品集/仓网规划助手/03-05 作品集_仓网规划助手_脱敏展示版.md';
const fixture = new URLSearchParams(location.search).get('fixture') || DEFAULT_FIXTURE;

function fail(error) {
  const cause = error instanceof Error ? error : new Error(String(error));
  const result = {
    error: {
      name: cause.name,
      message: cause.message,
      stack: cause.stack || ''
    }
  };
  window.__pdfMermaidSmoke = result;
  document.body.dataset.rendered = 'error';
  document.title = JSON.stringify(result);
}

async function waitForRuntime(frame) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (win && doc && win.MDW && win.DocsmithDiagrams
      && typeof win.MDW.setText === 'function'
      && typeof win.MDW.whenDiagramsReady === 'function') {
      return { win, doc };
    }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('iframe MDW/DocsmithDiagrams 没有启动');
}

(async () => {
  try {
    const frame = document.querySelector('#mount iframe');
    if (!frame) throw new Error('找不到 markdown iframe');

    const { win, doc } = await waitForRuntime(frame);
    const response = await fetch(new URL(fixture, location.href));
    if (!response.ok) throw new Error(`fixture 加载失败: ${response.status} ${fixture}`);
    await win.MDW.setText(await response.text());
    await win.MDW.whenDiagramsReady({ timeout: 120000, requireSuccess: true });

    const blocks = [...doc.querySelectorAll('.diagram-block')];
    const states = blocks.map(block => block.dataset.diagramState || '');
    if (blocks.length !== 8) throw new Error(`Mermaid 图数量应为 8，实际为 ${blocks.length}`);
    if (blocks.some(block => !block.querySelector('svg'))) throw new Error('存在没有 SVG 的 Mermaid 图');
    if (states.some(state => state !== 'ready')) throw new Error(`Mermaid 图状态异常: ${states.join(',')}`);

    const originalRequestAnimationFrame = win.requestAnimationFrame;
    if (typeof originalRequestAnimationFrame !== 'function') throw new Error('iframe requestAnimationFrame 不可用');
    let repeatedReadyFrames = 0;
    win.requestAnimationFrame = (...args) => {
      repeatedReadyFrames++;
      return originalRequestAnimationFrame.apply(win, args);
    };
    try {
      await win.MDW.whenDiagramsReady({ timeout: 120000, requireSuccess: true });
    } finally {
      win.requestAnimationFrame = originalRequestAnimationFrame;
    }
    if (repeatedReadyFrames !== 0) throw new Error(`重复就绪检查触发了 ${repeatedReadyFrames} 次 RAF`);

    const result = {
      ready: true,
      fixture,
      diagrams: blocks.length,
      states,
      screen: {
        width: win.innerWidth,
        height: win.innerHeight,
        devicePixelRatio: win.devicePixelRatio
      },
      repeatedReadyFrames
    };
    window.__pdfMermaidSmoke = result;
    document.body.dataset.rendered = 'true';
    document.title = JSON.stringify(result);
  } catch (error) {
    fail(error);
  }
})();
