/* =====================================================================
 * 存储适配器 · 阿里云 OSS（浏览器直传）
 * ---------------------------------------------------------------------
 * 文件从用户的浏览器直接传进他自己的 Bucket，不经过任何中转服务器。
 * 需要用户在阿里云控制台给 Bucket 开跨域访问（CORS），文档里有一步一步
 * 的说明。
 * ===================================================================== */
import { signRequest, signUrl, ossHost, uriEncode } from './aliyun-sign.js';

export const id = 'aliyun';

/** 配置齐了没有。缺什么就说缺什么，别让用户猜。 */
export function validate(cfg) {
  const miss = [];
  if (!cfg.region) miss.push('地域');
  if (!cfg.bucket) miss.push('存储空间名称');
  if (!cfg.accessKeyId) miss.push('AccessKey ID');
  if (!cfg.accessKeySecret) miss.push('AccessKey Secret');
  return miss.length ? `还差这些没填：${miss.join('、')}` : null;
}

/** 生成对象名：目录前缀 + 日期 + 随机短码 + 原文件名。 */
export function buildKey(cfg, fileName, relPath = '') {
  const prefix = String(cfg.prefix || '').replace(/^\/+/, '').replace(/\/*$/, m => (m ? '/' : '/'));
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 8);
  const safe = String(relPath || fileName).replace(/^\/+/, '').replace(/\.\./g, '_');
  return `${prefix === '/' ? '' : prefix}${day}/${rand}/${safe}`;
}

/**
 * 上传一个文件。
 * @param {File|Blob} file
 * @param {Object} ctx { cfg, fileName, relPath, onProgress, signal }
 * @returns {Promise<{url, key, size}>}
 */
export async function upload(file, ctx = {}) {
  const cfg = ctx.cfg || {};
  const err = validate(cfg);
  if (err) throw new Error(err);

  const fileName = ctx.fileName || file.name || 'file';
  const objectKey = buildKey(cfg, fileName, ctx.relPath);
  const contentType = file.type || 'application/octet-stream';

  const extraHeaders = {};
  if (cfg.acl === 'public-read') extraHeaders['x-oss-object-acl'] = 'public-read';
  // 让浏览器点开链接是「预览」而不是「下载」，同时保留原始文件名
  extraHeaders['x-oss-meta-name'] = encodeURIComponent(fileName);

  const { headers, url } = await signRequest({
    method: 'PUT',
    bucket: cfg.bucket,
    region: cfg.region,
    objectKey,
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    stsToken: cfg.stsToken,
    contentType,
    extraHeaders,
    customDomain: cfg.customDomain,
  });

  await put(url, headers, file, ctx);

  return {
    key: objectKey,
    size: file.size,
    url: await publicUrl(cfg, objectKey),
  };
}

/** 上传后拿到的可分享链接。私有 Bucket 会自动带上时效签名。 */
export async function publicUrl(cfg, objectKey) {
  if (cfg.acl === 'public-read') {
    const host = ossHost(cfg.bucket, cfg.region, cfg.customDomain);
    return `https://${host}/${uriEncode(objectKey, true)}`;
  }
  return signUrl({
    bucket: cfg.bucket,
    region: cfg.region,
    objectKey,
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    stsToken: cfg.stsToken,
    customDomain: cfg.customDomain,
    expires: Number(cfg.signedExpires) || 604800,
  });
}

/** 私有文件的链接会过期。这个方法给已有对象换一条新链接。 */
export async function refreshUrl(cfg, objectKey) {
  return publicUrl(cfg, objectKey);
}

function put(url, headers, body, ctx) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) {
      try { xhr.setRequestHeader(k, v); } catch (e) {}
    }
    if (ctx.onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) ctx.onProgress(e.loaded / e.total);
      });
    }
    if (ctx.signal) {
      ctx.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      reject(new Error(explain(xhr)));
    };
    xhr.onerror = () => reject(new Error(
      '连不上阿里云。多半是 Bucket 还没开启跨域访问（CORS）—— '
      + '照着「连接你的云存储」文档里的第 3 步设置一次就好。',
    ));
    xhr.onabort = () => reject(new Error('已取消'));
    xhr.send(body);
  });
}

/** 把阿里云返回的 XML 错误翻译成人话。 */
function explain(xhr) {
  const text = xhr.responseText || '';
  const code = (/<Code>([^<]+)<\/Code>/.exec(text) || [])[1] || '';
  const map = {
    SignatureDoesNotMatch: 'AccessKey Secret 不对，或者地域填错了。回设置里核对一下。',
    InvalidAccessKeyId: 'AccessKey ID 不存在。确认一下是不是复制少了字符。',
    AccessDenied: '这个密钥没有上传权限。到阿里云给它加上对应 Bucket 的写入权限。',
    NoSuchBucket: '找不到这个存储空间。检查名称拼写，以及地域是否和 Bucket 所在地一致。',
    RequestTimeTooSkewed: '你的电脑时间和阿里云差得太多，签名失效了。校准一下系统时间。',
  };
  if (map[code]) return map[code];
  if (xhr.status === 403) return '阿里云拒绝了这次上传（403）。多半是密钥权限不足，或 Bucket 策略限制了来源。';
  return `上传失败（HTTP ${xhr.status}${code ? ` · ${code}` : ''}）`;
}
