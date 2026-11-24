const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const {
  TikTokLiveConnection,
  WebcastEvent,
  RoomIdRouteConfig,
  IsLiveRouteConfig
} = require('tiktok-live-connector');

// Matikan HTML scraping yang lambat agar fallback langsung pakai API cepat
RoomIdRouteConfig.skipFetchRoomInfoFromHtmlRoute = true;
IsLiveRouteConfig.skipFetchRoomInfoFromHtmlRoute = true;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Keep-Alive agent agar koneksi ke CDN video TikTok tidak perlu handshake TLS berulang
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const streamRegistry = new Map();

app.use(express.static(path.join(__dirname, 'public')));

function registerStreams(qualities) {
  const now = Date.now();
  for (const [key, val] of streamRegistry.entries()) {
    if (now - val.createdAt > 6 * 60 * 60 * 1000) {
      streamRegistry.delete(key);
    }
  }

  return qualities.map(([quality, url]) => {
    const token = crypto.randomUUID();
    streamRegistry.set(token, { url, createdAt: now });
    return {
      quality,
      proxyUrl: `/stream/${token}`
    };
  });
}

// Jalur cepat: 1 request JSON langsung ke API Web Live TikTok (tanpa scrape HTML)
async function fetchFastApiLive(username) {
  const url =
    `https://www.tiktok.com/api-live/user/room` +
    `?aid=1988&app_name=tiktok_web&device_platform=web_pc&sourceType=54` +
    `&uniqueId=${encodeURIComponent(username)}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(4500),
    headers: {
      'User-Agent': CHROME_UA,
      'Referer': `https://www.tiktok.com/@${username}/live`,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const rawText = await res.text();
  // Jaga presisi angka 64-bit roomId agar tidak berubah saat JSON.parse
  const safeText = rawText.replace(/"(roomId|room_id)"\s*:\s*(\d{15,})/g, '"$1":"$2"');
  const json = JSON.parse(safeText);

  if (json.statusCode !== 0 || !json.data) {
    throw new Error('Response api-live tidak valid');
  }

  const user = json.data.user || {};
  const liveRoom = json.data.liveRoom || {};
  const roomId = String(user.roomId || liveRoom.roomId || '');

  // Status 4 = offline
  if (!liveRoom || liveRoom.status === 4) {
    return { isLive: false };
  }

  const rawStreamData = liveRoom.streamData?.pull_data?.stream_data;
  if (!rawStreamData) {
    throw new Error('streamData kosong');
  }

  const parsedStream = JSON.parse(rawStreamData);
  const streamEntries = parsedStream?.data || {};
  const priority = ['origin', 'uhd_60', 'uhd', 'hd_60', 'hd', 'sd', 'ld'];

  const qualities = [];
  for (const key of priority) {
    const flvUrl = streamEntries[key]?.main?.flv;
    if (typeof flvUrl === 'string' && flvUrl.startsWith('http')) {
      qualities.push([key.toUpperCase(), flvUrl]);
    }
  }

  if (qualities.length === 0) {
    throw new Error('FLV URL tidak ditemukan di streamData');
  }

  return {
    isLive: true,
    roomId,
    nickname: user.nickname || username,
    avatar: user.avatarThumb || '',
    title: liveRoom.title || 'TikTok LIVE',
    viewerCount: liveRoom.liveRoomUserInfo?.userCount || 0,
    streams: registerStreams(qualities)
  };
}

// 1. Endpoint deteksi LIVE (Fast Path + Fallback)
app.get('/api/live/:username', async (req, res) => {
  const startedAt = Date.now();
  const username = req.params.username.replace(/^@/, '').trim();
  if (!username) {
    return res.status(400).json({ error: 'Username tidak valid.' });
  }

  try {
    // Coba jalur cepat dulu (~0.3 - 1 detik)
    try {
      const fastResult = await fetchFastApiLive(username);
      const elapsedMs = Date.now() - startedAt;
      console.log(`[FAST] @${username} -> ${fastResult.isLive ? 'LIVE' : 'OFFLINE'} (${elapsedMs}ms)`);

      if (!fastResult.isLive) {
        return res.status(404).json({
          isLive: false,
          elapsedMs,
          error: `@${username} sedang tidak LIVE saat ini.`
        });
      }

      return res.json({ username, elapsedMs, ...fastResult });
    } catch (fastErr) {
      console.log(`[FAST MISS] @${username}: ${fastErr.message}, pindah ke fallback...`);
    }

    // Fallback ke tiktok-live-connector (sudah tanpa HTML scrape)
    const connection = new TikTokLiveConnection(username);
    const roomInfo = await connection.fetchRoomInfo();
    const flvMap = roomInfo?.stream_url?.flv_pull_url || {};
    const qualities = Object.entries(flvMap).filter(
      ([, url]) => typeof url === 'string' && url.startsWith('http')
    );

    const elapsedMs = Date.now() - startedAt;
    console.log(`[FALLBACK] @${username} (${elapsedMs}ms)`);

    if (!roomInfo || roomInfo.status === 4 || qualities.length === 0) {
      return res.status(404).json({
        isLive: false,
        elapsedMs,
        error: `@${username} sedang tidak LIVE saat ini.`
      });
    }

    const priority = ['FULL_HD1', 'HD1', 'SD2', 'SD1'];
    qualities.sort((a, b) => {
      const idxA = priority.indexOf(a[0]);
      const idxB = priority.indexOf(b[0]);
      return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
    });

    res.json({
      isLive: true,
      elapsedMs,
      roomId: String(roomInfo.id_str || roomInfo.id || connection.roomId || ''),
      username,
      nickname: roomInfo.owner?.nickname || username,
      avatar: roomInfo.owner?.avatar_thumb?.url_list?.[0] || '',
      title: roomInfo.title || 'TikTok LIVE',
      viewerCount: roomInfo.user_count || 0,
      streams: registerStreams(qualities)
    });
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.error(`[ERROR] @${username} (${elapsedMs}ms):`, err.message);
    res.status(500).json({
      isLive: false,
      elapsedMs,
      error: `Gagal mengecek @${username}. Pastikan username benar atau koneksi stabil.`
    });
  }
});

// 2. Proxy aliran video HTTP-FLV dengan Keep-Alive
function pipeStream(targetUrl, req, res, redirectCount = 0) {
  if (redirectCount > 5) {
    return res.status(502).end('Too many redirects');
  }

  const isHttps = targetUrl.startsWith('https');
  const client = isHttps ? https : http;
  const upstreamReq = client.get(
    targetUrl,
    {
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        'Referer': 'https://www.tiktok.com/',
        'User-Agent': CHROME_UA
      }
    },
    (upstreamRes) => {
      if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
        upstreamRes.resume();
        return pipeStream(upstreamRes.headers.location, req, res, redirectCount + 1);
      }

      if (upstreamRes.statusCode >= 400) {
        upstreamRes.resume();
        return res.status(upstreamRes.statusCode).end('Stream unavailable');
      }

      res.writeHead(200, {
        'Content-Type': 'video/x-flv',
        'Cache-Control': 'no-cache, no-store',
        'Access-Control-Allow-Origin': '*'
      });

      upstreamRes.pipe(res);

      req.on('close', () => {
        upstreamRes.destroy();
      });
    }
  );

  upstreamReq.on('error', (err) => {
    console.error('Upstream stream error:', err.message);
    if (!res.headersSent) {
      res.status(502).end('Stream error');
    }
  });
}

app.get('/stream/:token', (req, res) => {
  const entry = streamRegistry.get(req.params.token);
  if (!entry) {
    return res.status(404).send('Token stream tidak ditemukan atau kedaluwarsa.');
  }
  pipeStream(entry.url, req, res);
});

// 3. Socket.IO untuk Live Chat (langsung pakai roomId agar tidak scan ulang)
io.on('connection', (socket) => {
  let tiktokConn = null;

  const cleanup = () => {
    if (tiktokConn) {
      try {
        tiktokConn.disconnect();
      } catch (_) {}
      tiktokConn = null;
    }
  };

  socket.on('watch', async (payload) => {
    cleanup();
    const rawUsername = typeof payload === 'string' ? payload : payload?.username;
    const roomId = typeof payload === 'object' ? payload?.roomId : '';
    const username = String(rawUsername || '').replace(/^@/, '').trim();
    if (!username) return;

    tiktokConn = new TikTokLiveConnection(username, {
      processInitialData: false,
      fetchRoomInfoOnConnect: !roomId,
      enableExtendedGiftInfo: true
    });

    tiktokConn.on(WebcastEvent.CHAT, (data) => {
      socket.emit('chat', {
        user: data.user?.uniqueId || data.user?.displayId || data.user?.nickname || 'Anonim',
        nickname: data.user?.nickname || data.user?.uniqueId || 'Anonim',
        comment: data.content || data.comment || ''
      });
    });

    tiktokConn.on(WebcastEvent.GIFT, (data) => {
      if (data.giftType === 1 && !data.repeatEnd) return;
      socket.emit('gift', {
        user: data.user?.nickname || data.user?.uniqueId || 'Penonton',
        giftName: data.giftDetails?.giftName || data.giftName || 'Gift',
        repeatCount: data.repeatCount || 1
      });
    });

    tiktokConn.on(WebcastEvent.ROOM_USER, (data) => {
      if (typeof data.viewerCount === 'number') {
        socket.emit('viewerCount', data.viewerCount);
      }
    });

    tiktokConn.on(WebcastEvent.LIKE, (data) => {
      if (typeof data.totalLikeCount === 'number') {
        socket.emit('likeCount', data.totalLikeCount);
      }
    });

    tiktokConn.on(WebcastEvent.STREAM_END, () => {
      socket.emit('streamEnd');
    });

    try {
      await tiktokConn.connect(roomId || undefined);
      socket.emit('chatStatus', 'Terhubung ke Live Chat');
    } catch (err) {
      socket.emit('chatStatus', 'Chat tidak tersedia (Video tetap berjalan)');
    }
  });

  socket.on('disconnect', cleanup);
});

server.listen(PORT, () => {
  console.log(`Monitor TikTok Live berjalan di http://localhost:${PORT}`);
});
