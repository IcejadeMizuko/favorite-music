/* Local image/text exports. No external libraries or uploaded ranking data. */
(function (root) {
  'use strict';
  const FONT = '"Segoe UI", "Microsoft YaHei", sans-serif';
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  function songTitle(song) {
    return root.TuneCore.shareSongTitle(song);
  }
  function text(snapshot) {
    return root.TuneCore.shareText(snapshot);
  }
  function setFont(context, size, weight = 400) { context.font = `${weight} ${size}px ${FONT}`; }
  function wrap(context, value, width) {
    const words = clean(value).match(/\S+\s*/gu) || [''];
    const lines = []; let line = '';
    for (const word of words) {
      if (context.measureText(line + word.trimEnd()).width <= width) { line += word; continue; }
      if (line.trim()) { lines.push(line.trimEnd()); line = ''; }
      if (context.measureText(word.trimEnd()).width <= width) { line = word; continue; }
      const glyphs = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word)].map(item => item.segment) : Array.from(word);
      for (const glyph of glyphs) {
        if (line && context.measureText(line + glyph).width > width) { lines.push(line.trimEnd()); line = ''; }
        line += glyph;
      }
    }
    if (line.trim() || !lines.length) lines.push(line.trimEnd());
    return lines;
  }
  function rounded(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath(); context.moveTo(x + r, y); context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r); context.arcTo(x, y + height, x, y, r); context.arcTo(x, y, x + width, y, r); context.closePath();
  }
  function lines(context, values, x, y, lineHeight) {
    for (let i = 0; i < values.length; i++) context.fillText(values[i], x, y + i * lineHeight);
  }
  function imageURL(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      if (url.hostname.endsWith('.music.126.net')) { url.protocol = 'https:'; url.searchParams.set('param', '512y512'); }
      return url.href;
    } catch { return ''; }
  }
  function attemptImage(value) {
    return new Promise(resolve => {
      const url = imageURL(value); if (!url) { resolve(null); return; }
      const image = new Image(); let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); image.onload = null; image.onerror = null;
        if (!result) image.removeAttribute('src');
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), 12000);
      // Anonymous CORS prevents an unavailable cover from tainting the PNG canvas.
      image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer'; image.decoding = 'async';
      image.onload = () => finish(image.naturalWidth > 0 ? image : null);
      image.onerror = () => finish(null); image.src = url;
    });
  }
  async function loadImage(value) {
    const first = await attemptImage(value);
    return first || await attemptImage(value);
  }
  function drawCover(context, image, x, y, size) {
    context.save(); rounded(context, x, y, size, size, 7); context.clip();
    if (image) {
      const source = Math.min(image.naturalWidth, image.naturalHeight);
      context.drawImage(image, (image.naturalWidth - source) / 2, (image.naturalHeight - source) / 2, source, source, x, y, size, size);
    } else {
      context.fillStyle = '#e9edf1'; context.fillRect(x, y, size, size);
      context.fillStyle = '#67717d'; setFont(context, 15); context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText('暂无封面', x + size / 2, y + size / 2);
    }
    context.restore(); context.textBaseline = 'top';
  }
  async function image(snapshot, options = {}) {
    if (!snapshot.items?.length) throw new Error('当前没有可分享的排名。');
    if (document.fonts?.ready) await document.fonts.ready;
    const width = 1200, margin = 48, bodyWidth = width - margin * 2;
    const canvas = document.createElement('canvas');
    const measure = canvas.getContext('2d');
    if (!measure) throw new Error('浏览器无法生成图片，可使用文字分享。');
    setFont(measure, 36, 600);
    const heading = wrap(measure, snapshot.title, bodyWidth);
    let y = margin + heading.length * 48 + 30;
    const layouts = [], counts = new Map();
    for (const song of snapshot.items) counts.set(song.rank, (counts.get(song.rank) || 0) + 1);
    if (snapshot.mode === 'list') {
      for (const song of snapshot.items) {
        setFont(measure, 25, 600); const title = wrap(measure, songTitle(song), bodyWidth - 92);
        setFont(measure, 18); const artist = wrap(measure, clean(song.artist) || '未知歌手', bodyWidth - 92);
        const height = title.length * 36 + artist.length * 28 + 33;
        layouts.push({ song, y, title, artist, height }); y += height;
      }
    } else {
      for (let index = 0; index < snapshot.items.length;) {
        const capacity = index === 0 ? 1 : index < 10 ? 3 : 7, dense = capacity === 7;
        const gap = dense ? 18 : 28, area = dense ? bodyWidth : Math.min(820, bodyWidth);
        const size = (area - gap * (dense ? 6 : 2)) / (dense ? 7 : 3);
        const group = snapshot.items.slice(index, index + capacity), groupWidth = group.length * size + (group.length - 1) * gap;
        const start = (width - groupWidth) / 2, fontSize = dense ? 19 : 24, lineHeight = dense ? 28 : 34, artistSize = dense ? 15 : 17, artistHeight = dense ? 22 : 26;
        let height = 0;
        const cells = group.map((song, i) => {
          setFont(measure, fontSize, 600); const title = wrap(measure, songTitle(song), size);
          setFont(measure, artistSize); const artist = wrap(measure, clean(song.artist) || '未知歌手', size);
          height = Math.max(height, size + 14 + title.length * lineHeight + 7 + artist.length * artistHeight);
          return { song, x: start + i * (size + gap), title, artist };
        });
        layouts.push({ cells, y, size, fontSize, lineHeight, artistSize, artistHeight });
        y += height + (dense ? 36 : 42); index += capacity;
      }
    }
    const height = Math.ceil(y + margin);
    // Keep a readable image and stay within common mobile/desktop canvas limits.
    if (height > 30000) throw new Error('排名太长，无法生成清晰的单张长图，请使用文字分享或减少排名数量。');
    const scale = Math.min(2, 16000 / height, Math.sqrt(16000000 / (width * height)));
    canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
    const context = canvas.getContext('2d'); if (!context) throw new Error('图片过大，浏览器无法生成，可使用文字分享。');
    context.scale(scale, scale); context.fillStyle = '#f5f6f8'; context.fillRect(0, 0, width, height);
    context.textBaseline = 'top'; context.textAlign = 'center'; context.fillStyle = '#242931'; setFont(context, 36, 600);
    lines(context, heading, width / 2, margin, 48);
    let missingCovers = 0;
    for (const layout of layouts) {
      if (snapshot.mode === 'list') {
        const { song, title, artist } = layout;
        context.textAlign = 'left'; context.fillStyle = song.rank <= 3 ? '#b5462b' : '#242931'; setFont(context, 25, 600);
        context.fillText(String(song.rank).padStart(2, '0'), margin, layout.y + 4);
        context.fillStyle = '#242931'; lines(context, title, margin + 92, layout.y, 36);
        setFont(context, 18); context.fillStyle = '#67717d'; lines(context, artist, margin + 92, layout.y + title.length * 36 + 5, 28);
        context.strokeStyle = '#dfe3e8'; context.beginPath(); context.moveTo(margin, layout.y + layout.height - 14); context.lineTo(width - margin, layout.y + layout.height - 14); context.stroke();
      } else {
        // Load one row at a time to bound decoded-image memory for long rankings.
        const covers = await Promise.all(layout.cells.map(async cell => {
          let cover = cell.song.cover;
          try { if (!cover && options.resolveCover) cover = await options.resolveCover(cell.song); } catch {}
          return loadImage(cover);
        }));
        for (let i = 0; i < layout.cells.length; i++) {
          const { song, x, title, artist } = layout.cells[i];
          const cover = covers[i]; if (!cover) missingCovers++;
          drawCover(context, cover, x, layout.y, layout.size);
          const badge = String(song.rank).padStart(2, '0') + (counts.get(song.rank) > 1 ? ' · 并列' : '');
          setFont(context, 17, 600); const badgeWidth = context.measureText(badge).width + 14;
          context.fillStyle = '#fffffff2'; rounded(context, x + 8, layout.y + 8, badgeWidth, 29, 4); context.fill();
          context.textAlign = 'left'; context.fillStyle = song.rank <= 3 ? '#b5462b' : '#242931'; context.fillText(badge, x + 15, layout.y + 13);
          context.textAlign = 'center'; context.fillStyle = '#242931'; setFont(context, layout.fontSize, 600);
          lines(context, title, x + layout.size / 2, layout.y + layout.size + 14, layout.lineHeight);
          context.fillStyle = '#67717d'; setFont(context, layout.artistSize);
          lines(context, artist, x + layout.size / 2, layout.y + layout.size + 21 + title.length * layout.lineHeight, layout.artistHeight);
        }
      }
      // Yield to the browser between rows, keeping the page usable during export.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const blob = await new Promise((resolve, reject) => {
      try { canvas.toBlob(value => value ? resolve(value) : reject(new Error('浏览器未能生成 PNG，请使用文字分享。')), 'image/png'); }
      catch { reject(new Error('封面来源不允许生成图片，请切换文字列表后重试。')); }
    });
    const dimensions = { width: canvas.width, height: canvas.height };
    canvas.width = 1; canvas.height = 1;
    return { blob, missingCovers, ...dimensions };
  }
  const api = { text, image, songTitle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TuneShare = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
