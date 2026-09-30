# PDF / Mermaid Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PDF preparation reuse stable Mermaid layout and keep Mermaid SVGs inside the printable page width, then publish the verified fix as `v1.17.2`.

**Architecture:** Keep the existing browser-native print flow and the existing serial Mermaid render queue. Add a small readiness/layout cache keyed by the current Mermaid render token, and constrain only the print-time diagram container/SVG in `doc.css`; screen pan/zoom keeps its intrinsic SVG dimensions. Validate the real eight-diagram fixture before changing the version.

**Tech Stack:** Classic browser JavaScript in `workspace.js`, CSS media queries in `doc.css`, standalone HTML smoke tests, Node.js standalone checks, Chrome/Edge CDP smoke execution.

**Spec:** `docs/superpowers/specs/2026-10-01-docsmith-export-cards-design.md`

## Global Constraints

- Preserve browser-native “打印 → 另存为 PDF”; do not add a PDF engine, font bundle, service, or dependency.
- Keep Mermaid rendering serial; do not parallelize the global Mermaid runtime or temporary DOM.
- Keep existing timeout, cancellation, source fallback, and print-tab fallback behavior.
- Keep the whole-document PNG contract unchanged: one Markdown document produces one PNG.
- Use the supplied fixture `areas/职业发展/求职/作品集/仓网规划助手/03-05 作品集_仓网规划助手_脱敏展示版.md`; it contains 8 Mermaid fences.
- Do not publish or push until all stage-one checks pass; the release version is exactly `1.17.2` and the tag is exactly `v1.17.2`.

## Review Focus

- **Repeated readiness call:** calling `whenDiagramsReady(preview)` twice for the same render token must not schedule a second two-frame layout settle; the second call must resolve without a new `requestAnimationFrame`.
- **Eight mixed Chinese Mermaid diagrams:** every supplied-fixture block must reach `data-diagram-state="ready"` and retain a non-empty SVG/viewBox.
- **Print width constraint:** under emulated print media, a diagram’s rendered SVG width must not exceed its printable diagram container, while its width/height ratio remains within a small rounding tolerance of its viewBox ratio.
- **Fallback print path:** when the workspace is embedded or `window.print` is unavailable, `exportPdf()` must still build the standalone HTML path and preserve the existing user-facing failure message if the tab is blocked.
- **Render/timeout error:** a failed or timed-out Mermaid render must remain a source/error fallback and must not be reported as a successful PDF preparation.

---

### Task 1: Add the failing real-fixture export smoke

**Files:**
- Create: `tests/pdf-mermaid-workspace-smoke.html`
- Create: `tests/run-pdf-mermaid-workspace-smoke.mjs`
- Modify: `tests/export-formats-workspace-smoke.mjs:1-20` only if the existing export smoke needs the readiness-cache assertion shared by this task.

**Interfaces:**
- Consumes: `window.MDW.setText`, `window.MDW.whenDiagramsReady`, `window.MDW.exportPdf`, the existing iframe smoke pattern, and a fixture URL supplied through `?fixture=`.
- Produces: `window.__pdfMermaidSmoke` with `{ready, fixture, diagrams, states, screen, repeatedReadyFrames}` for the CDP runner and later regression review.

- [ ] **Step 1: Write the smoke HTML wrapper**

Use the same full-viewport iframe structure as the existing export smoke:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Docsmith PDF Mermaid smoke</title>
  <style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style>
</head>
<body>
  <div id="mount"></div>
  <script type="module" src="./pdf-mermaid-workspace-smoke.mjs"></script>
</body>
</html>
```

- [ ] **Step 2: Write the failing fixture/readiness assertions**

In `pdf-mermaid-workspace-smoke.mjs`, fetch the fixture URL, set the document, wait for readiness, and assert all eight diagrams are ready. Then patch the iframe’s `requestAnimationFrame` **after** the first readiness call and call readiness again; the cache requirement fails against the current implementation because `settleDiagramViewports()` schedules two more frames.

```js
const params = new URLSearchParams(location.search);
const fixture = params.get('fixture') || '/areas/职业发展/求职/作品集/仓网规划助手/03-05 作品集_仓网规划助手_脱敏展示版.md';
const fail = (message) => {
  window.__pdfMermaidSmoke = { error: String(message) };
  document.body.dataset.rendered = 'error';
  document.title = String(message);
};

const frame = document.createElement('iframe');
frame.src = '../src/views/markdown/index.html';
frame.addEventListener('load', () => run().catch(fail), { once: true });
document.querySelector('#mount').append(frame);

async function run() {
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  const source = await fetch(fixture).then((response) => {
    if (!response.ok) throw new Error(`fixture HTTP ${response.status}`);
    return response.text();
  });
  const started = Date.now();
  while (!win.MDW || !win.DocsmithDiagrams) {
    if (Date.now() - started > 15000) throw new Error('工作台没有启动');
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  win.MDW.setText(source);
  const first = await win.MDW.whenDiagramsReady({ timeout: 120000, requireSuccess: true });
  const blocks = [...doc.querySelectorAll('.diagram-block')];
  const svgs = blocks.map((block) => block.querySelector('.mm-stage > svg'));
  if (blocks.length !== 8 || svgs.some((svg) => !svg)) throw new Error(`Mermaid 图数量/输出错误：${blocks.length}`);
  if (blocks.some((block) => block.dataset.diagramState !== 'ready')) throw new Error('存在未完成的 Mermaid 图');

  const originalRaf = win.requestAnimationFrame;
  let repeatedReadyFrames = 0;
  win.requestAnimationFrame = (callback) => {
    repeatedReadyFrames += 1;
    return originalRaf.call(win, callback);
  };
  await win.MDW.whenDiagramsReady({ timeout: 120000, requireSuccess: true });
  win.requestAnimationFrame = originalRaf;
  if (repeatedReadyFrames !== 0) throw new Error(`重复 readiness 仍触发布局：${repeatedReadyFrames} frames`);

  const screen = svgs.map((svg, index) => {
    const viewBox = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    return { index, viewBox: [viewBox.width, viewBox.height], rect: [rect.width, rect.height] };
  });
  window.__pdfMermaidSmoke = { ready: first.ready, fixture, diagrams: blocks.length,
    states: blocks.map((block) => block.dataset.diagramState), screen, repeatedReadyFrames };
  document.body.dataset.rendered = 'true';
  document.title = JSON.stringify(window.__pdfMermaidSmoke);
}
```

Keep the test’s print-media geometry assertion in the browser runner’s evaluation step (Task 3), because only CDP can emulate `print` reliably for this extension-style page.

- [ ] **Step 3: Add the deterministic CDP runner and run the smoke before implementation**

Create `tests/run-pdf-mermaid-workspace-smoke.mjs` by following the existing `tests/run-document-image-exact-smoke.mjs` CDP pattern, with these exact differences:

```js
const pagePath = '/projects/docsmith/code/tests/pdf-mermaid-workspace-smoke.html';
const fixturePath = '/areas/职业发展/求职/作品集/仓网规划助手/03-05 作品集_仓网规划助手_脱敏展示版.md';
// Serve the workbench root, launch the first available Edge/Chrome candidate,
// create a target at pagePath + '?fixture=' + encodeURIComponent(fixturePath),
// and wait until document.body.dataset.rendered is 'true' or 'error'.
const state = await evaluate(`({state: document.body?.dataset?.rendered || '', result: window.__pdfMermaidSmoke || null, title: document.title})`);
if (state.state !== 'true') throw new Error(state.result?.error || state.title || 'PDF Mermaid smoke failed');
await cdp('Emulation.setEmulatedMedia', { media: 'print' });
const printGeometry = await evaluate(`(() => {
  const win = document.querySelector('#workspace').contentWindow;
  return [...win.document.querySelectorAll('.diagram-block')].map((block, index) => {
    const svg = block.querySelector('.mm-stage > svg, .diagram-render svg');
    const stage = block.querySelector('.mm-stage');
    const vb = svg?.viewBox?.baseVal;
    const rect = svg?.getBoundingClientRect();
    const stageRect = stage?.getBoundingClientRect();
    return { index, svgWidth: rect?.width, svgHeight: rect?.height,
      stageWidth: stageRect?.width, ratio: vb ? vb.width / Math.max(1, vb.height) : null,
      renderedRatio: rect ? rect.width / Math.max(1, rect.height) : null };
  });
})()`);
if (printGeometry.some((item) => item.svgWidth > item.stageWidth + 1
  || Math.abs(item.ratio - item.renderedRatio) > item.ratio * 0.01)) {
  throw new Error('print geometry overflow or aspect-ratio mismatch');
}
```

Run it from the source repository:

```bash
cd '/mnt/e/02 workbench/projects/docsmith/code'
node tests/run-pdf-mermaid-workspace-smoke.mjs
```

Expected before the production fix: the runner reaches the repeated-readiness assertion and fails with `重复 readiness 仍触发布局`; after the production fix it prints the JSON result with `diagrams: 8`, `repeatedReadyFrames: 0`, and no print-geometry error. If the browser executable cannot launch, record that environmental limitation instead of weakening the assertion.

- [ ] **Step 4: Commit the failing smoke**

```bash
git add tests/pdf-mermaid-workspace-smoke.html tests/pdf-mermaid-workspace-smoke.mjs tests/run-pdf-mermaid-workspace-smoke.mjs
git commit -m "test: cover PDF Mermaid readiness and fixture"
```

---

### Task 2: Implement readiness reuse and print-width containment

**Files:**
- Modify: `src/views/markdown/workspace.js:1115-1120,1188-1284,2325-2335`
- Modify: `src/views/markdown/doc.css:218-230`
- Test: `tests/pdf-mermaid-workspace-smoke.mjs`

**Interfaces:**
- Consumes: the existing `mmRunToken`, `mmReadyPromise`, `settleDiagramViewports(scope)`, `whenDiagramsReady(root, opts)`, `svgDims(svg)`, and `preparePrintDiagrams()` functions.
- Produces: unchanged public `MDW.whenDiagramsReady(opts)` and `MDW.exportPdf()` contracts; repeated calls for the same render token return the already-settled readiness result without another viewport settle.

- [ ] **Step 1: Add a token/scope cache invalidated at render start**

Add private state beside the existing readiness state:

```js
var mmRunToken = 0;
var mmReadyPromise = Promise.resolve({ ready: true, errors: 0, cancelled: false });
var mmSettledToken = -1;
var mmSettledScope = null;
```

At the beginning of `renderDiagrams(root)`, before scheduling the new queue, invalidate the cache:

```js
mmSettledToken = -1;
mmSettledScope = null;
```

Do not alter the serial `step()` queue or cancellation behavior.

- [ ] **Step 2: Make `whenDiagramsReady` skip only an already-settled matching token**

After the `result.cancelled` branch and before waiting for fonts/settling, add the narrow cache check:

```js
var scope = root || preview;
if (result.token != null && result.token === mmSettledToken && scope === mmSettledScope) {
  if (opts.requireSuccess && result.errors) throw new Error(result.errors + ' 个图表未能渲染');
  return result;
}
```

After the existing font wait and `settleDiagramViewports(scope)` promise resolves, mark the exact result settled:

```js
return settleDiagramViewports(scope).then(function () {
  if (result.token != null) {
    mmSettledToken = result.token;
    mmSettledScope = scope;
  }
  if (opts.requireSuccess && result.errors) throw new Error(result.errors + ' 个图表未能渲染');
  return result;
});
```

Preserve the existing timeout rejection and `result.cancelled` retry. A no-diagram initial result has no token and must continue through the existing path without being cached as a diagram render.

- [ ] **Step 3: Constrain only print layout, not interactive layout**

Inside `@media print` in `src/views/markdown/doc.css`, add explicit width constraints for the block, viewport, and stage before the existing SVG rule:

```css
  .doc .diagram-render,.doc .mm-viewport,.doc .mm-stage{
    width:100% !important; max-width:100% !important;
  }
  .doc .mm-stage{display:block !important; overflow:visible !important;}
```

Keep the existing print SVG ratio-preserving declarations, and retain the landscape `@page wide-diagram` class behavior:

```css
  .doc .mm-stage svg{
    display:block; width:100% !important; height:auto !important;
    max-width:100% !important; max-height:245mm !important;
    object-fit:contain; margin:0 auto !important;
  }
```

Do not change the non-print `.mm-stage svg{width:d.w;height:d.h}` behavior used by pan/zoom. Do not remove `preparePrintDiagrams()`; it still determines when a diagram deserves a landscape page.

- [ ] **Step 4: Run the focused regression**

Run the real-fixture smoke again. Expected: 8 ready diagrams and `repeatedReadyFrames: 0`; under CDP print emulation, every SVG `getBoundingClientRect().width` is `<=` its `.mm-stage` width plus 1px, and each rendered ratio is within 1% of its viewBox ratio.

Also run the deterministic diagram regression:

```bash
cd '/mnt/e/02 workbench/projects/docsmith/code'
node tests/diagram-regression.mjs
```

Expected: `diagram regression: ok`.

- [ ] **Step 5: Commit the production fix**

```bash
git add src/views/markdown/workspace.js src/views/markdown/doc.css tests/pdf-mermaid-workspace-smoke.mjs
git commit -m "fix: speed up PDF readiness and constrain Mermaid print width"
```

---

### Task 3: Verify all exports, update version metadata, and publish v1.17.2

**Files:**
- Modify: `manifest.json:4`
- Modify: `docs/CHANGELOG.md:1`
- Modify: `docs/03-版本号规则.md:4`
- Modify: `README.md:20,120`
- Test: existing `tests/export-formats-workspace-smoke.html/.mjs`, `tests/diagram-workspace-smoke.html`, `tests/mermaid-official-workspace-smoke.html`

**Interfaces:**
- Consumes: the fixed `MDW.exportPdf()`, standalone HTML/Word/PNG export paths, and the repository’s existing version/tag convention.
- Produces: manifest version `1.17.2`, a top `1.17.2` CHANGELOG entry, and pushed refs `origin/main` and `origin/v1.17.2` only after every check passes.

- [ ] **Step 1: Run static and syntax checks**

```bash
cd '/mnt/e/02 workbench/projects/docsmith/code'
node --check src/views/markdown/workspace.js
node --check tests/pdf-mermaid-workspace-smoke.mjs
git diff --check
node tests/diagram-regression.mjs
```

Expected: all commands exit 0; the diagram regression prints `diagram regression: ok`.

- [ ] **Step 2: Run existing export and Mermaid browser smokes**

Run the existing standalone HTML smokes through their repository runners, then inspect `document.body.dataset.rendered`, `window.__exportFormatsSmoke`, `window.__workspaceSmoke`, and `window.__officialMermaidSmoke`. Run the new fixture geometry smoke with the exact command below; its runner emulates print media before evaluating the SVG rectangles.

```bash
cd '/mnt/e/02 workbench/projects/docsmith/code'
node tests/run-pdf-mermaid-workspace-smoke.mjs
```

Required results:

```text
export formats: ready=true, html=true, word=true, pdfFallback=true
workspace diagrams: ready=true, themeLeak=false, overviewTakeover=false
official Mermaid: official=true, diagrams=10, standaloneEmbedded=10
PDF fixture: diagrams=8, repeatedReadyFrames=0, no print-geometry overflow
```

Preserve the PDF fixture JSON output as the release verification record in `.local/work/docsmith-pdf-repro/`; do not add that machine-local output to Git.

- [ ] **Step 3: Create the required backup before version edits**

```bash
cd '/mnt/e/02 workbench/projects/docsmith/code'
node scripts/backup.js
```

Expected: the backup script exits 0 and creates its versioned external archive.

- [ ] **Step 4: Update the four release metadata locations**

Change only the current product version from `1.17.1` to `1.17.2` in `manifest.json`, `docs/03-版本号规则.md`, and both current-version mentions in `README.md`. Add this top CHANGELOG entry:

```markdown
## 1.17.2 — 2026-10-01

- **修复 PDF 导出准备过程**：已完成的 Mermaid 布局不再在打印前重复等待。
- **修复 Mermaid 打印宽度**：宽图按可打印页面约束缩放，保持比例且不再横向溢出。
- **为什么**：复杂中文 Mermaid 文档在导出 PDF 时等待过多，打印态的 SVG 固有宽度还会把版面撑宽。
```

Do not update `ORDER_VERSION`; this release does not change capability ordering.

- [ ] **Step 5: Re-run release checks and inspect the final diff**

```bash
git diff --check
git status --short
git diff --stat
git diff -- manifest.json docs/CHANGELOG.md docs/03-版本号规则.md README.md
```

Expected: only the stage-one source/test/docs/version files are changed; no cards files, generated cache, or `.local` output is staged.

- [ ] **Step 6: Commit the release metadata**

```bash
git add manifest.json docs/CHANGELOG.md docs/03-版本号规则.md README.md
git commit -m "release: Docsmith v1.17.2"
```

- [ ] **Step 7: Publish the main commit and matching tag**

Run only after the verification evidence above is green:

```bash
git push origin main
git tag -a v1.17.2 -m "Docsmith v1.17.2"
git push origin v1.17.2
```

Verify the published refs without rewriting history:

```bash
git fetch origin --tags
git rev-parse v1.17.2
 git rev-parse origin/main
```

The tag must point at the release commit, and the remote main must contain that commit.

---

## Handoff to the next plan

Do not start card removal in this plan. After `v1.17.2` is verified and published, create a separate implementation plan for the already-approved card-removal section of the spec, then execute it and publish `v2.0.0` only after its own checks pass.

## Plan self-review

- Spec coverage: the real fixture, readiness reuse, print width, fallback behavior, error behavior, no-new-dependency boundary, existing export regressions, backup, version bump, tag, and push each have an owning task.
- Placeholder scan: no unfinished-marker text, vague “implement later” steps, or unspecified test step remains.
- Interface consistency: the private cache uses the existing render token and public `MDW.whenDiagramsReady(opts)` signature; no later task depends on a new public API.
- Scope: card removal is deliberately excluded and will receive its own plan after `v1.17.2`, avoiding one plan spanning two independent releases.
