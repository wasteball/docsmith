import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(testDir, '..');
export const testPath = '/tests/pdf-mermaid-workspace-smoke.html';
const workspacePath = '/src/views/markdown/index.html';
const timeout = Number(process.env.DOCSMITH_PDF_MERMAID_TIMEOUT || 600000);

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

class BrowserUnavailable extends Error {}

function errorObject(error) {
  const cause = error instanceof Error ? error : new Error(String(error));
  return { name: cause.name, message: cause.message, stack: cause.stack || '' };
}

async function fixtureFromEnvironment() {
  const configured = process.env.DOCSMITH_PDF_MERMAID_FIXTURE;
  if (!configured) {
    throw new Error('缺少 DOCSMITH_PDF_MERMAID_FIXTURE；请将它设为包含 8 张 Mermaid 图的 Markdown 文件路径');
  }
  const fixturePath = resolve(configured);
  let stat;
  try {
    stat = await fs.stat(fixturePath);
  } catch (error) {
    throw new Error(`DOCSMITH_PDF_MERMAID_FIXTURE 不可读取: ${fixturePath}`, { cause: error });
  }
  if (!stat.isFile()) throw new Error(`DOCSMITH_PDF_MERMAID_FIXTURE 不是文件: ${fixturePath}`);
  return fixturePath;
}

export function serveRepository(fixturePath) {
  return new Promise((resolveServer, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        let target;
        if (pathname === '/fixture.md') {
          target = fixturePath;
        } else {
          target = resolve(repoRoot, '.' + pathname);
          if (target !== repoRoot && !target.startsWith(repoRoot + sep)) {
            response.writeHead(403).end('Forbidden');
            return;
          }
        }
        const stat = await fs.stat(target);
        if (!stat.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Length': stat.size,
          'Content-Type': mime[extname(target).toLowerCase()] || 'application/octet-stream'
        });
        createReadStream(target).pipe(response);
      } catch (error) {
        const missing = error?.code === 'ENOENT';
        response.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : 'Server error');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

async function findBrowser() {
  const configured = process.env.DOCSMITH_BROWSER;
  if (process.platform === 'linux' && configured && /\.exe$/i.test(configured)) {
    throw new BrowserUnavailable('WSL/Linux 不能用 Windows 浏览器连接本机 CDP；请在 Windows Node 中运行，或将 DOCSMITH_BROWSER 指向 Linux Chromium');
  }

  let candidates;
  if (configured) {
    candidates = [configured];
  } else if (process.platform === 'win32') {
    candidates = [
      process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean);
  } else if (process.platform === 'linux') {
    candidates = [
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ];
  } else {
    throw new BrowserUnavailable(`暂不支持 ${process.platform}；请在原生 Windows 或 Linux Node 中运行`);
  }

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  const hint = process.platform === 'linux' && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
    ? 'WSL 中未找到 Linux Chromium；请安装 Linux 浏览器，或改用 Windows Node 运行此脚本'
    : '找不到当前系统的 Edge 或 Chrome；可通过 DOCSMITH_BROWSER 指定本机浏览器可执行文件';
  throw new BrowserUnavailable(hint);
}

async function waitForTarget(debugPort, browserProcess) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (browserProcess.launchError) throw new BrowserUnavailable('浏览器启动失败：' + browserProcess.launchError.message);
    if (browserProcess.exitCode !== null) throw new BrowserUnavailable(`浏览器启动后退出（代码 ${browserProcess.exitCode}）`);
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
      const target = targets.find(item => item.type === 'page' && item.url === 'about:blank')
        || targets.find(item => item.type === 'page');
      if (target) return target;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new BrowserUnavailable('浏览器调试端口没有就绪；确认浏览器与 Node 运行在同一操作系统');
}

function connect(url) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolveSocket(socket), { once: true });
    socket.addEventListener('error', () => reject(new BrowserUnavailable('无法连接浏览器调试会话')), { once: true });
  });
}

function cdp(socket) {
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const job = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) job.reject(new Error(JSON.stringify(message.error)));
    else job.resolve(message.result);
  });
  return (method, params = {}) => new Promise((resolveCall, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve: resolveCall, reject });
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
}

async function evaluate(call, expression, awaitPromise = false) {
  const evaluated = await call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || '页面脚本执行失败');
  }
  return evaluated.result.value;
}

async function waitForSmoke(call) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    try {
      state = await evaluate(call, '({state:document.body?.dataset?.rendered||"",result:window.__pdfMermaidSmoke||null,title:document.title})');
      if (state.state === 'true' || state.state === 'error') return state;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
  }
  return state;
}

async function waitForWorkspace(call) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(call, 'Boolean(window.MDW && typeof window.MDW.setText === "function" && typeof window.MDW.exportPdf === "function")')) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('顶层 Markdown 工作台没有启动');
}

async function closeServer(server) {
  if (!server) return;
  await new Promise(resolveClose => server.close(resolveClose));
}

export async function run() {
  let server;
  let browserProcess;
  let socket;
  let call;
  let report;
  let failure;

  try {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('DOCSMITH_PDF_MERMAID_TIMEOUT 必须是正数');
    if (typeof WebSocket !== 'function') throw new BrowserUnavailable('当前 Node.js 缺少 WebSocket；请使用 Node.js 22+');
    const fixturePath = await fixtureFromEnvironment();
    const browser = await findBrowser();
    server = await serveRepository(fixturePath);
    const serverPort = server.address().port;
    const debugPort = await freePort();
    const profilePath = join(tmpdir(), `docsmith-pdf-mermaid-${process.pid}-${debugPort}`);
    const browserArgs = [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profilePath}`,
      '--window-size=1440,1000',
      'about:blank'
    ];
    browserProcess = spawn(browser, browserArgs, { stdio: 'ignore' });
    browserProcess.once('error', error => { browserProcess.launchError = error; });

    const target = await waitForTarget(debugPort, browserProcess);
    socket = await connect(target.webSocketDebuggerUrl);
    call = cdp(socket);
    await call('Page.enable');
    await call('Network.enable');
    await call('Network.setCacheDisabled', { cacheDisabled: true });

    const page = new URL(`http://127.0.0.1:${serverPort}${testPath}`);
    page.searchParams.set('fixture', '/fixture.md');
    page.searchParams.set('run', String(Date.now()));
    await call('Page.navigate', { url: page.href });
    const state = await waitForSmoke(call);
    if (!state || state.state !== 'true') {
      const detail = state?.result?.error?.message || state?.title || `PDF Mermaid smoke 在 ${timeout}ms 内未完成`;
      throw new Error(detail);
    }

    await call('Emulation.setEmulatedMedia', { media: 'print' });
    const print = await evaluate(call, `(() => {
      const workspace = document.querySelector('#workspace');
      const doc = workspace?.contentDocument;
      if (!doc) return {ok:false,items:[],error:'workspace iframe document 不可用'};
      const probe = doc.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;width:1mm';
      doc.body.appendChild(probe);
      const pxPerMm = probe.getBoundingClientRect().width;
      probe.remove();
      const items = [...doc.querySelectorAll('.diagram-block')].map((block,index) => {
        const svg = block.querySelector('.mm-stage > svg');
        const stage = block.querySelector('.mm-stage');
        const svgRect = svg?.getBoundingClientRect();
        const stageRect = stage?.getBoundingClientRect();
        const viewBox = svg?.getAttribute('viewBox')?.trim().split(/\\s+/).map(Number);
        const naturalWidth = viewBox?.length === 4 ? viewBox[2] : NaN;
        const naturalHeight = viewBox?.length === 4 ? viewBox[3] : NaN;
        const viewBoxRatio = naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : NaN;
        const renderedRatio = svgRect?.width > 0 && svgRect?.height > 0 ? svgRect.width / svgRect.height : NaN;
        const ratioDelta = Number.isFinite(renderedRatio) && Number.isFinite(viewBoxRatio)
          ? Math.abs(renderedRatio / viewBoxRatio - 1) : Infinity;
        const pageHeight = pxPerMm * (block.classList.contains('diagram-print-wide') ? 158 : 245);
        const positive = Boolean(svgRect && stageRect)
          && svgRect.width > 0 && svgRect.height > 0 && stageRect.width > 0 && stageRect.height > 0;
        return {
          index:index + 1,
          svgWidth:svgRect?.width ?? null,
          svgHeight:svgRect?.height ?? null,
          stageWidth:stageRect?.width ?? null,
          stageHeight:stageRect?.height ?? null,
          naturalWidth,
          naturalHeight,
          pageHeight,
          ratioDelta,
          positive,
          widthOk:positive && svgRect.width <= stageRect.width + 1,
          ratioOk:ratioDelta <= 0.01,
          naturalOk:positive && svgRect.width <= naturalWidth + 1 && svgRect.height <= naturalHeight + 1,
          pageHeightOk:positive && svgRect.height <= pageHeight + 1
        };
      });
      return {ok:items.length === 8 && items.every(item => item.widthOk && item.ratioOk && item.naturalOk && item.pageHeightOk),items};
    })()`);
    if (!print?.ok) throw new Error('打印媒体下 Mermaid SVG 尺寸、比例或 shrink-only 校验失败');

    await call('Emulation.setEmulatedMedia', { media: 'screen' });
    await call('Page.navigate', { url: `http://127.0.0.1:${serverPort}${workspacePath}?run=${Date.now()}` });
    await waitForWorkspace(call);
    const nativePrint = await evaluate(call, `(async () => {
      const response = await fetch('/fixture.md');
      if (!response.ok) throw new Error('fixture 加载失败: ' + response.status);
      window.MDW.setText(await response.text());
      await window.MDW.whenDiagramsReady({timeout:120000,requireSuccess:true});
      const blocks = [...document.querySelectorAll('.diagram-block')];
      const wideBefore = blocks.map((block,index) => block.classList.contains('diagram-print-wide') ? index : -1).filter(index => index >= 0);
      const originalPrint = window.print;
      let printCalls = 0;
      window.print = () => { printCalls++; };
      try { await window.MDW.exportPdf(); } finally { window.print = originalPrint; }
      const wideAfter = blocks.map((block,index) => block.classList.contains('diagram-print-wide') ? index : -1).filter(index => index >= 0);
      const temporaryRatios = blocks.filter(block => block.style.getPropertyValue('--diagram-print-ratio')).length;
      return {
        ok:blocks.length === 8 && wideBefore.length > 0 && printCalls === 1
          && JSON.stringify(wideAfter) === JSON.stringify(wideBefore) && temporaryRatios === 0,
        diagrams:blocks.length,
        wideBefore,
        wideAfter,
        printCalls,
        temporaryRatios
      };
    })()`, true);
    if (!nativePrint?.ok) throw new Error('原生 PDF 打印清理破坏了 Mermaid 横向分类或未调用一次 print');

    report = { ...state.result, print, nativePrint };
  } catch (error) {
    failure = error;
    report = {
      status: error instanceof BrowserUnavailable ? 'blocked' : 'failed',
      error: errorObject(error),
      ...(report || {})
    };
  } finally {
    if (call) {
      try {
        await Promise.race([
          call('Browser.close'),
          new Promise(resolveWait => setTimeout(resolveWait, 3000))
        ]);
      } catch {}
    }
    if (socket) socket.close();
    if (browserProcess && browserProcess.exitCode === null) {
      await Promise.race([
        new Promise(resolveExit => browserProcess.once('exit', resolveExit)),
        new Promise(resolveWait => setTimeout(resolveWait, 5000))
      ]);
      if (browserProcess.exitCode === null) browserProcess.kill();
    }
    await closeServer(server);
  }

  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
