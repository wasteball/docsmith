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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function withTimeout(promise, timeout, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeout);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
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

async function reloadWorkspace(frame, name) {
  await withTimeout(new Promise(resolve => {
    frame.addEventListener('load', resolve, { once: true });
    frame.src = `../src/views/markdown/index.html?readiness=${encodeURIComponent(name)}&run=${Date.now()}`;
  }), 30000, `${name}: iframe 重新加载超时`);
  return waitForRuntime(frame);
}

function inspectExport(win, html, labels, name) {
  const exported = new win.DOMParser().parseFromString(html, 'text/html');
  const blocks = [...exported.querySelectorAll('.diagram-block')];
  const states = blocks.map(block => block.dataset.diagramState || '');
  const missingSvg = blocks.filter(block => !block.querySelector('.mm-stage > svg')).length;
  const text = blocks.map(block => block.querySelector('.mm-stage > svg')?.textContent || '').join('\n');
  const missingLabels = labels.filter(label => !text.includes(label));
  const pending = states.filter(state => state !== 'ready').length
    + exported.querySelectorAll('.mm-loading').length;
  if (blocks.length !== labels.length || missingSvg || missingLabels.length || pending) {
    throw new Error(`${name}: 导出图表未就绪（数量 ${blocks.length}/${labels.length}，缺 SVG ${missingSvg}，状态 ${states.join(',')}，缺文字 ${missingLabels.join(',')}）`);
  }
  return { diagrams: blocks.length, states, labels };
}

async function checkReviewGhostOwnership(frame) {
  const { win, doc } = await reloadWorkspace(frame, 'scope-ownership');
  const baseline = `# Review baseline

\`\`\`mermaid
flowchart LR
  OLD_REVIEW[Old Review] --> OLD_DONE[Old Done]
\`\`\``;
  const current = `# Review current

\`\`\`mermaid
flowchart LR
  MAIN_ONE[Main One] --> MAIN_DONE[Main Done]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  Alice->>Bob: Main Two
\`\`\`

\`\`\`mermaid
flowchart TD
  MAIN_THREE[Main Three] --> MAIN_END[Main End]
\`\`\``;
  const labels = ['Main One', 'Main Two', 'Main Three'];

  win.MDW.setText(baseline);
  await win.MDW.whenDiagramsReady({ timeout: 30000, requireSuccess: true });

  const originalRender = win.DocsmithDiagrams.renderMermaid;
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let renderCalls = 0;
  win.DocsmithDiagrams.renderMermaid = function (...args) {
    renderCalls++;
    if (renderCalls === 1) {
      firstStarted.resolve();
      return releaseFirst.promise.then(() => originalRender.apply(this, args));
    }
    return originalRender.apply(this, args);
  };

  try {
    win.MDW.setText(current);
    await withTimeout(firstStarted.promise, 5000, 'scope ownership: 正文 Mermaid 没有开始');

    doc.querySelector('#chgBtn')?.click();
    const expandAll = doc.querySelector('#chgPanel [data-chg-act="all"]');
    if (!expandAll) throw new Error('scope ownership: 找不到实际审阅“全部展开”控件');
    expandAll.click();
    if (!doc.querySelector('.chg-diff .cd-ghost .diagram-block')) {
      throw new Error('scope ownership: Mermaid 审阅 ghost 没有通过实际 UI 打开');
    }

    const ghostStartedWhileMainBlocked = renderCalls > 1;
    const exported = win.MDW.buildStandaloneHtml();
    if (!ghostStartedWhileMainBlocked) releaseFirst.resolve();
    const html = await withTimeout(exported, 30000, 'scope ownership: 独立 HTML 导出超时');
    return {
      ...inspectExport(win, html, labels, 'scope ownership'),
      reviewGhost: true,
      ghostStartedWhileMainBlocked
    };
  } finally {
    releaseFirst.resolve();
    win.DocsmithDiagrams.renderMermaid = originalRender;
  }
}

async function checkSettleGeneration(frame) {
  const { win } = await reloadWorkspace(frame, 'settle-generation');
  const initial = `# Initial generation

\`\`\`mermaid
flowchart LR
  OLD_ONE[Old One] --> OLD_END[Old End]
\`\`\``;
  const current = `# Current generation

\`\`\`mermaid
flowchart LR
  NEW_ONE[New One] --> NEW_END[New End]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  Carol->>Dave: New Two
\`\`\`

\`\`\`mermaid
flowchart TD
  NEW_THREE[New Three] --> NEW_DONE[New Done]
\`\`\``;
  const labels = ['New One', 'New Two', 'New Three'];

  const originalRender = win.DocsmithDiagrams.renderMermaid;
  const originalRaf = win.requestAnimationFrame;
  const releaseCurrent = deferred();
  const mutationStarted = deferred();
  let armed = false;
  let mutated = false;
  let heldCurrentRender = false;
  let exportPromise;

  win.DocsmithDiagrams.renderMermaid = function (...args) {
    if (mutated && !heldCurrentRender) {
      heldCurrentRender = true;
      mutationStarted.resolve();
      return releaseCurrent.promise.then(() => originalRender.apply(this, args));
    }
    return originalRender.apply(this, args);
  };
  win.requestAnimationFrame = function (callback) {
    if (armed && !mutated) {
      mutated = true;
      win.MDW.setText(current);
    }
    return originalRaf.call(this, callback);
  };

  try {
    const firstReady = deferred();
    win.addEventListener('docsmith:diagrams-ready', function startExport() {
      armed = true;
      exportPromise = win.MDW.buildStandaloneHtml();
      firstReady.resolve();
    }, { once: true });

    win.MDW.setText(initial);
    await withTimeout(firstReady.promise, 30000, 'settle generation: 初始图表没有就绪');
    await withTimeout(mutationStarted.promise, 5000, 'settle generation: RAF 等待期间没有触发新文档');
    const releaseTimer = setTimeout(() => releaseCurrent.resolve(), 800);
    let html;
    try {
      html = await withTimeout(exportPromise, 30000, 'settle generation: 独立 HTML 导出超时');
    } finally {
      clearTimeout(releaseTimer);
    }
    return {
      ...inspectExport(win, html, labels, 'settle generation'),
      mutationDuringSettle: mutated
    };
  } finally {
    releaseCurrent.resolve();
    win.requestAnimationFrame = originalRaf;
    win.DocsmithDiagrams.renderMermaid = originalRender;
  }
}

(async () => {
  try {
    const frame = document.querySelector('#workspace');
    if (!frame) throw new Error('找不到 markdown iframe');

    let { win, doc } = await waitForRuntime(frame);
    const response = await fetch(new URL(fixture, location.href));
    if (!response.ok) throw new Error(`fixture 加载失败: ${response.status} ${fixture}`);
    const fixtureText = await response.text();
    await win.MDW.setText(fixtureText);
    await win.MDW.whenDiagramsReady({ timeout: 120000, requireSuccess: true });

    let blocks = [...doc.querySelectorAll('.diagram-block')];
    let states = blocks.map(block => block.dataset.diagramState || '');
    if (blocks.length !== 8) throw new Error(`Mermaid 图数量应为 8，实际为 ${blocks.length}`);
    if (blocks.some(block => !block.querySelector('.mm-stage > svg'))) throw new Error('存在没有 SVG 的 Mermaid 图');
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

    const readiness = {};
    const failures = [];
    try { readiness.scopeOwnership = await checkReviewGhostOwnership(frame); }
    catch (error) { failures.push(error.message || String(error)); }
    try { readiness.settleGeneration = await checkSettleGeneration(frame); }
    catch (error) { failures.push(error.message || String(error)); }
    if (failures.length) throw new Error(failures.join(' | '));

    ({ win, doc } = await waitForRuntime(frame));
    win.MDW.setText(fixtureText);
    await win.MDW.whenDiagramsReady({ timeout: 120000, requireSuccess: true });
    blocks = [...doc.querySelectorAll('.diagram-block')];
    states = blocks.map(block => block.dataset.diagramState || '');
    if (blocks.length !== 8) throw new Error(`恢复 fixture 后 Mermaid 图数量应为 8，实际为 ${blocks.length}`);
    if (blocks.some(block => !block.querySelector('.mm-stage > svg'))) throw new Error('恢复 fixture 后存在没有 SVG 的 Mermaid 图');
    if (states.some(state => state !== 'ready')) throw new Error(`恢复 fixture 后 Mermaid 图状态异常: ${states.join(',')}`);

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
      repeatedReadyFrames,
      readiness
    };
    window.__pdfMermaidSmoke = result;
    document.body.dataset.rendered = 'true';
    document.title = JSON.stringify(result);
  } catch (error) {
    fail(error);
  }
})();
