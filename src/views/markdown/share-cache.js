(function (w) {
  var KEY = 'docsmith:share-cache', MAX = 80;
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
  function save(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }

  // FNV-1a 双路 32 位 + 长度，同步、无依赖、碰撞率对本场景足够
  function hash(str) {
    str = String(str);
    var h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193);
      h2 ^= c; h2 = Math.imul(h2, 0x85ebca6b);
    }
    return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36) + '-' + str.length.toString(36);
  }



  w.ShareCache = {
    key: function (kind, name, payload) { return kind + '|' + name + '|' + hash(payload); },
    get: function (k) {
      var entry = read()[k];
      return (entry && entry.url) ? entry : null;
    },
    put: function (k, value) {
      var o = read();
      o[k] = {
        url: value.url,
        id: value.id,
        name: value.name,
        size: value.size,
        ts: Date.now()
      };
      var keys = Object.keys(o);
      if (keys.length > MAX) {                              // 淘汰最旧的
        keys.sort(function (a, b) { return (o[a].ts || 0) - (o[b].ts || 0); })
          .slice(0, keys.length - MAX).forEach(function (x) { delete o[x]; });
      }
      save(o);
    },
    drop: function (k) { var o = read(); delete o[k]; save(o); },
    clear: function () { save({}); }
  };
})(window);
