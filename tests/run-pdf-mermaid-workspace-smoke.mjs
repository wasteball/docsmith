import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const workspaceRoot = resolve('/mnt/e/02 workbench');
const fixture = '/areas/职业发展/求职/作品集/仓网规划助手/03-05 作品集_仓网规划助手_脱敏展示版.md';
const fixturePath = resolve(workspaceRoot, '.' + fixture);
const testPath = '/projects/docsmith/code/tests/pdf-mermaid-workspace-smoke.html';
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

async function freePortForBrowser(windowsBrowser) {
  if (!windowsBrowser) {
    return new Promise((resolvePort, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(error => error ? reject(error) : resolvePort(port));
      });
    });
  }
  const script = [
    '$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)',
    '$listener.Start()',
    '$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port',
    '$listener.Stop()',
    '[Console]::Write($port)'
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  const port = Number(stdout.trim());
  if (code !== 0 || !Number.isInteger(port) || port < 1) {
    throw new BrowserUnavailable('无法在 Windows 侧分配浏览器调试端口：' + stderr.trim());
  }
  return port;
}

function serveWorkspace() {
  return new Promise((resolveServer, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const target = resolve(workspaceRoot, '.' + pathname);
        if (target !== workspaceRoot && !target.startsWith(workspaceRoot + sep)) {
          response.writeHead(403).end('Forbidden');
          return;
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
        response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

async function findBrowser() {
  const configured = process.env.DOCSMITH_BROWSER;
  const candidates = configured ? [configured] : [
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new BrowserUnavailable('找不到 Edge 或 Chrome；可通过 DOCSMITH_BROWSER 指定可执行文件');
}

function profileFor(browser, debugPort) {
  const name = `docsmith-pdf-mermaid-${process.pid}-${debugPort}`;
  if (browser.endsWith('.exe') && browser.startsWith('/mnt/')) {
    return {
      argument: `C:\\Windows\\Temp\\${name}`,
      path: `/mnt/c/Windows/Temp/${name}`
    };
  }
  return { argument: `/tmp/${name}`, path: `/tmp/${name}` };
}

async function waitForTarget(debugPort, browserProcess, windowsBrowser) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (browserProcess?.launchError) {
      throw new BrowserUnavailable('浏览器启动失败：' + browserProcess.launchError.message);
    }
    if (!windowsBrowser && browserProcess?.exitCode !== null) {
      throw new BrowserUnavailable(`浏览器启动后退出（代码 ${browserProcess.exitCode}）`);
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
      const target = targets.find(item => item.type === 'page' && item.url === 'about:blank')
        || targets.find(item => item.type === 'page' && !item.url.startsWith('edge://'));
      if (target) return target;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new BrowserUnavailable('浏览器调试端口没有就绪；浏览器可能无法在当前环境启动');
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

function launchBrowser(browser, browserArgs, windowsBrowser) {
  let browserProcess;
  if (windowsBrowser) {
    const executable = browser.replaceAll('/', '\\').replace(/^\\mnt\\([a-z])\\/i, (_, drive) => drive.toUpperCase() + ':\\');
    const commandLine = `cmd.exe /c start \"\" /b \"${executable.replaceAll('\\', '\\\\')}\" ${browserArgs.map(argument => argument.replaceAll('\\', '\\\\')).join(' ')}`;
    browserProcess = spawn('bash', ['-lc', commandLine], { detached: true, stdio: 'ignore' });
    browserProcess.unref();
  } else {
    browserProcess = spawn(browser, browserArgs, { stdio: 'ignore' });
  }
  browserProcess.once('error', error => { browserProcess.launchError = error; });
  return browserProcess;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise(resolveClose => server.close(resolveClose));
}

let server;
let browserProcess;
let socket;
let call;
let profile;
let report;
let failure;

try {
  if (typeof WebSocket !== 'function') throw new BrowserUnavailable('当前 Node.js 缺少 WebSocket；请使用 Node.js 22+');
  await fs.access(fixturePath);

  server = await serveWorkspace();
  const serverPort = server.address().port;
  const browser = await findBrowser();
  const windowsBrowser = browser.endsWith('.exe') && browser.startsWith('/mnt/');
  const debugPort = await freePortForBrowser(windowsBrowser);
  profile = profileFor(browser, debugPort);
  await fs.mkdir(profile.path, { recursive: true });

  const browserArgs = [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile.argument}`,
    '--window-size=1440,1000',
    'about:blank'
  ];
  browserProcess = launchBrowser(browser, browserArgs, windowsBrowser);

  const target = await waitForTarget(debugPort, browserProcess, windowsBrowser);
  socket = await connect(target.webSocketDebuggerUrl);
  call = cdp(socket);
  await call('Network.enable');
  await call('Network.setCacheDisabled', { cacheDisabled: true });

  const page = new URL(`http://127.0.0.1:${serverPort}${testPath}`);
  page.searchParams.set('fixture', fixture);
  page.searchParams.set('run', String(Date.now()));
  const pageTarget = await call('Target.createTarget', { url: page.href });
  const deadlineTarget = Date.now() + 10000;
  let testTarget;
  while (Date.now() < deadlineTarget) {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(response => response.json());
    testTarget = targets.find(item => item.id === pageTarget.targetId);
    if (testTarget) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (!testTarget) throw new Error('PDF Mermaid smoke 标签页没有创建成功');
  socket.close();
  socket = await connect(testTarget.webSocketDebuggerUrl);
  call = cdp(socket);

  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    const evaluated = await call('Runtime.evaluate', {
      expression: '({state:document.body?.dataset?.rendered||"",result:window.__pdfMermaidSmoke||null,title:document.title})',
      returnByValue: true
    });
    state = evaluated.result.value;
    if (state.state === 'true' || state.state === 'error') break;
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
  }

  if (!state || state.state !== 'true') {
    const detail = state?.result?.error?.message || state?.title || `PDF Mermaid smoke 在 ${timeout}ms 内未完成`;
    throw new Error(detail);
  }

  await call('Emulation.setEmulatedMedia', { media: 'print' });
  const layoutEvaluation = await call('Runtime.evaluate', {
    expression: `(() => {
      const workspace = document.querySelector('#workspace');
      const workspaceDocument = workspace?.contentDocument;
      if (!workspaceDocument) return {ok: false, items: [], error: 'workspace iframe document 不可用'};
      const items = [...workspaceDocument.querySelectorAll('.diagram-block')].map((block, index) => {
        const svg = block.querySelector('.mm-stage > svg');
        const stage = block.querySelector('.mm-stage');
        const svgRect = svg?.getBoundingClientRect();
        const stageRect = stage?.getBoundingClientRect();
        const viewBox = svg?.getAttribute('viewBox')?.trim().split(/\\s+/).map(Number);
        const viewBoxRatio = viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0 ? viewBox[2] / viewBox[3] : NaN;
        const renderedRatio = svgRect?.width > 0 && svgRect?.height > 0 ? svgRect.width / svgRect.height : NaN;
        const widthOk = Boolean(svgRect && stageRect) && svgRect.width <= stageRect.width + 1;
        const ratioDelta = Number.isFinite(renderedRatio) && Number.isFinite(viewBoxRatio)
          ? Math.abs(renderedRatio / viewBoxRatio - 1)
          : Infinity;
        return {
          index: index + 1,
          svgWidth: svgRect?.width ?? null,
          stageWidth: stageRect?.width ?? null,
          svgHeight: svgRect?.height ?? null,
          stageHeight: stageRect?.height ?? null,
          viewBoxRatio,
          renderedRatio,
          ratioDelta,
          widthOk,
          ratioOk: ratioDelta <= 0.01
        };
      });
      return {ok: items.length === 8 && items.every(item => item.widthOk && item.ratioOk), items};
    })()`,
    returnByValue: true
  });
  const print = layoutEvaluation.result.value;
  report = { ...state.result, print };
  if (!print?.ok) throw new Error('打印媒体下 Mermaid SVG 尺寸或比例校验失败');
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
  if (browserProcess && browserProcess.exitCode === null && !profile?.argument.startsWith('C:')) {
    await Promise.race([
      new Promise(resolveExit => browserProcess.once('exit', resolveExit)),
      new Promise(resolveWait => setTimeout(resolveWait, 5000))
    ]);
    if (browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
  }
  if (profile?.argument.startsWith('C:')) {
    await new Promise(resolveKill => {
      const escaped = profile.argument.replaceAll("'", "''");
      const killer = spawn('powershell.exe', ['-NoProfile', '-Command', `$processes = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(msedge|chrome)\\.exe$' -and $_.CommandLine -like '*${escaped}*' }; $processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
      killer.once('exit', resolveKill);
      killer.once('error', resolveKill);
    });
  }
  await closeServer(server);
  if (profile) await fs.rm(profile.path, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

console.log(JSON.stringify(report, null, 2));
if (failure) process.exitCode = 1;
