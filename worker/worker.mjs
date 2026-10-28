// Cloudflare Worker ES module. No login cookies, audio proxying or dependencies.
const ID = /^[1-9]\d{0,15}$/;
const validID = value => ID.test(value) && Number.isSafeInteger(Number(value));
class APIError extends Error {
  constructor(message, code = 'UPSTREAM_ERROR', diagnostics = {}) { super(message); this.name = 'APIError'; this.code = code; this.diagnostics = diagnostics; }
}
const apiError = (message, code, diagnostics) => { throw new APIError(message, code, diagnostics); };
function coverURL(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname.endsWith('.music.126.net')) { url.protocol = 'https:'; return url.href; }
  } catch {}
  return '';
}
function songInfo(track) {
  const album = track.al || track.album || {}, artists = track.ar || track.artists || [];
  return { songId: String(track.id), name: String(track.name || ''), artist: artists.map(a => a.name || '').filter(Boolean).join('/') || '未知歌手', album: String(album.name || ''), cover: coverURL(album.picUrl) };
}
async function netease(path, params) {
  const url = new URL(path, 'https://music.163.com');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 12000);
  try {
    let response;
    try {
      response = await fetch(url.href, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' },
        // Workers supports manual/follow, but not the browser's "error" mode.
        redirect: 'manual', signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) throw error;
      console.error(JSON.stringify({ code: 'UPSTREAM_FETCH_FAILED', path, type: error.name, message: error.message }));
      apiError('Cloudflare 无法连接网易云，请查看 Worker 日志或使用 CSV。', 'UPSTREAM_FETCH_FAILED');
    }
    if (response.status >= 300 && response.status < 400) apiError('网易云将接口请求重定向，未自动跟随。可重试或使用 CSV。', 'UPSTREAM_REDIRECT', { upstreamStatus: response.status });
    if (!response.ok) apiError(`网易云接口返回 HTTP ${response.status}，请稍后重试或使用 CSV。`, 'UPSTREAM_HTTP_ERROR', { upstreamStatus: response.status });
    const reader = response.body.getReader(), chunks = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 16 * 1024 * 1024) { await reader.cancel(); apiError('歌单响应过大，请改用 CSV 导入。'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let data;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { apiError('网易云返回了非 JSON 内容，可能是验证页或服务限制。可重试或使用 CSV。', 'UPSTREAM_NOT_JSON', { upstreamStatus: response.status, contentType: (response.headers.get('Content-Type') || '').slice(0, 120) }); }
    if (!data || data.code !== 200) apiError('网易云未允许读取数据，可能需要登录、已删除或暂时受限。可改用 CSV。', 'UPSTREAM_REJECTED', { upstreamCode: typeof data?.code === 'number' ? data.code : null });
    return data;
  } finally { clearTimeout(timer); }
}
async function resolve(path, params) {
  if (path === '/api/songs') {
    const ids = (params.get('ids') || '').split(',');
    if (!ids.length || ids.length > 100 || ids.some(id => !validID(id)) || new Set(ids).size !== ids.length) return { status: 400, data: { error: '每次需提供 1–100 个不同的有效歌曲 ID。' } };
    const data = await netease('/api/song/detail/', { ids: JSON.stringify(ids.map(Number)) });
    const allowed = new Set(ids);
    return { data: { songs: (data.songs || []).filter(s => allowed.has(String(s.id)) && s.name).map(songInfo) }, ttl: 300 };
  }
  const id = params.get('id') || '';
  if (!validID(id)) return { status: 400, data: { error: '无效的网易云 ID。' } };
  if (path === '/api/playlist') {
    const data = await netease('/api/v6/playlist/detail', { id, n: 10000, s: 0 });
    const p = data.playlist || {}, total = p.trackCount;
    if (!Number.isInteger(total) || total < 1) apiError('歌单为空或无法公开读取。');
    if (total > 10000) apiError('最多支持 10000 首歌曲，请拆分或用 CSV 导入。');
    const ids = (p.trackIds || []).map(entry => String(entry.id));
    if (ids.length !== total || ids.some(id => !validID(id)) || new Set(ids).size !== total) apiError(`歌单声明 ${total} 首，但未获得完整歌曲 ID，未导入。请改用 CSV。`);
    const wanted = new Set(ids);
    return { data: { id, name: String(p.name || '网易云歌单'), total, ids, songs: (p.tracks || []).filter(s => wanted.has(String(s.id)) && s.name).map(songInfo) }, ttl: 60 };
  }
  if (path === '/api/cover') {
    const data = await netease('/api/song/detail/', { id, ids: JSON.stringify([Number(id)]) });
    const track = (data.songs || []).find(s => String(s.id) === id);
    const cover = track && songInfo(track).cover;
    return { data: cover ? { cover } : { error: '未获取到网易云封面。' }, ttl: cover ? 3600 : 0 };
  }
  const data = await netease('/api/song/enhance/player/url', { ids: JSON.stringify([Number(id)]), br: 128000 });
  const track = (data.data || []).find(s => String(s.id) === id);
  const url = coverURL(track?.url);
  return { data: url ? { url, trial: !!track.freeTrialInfo } : { error: '网易云暂未提供公开音源，可使用本地音频。' }, ttl: url ? 180 : 0 };
}
function json(data, status = 200, origin = '') {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(data), { status, headers });
}
export default {
  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true, service: 'netease-sort-api', version: 2 });
    let allowed;
    try {
      allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).map(value => {
        const origin = new URL(value);
        if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('Invalid origin');
        return origin.origin;
      });
    } catch { allowed = []; }
    if (!allowed.length) return json({ error: '请先在 Worker 配置 ALLOWED_ORIGINS，填写 GitHub Pages 的 HTTPS 域名，不带路径。' }, 503);
    const origin = request.headers.get('Origin') || '';
    if (origin && !allowed.includes(origin)) return json({ error: '网页域名未获允许，请检查 ALLOWED_ORIGINS。' }, 403);
    if (!['GET', 'OPTIONS'].includes(request.method)) return json({ error: '仅支持 GET 请求。' }, 405, origin);
    if (request.method === 'OPTIONS') {
      const response = json({}, 200, origin);
      response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      return response;
    }
    if (!['/api/playlist', '/api/songs', '/api/cover', '/api/preview'].includes(url.pathname)) return json({ error: '接口不存在。' }, 404, origin);
    // Ignore arbitrary query parameters so they cannot bypass cache keys.
    const key = new URL(url.origin + url.pathname);
    const param = url.pathname === '/api/songs' ? 'ids' : 'id';
    key.searchParams.set(param, url.searchParams.get(param) || '');
    key.searchParams.set('workerVersion', '2');
    try {
      const cache = globalThis.caches?.default;
      let cached;
      try { cached = cache && await cache.match(key.href); }
      catch { console.warn('Edge cache unavailable; continuing without cache.'); }
      if (cached) return json(await cached.json(), 200, origin);
      const result = await resolve(url.pathname, key.searchParams);
      if (cache && result.ttl && !result.data.error) {
        const value = new Response(JSON.stringify(result.data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${result.ttl}` } });
        const save = cache.put(key.href, value).catch(() => console.warn('Edge cache write failed.'));
        if (ctx.waitUntil) ctx.waitUntil(save); else await save;
      }
      return json(result.data, result.status || 200, origin);
    } catch (error) {
      if (error instanceof APIError) return json({ error: error.message, code: error.code, ...error.diagnostics }, 502, origin);
      console.error(JSON.stringify({ code: 'WORKER_INTERNAL_ERROR', path: url.pathname, type: error.name, message: error.message }));
      return json({ error: error.name === 'AbortError' ? '网易云请求超时，请重试或使用 CSV。' : 'Worker 处理失败，请查看 Cloudflare 实时日志。', code: error.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'WORKER_INTERNAL_ERROR' }, 502, origin);
    }
  },
};
