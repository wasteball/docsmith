import { KEYS } from './config.js';
import { read, write } from './store.js';

const CARDS_ID = 'cards';
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function cleanupRemovedCards() {
  try {
    const saved = read(KEYS.prefs, {});
    if (isRecord(saved)) {
      let changed = false;
      for (const key of Object.keys(saved)) {
        if (!key.startsWith('cards.')) continue;
        delete saved[key];
        changed = true;
      }
      if (changed) write(KEYS.prefs, saved);
    }
  } catch (error) {
    console.warn('[docsmith] 清理已移除的图文卡片偏好失败：', error);
  }

  try {
    const saved = read(KEYS.shell, {});
    if (!isRecord(saved)) return;
    let changed = false;
    for (const field of ['order', 'hidden']) {
      if (!Array.isArray(saved[field])) continue;
      const next = saved[field].filter((id) => id !== CARDS_ID);
      if (next.length === saved[field].length) continue;
      saved[field] = next;
      changed = true;
    }
    if (saved.activeId === CARDS_ID) {
      delete saved.activeId;
      changed = true;
    }
    if (changed) write(KEYS.shell, saved);
  } catch (error) {
    console.warn('[docsmith] 清理已移除的图文卡片菜单状态失败：', error);
  }
}
