/* All playlist and preference data stays in this browser. */
(() => {
  'use strict';
  const C = window.TuneCore, $ = s => document.querySelector(s);
  const STORAGE = 'tune-order:v1';
  const defaults = { seconds: 10, start: 30, autoplay: true, shuffle: true, volume: .65, topN: 10 };
  let state = { songs: [], selected: [], name: '', settings: { ...defaults }, session: null };
  let engine = null, view = 'prepare', query = '', toastTimer, confirmResolve;
  let audioPool = new Map(), chosenAudio = new Map(), audioBlobs = new Map(), pendingAudio = null;
  let sourceCache = new Map(), sequenceVersion = 0, playbackVersion = 0, cancelPlayback = null, playingUid = null;
  const coverCache = new Map();
  let playlistRequest = null;
  function apiURL(path) {
    const value = String(window.TUNE_CONFIG?.API_BASE || '').trim().replace(/\/+$/, '');
    if (!value) throw new Error('网站尚未配置接口地址，请在 config.js 中填写 Cloudflare Worker 地址。');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('config.js 的 API_BASE 应为 Worker 的 HTTPS 地址，不带路径。');
    return url.origin + path;
  }
  const player = $('#player');
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const songMap = () => new Map(state.songs.map(s => [s.uid, s]));
  const identity = s => C.trackKey(s.name, s.artist);
  const isTopMode = () => engine?.algorithm === 'tournament-v1';
  const modeLabel = () => isTopMode() ? `前 ${Math.min(engine.limit, engine.total - engine.excluded.length)} 名` : '完整排名';
  function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4600); }
  function save() {
    try { localStorage.setItem(STORAGE, JSON.stringify({ version: 1, ...state })); $('#save-status').textContent = '已自动保存到本机 · ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
    catch { $('#save-status').textContent = '本机存储不可用，请导出进度备份'; toast('浏览器存储空间不足或不可用，请使用「导出进度」备份。'); }
  }
  function rebuild() {
    engine = state.session ? state.session.algorithm === 'tournament-v1' ? C.createTournamentEngine(state.session.ids, state.session.limit) : C.createEngine(state.session.ids) : null;
    for (const decision of state.session?.decisions || []) {
      if (engine.done) throw new Error('进度包含多余的选择记录。');
      C.choose(engine, decision);
    }
  }
  function validateBackup(data) {
    if (data?.version !== 1 || !Array.isArray(data.songs) || data.songs.length < 2 || data.songs.length > 10000) throw new Error('这不是有效的排序进度文件。');
    const ids = new Set();
    const songs = data.songs.map((s, i) => {
      if (!s || typeof s.uid !== 'string' || !/^s\d+$/.test(s.uid) || ids.has(s.uid) || typeof s.name !== 'string' || !s.name.trim()) throw new Error('进度中的歌曲信息无效。');
      ids.add(s.uid);
      return { uid: s.uid, name: s.name.slice(0, 3000), artist: String(s.artist || '未知歌手').slice(0, 3000), songId: C.extractId(s.songId), url: C.httpURL(s.url), album: String(s.album || '').slice(0, 3000), cover: C.httpURL(s.cover), start: Number.isFinite(s.start) ? Math.max(0, s.start) : null, duration: Number.isFinite(s.duration) && s.duration > 0 ? Math.min(60, s.duration) : null };
    });
    let session = null;
    if (data.session) {
      const s = data.session;
      if (!Array.isArray(s.ids) || s.ids.length < 2 || new Set(s.ids).size !== s.ids.length || s.ids.some(id => !ids.has(id)) || !Array.isArray(s.decisions) || ![undefined, 'merge-v1', 'tournament-v1'].includes(s.algorithm) || s.decisions.length > s.ids.length * (Math.ceil(Math.log2(s.ids.length)) + 2) || s.decisions.some(c => !['left', 'right', 'tie', 'ban-left', 'ban-right'].includes(c))) throw new Error('进度中的排序记录无效。');
      if (s.algorithm === 'tournament-v1' && ![5, 10, 30, 50].includes(s.limit)) throw new Error('进度中的目标排名数量无效。');
      const test = s.algorithm === 'tournament-v1' ? C.createTournamentEngine(s.ids, s.limit) : C.createEngine(s.ids);
      for (const choice of s.decisions) { if (test.done) throw new Error('排序记录与歌曲数量不符。'); C.choose(test, choice); }
      session = { ids: s.ids, decisions: s.decisions, startedAt: typeof s.startedAt === 'string' ? s.startedAt : new Date().toISOString(), ...(s.algorithm === 'tournament-v1' ? { algorithm: s.algorithm, limit: s.limit } : {}) };
    }
    const settings = { ...defaults, ...data.settings };
    settings.seconds = Math.min(60, Math.max(3, Number(settings.seconds) || 10));
    if (![5, 10, 15, 20, 30, 60].includes(settings.seconds)) settings.seconds = 10;
    settings.start = Math.min(3600, Math.max(0, Number(settings.start) || 0));
    settings.volume = Math.min(1, Math.max(0, Number.isFinite(Number(settings.volume)) ? Number(settings.volume) : .65));
    settings.autoplay = settings.autoplay === true; settings.shuffle = settings.shuffle === true;
    settings.topN = [0, 5, 10, 30, 50].includes(Number(settings.topN)) ? Number(settings.topN) : 10;
    return { songs, selected: Array.isArray(data.selected) ? [...new Set(data.selected.filter(id => ids.has(id)))] : songs.map(s => s.uid), name: String(data.name || '恢复的歌单').slice(0, 500), settings, session };
  }
  function confirm(title, body, ok = '确认') {
    $('#confirm-title').textContent = title; $('#confirm-body').textContent = body; $('#confirm-ok').textContent = ok;
    $('#confirm-dialog').showModal(); return new Promise(resolve => { confirmResolve = resolve; });
  }
  function finishConfirm(value) { $('#confirm-dialog').close(); confirmResolve?.(value); confirmResolve = null; }
  $('#confirm-ok').addEventListener('click', () => finishConfirm(true));
  $('#confirm-cancel').addEventListener('click', () => finishConfirm(false));
  $('#confirm-dialog').addEventListener('cancel', e => { e.preventDefault(); finishConfirm(false); });
  function sourceType(s) {
    if (audioPool.has(s.uid)) return { text: audioPool.get(s.uid).length > 1 && !chosenAudio.has(s.uid) ? '待确认音频' : '本地音频', ready: true };
    if (s.url) return { text: '音频链接', ready: true };
    if (s.songId) return { text: '网易云 ID', ready: true };
    return { text: '待补充音源', ready: false };
  }
  function settingsHTML(compact = false) {
    return `<label class="setting-row"><span>每轮自动试听</span><span class="switch"><input type="checkbox" data-setting="autoplay" aria-label="每轮自动试听" ${state.settings.autoplay ? 'checked' : ''}></span></label>
      <label class="setting-row"><span>每首试听</span><select data-setting="seconds" aria-label="每首试听时长">${[5, 10, 15, 20, 30, 60].map(n => `<option value="${n}" ${state.settings.seconds === n ? 'selected' : ''}>${n} 秒</option>`).join('')}</select></label>
      <label class="setting-row"><span>从第几秒开始</span><input type="number" min="0" max="3600" step="1" value="${state.settings.start}" data-setting="start" aria-label="试听起始秒"></label>
      ${compact ? `<label class="inline-volume">音量 <input type="range" min="0" max="1" step=".05" data-setting="volume" value="${state.settings.volume}" aria-label="音量"></label>` : ''}`;
  }
  function render() {
    playlistRequest?.abort(); playlistRequest = null;
    stopAudio();
    document.body.dataset.view = view;
    for (const name of ['prepare', 'compare', 'results']) $('#nav-' + name).classList.toggle('active', view === name);
    $('#nav-compare').disabled = !engine || engine.done; $('#nav-results').disabled = !engine?.done;
    if (view === 'prepare') renderPrepare(); else if (view === 'compare') renderCompare(); else renderResults();
    document.querySelectorAll('[data-cover-slot]').forEach(slot => loadCover(slot));
  }
  function renderPrepare() {
    const n = state.selected.length, sources = state.songs.filter(s => sourceType(s).ready).length;
    const missing = state.songs.length - sources;
    $('#app').innerHTML = `<p class="page-description">导入网易云歌单链接或 CSV，选择参与排序的歌曲。试听后比较两首歌曲，生成偏好排名。</p>
      ${engine ? `<div class="resume-banner"><p><b>${engine.done ? '排序已完成' : '有未完成的排序'} · ${modeLabel()}</b><br>已比较 ${engine.comparisons} 次 · 参与 ${engine.total - engine.excluded.length} 首 · 已排除 ${engine.excluded.length} 首。可导入补充 ID 的同一份歌单，保留进度。</p><button class="button small soft" data-action="${engine.done ? 'results' : 'compare'}">${engine.done ? '查看排行' : '继续排序 →'}</button></div>` : ''}
      <div class="content-grid"><section class="panel library-panel"><div class="panel-heading"><h2>我的歌单 <span class="tiny-number">${state.songs.length} 首</span></h2><span class="small-tag">链接 / CSV 导入</span></div>
      <form id="playlist-form" class="playlist-import"><label for="playlist-link">网易云歌单链接或 ID</label><div class="playlist-input-row"><input id="playlist-link" type="text" maxlength="3000" placeholder="https://music.163.com/playlist?id=…" autocomplete="off" required><button type="submit" class="button">导入链接</button></div><p id="playlist-status" role="status">自动获取歌曲 ID、歌手和封面，并校验歌单是否完整。短链接请先在浏览器打开。</p></form>
      <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="导入 CSV 歌单"><span class="upload-icon" aria-hidden="true">↥</span><div><strong>导入网易云歌单 CSV</strong><p>拖入 CSV 文件，或点击选择 · 歌曲名称 / 歌手 / song_id</p></div><span class="text-button">选择文件 ↗</span></div>
      <div class="file-info"><div class="file-name"><span style="color:var(--green)">▤</span><strong>${esc(state.name)}</strong><span class="muted">· ${state.songs.length} 首</span></div><button class="text-button" data-action="sample">使用示例歌单</button></div>
      <div class="library-tools"><label class="check-label"><input id="select-all" type="checkbox" aria-label="全选当前搜索结果"> <span id="selection-label">已选 ${n} 首</span></label><input class="search" id="search" type="search" placeholder="搜索歌曲或歌手…" value="${esc(query)}" aria-label="搜索歌曲或歌手"></div>
      <div class="song-list" id="song-list"></div><div class="list-bottom"><span>✓ 自动识别表头 · 同一首歌自动去重</span><span>${sources} 首有音源信息</span></div></section>
      <aside class="panel settings-panel"><h2>排序设置</h2><div class="selection-summary"><b id="selected-count">${n}</b><span>首歌曲参与排序</span></div><label class="setting-row"><span>目标排名</span><select data-setting="topN" aria-label="目标排名">${[5, 10, 30, 50, 0].map(k => `<option value="${k}" ${state.settings.topN === k ? 'selected' : ''}>${k ? '前 ' + k + ' 名' : '全部歌曲'}</option>`).join('')}</select></label>${state.session ? '<p class="mini-note">目标设置只影响新一轮排序。</p>' : ''}<div class="estimate" id="estimate"></div><div class="divider"></div>
      ${settingsHTML()}<p class="mini-note">每轮依次试听左、右两首，也可以随时重听。</p><label class="setting-row"><span>开始时打乱顺序</span><span class="switch"><input type="checkbox" data-setting="shuffle" aria-label="开始时打乱顺序" ${state.settings.shuffle ? 'checked' : ''}></span></label>
      ${missing ? `<div class="notice">${missing === state.songs.length ? '这份歌单还没有音源信息。' : `${missing} 首歌曲还没有音源信息。`}<br>加入 <b>song_id</b> 可尝试网易云试听；也可导入本地音频。当前仍能按歌名排序。</div>` : '<div class="notice">已识别音源信息。在线曲目能否试听，以实际播放为准。</div>'}
      <button class="button primary full start-button" id="start-button" data-action="start" ${n < 2 ? 'disabled' : ''}>开始偏好排序 <span>→</span></button><div class="secondary-links"><button class="text-button" data-action="export-backup">导出进度</button><button class="text-button" data-action="import-backup">恢复进度</button><button class="text-button" data-action="template">CSV 模板</button></div>
      <div class="divider"></div><button class="button small full audio-import" data-action="import-audio">选择本地音频文件</button><p class="privacy-note">进度自动保存在当前浏览器。</p></aside></div>`;
    renderList(); updateSelection();
    $('#playlist-form').addEventListener('submit', e => { e.preventDefault(); importPlaylistLink(); });
    const zone = $('#dropzone');
    zone.addEventListener('click', () => $('#csv-file').click());
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#csv-file').click(); } });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag'); if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]); });
    $('#search').addEventListener('input', e => { query = e.target.value; renderList(); });
    $('#select-all').addEventListener('change', e => {
      const selected = new Set(state.selected); for (const s of filteredSongs()) { if (e.target.checked) selected.add(s.uid); else selected.delete(s.uid); }
      state.selected = [...selected]; renderList(); updateSelection(); save();
    });
  }
  function filteredSongs() { const q = query.trim().toLowerCase(); return state.songs.filter(s => !q || (s.name + ' ' + s.artist + ' ' + s.songId).toLowerCase().includes(q)); }
  function renderList() {
    const filtered = filteredSongs(), selected = new Set(state.selected);
    $('#song-list').innerHTML = filtered.length ? filtered.map((s, i) => {
      const source = sourceType(s);
      return `<div class="song-row"><input type="checkbox" data-song="${s.uid}" aria-label="选择 ${esc(s.name)}" ${selected.has(s.uid) ? 'checked' : ''}><span class="song-num">${String(state.songs.indexOf(s) + 1).padStart(2, '0')}</span><div><div class="song-title" title="${esc(s.name)}">${esc(s.name)}</div><div class="song-artist" title="${esc(s.artist)}">${esc(s.artist)}</div></div><span class="source-tag ${source.ready ? 'ready' : ''}">${source.text}</span></div>`;
    }).join('') : '<div class="empty-state">没有匹配的歌曲。</div>';
    const checked = filtered.filter(s => selected.has(s.uid)).length;
    $('#select-all').checked = !!filtered.length && checked === filtered.length;
    $('#select-all').indeterminate = checked > 0 && checked < filtered.length;
  }
  function updateSelection() {
    const n = state.selected.length;
    if ($('#selected-count')) $('#selected-count').textContent = n;
    if ($('#selection-label')) $('#selection-label').textContent = `已选 ${n} 首`;
    if ($('#estimate')) {
      const target = Math.min(state.settings.topN || n, n), count = state.settings.topN ? C.topBounds(n, target).comparisons : C.bounds(n).comparisons;
      $('#estimate').innerHTML = n >= 2 ? `${state.settings.topN ? `确定前 ${target} 名后自动结束` : '生成全部歌曲的完整排名'}<br>无排除时最多约 ${count.toLocaleString()} 次比较${state.settings.topN ? '<br>其余歌曲不排序，临界并列全部保留。' : ''}` : '至少选择两首歌曲，即可开始';
    }
    if ($('#start-button')) $('#start-button').disabled = n < 2;
  }
  function artHTML(s) {
    return `<div class="cover-slot" data-cover-slot="${s.uid}" aria-label="${esc(s.name)} 封面"><span class="cover-status">${s.cover || s.songId ? '加载封面…' : '暂无封面<br>需 song_id'}</span></div>`;
  }
  async function loadCover(slot) {
    const s = songMap().get(slot.dataset.coverSlot); if (!s) return;
    const fail = message => {
      if (slot.isConnected) slot.innerHTML = `<span class="cover-status">${esc(message)}${s.cover || s.songId && location.protocol !== 'file:' ? '<button class="text-button" data-action="retry-cover">重试</button>' : ''}</span>`;
    };
    let url = s.cover;
    if (!url && s.songId) {
      if (location.protocol === 'file:') { fail('请打开部署后的 HTTPS 网站'); return; }
      let cached = coverCache.get(s.songId);
      if (!cached || cached.expires < Date.now()) {
        const id = s.songId;
        const promise = (async () => {
          const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 10000);
          try {
            const response = await fetch(apiURL('/api/cover?id=' + encodeURIComponent(id)), { signal: abort.signal, credentials: 'omit' });
            if (!response.ok) throw new Error('封面接口不可用，请检查 Worker 配置');
            const result = await response.json();
            const cover = C.httpURL(result.cover); if (!cover) throw new Error(result.error || '暂无封面');
            return cover;
          } finally { clearTimeout(timeout); }
        })();
        cached = { promise, expires: Date.now() + 60 * 60 * 1000 }; coverCache.set(id, cached);
      }
      try { url = await cached.promise; }
      catch { if (coverCache.get(s.songId) === cached) cached.expires = Date.now() + 30000; fail('封面获取失败'); return; }
    }
    if (!url || !slot.isConnected) return;
    const image = document.createElement('img'); image.className = 'track-cover'; image.alt = s.name + ' 封面'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => fail('封面加载失败'), { once: true });
    image.addEventListener('load', () => { if (slot.isConnected) slot.classList.add('loaded'); }, { once: true });
    image.src = url; slot.replaceChildren(image);
  }
  function cardHTML(s, side) {
    const isLeft = side === 'left', label = isLeft ? 'A' : 'B', source = sourceType(s), active = engine.active;
    const group = isLeft ? active.left[active.i] : active.right[active.j];
    return `<article class="track-card" id="card-${side}"><div class="card-label"><span>歌曲 ${label}</span><span>${group.length > 1 ? `并列组 · ${group.length} 首` : ''}</span></div>${artHTML(s)}<h2>${esc(s.name)}</h2><p class="artist">${esc(s.artist)}${s.album ? '<br>' + esc(s.album) : ''}</p>
      <div class="track-meta"><span>${source.text}${s.songId ? ' · ' + esc(s.songId) : ''}</span>${s.songId ? `<a href="https://music.163.com/#/song?id=${s.songId}" target="_blank" rel="noopener noreferrer">在网易云打开 ↗</a>` : ''}</div>
      <div class="preview-controls"><button class="play-button" data-action="play" data-uid="${s.uid}" data-side="${side}" aria-label="试听 ${esc(s.name)}">▶</button><div class="preview-info"><div class="preview-status" id="status-${side}" role="status">${source.ready ? '点击试听，或开启每轮自动试听' : '缺少音源 · 可补充 ID 或本地音频'}</div></div></div>
      <button class="button choose-button" data-action="choose-${side}">更喜欢这首 <kbd>${isLeft ? '←' : '→'}</kbd></button><button class="button exclude-button" data-action="ban-${side}" title="仅排除当前显示的这一首歌，不影响并列组中的其他歌曲">排除${isLeft ? '左' : '右'}曲（本轮）</button></article>`;
  }
  function renderCompare() {
    if (!engine || engine.done) { view = engine?.done ? 'results' : 'prepare'; render(); return; }
    const [left, right] = C.pair(engine).map(id => songMap().get(id));
    const progress = Math.min(99, Math.floor(isTopMode() ? engine.comparisons / (engine.bounds.comparisons + engine.excluded.length * Math.ceil(Math.log2(engine.total))) * 100 : engine.processed / engine.bounds.work * 100));
    $('#app').innerHTML = `<section class="compare-header"><h2>选择更喜欢的歌曲 · ${modeLabel()}</h2><p>${isTopMode() ? `已确定 ${engine.rankedCount} 首，达到目标后自动结束。` : ''}排除的歌曲不再参与本轮排序，可撤销。</p></section><div class="progress-wrap"><div class="progress-label"><span>第 ${engine.comparisons + 1} 次比较 · 参与 ${engine.total - engine.excluded.length} 首 · 已排除 ${engine.excluded.length} 首</span><span>${isTopMode() ? '预计进度' : '已完成'} ${progress}%</span></div><div class="progress-bar" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100" aria-label="排序进度"><span style="width:${progress}%"></span></div></div>
      <div class="compare-grid">${cardHTML(left, 'left')}<span class="versus" aria-hidden="true">/</span>${cardHTML(right, 'right')}</div><div class="compare-actions"><button class="button" data-action="undo" ${state.session.decisions.length ? '' : 'disabled'}>↶ 撤销 <kbd>Z</kbd></button><button class="button" data-action="choose-tie">一样喜欢 <kbd>T</kbd></button><button class="button" data-action="sequence">依次试听两首</button><button class="button" data-action="prepare">保存并返回</button></div>
      <div class="compare-settings">${settingsHTML(true)}</div><p class="audio-hint">空格停止试听 · A / D 分别试听 · ← / → 选择 · T 并列<br>试听不可用时，可在网易云打开，或 <button class="text-button" data-action="import-audio" style="font-size:inherit;color:var(--orange)">补充本地音频</button>。<button class="text-button" data-action="export-backup" style="font-size:inherit">导出当前进度 ↗</button></p>`;
  }
  function renderResults() {
    if (!engine?.done) { view = 'prepare'; render(); return; }
    const rows = C.flattenResults(engine), map = songMap(), counts = new Map();
    for (const r of rows) counts.set(r.rank, (counts.get(r.rank) || 0) + 1);
    const tiers = [];
    for (let i = 0, size = 1; i < rows.length; size = Math.min(3, size + 1)) {
      tiers.push(rows.slice(i, i + size)); i += size;
    }
    $('#app').innerHTML = `<section class="results-head"><h2>偏好排名 · ${modeLabel()}</h2><p>${esc(state.name)} · 排名 ${rows.length} 首 · 已排除 ${engine.excluded.length} 首 · ${engine.comparisons} 次比较</p><div class="result-actions"><button class="button primary" data-action="export-results">↓ 导出排行 CSV</button><button class="button" data-action="export-backup">导出进度</button><button class="button" data-action="undo">↶ 撤销上次操作</button><button class="button" data-action="prepare">返回歌单</button></div></section><section class="results-list" aria-label="歌曲偏好排名">${tiers.map(tier => `<div class="ranking-tier">${tier.map(r => {
      const s = map.get(r.uid); return `<article class="result-row${r.rank <= 3 ? ' result-top' : ''}" aria-label="第 ${r.rank} 名 ${esc(s.name)}"><div class="result-art">${artHTML(s)}<span class="rank">${String(r.rank).padStart(2, '0')}</span><button class="play-button" data-action="play" data-uid="${s.uid}" data-side="result" aria-label="试听 ${esc(s.name)}">▶</button></div><div class="result-name">${esc(s.name)}${counts.get(r.rank) > 1 ? '<span class="tie-tag">并列</span>' : ''}</div><div class="result-artist">${esc(s.artist)}</div></article>`;
    }).join('')}</div>`).join('')}</section><p class="result-note">并列歌曲共享名次，后续名次按歌曲数顺延。排除的歌曲不计入排名。${isTopMode() ? `<br>已确定目标名次及其顺序，临界并列全部保留；其余 ${engine.total - engine.excluded.length - rows.length} 首未排序。` : ''}</p>${engine.excluded.length ? `<details class="excluded-list"><summary>本轮已排除 ${engine.excluded.length} 首</summary><ul>${engine.excluded.map(id => `<li>${esc(map.get(id).name)} · ${esc(map.get(id).artist)}</li>`).join('')}</ul></details>` : ''}`;
  }
  function playlistIdFromInput(value) {
    const text = value.trim();
    if (/^[1-9]\d{0,19}$/.test(text)) return text;
    const match = text.match(/https?:\/\/[^\s<>"“”]+/i);
    if (!match) throw new Error('请输入网易云歌单完整链接或数字歌单 ID。');
    const url = new URL(match[0]);
    if (!['music.163.com', 'm.music.163.com'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('请使用 music.163.com 的歌单链接；短链接请先在浏览器打开再复制完整地址。');
    const route = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
    if (!/^\/(?:m\/)?playlist\/?$/.test(route.pathname)) throw new Error('此链接不是歌单，请复制包含 playlist?id= 的歌单链接。');
    const id = route.searchParams.get('id') || '';
    if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error('链接中没有有效的歌单 ID。');
    return id;
  }
  async function completePlaylist(result, signal, status) {
    if (!Array.isArray(result.ids) || !Number.isInteger(result.total) || result.total < 1 || result.total > 10000 || result.ids.length !== result.total || new Set(result.ids).size !== result.total || result.ids.some(id => !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) || !Array.isArray(result.songs)) throw new Error('歌单 ID 列表不完整，原歌单未被替换。');
    const wanted = new Set(result.ids), found = new Map();
    const add = songs => {
      for (const song of songs) if (song && wanted.has(song.songId) && typeof song.name === 'string' && song.name.trim()) found.set(song.songId, song);
    };
    add(result.songs);
    const missing = result.ids.filter(id => !found.has(id));
    for (let i = 0; i < missing.length; i += 100) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      status.textContent = `已读取 ${found.size} / ${result.total} 首，正在补充歌曲详情…`;
      const response = await fetch(apiURL('/api/songs?ids=' + missing.slice(i, i + 100).join(',')), { signal, credentials: 'omit' });
      const data = await response.json();
      if (!response.ok || data.error || !Array.isArray(data.songs)) throw new Error(data.error || '歌曲详情读取失败，原歌单未被替换。');
      add(data.songs);
    }
    if (found.size !== result.total) throw new Error(`歌单共 ${result.total} 首，有 ${result.total - found.size} 首缺少详情；未导入不完整歌单，请改用 CSV。`);
    result.songs = result.ids.map(id => found.get(id));
  }
  async function importPlaylistLink() {
    const form = $('#playlist-form'), status = $('#playlist-status'), button = form.querySelector('button');
    let request, timer;
    try {
      const id = playlistIdFromInput($('#playlist-link').value);
      if (location.protocol === 'file:') throw new Error('请打开部署后的 HTTPS 网站使用链接导入。');
      playlistRequest?.abort(); request = new AbortController(); playlistRequest = request;
      button.disabled = true; button.textContent = '读取中…'; form.setAttribute('aria-busy', 'true');
      status.textContent = '正在读取完整歌单并补充歌曲详情，请稍候…';
      timer = setTimeout(() => request.abort(), 180000);
      const response = await fetch(apiURL('/api/playlist?id=' + id), { signal: request.signal, credentials: 'omit' });
      const result = await response.json();
      if (result.error) throw new Error(result.error);
      if (!response.ok) throw new Error('歌单读取失败，请检查接口配置或使用 CSV。');
      await completePlaylist(result, request.signal, status);
      if (!Array.isArray(result.songs) || result.songs.length !== result.total || !result.total || result.total > 10000) throw new Error('未获取到完整歌单，原歌单未被替换，请重试或使用 CSV。');
      if (result.total < 2) throw new Error('此歌单只有一首歌曲，偏好排序至少需要两首。');
      const seen = new Set();
      const songs = result.songs.map((s, i) => {
        if (!s || typeof s.name !== 'string' || !s.name.trim() || !/^[1-9]\d{0,19}$/.test(s.songId) || seen.has(s.songId)) throw new Error('歌单歌曲信息不完整，原歌单未被替换。');
        seen.add(s.songId);
        return { uid: 's' + i, name: s.name.slice(0, 3000), artist: String(s.artist || '未知歌手').slice(0, 3000), songId: s.songId, album: String(s.album || '').slice(0, 3000), cover: C.httpURL(s.cover), url: '', start: null, duration: null };
      });
      if (request.signal.aborted || playlistRequest !== request) return;
      await acceptPlaylist(songs, String(result.name || '网易云歌单').slice(0, 500));
      if (status.isConnected) status.textContent = '已取消替换，当前歌单和进度已保留。';
    } catch (e) {
      if (status.isConnected && (!request || playlistRequest === request)) status.textContent = e.name === 'AbortError' ? '歌单读取超时，请重试或改用 CSV 导入。' : e.message || '导入失败，请重试。';
    } finally {
      clearTimeout(timer);
      if (playlistRequest === request) playlistRequest = null;
      if (form.isConnected) { button.disabled = false; button.textContent = '导入链接'; form.removeAttribute('aria-busy'); }
    }
  }
  async function importFile(file) {
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请分成较小的歌单导入。');
      const buffer = await file.arrayBuffer(); let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { text = new TextDecoder('gb18030').decode(buffer); }
      const result = C.importCSV(text);
      if (result.songs.length > 10000) throw new Error('最多支持 10000 首歌曲，请先拆分歌单。');
      await acceptPlaylist(result.songs, file.name, result);
    } catch (e) { toast(e.message || '文件读取失败，请重试。'); }
    $('#csv-file').value = '';
  }
  async function acceptPlaylist(songs, name, info = {}) {
    const oldByIdentity = new Map(state.songs.map(s => [identity(s), s]));
    const uniqueIdentity = new Set(songs.map(identity)).size === songs.length && oldByIdentity.size === state.songs.length;
    const same = songs.length === state.songs.length && uniqueIdentity && songs.every(s => oldByIdentity.has(identity(s)));
    if (same && state.session) {
      state.songs = songs.map(s => ({ ...oldByIdentity.get(identity(s)), ...s, uid: oldByIdentity.get(identity(s)).uid }));
      state.name = name; sourceCache.clear(); stopAudio(); save(); view = 'prepare'; render();
      toast('歌曲信息已更新，原有排序进度已保留。'); return;
    }
    if (state.session && !await confirm('更换歌单？', '当前排序会被替换。建议先取消并导出进度，之后可从备份恢复。', '更换歌单')) return;
    clearAudioFiles(); state.songs = songs; state.name = name; state.selected = songs.map(s => s.uid); state.session = null;
    engine = null; sourceCache.clear(); query = ''; view = 'prepare'; save(); render();
    toast(`已导入 ${songs.length} 首歌曲${info.duplicates ? `，已去除 ${info.duplicates} 首重复歌曲` : ''}${info.skipped ? `，跳过 ${info.skipped} 行空歌曲` : ''}。`);
  }
  function shuffled(ids) {
    const out = [...ids]; const values = new Uint32Array(1);
    for (let i = out.length - 1; i > 0; i--) { crypto.getRandomValues(values); const j = values[0] % (i + 1); [out[i], out[j]] = [out[j], out[i]]; } return out;
  }
  async function start() {
    if (state.selected.length < 2) return;
    if (state.session && !await confirm('开始新一轮排序？', '当前排序会被替换。要继续原来的排序，请取消并点击「继续排序」；也可先导出进度。', '开始新排序')) return;
    const ids = state.songs.filter(s => state.selected.includes(s.uid)).map(s => s.uid);
    state.session = { ids: state.settings.shuffle ? shuffled(ids) : ids, decisions: [], startedAt: new Date().toISOString(), ...(state.settings.topN ? { algorithm: 'tournament-v1', limit: state.settings.topN } : {}) };
    rebuild(); view = 'compare'; save(); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    if (state.settings.autoplay) sequence();
  }
  function choose(choice) {
    if (view !== 'compare' || !engine || engine.done) return;
    const excludedSong = choice.startsWith('ban-') ? songMap().get(C.pair(engine)[choice === 'ban-left' ? 0 : 1]) : null;
    stopAudio(); state.session.decisions.push(choice); C.choose(engine, choice);
    view = engine.done ? 'results' : 'compare'; save(); render();
    if (!engine.done && state.settings.autoplay) sequence();
    if (engine.done) { window.scrollTo({ top: 0, behavior: 'smooth' }); toast('排序完成，可查看或导出排名。'); }
    else if (excludedSong) toast(`已从本轮排除「${excludedSong.name}」，可撤销。`);
  }
  function undo() {
    if (!state.session?.decisions.length) return;
    state.session.decisions.pop(); rebuild(); view = 'compare'; save(); render(); toast('已撤销上次操作。');
    if (state.settings.autoplay) sequence();
  }
  function download(name, content, type) {
    const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  const dateStamp = () => new Date().toLocaleDateString('sv-SE');
  function exportResults() {
    if (!engine?.done) return;
    const map = songMap();
    const rows = [['排名', '歌曲名称', '歌手名称', 'song_id'], ...C.flattenResults(engine).map(r => { const s = map.get(r.uid); return [r.rank, s.name, s.artist, s.songId]; })];
    download(`网易云歌单-${modeLabel()}-${dateStamp()}.csv`, '\uFEFF' + rows.map(row => row.map(C.csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  }
  function exportBackup() { download(`网易云歌单-排序进度-${dateStamp()}.json`, JSON.stringify({ version: 1, ...state }, null, 2), 'application/json'); toast('进度已导出。本地音频文件不会打包进备份。'); }
  async function importBackup(file) {
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('进度文件过大，无法恢复。');
      const next = validateBackup(JSON.parse(await file.text()));
      if (state.session && !await confirm('恢复备份进度？', '恢复后会替换当前歌单和排序，请确认当前进度已备份。', '恢复进度')) return;
      stopAudio(); clearAudioFiles(); state = next; rebuild(); view = engine?.done ? 'results' : 'prepare'; query = ''; sourceCache.clear(); save(); render(); toast('进度已恢复。使用过的本地音频需重新选择。');
    } catch (e) { toast('无法恢复：' + (e.message || '文件格式不正确')); }
    $('#backup-file').value = '';
  }
  function clearAudioFiles() { stopAudio(); audioBlobs.forEach(URL.revokeObjectURL); audioPool.clear(); chosenAudio.clear(); audioBlobs.clear(); }
  function fileKeys(name) {
    const base = name.replace(/\.[^.]+$/, '');
    return [C.normalize(base), C.normalize(base.replace(/^\d+[\s._-]+/, ''))];
  }
  function songKeys(s) {
    const basic = s.name.replace(/\s+-\s+\([^)]*\)\s*$/, '').trim();
    return [s.songId, s.name, basic, `${s.artist} - ${s.name}`, `${s.name} - ${s.artist}`].filter(Boolean).map(C.normalize);
  }
  function importAudio(files) {
    let matched = 0; const supported = Array.from(files).filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac|opus|webm)$/i.test(f.name));
    const fileIndex = new Map();
    for (const file of supported) for (const key of fileKeys(file.name)) { if (!fileIndex.has(key)) fileIndex.set(key, []); if (!fileIndex.get(key).includes(file)) fileIndex.get(key).push(file); }
    for (const s of state.songs) {
      // Exact song IDs win over name matching.
      let candidates = s.songId && fileIndex.get(C.normalize(s.songId));
      if (!candidates) candidates = [...new Set(songKeys(s).flatMap(k => fileIndex.get(k) || []))];
      if (candidates.length) { audioPool.set(s.uid, candidates); chosenAudio.delete(s.uid); if (audioBlobs.has(s.uid)) URL.revokeObjectURL(audioBlobs.get(s.uid)); audioBlobs.delete(s.uid); matched++; }
    }
    render(); toast(`选入 ${supported.length} 个音频，匹配到 ${matched} 首歌曲。${matched ? '音频已就绪。' : '请将文件命名为 歌曲ID.mp3 或 歌曲名称.mp3。'}`);
    $('#audio-files').value = '';
  }
  function selectAudio(uid, side) {
    const files = audioPool.get(uid); if (!files?.length) return;
    pendingAudio = { uid, side };
    $('#audio-options').innerHTML = files.map((f, i) => `<button class="button audio-option" data-action="select-audio" data-index="${i}">${esc(f.name)}</button>`).join('');
    $('#audio-dialog').showModal();
  }
  function setStatus(side, message, error = false) {
    const element = $('#status-' + side); if (element) { element.textContent = message; element.classList.toggle('error', error); }
    else if (side === 'result' && error) toast(message);
  }
  function setPlaying(side, value) {
    document.querySelectorAll('.track-card').forEach(card => card.classList.remove('playing'));
    document.querySelectorAll('[data-action=play]').forEach(b => b.textContent = '▶');
    if (value) {
      $('#card-' + side)?.classList.add('playing');
      document.querySelector(`[data-action="play"][data-uid="${playingUid}"]`)?.replaceChildren(document.createTextNode('Ⅱ'));
    }
  }
  function stopPlayback() {
    if (cancelPlayback) { const cancel = cancelPlayback; cancelPlayback = null; cancel(); }
    playbackVersion++;
    player.pause(); player.removeAttribute('src'); player.load(); playingUid = null; setPlaying('', false);
  }
  function stopAudio() { sequenceVersion++; stopPlayback(); }
  async function resolveSource(s, signal) {
    if (audioPool.has(s.uid)) {
      const files = audioPool.get(s.uid), file = chosenAudio.get(s.uid) || (files.length === 1 ? files[0] : null);
      if (!file) throw new Error('有多个匹配音频，点击试听按钮确认文件。');
      if (!audioBlobs.has(s.uid)) audioBlobs.set(s.uid, URL.createObjectURL(file));
      return { url: audioBlobs.get(s.uid), local: true };
    }
    if (s.url) return { url: s.url };
    if (!s.songId) throw new Error('缺少音源：请补充 song_id 或导入本地音频。');
    const cached = sourceCache.get(s.songId);
    if (cached && cached.expires > Date.now()) return cached;
    if (location.protocol !== 'file:') {
      try {
        const response = await fetch(apiURL('/api/preview?id=' + encodeURIComponent(s.songId)), { signal, credentials: 'omit' });
        if (response.ok) {
          const result = await response.json();
          if (result.error) throw Object.assign(new Error(result.error), { unavailable: true });
          const url = C.httpURL(result.url);
          if (url) { const source = { url, trial: !!result.trial, expires: Date.now() + 5 * 60 * 1000 }; sourceCache.set(s.songId, source); return source; }
        }
      } catch (e) { if (e.name === 'AbortError' || e.unavailable) throw e; }
    }
    return { url: `https://music.163.com/song/media/outer/url?id=${s.songId}.mp3` };
  }
  async function playOne(uid, side) {
    stopPlayback(); const version = playbackVersion, s = songMap().get(uid); if (!s) return 'failed';
    const abort = new AbortController(); let finish, finished = false, timeout, stallTimer, startAt = 0, hasPlayed = false, seconds = s.duration || state.settings.seconds;
    const completion = new Promise(resolve => { finish = resolve; });
    const cleanups = [];
    function on(event, callback) { player.addEventListener(event, callback); cleanups.push(() => player.removeEventListener(event, callback)); }
    function settle(reason, message, error = false) {
      if (finished) return; finished = true; clearTimeout(timeout); clearTimeout(stallTimer); abort.abort(); cleanups.forEach(f => f());
      if (version === playbackVersion) { player.pause(); playingUid = null; setPlaying(side, false); if (message) setStatus(side, message, error); cancelPlayback = null; }
      finish(reason);
    }
    cancelPlayback = () => settle('cancelled', '已停止试听');
    playingUid = uid; setStatus(side, '正在获取试听音源…');
    timeout = setTimeout(() => settle('failed', '音源响应超时，可重试或使用本地音频。', true), 15000);
    try {
      const source = await resolveSource(s, abort.signal);
      if (finished || version !== playbackVersion) return completion;
      setStatus(side, '正在缓冲试听…');
      startAt = s.start ?? (source.trial ? 0 : state.settings.start);
      player.volume = state.settings.volume;
      on('loadedmetadata', () => {
        if (Number.isFinite(player.duration) && player.duration > 0) startAt = Math.min(startAt, Math.max(0, player.duration - seconds));
        try { player.currentTime = startAt; } catch { startAt = 0; }
      });
      on('playing', () => { hasPlayed = true; clearTimeout(timeout); clearTimeout(stallTimer); setPlaying(side, true); setStatus(side, `正在试听 · ${seconds} 秒片段`); });
      on('waiting', () => { setStatus(side, '缓冲中…'); clearTimeout(stallTimer); stallTimer = setTimeout(() => settle('failed', '音源缓冲超时，请重试。', true), 12000); });
      on('timeupdate', () => {
        if (!hasPlayed) return;
        const elapsed = Math.max(0, player.currentTime - startAt);
        if (elapsed >= seconds) settle('finished', `已试听 ${seconds} 秒 · 可点击重听`);
        else setStatus(side, `正在试听 ${Math.floor(elapsed)} / ${seconds} 秒`);
      });
      on('ended', () => settle('finished', '试听片段结束 · 可点击重听'));
      on('error', () => settle('failed', audioPool.has(uid) ? '此音频格式无法播放，请改用 MP3 / WAV。' : '此音源无法播放，可在网易云打开或补充本地音频。', true));
      player.src = source.url;
      try { await player.play(); }
      catch (e) {
        if (!finished && version === playbackVersion) {
          if (e.name === 'NotAllowedError') settle('blocked', '浏览器阻止自动播放，请点击试听按钮。', true);
          else settle('failed', '音源无法播放，请检查链接或补充本地音频。', true);
        }
      }
    } catch (e) { if (!finished && version === playbackVersion) settle('failed', e.message || '试听获取失败。', true); }
    return completion;
  }
  async function sequence() {
    if (view !== 'compare' || !engine || engine.done) return;
    stopAudio(); const version = sequenceVersion; const ids = C.pair(engine);
    const result = await playOne(ids[0], 'left');
    if (version !== sequenceVersion || result === 'blocked' || result === 'cancelled') return;
    await playOne(ids[1], 'right');
  }
  async function playManual(uid, side) {
    if (playingUid === uid) { stopAudio(); return; }
    stopAudio();
    if ((audioPool.get(uid)?.length || 0) > 1 && !chosenAudio.has(uid)) { selectAudio(uid, side); return; }
    await playOne(uid, side);
  }
  document.addEventListener('click', async e => {
    const button = e.target.closest('[data-action]'); if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'help') { stopAudio(); $('#help-dialog').showModal(); }
    else if (action === 'close-help') $('#help-dialog').close();
    else if (action === 'close-audio') { $('#audio-dialog').close(); pendingAudio = null; }
    else if (action === 'select-audio' && pendingAudio) {
      const { uid, side } = pendingAudio, file = audioPool.get(uid)?.[Number(button.dataset.index)];
      if (file) { chosenAudio.set(uid, file); $('#audio-dialog').close(); pendingAudio = null; playManual(uid, side); }
    }
    else if (action === 'start') start();
    else if (action.startsWith('choose-')) choose(action.replace('choose-', ''));
    else if (action === 'ban-left' || action === 'ban-right') choose(action);
    else if (action === 'retry-cover') {
      const slot = button.closest('[data-cover-slot]'), song = songMap().get(slot?.dataset.coverSlot);
      if (song) { coverCache.delete(song.songId); slot.classList.remove('loaded'); slot.innerHTML = '<span class="cover-status">加载封面…</span>'; loadCover(slot); }
    }
    else if (action === 'undo') undo();
    else if (action === 'prepare') { view = 'prepare'; render(); }
    else if (action === 'compare' && engine && !engine.done) { view = 'compare'; render(); if (state.settings.autoplay) sequence(); }
    else if (action === 'results' && engine?.done) { view = 'results'; render(); }
    else if (action === 'sample') acceptPlaylist(C.importCSV(window.SAMPLE_CSV).songs, '示例歌单');
    else if (action === 'export-backup') exportBackup();
    else if (action === 'import-backup') $('#backup-file').click();
    else if (action === 'export-results') exportResults();
    else if (action === 'import-audio') { stopAudio(); $('#audio-files').click(); }
    else if (action === 'sequence') sequence();
    else if (action === 'play') playManual(button.dataset.uid, button.dataset.side);
    else if (action === 'template') download('网易云歌单-模板.csv', '\uFEFF序号,歌曲名称,歌手名称,song_id,preview_url,preview_start,preview_duration\r\n1,示例歌曲一,示例歌手,,,30,10\r\n2,示例歌曲二,示例歌手,,,30,10\r\n', 'text/csv;charset=utf-8');
  });
  document.addEventListener('change', e => {
    const target = e.target;
    if (target.dataset.song) {
      const ids = new Set(state.selected); if (target.checked) ids.add(target.dataset.song); else ids.delete(target.dataset.song);
      state.selected = [...ids]; updateSelection(); renderList(); save();
    }
    if (target.dataset.setting) {
      const key = target.dataset.setting;
      state.settings[key] = target.type === 'checkbox' ? target.checked : Number(target.value);
      if (key === 'start') state.settings.start = Math.min(3600, Math.max(0, state.settings.start || 0));
      if (key === 'topN') updateSelection();
      if (key === 'volume') player.volume = state.settings.volume;
      else stopAudio();
      save(); if (key === 'autoplay' && state.settings.autoplay && view === 'compare') sequence();
    }
  });
  $('#csv-file').addEventListener('change', e => { if (e.target.files[0]) importFile(e.target.files[0]); });
  $('#backup-file').addEventListener('change', e => { if (e.target.files[0]) importBackup(e.target.files[0]); });
  $('#audio-files').addEventListener('change', e => { if (e.target.files.length) importAudio(e.target.files); });
  document.addEventListener('keydown', e => {
    if (e.repeat || document.querySelector('dialog[open]') || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(e.target.tagName) && e.key === ' ' || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ' && view === 'compare') { e.preventDefault(); stopAudio(); }
    if (view !== 'compare' || engine?.done) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); choose('left'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); choose('right'); }
    else if (e.key.toLowerCase() === 't') choose('tie');
    else if (e.key.toLowerCase() === 'z') undo();
    else if (e.key.toLowerCase() === 'a') playManual(C.pair(engine)[0], 'left');
    else if (e.key.toLowerCase() === 'd') playManual(C.pair(engine)[1], 'right');
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAudio(); });
  window.addEventListener('pagehide', stopAudio);
  try {
    const stored = localStorage.getItem(STORAGE);
    if (stored) { state = validateBackup(JSON.parse(stored)); rebuild(); }
    else { state.songs = C.importCSV(window.SAMPLE_CSV).songs; state.selected = state.songs.map(s => s.uid); state.name = '示例歌单'; }
  } catch (e) {
    state.songs = C.importCSV(window.SAMPLE_CSV).songs; state.selected = state.songs.map(s => s.uid); state.name = '示例歌单'; state.session = null; engine = null;
    toast('本机进度无法读取，已载入示例歌单；如有备份可点击恢复进度。');
  }
  render();
})();
