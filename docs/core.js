/* CSV and preference sorting. No dependencies; shared by the browser and tests. */
(function (root) {
  'use strict';
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const first = text.split(/\r?\n/, 1)[0];
    const delimiter = first.includes('\t') && !first.includes(',') ? '\t' : ',';
    const rows = []; let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') { field += '"'; i++; }
        else if (quoted || !field.trim()) quoted = !quoted;
        else field += c;
      } else if (c === delimiter && !quoted) { row.push(field.trim()); field = ''; }
      else if ((c === '\n' || c === '\r') && !quoted) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (quoted) throw new Error('CSV 有未闭合的引号，请检查文件格式。');
    row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
    return rows;
  }
  const aliases = {
    name: ['歌曲名称', '歌曲名', '歌名', '歌曲', 'song_name', 'songname', 'name', 'title', 'track', 'track_name'],
    translation: ['translation', 'translated_name', '译名', '翻译', '歌曲翻译', '翻译名', 'transname', 'tns'],
    artist: ['歌手名称', '歌手', '歌手名', '艺人', 'artist', 'artists', 'artist_name', 'artistname', 'singer'],
    songId: ['song_id', 'songid', '歌曲id', '音乐id', '网易云id', 'netease_id', 'id'],
    url: ['preview_url', 'audio_url', '试听链接', '试听地址', '音频地址', '播放链接', 'mp3_url'],
    link: ['song_url', '歌曲链接', '歌曲网址', '歌曲地址', 'link'],
    album: ['album', 'album_name', '专辑', '专辑名称'],
    cover: ['cover_url', '封面地址', '封面', 'picurl'],
    start: ['preview_start', '试听起点', '试听起始秒'],
    duration: ['preview_duration', '试听时长'],
  };
  function normalize(s) { return String(s || '').toLowerCase().replace(/[\s\u00a0_-]/g, ''); }
  function trackKey(name, artist) {
    const text = s => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
    return JSON.stringify([text(name), text(artist)]);
  }
  function httpURL(s) {
    try { const u = new URL(s); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
  }
  function extractId(value) {
    value = String(value || '').trim();
    if (/^\d+$/.test(value)) return value;
    return value.match(/[?&]id=(\d+)/)?.[1] || value.match(/\/(?:song)\/(\d+)/)?.[1] || '';
  }
  function importCSV(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('CSV 需要一行表头和至少两首歌曲。');
    const headers = rows.shift().map(normalize);
    const columns = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k, headers.findIndex(h => v.some(a => normalize(a) === h))]));
    if (columns.name < 0) throw new Error('未找到歌曲名称列。请使用「歌曲名称」或 song_name 作为表头。');
    const songs = [], seen = new Set(); let duplicates = 0, skipped = 0;
    for (const row of rows) {
      const val = k => columns[k] >= 0 ? String(row[columns[k]] || '').trim() : '';
      if (!val('name')) { skipped++; continue; }
      const songId = extractId(val('songId')) || extractId(val('link'));
      const key = songId ? 'id:' + songId : 'name:' + trackKey(val('name'), val('artist'));
      if (seen.has(key)) { duplicates++; continue; } seen.add(key);
      songs.push({ uid: 's' + songs.length, name: val('name'), translation: val('translation'), artist: val('artist') || '未知歌手', songId,
        url: httpURL(val('url')), album: val('album'), cover: httpURL(val('cover')),
        start: val('start') !== '' && Number.isFinite(Number(val('start'))) ? Math.max(0, Number(val('start'))) : null,
        duration: val('duration') !== '' && Number(val('duration')) > 0 ? Math.min(60, Number(val('duration'))) : null });
    }
    if (songs.length < 2) throw new Error('有效歌曲少于两首，暂时无法开始排序。');
    return { songs, duplicates, skipped };
  }
  function bounds(n) {
    let runs = Array(n).fill(1), work = 0, comparisons = 0;
    while (runs.length > 1) {
      const next = [];
      for (let i = 0; i < runs.length; i += 2) {
        if (i + 1 === runs.length) next.push(runs[i]);
        else { const size = runs[i] + runs[i + 1]; next.push(size); work += size; comparisons += size - 1; }
      } runs = next;
    } return { work, comparisons };
  }
  function advance(e) {
    while (!e.done) {
      if (e.active) {
        const a = e.active;
        if (a.i < a.left.length && a.j < a.right.length) return;
        for (const group of [...a.left.slice(a.i), ...a.right.slice(a.j)]) { a.out.push(group); e.processed += group.length; }
        e.next.push(a.out); e.active = null;
      }
      if (e.queue.length >= 2) e.active = { left: e.queue.shift(), right: e.queue.shift(), i: 0, j: 0, out: [] };
      else {
        if (e.queue.length) e.next.push(e.queue.shift());
        if (e.next.length === 1) { e.result = e.next[0]; e.done = true; return; }
        e.queue = e.next; e.next = [];
      }
    }
  }
  function createEngine(ids) {
    if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error('排序需要至少两首不同歌曲。');
    const e = { queue: ids.map(id => [[id]]), next: [], active: null, result: null, done: false, comparisons: 0, processed: 0, bounds: bounds(ids.length), total: ids.length, excluded: [] };
    advance(e); return e;
  }
  function pair(e) { return e.done ? null : [e.active.left[e.active.i][0], e.active.right[e.active.j][0]]; }
  function exclude(e, side) {
    if (e.algorithm === 'tournament-v1') return excludeTournament(e, side);
    if (e.done || !['left', 'right'].includes(side)) return;
    const uid = pair(e)[side === 'left' ? 0 : 1];
    // Keep the merge position and all prior preferences. Exclude only the displayed
    // track, even when it represents a larger tied group.
    const filterRun = run => run.map(group => group.filter(id => id !== uid)).filter(group => group.length);
    const a = e.active;
    a.left = filterRun(a.left.slice(a.i)); a.right = filterRun(a.right.slice(a.j));
    a.out = filterRun(a.out); a.i = 0; a.j = 0;
    e.queue = e.queue.map(filterRun).filter(run => run.length);
    e.next = e.next.map(filterRun).filter(run => run.length);
    e.excluded.push(uid);
    if (e.total - e.excluded.length === 1) {
      const remaining = [...new Set([a.out, a.left, a.right, ...e.queue, ...e.next].flat(2))];
      e.result = [remaining]; e.queue = []; e.next = []; e.active = null; e.done = true;
    } else advance(e);
    return uid;
  }
  function choose(e, choice) {
    if (e.algorithm === 'tournament-v1') { chooseTournament(e, choice); return; }
    if (choice === 'ban-left' || choice === 'ban-right') { exclude(e, choice.slice(4)); return; }
    if (e.done || !['left', 'right', 'tie'].includes(choice)) return;
    const a = e.active; let group;
    if (choice === 'tie') group = [...a.left[a.i++], ...a.right[a.j++]];
    else if (choice === 'left') group = a.left[a.i++];
    else group = a.right[a.j++];
    a.out.push(group); e.processed += group.length; e.comparisons++; advance(e);
  }
  function topBounds(n, limit) {
    const target = Math.min(n, Math.max(1, Math.floor(limit)));
    return { comparisons: Math.max(0, n - 1) + Math.max(0, target - 1) * Math.max(0, Math.ceil(Math.log2(n)) - 1) };
  }
  function createTournamentEngine(ids, limit) {
    if (ids.length < 2 || new Set(ids).size !== ids.length || !Number.isInteger(limit) || limit < 1) throw new Error('前 N 名排序需要至少两首不同歌曲和有效的目标数量。');
    let size = 1; while (size < ids.length) size *= 2;
    const tree = Array(size * 2).fill(null);
    for (let i = 0; i < size; i++) tree[size + i] = i < ids.length ? [ids[i]] : [];
    const e = { algorithm: 'tournament-v1', total: ids.length, limit, target: Math.min(limit, ids.length), size, tree,
      positions: Object.fromEntries(ids.map((id, i) => [id, size + i])), result: [], rankedCount: 0, active: null,
      done: false, comparisons: 0, excluded: [], bounds: topBounds(ids.length, limit) };
    advanceTournament(e); return e;
  }
  function invalidateLeaf(e, uid) {
    let index = e.positions[uid]; e.tree[index] = [];
    while (index > 1) { index = Math.floor(index / 2); e.tree[index] = null; }
  }
  function advanceTournament(e) {
    e.active = null;
    while (!e.done) {
      if (e.rankedCount >= Math.min(e.target, e.total - e.excluded.length)) { e.done = true; return; }
      for (let i = e.size - 1; i >= 1; i--) {
        if (e.tree[i] !== null) continue;
        const left = e.tree[i * 2], right = e.tree[i * 2 + 1];
        if (left === null || right === null) continue;
        if (!left.length || !right.length) e.tree[i] = left.length ? left : right;
        else {
          e.active = { node: i, left: [left], right: [right], i: 0, j: 0 };
          return;
        }
      }
      const winners = e.tree[1];
      if (!winners?.length) { e.done = true; return; }
      // A tournament winner contains every track tied for this rank. Include the
      // whole group at the cutoff, and retain all losing branches for later ranks.
      e.result.push([...winners]); e.rankedCount += winners.length;
      for (const uid of winners) invalidateLeaf(e, uid);
    }
  }
  function chooseTournament(e, choice) {
    if (e.done) return;
    if (choice === 'ban-left' || choice === 'ban-right') { excludeTournament(e, choice.slice(4)); return; }
    if (!['left', 'right', 'tie'].includes(choice)) return;
    const a = e.active, left = a.left[0], right = a.right[0];
    e.tree[a.node] = choice === 'tie' ? [...left, ...right] : choice === 'left' ? left : right;
    e.comparisons++; advanceTournament(e);
  }
  function excludeTournament(e, side) {
    if (e.done || !['left', 'right'].includes(side)) return;
    const uid = pair(e)[side === 'left' ? 0 : 1];
    invalidateLeaf(e, uid); e.excluded.push(uid); advanceTournament(e); return uid;
  }
  function flattenResults(e) {
    let rank = 1; const rows = [];
    for (const group of e.result || []) { for (const uid of group) rows.push({ uid, rank }); rank += group.length; }
    return rows;
  }
  function csvCell(v) {
    let s = String(v ?? '');
    // Preserve metadata as text when the exported CSV is opened in a spreadsheet.
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function shareSongTitle(song) {
    const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const name = clean(song.name), translation = clean(song.translation);
    if (!translation || translation === name || name.includes('(' + translation + ')') || name.includes('（' + translation + '）')) return name;
    return name + '(' + translation + ')';
  }
  function shareText(snapshot) {
    const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    return snapshot.title + ':\n\n' + snapshot.items.map(song => `${song.rank}. ${shareSongTitle(song)} - ${clean(song.artist) || '未知歌手'}`).join('\n');
  }
  const api = { shareSongTitle, shareText, parseCSV, importCSV, normalize, trackKey, httpURL, extractId, bounds, topBounds, createEngine, createTournamentEngine, choose, exclude, pair, flattenResults, csvCell };
  if (typeof module !== 'undefined') module.exports = api; else root.TuneCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
