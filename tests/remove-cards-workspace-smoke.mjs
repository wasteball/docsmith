const KEYS = {
  appearance: 'docsmith:appearance',
  shell: 'docsmith:shell',
  storage: 'docsmith:storage',
  library: 'docsmith:library',
  prefs: 'docsmith:prefs',
  reviewNotes: 'docsmith:review-notes',
  baselines: 'docsmith:confirmed'
};

const RESULT_VAR = '__removeCardsSmoke';
const diagnostics = {};
const CUSTOM_ID = 'custom-kept';
const initialMirror = {
  [KEYS.prefs]: {
    'cards.mode': 'manual',
    'cards.ratio': '1:1',
    'editor.mode': 'edit',
    'custom.preference': 'keep'
  },
  [KEYS.shell]: {
    orderV: 2,
    order: ['cards', 'markdown', CUSTOM_ID, 'files'],
    hidden: ['cards', CUSTOM_ID],
    custom: [{ id: CUSTOM_ID, name: '保留能力', url: 'https://example.invalid/tool', builtin: false, emoji: 'K' }],
    activeId: 'cards',
    pinned: true,
    customSettings: { dense: true }
  },
  [KEYS.storage]: {
    active: 'default',
    profiles: { default: { provider: 'aliyun', accessKeyId: 'keep-id', accessKeySecret: 'must-not-export' } }
  }
};

function finish(result, rendered) {
  window[RESULT_VAR] = result;
  document.body.dataset.rendered = rendered;
  document.title = JSON.stringify(result);
}

function fail(error) {
  const cause = error instanceof Error ? error : new Error(String(error));
  finish({ error: { name: cause.name, message: cause.message, stack: cause.stack || '' }, diagnostics }, 'error');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`${label}超时`);
}

function stored(win, key) {
  const raw = win.localStorage.getItem(key);
  return raw == null ? null : JSON.parse(raw);
}

function withoutCards(value) {
  return !Object.keys(value || {}).some((key) => key.startsWith('cards.'));
}

function chromeStubSource(mirror) {
  return `(() => {
    const mirror = ${JSON.stringify(mirror)};
    const calls = { operations: [], sets: [], removes: [] };
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const local = {
      async get(keys) {
        calls.operations.push({ type: 'get', keys: clone(keys) });
        const names = typeof keys === 'string' ? [keys]
          : Array.isArray(keys) ? keys
          : Object.keys(keys || mirror);
        const out = {};
        for (const key of names) if (mirror[key] != null) out[key] = clone(mirror[key]);
        return out;
      },
      async set(batch) {
        calls.operations.push({ type: 'set', keys: Object.keys(batch) });
        calls.sets.push(clone(batch));
        Object.assign(mirror, clone(batch));
      },
      async remove(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        calls.operations.push({ type: 'remove', keys: names });
        calls.removes.push(names.slice());
        for (const key of names) delete mirror[key];
      }
    };
    const root = new URL('../../', document.baseURI);
    const runtime = {
      getURL(path) { return new URL(String(path).replace(/^\\/+/, ''), root).href; },
      async sendMessage() { return { ok: false }; }
    };
    const api = window.chrome || {};
    Object.defineProperty(api, 'runtime', { configurable: true, value: runtime });
    Object.defineProperty(api, 'storage', { configurable: true, value: { local } });
    Object.defineProperty(api, 'tabs', { configurable: true, value: { async create() { return {}; } } });
    try { Object.defineProperty(window, 'chrome', { configurable: true, value: api }); } catch (error) {}
    window.__chromeStub = { mirror, calls };
  })();`;
}

async function bootRealShell(frame) {
  localStorage.clear();
  const appUrl = new URL('../src/app/index.html', location.href).href;
  const response = await fetch(appUrl);
  if (!response.ok) throw new Error(`外壳 HTML 加载失败：${response.status}`);
  let html = await response.text();
  html = html.replace(/<head>/i, `<head><base href="${appUrl}">`);
  const mainTag = '<script type="module" src="./main.js"></script>';
  assert(html.includes(mainTag), '找不到真实外壳 main.js 入口');
  html = html.replace(mainTag,
    `<script>${chromeStubSource(initialMirror)}<\/script>`
    + `<script type="module">
      await import('./main.js');
      const [{ CAPABILITIES, KEYS }, { exportAll }, { secretPaths }] = await Promise.all([
        import('../core/config.js'), import('../core/store.js'), import('../storage/index.js')
      ]);
      window.__docsmithTest = {
        loaded: true,
        CAPABILITIES,
        KEYS,
        exportAll,
        secretPaths,
        importMigration: () => import('../core/remove-cards.js')
      };
    <\/script>`);

  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  frame.src = url;
  await waitFor(() => frame.contentWindow?.__docsmithTest?.loaded, '真实外壳启动');
  return { win: frame.contentWindow, doc: frame.contentDocument, url };
}

async function checkZip(win) {
  const text = 'zip-ok';
  const blob = await win.DSZip.createZip([{
    path: '保留/ok.txt',
    data: new TextEncoder().encode(text).buffer
  }]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert(blob.type === 'application/zip', 'DSZip MIME 类型错误');
  assert(view.getUint32(0, true) === 0x04034b50, 'ZIP 本地文件头无效');
  assert(view.getUint16(6, true) === 0x0800, 'ZIP 文件名未标记 UTF-8');
  const method = view.getUint16(8, true);
  const compressedSize = view.getUint32(18, true);
  const rawSize = view.getUint32(22, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const dataAt = 30 + nameLength + extraLength;
  const compressed = bytes.slice(dataAt, dataAt + compressedSize);
  let raw;
  if (method === 0) raw = compressed;
  else if (method === 8) {
    const stream = new win.Blob([compressed]).stream()
      .pipeThrough(new win.DecompressionStream('deflate-raw'));
    raw = new Uint8Array(await new win.Response(stream).arrayBuffer());
  } else throw new Error(`ZIP 使用了不支持校验的方法 ${method}`);

  const name = new TextDecoder().decode(bytes.slice(30, 30 + nameLength));
  const content = new TextDecoder().decode(raw);
  assert(name === '保留/ok.txt' && content === text && raw.length === rawSize, 'ZIP 条目名、内容或长度损坏');
  const centralAt = dataAt + compressedSize;
  assert(view.getUint32(centralAt, true) === 0x02014b50, 'ZIP 中央目录无效');
  assert(view.getUint16(centralAt + 10, true) === method, 'ZIP 两处压缩方法不一致');
  assert(view.getUint32(centralAt + 20, true) === compressedSize
    && view.getUint32(centralAt + 24, true) === rawSize, 'ZIP 中央目录大小不一致');
  assert(view.getUint32(bytes.length - 22, true) === 0x06054b50, 'ZIP 结束记录无效');
  return { bytes: bytes.length, name, method };
}

async function checkCleanAndIdempotent(win) {
  const { cleanupRemovedCards } = await win.__docsmithTest.importMigration();
  assert(typeof cleanupRemovedCards === 'function', '找不到共享的 cards 清理模块');
  await sleep(500);

  win.localStorage.removeItem(KEYS.prefs);
  win.localStorage.removeItem(KEYS.shell);
  win.__chromeStub.calls.sets.length = 0;
  cleanupRemovedCards();
  await sleep(450);
  assert(win.localStorage.getItem(KEYS.prefs) == null && win.localStorage.getItem(KEYS.shell) == null,
    '全新安装被迁移写入了状态');
  assert(!win.__chromeStub.calls.sets.some((batch) => KEYS.prefs in batch || KEYS.shell in batch),
    '全新安装触发了镜像写入');

  win.localStorage.setItem(KEYS.prefs, JSON.stringify({ 'cards.cover': true, 'editor.mode': 'source', keep: 7 }));
  win.localStorage.setItem(KEYS.shell, JSON.stringify({
    orderV: 2,
    order: ['cards', 'files', CUSTOM_ID, 'markdown'],
    hidden: ['cards', CUSTOM_ID],
    activeId: 'cards',
    custom: initialMirror[KEYS.shell].custom,
    keep: 9
  }));
  win.__chromeStub.calls.sets.length = 0;
  cleanupRemovedCards();
  await sleep(450);
  const once = {
    prefs: stored(win, KEYS.prefs),
    shell: stored(win, KEYS.shell)
  };
  assert(withoutCards(once.prefs) && once.prefs.keep === 7, '首次清理没有保留其他偏好');
  assert(JSON.stringify(once.shell.order) === JSON.stringify(['files', CUSTOM_ID, 'markdown']), '首次清理破坏菜单顺序');
  assert(JSON.stringify(once.shell.hidden) === JSON.stringify([CUSTOM_ID]), '首次清理破坏隐藏项');
  assert(!('activeId' in once.shell) && once.shell.keep === 9, '首次清理没有移除旧 activeId 或保留其他字段');
  assert(win.__chromeStub.calls.sets.some((batch) => KEYS.prefs in batch && KEYS.shell in batch),
    '首次清理没有同步 Chrome 镜像');

  win.__chromeStub.calls.sets.length = 0;
  cleanupRemovedCards();
  await sleep(450);
  assert(JSON.stringify({ prefs: stored(win, KEYS.prefs), shell: stored(win, KEYS.shell) }) === JSON.stringify(once),
    '重复清理改变了状态');
  assert(!win.__chromeStub.calls.sets.some((batch) => KEYS.prefs in batch || KEYS.shell in batch),
    '重复清理仍写入 Chrome 镜像');
  return true;
}

async function importOldBackup(frame, win, doc) {
  const imported = {
    _docsmith: 1,
    data: {
      [KEYS.prefs]: { 'cards.background': 'ink', 'editor.mode': 'read', 'import.marker': 'current-session' },
      [KEYS.shell]: {
        orderV: 2,
        order: ['cards', 'markdown', CUSTOM_ID, 'files'],
        hidden: ['cards', CUSTOM_ID],
        activeId: 'cards',
        custom: initialMirror[KEYS.shell].custom,
        importedOther: true
      },
      [KEYS.storage]: initialMirror[KEYS.storage]
    }
  };
  const input = doc.querySelector('#importFile');
  assert(input, '找不到真实配置导入控件');
  const file = new win.File([JSON.stringify(imported)], 'old-docsmith.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });

  const storageEvents = [];
  const completed = new Promise((resolve, reject) => {
    const detach = () => {
      window.removeEventListener('storage', onStorage);
      frame.removeEventListener('load', onReload);
    };
    const snapshot = () => {
      const prefs = stored(window, KEYS.prefs);
      const shell = stored(window, KEYS.shell);
      diagnostics.import = { storageEvents, prefs, shell };
      return { prefs, shell };
    };
    const onStorage = (event) => {
      if (event.key !== KEYS.prefs && event.key !== KEYS.shell) return;
      storageEvents.push(event.key);
      const { prefs, shell } = snapshot();
      if (prefs?.['import.marker'] !== 'current-session' || !withoutCards(prefs)) return;
      if (shell?.order?.includes('cards') || shell?.hidden?.includes('cards') || shell?.activeId === 'cards') return;
      detach();
      resolve();
    };
    const onReload = () => {
      snapshot();
      detach();
      reject(new Error('旧配置在导入边界清理完成前触发了重载'));
    };
    window.addEventListener('storage', onStorage);
    frame.addEventListener('load', onReload);
  });

  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  await completed;
  assert(!doc.querySelector('#nav .cap[data-id="cards"]'), '导入旧配置后 cards 回到了当前导航');
}

(async () => {
  let shellUrl = '';
  try {
    const frame = document.querySelector('#shell');
    const { win, doc, url } = await bootRealShell(frame);
    shellUrl = url;

    const restoredPrefs = stored(win, KEYS.prefs);
    const restoredShell = stored(win, KEYS.shell);
    const operations = win.__chromeStub.calls.operations;
    diagnostics.restore = { operations, prefs: restoredPrefs, shell: restoredShell };
    const restoreGet = operations.findIndex((operation) => operation.type === 'get'
      && operation.keys?.includes?.(KEYS.prefs) && operation.keys.includes(KEYS.shell));
    const firstStateWrite = operations.findIndex((operation) => operation.type === 'set'
      && operation.keys?.some?.((key) => key === KEYS.prefs || key === KEYS.shell));
    assert(restoreGet >= 0, '启动没有从 Chrome 镜像读取 prefs/shell');
    assert(firstStateWrite < 0 || restoreGet < firstStateWrite, 'cards 清理发生在 Chrome 镜像恢复之前');
    assert(withoutCards(restoredPrefs), 'Chrome 镜像恢复后仍保留 cards 偏好');
    assert(restoredPrefs['editor.mode'] === 'edit' && restoredPrefs['custom.preference'] === 'keep',
      '迁移丢失了其他偏好');
    assert(JSON.stringify(restoredShell.order) === JSON.stringify(['markdown', CUSTOM_ID, 'files']),
      '迁移没有只移除 cards 顺序项');
    assert(JSON.stringify(restoredShell.hidden) === JSON.stringify([CUSTOM_ID]), '迁移没有只移除 cards 隐藏项');
    assert(restoredShell.custom?.[0]?.id === CUSTOM_ID && restoredShell.customSettings?.dense === true,
      '迁移丢失了自定义能力或其他 shell 设置');

    await waitFor(() => win.MDW && doc.querySelector('[data-ds-host="markdown"]'), 'Markdown 工作台挂载');
    assert(typeof win.MDW.exportImage === 'function', '整篇 PNG 入口没有保留');
    const navBefore = [...doc.querySelectorAll('#nav .cap')].map((node) => node.dataset.id);
    assert(JSON.stringify(navBefore) === JSON.stringify(['markdown', 'files']), `导航异常：${navBefore.join(',')}`);

    doc.querySelector('#nav .cap[data-id="files"]')?.click();
    await waitFor(() => win.DSZip && doc.querySelector('[data-ds-host="files"]'), '文件库挂载');
    const zip = await checkZip(win);
    assert(win.__docsmithTest.CAPABILITIES.map((cap) => cap.id).join(',') === 'markdown,files', '内置能力表仍含 cards');

    await checkCleanAndIdempotent(win);
    await importOldBackup(frame, win, doc);

    const payload = win.__docsmithTest.exportAll(Object.values(win.__docsmithTest.KEYS), {
      secretPaths: win.__docsmithTest.secretPaths()
    });
    const exportedPrefs = payload.data[KEYS.prefs];
    const exportedShell = payload.data[KEYS.shell];
    const exportedStorage = payload.data[KEYS.storage];
    assert(withoutCards(exportedPrefs), '配置导出仍包含 cards 偏好');
    assert(!exportedShell.order.includes('cards') && !exportedShell.hidden.includes('cards')
      && exportedShell.activeId !== 'cards', '配置导出仍包含 cards 导航状态');
    assert(exportedShell.custom?.[0]?.id === CUSTOM_ID && exportedShell.importedOther === true,
      '配置导出丢失自定义能力或其他 shell 字段');
    assert(!('accessKeySecret' in exportedStorage.profiles.default), '配置导出泄露了存储密钥');

    finish({
      ready: true,
      restoreBeforeCleanup: true,
      cleanInstall: true,
      idempotent: true,
      importBoundary: true,
      exportClean: true,
      secretStripped: true,
      navigation: ['markdown', 'files'],
      markdownMounted: true,
      filesMounted: true,
      wholePng: true,
      zip
    }, 'true');
  } catch (error) {
    fail(error);
  } finally {
    if (shellUrl) setTimeout(() => URL.revokeObjectURL(shellUrl), 1000);
  }
})();
