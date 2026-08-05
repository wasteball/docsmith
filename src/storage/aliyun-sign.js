/* =====================================================================
 * 阿里云 OSS · V4 签名
 * ---------------------------------------------------------------------
 * 浏览器直传要自己算签名。这里实现阿里云的 OSS4-HMAC-SHA256，两种用法：
 *
 *   signRequest()  给 PUT 上传请求算 Authorization 头
 *   signUrl()      给私有文件生成一条带时效的分享链接
 *
 * 全部用浏览器自带的 Web Crypto，没有任何第三方依赖。
 * 参考：阿里云 OSS 开发者文档「在请求头中包含签名（V4）」。
 * ===================================================================== */

const enc = new TextEncoder();

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return hex(new Uint8Array(buf));
}

function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC 3986 编码。OSS 要求空格编成 %20，而不是 +。 */
export function uriEncode(str, keepSlash = false) {
  let out = encodeURIComponent(String(str))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (keepSlash) out = out.replace(/%2F/g, '/');
  return out;
}

/** 20240131T091500Z 形式的时间戳 */
export function isoStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** 地域标准化：oss-cn-hangzhou → cn-hangzhou（签名域里不带 oss- 前缀） */
export function bareRegion(region) {
  return String(region || '').trim().replace(/^oss-/, '');
}

/** 请求要打到的主机名 */
export function ossHost(bucket, region, customDomain) {
  if (customDomain) {
    return String(customDomain).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
  const r = String(region || '').trim();
  const withPrefix = r.startsWith('oss-') ? r : `oss-${r}`;
  return `${bucket}.${withPrefix}.aliyuncs.com`;
}

async function signingKey(secret, date, region) {
  let k = await hmac(enc.encode(`aliyun_v4${secret}`), date);
  k = await hmac(k, region);
  k = await hmac(k, 'oss');
  k = await hmac(k, 'aliyun_v4_request');
  return k;
}

/**
 * 给一个请求算出应该带的头。
 * @returns {Promise<Object>} 直接可以塞进 XHR/fetch 的 headers
 */
export async function signRequest({
  method = 'PUT', bucket, region, objectKey,
  accessKeyId, accessKeySecret, stsToken,
  contentType, extraHeaders = {}, customDomain,
}) {
  const now = new Date();
  const stamp = isoStamp(now);
  const date = stamp.slice(0, 8);
  const reg = bareRegion(region);
  const host = ossHost(bucket, region, customDomain);

  const headers = {
    'x-oss-date': stamp,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    ...extraHeaders,
  };
  if (stsToken) headers['x-oss-security-token'] = stsToken;
  if (contentType) headers['Content-Type'] = contentType;

  // 参与签名的头：host + content-type + 所有 x-oss-*，按名字排序
  const signed = { host };
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'content-type' || lk.startsWith('x-oss-')) signed[lk] = String(v).trim();
  }
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]}\n`).join('');
  // 除 host / content-type / x-oss-* 之外没有额外头参与签名
  const additionalHeaders = '';

  const canonicalUri = `/${bucket}/${uriEncode(objectKey, true)}`;
  const canonicalRequest = [
    method,
    canonicalUri,
    '',                    // 查询串（上传时为空）
    canonicalHeaders,
    additionalHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope = `${date}/${reg}/oss/aliyun_v4_request`;
  const stringToSign = [
    'OSS4-HMAC-SHA256',
    stamp,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const key = await signingKey(accessKeySecret, date, reg);
  const signature = hex(await hmac(key, stringToSign));

  headers.Authorization =
    `OSS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},Signature=${signature}`;

  return { headers, host, url: `https://${host}/${uriEncode(objectKey, true)}` };
}

/**
 * 私有文件的临时分享链接。
 * @param expires 有效期（秒）。阿里云 V4 最长 7 天。
 */
export async function signUrl({
  bucket, region, objectKey, accessKeyId, accessKeySecret, stsToken,
  expires = 604800, customDomain, method = 'GET',
}) {
  const now = new Date();
  const stamp = isoStamp(now);
  const date = stamp.slice(0, 8);
  const reg = bareRegion(region);
  const host = ossHost(bucket, region, customDomain);
  const scope = `${accessKeyId}/${date}/${reg}/oss/aliyun_v4_request`;

  const q = {
    'x-oss-signature-version': 'OSS4-HMAC-SHA256',
    'x-oss-credential': scope,
    'x-oss-date': stamp,
    'x-oss-expires': String(Math.min(Math.max(expires | 0, 1), 604800)),
    'x-oss-additional-headers': 'host',
  };
  if (stsToken) q['x-oss-security-token'] = stsToken;

  const canonicalQuery = Object.keys(q).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(q[k])}`).join('&');

  const canonicalRequest = [
    method,
    `/${bucket}/${uriEncode(objectKey, true)}`,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'OSS4-HMAC-SHA256',
    stamp,
    `${date}/${reg}/oss/aliyun_v4_request`,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const key = await signingKey(accessKeySecret, date, reg);
  const signature = hex(await hmac(key, stringToSign));

  return `https://${host}/${uriEncode(objectKey, true)}?${canonicalQuery}&x-oss-signature=${uriEncode(signature)}`;
}
