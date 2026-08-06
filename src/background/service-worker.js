/* =====================================================================
 * Docsmith · 后台
 * ---------------------------------------------------------------------
 * 扩展里唯一常驻的一小段代码。它只做三件事：
 *   1. 点扩展图标 → 打开侧边面板
 *   2. 右键网页上的链接 → 在 Markdown 工作台里打开它
 *   3. 首次安装 → 打开一次上手说明
 *
 * 这里不碰用户的任何数据。
 * ===================================================================== */

const PANEL_PATH = 'src/app/index.html';

/* 点图标之后是开整页还是开侧边栏，由用户在设置里决定。
   默认整页 —— 读文档、看图表是主要用途，侧边栏那 300–400px 装不下一张
   流程图。想一边看网页一边传文件的人可以在设置里切回侧边栏。
   注意这里的回落值必须和 core/settings.js 里 ui.openMode 的 default 一致：
   没设过的时候两边得给出同一个答案，否则设置面板显示「整页」而实际开侧边栏。 */
async function openMode() {
  try {
    const { 'docsmith:prefs': p } = await chrome.storage.local.get('docsmith:prefs');
    return p?.['ui.openMode'] === 'panel' ? 'panel' : 'tab';
  } catch (e) { return 'tab'; }
}

/* 侧边栏模式下点图标直接开，不用经过下面的监听 */
async function syncActionBehavior() {
  const mode = await openMode();
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: mode === 'panel' })
    .catch(() => {});
}
syncActionBehavior();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['docsmith:prefs']) syncActionBehavior();
});

chrome.action.onClicked.addListener(async (tab) => {
  // 只有整页模式才会走到这里（侧边栏模式由 setPanelBehavior 直接接管）
  if (await openMode() === 'tab') { openInTab(); return; }
  try {
    if (chrome.sidePanel && tab?.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    }
  } catch (e) { /* 不支持侧边栏就退回标签页 */ }
  openInTab();
});

/* 外壳里点「展开为整页」时发过来 */
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'docsmith:open-tab') { openInTab(); respond?.({ ok: true }); }
  /* 「导出 PDF」用：外壳把 blob: URL 发过来，这里开一个真标签页。
     为什么绕到 service worker：侧边栏页面里 chrome.tabs 不一定拿得到，
     而 window.open 又常被当成弹窗拦掉。service worker 一定有 chrome.tabs，
     这是三级降级里最可靠的一级（另外两级在 app/main.js 里）。
     URL 由外壳创建并持有，这里只负责打开。 */
  if (msg?.type === 'docsmith:open-url' && msg.url) {
    chrome.tabs.create({ url: msg.url, active: true })
      .then(() => respond?.({ ok: true }), () => respond?.({ ok: false }));
    return true;                       // 异步回复，必须返回 true
  }
  return false;
});

async function openInTab() {
  const url = chrome.runtime.getURL(PANEL_PATH);
  const [existing] = await chrome.tabs.query({ url: `${url}*` });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

/* ------------------------------------------------------------ 右键菜单 */
chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'docsmith-open',
      title: '在 Docsmith 里打开',
      contexts: ['link'],
      targetUrlPatterns: ['*://*/*'],
    });
    chrome.contextMenus.create({
      id: 'docsmith-panel',
      title: '打开 Docsmith 面板',
      contexts: ['page', 'selection'],
    });
  });

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/views/welcome/index.html') });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'docsmith-panel') {
    if (chrome.sidePanel && tab?.windowId != null) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(openInTab);
    } else {
      openInTab();
    }
    return;
  }

  if (info.menuItemId === 'docsmith-open' && info.linkUrl) {
    // 把链接交给 Markdown 工作台，它会自己抓取并渲染
    const url = chrome.runtime.getURL(
      `${PANEL_PATH}#open=${encodeURIComponent(info.linkUrl)}`,
    );
    chrome.tabs.create({ url });
  }
});
