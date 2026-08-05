/* =====================================================================
 * 存储适配器 · 通用上传接口
 * ---------------------------------------------------------------------
 * 适用于「我们公司已经有一个上传接口」的情况：把文件 POST 过去，从返回的
 * JSON 里取出文件链接。所有细节都是配置项 ——
 *   · 接口地址
 *   · 文件用哪个字段名
 *   · 还要额外带哪些参数（bucket、userCode、cdn……）
 *   · 需要哪些请求头（Authorization……）
 *   · 返回的 JSON 里，链接藏在哪一层
 *
 * 这是本项目的默认方式，因为密钥留在服务器上，浏览器这边什么都不用存。
 * ===================================================================== */

export const id = 'gateway';

export function validate(cfg) {
  const miss = [];
  if (!cfg.apiUrl) miss.push('上传地址');
  if (!cfg.urlPath) miss.push('返回链接的位置');
  if (cfg.apiUrl && !/^https?:\/\//i.test(cfg.apiUrl)) {
    return '上传地址要以 http:// 或 https:// 开头。';
  }
  return miss.length ? `还差这些没填：${miss.join('、')}` : null;
}

/**
 * @param {File|Blob} file
 * @param {Object} ctx { cfg, fileName, relPath, onProgress, signal }
 */
export function upload(file, ctx = {}) {
  const cfg = ctx.cfg || {};
  const err = validate(cfg);
  if (err) return Promise.reject(new Error(err));

  const fileName = ctx.fileName || file.name || 'file';

  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append(cfg.fileField || 'file', file, fileName);
    for (const [k, v] of pairs(cfg.extraFields)) fd.append(k, v);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', cfg.apiUrl);
    for (const [k, v] of pairs(cfg.headers)) {
      try { xhr.setRequestHeader(k, v); } catch (e) {}
    }
    if (ctx.onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) ctx.onProgress(e.loaded / e.total);
      });
    }
    if (ctx.signal) ctx.signal.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`上传地址返回了 HTTP ${xhr.status}。${hint(xhr.status)}`));
        return;
      }
      let res;
      try {
        res = JSON.parse(xhr.responseText);
      } catch (e) {
        reject(new Error('接口返回的不是 JSON，Docsmith 读不出文件链接。确认一下上传地址填对了没有。'));
        return;
      }
      const url = dig(res, cfg.urlPath || 'data.downUrl');
      if (!url || typeof url !== 'string') {
        const msg = res?.msg || res?.message || res?.errMsg;
        reject(new Error(
          msg ? `接口说：${msg}`
            : `在返回结果的「${cfg.urlPath}」里没找到链接。到设置里把「返回链接的位置」改成正确的字段。`,
        ));
        return;
      }
      resolve({ url, key: url, size: file.size, raw: res });
    };
    xhr.onerror = () => reject(new Error(
      '连不上上传地址。检查网络，以及这个接口是否允许浏览器扩展访问（CORS）。',
    ));
    xhr.onabort = () => reject(new Error('已取消'));
    xhr.send(fd);
  });
}

/** 通用接口的链接一般是长期有效的，不需要刷新。 */
export async function refreshUrl(cfg, key) { return key; }

/* ------------------------------------------------------------- 小工具 */

/** 'data.downUrl' → res.data.downUrl；支持 a.b[0].c */
function dig(obj, path) {
  return String(path).split('.').reduce((o, seg) => {
    if (o == null) return undefined;
    const m = /^(.*?)\[(\d+)\]$/.exec(seg);
    if (m) return m[1] ? o[m[1]]?.[Number(m[2])] : o[Number(m[2])];
    return o[seg];
  }, obj);
}

/** 键值对配置既支持数组 [{key,value}]，也支持对象 {k:v}。 */
function pairs(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter((p) => p && p.key).map((p) => [p.key, p.value ?? '']);
  if (typeof v === 'object') return Object.entries(v);
  return [];
}

function hint(status) {
  if (status === 401 || status === 403) return '看起来是没有权限 —— 检查「请求头」里的令牌是不是过期了。';
  if (status === 404) return '这个地址不存在，核对一下路径。';
  if (status === 413) return '文件超过了接口允许的大小。';
  if (status >= 500) return '是接口那边出错了，稍后再试或联系接口维护的同事。';
  return '';
}
