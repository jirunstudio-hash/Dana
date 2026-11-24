const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// Menyimpan token sementara -> URL stream asli (mencegah open-proxy)
const streamRegistry = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// 1. Endpoint untuk cek status LIVE & ambil daftar resolusi stream
app.get('/api/live/:username', async (req, res) => {
  const username = req.params.username.replace(/^@/, '').trim();
  if (!username) {
    return res.status(400).json({ error: 'Username tidak valid.' });
  }

  try {
    const connection = new TikTokLiveConnection(username);
    const roomInfo = await connection.fetchRoomInfo();

    // Status 2 di TikTok biasanya menandakan sedang LIVE
    const flvMap = roomInfo?.stream_url?.flv_pull_url || {};
    const qualities = Object.entries(flvMap).filter(([, url]) => typeof url === 'string' && url.startsWith('http'));

    if (!roomInfo || roomInfo.status === 4 || qualities.length === 0) {
      return res.status(404).json({
        isLive: false,
        error: `@${username} sedang tidak LIVE saat ini.`
      });
    }

    // Urutkan kualitas dari tertinggi ke terendah
    const priority = ['FULL_HD1', 'HD1', 'SD2', 'SD1'];
    qualities.sort((a, b) => {
      const idxA = priority.indexOf(a[0]);
      const idxB = priority.indexOf(b[0]);
      return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
    });

    const streams = qualities.map(([quality, url]) => {
      const token = crypto.randomUUID();
      streamRegistry.set(token, { url, createdAt: Date.now() });
      return {
        quality,
        proxyUrl: `/stream/${token}`
      };
    });

    // Bersihkan token lama (> 6 jam) agar memori tetap hemat
    const now = Date.now();
    for (const [key, val] of streamRegistry.entries()) {
      if (now - val.createdAt > 6 * 60 * 60 * 1000) {
        streamRegistry.delete(key);
      }
    }

    res.json({
      isLive: true,
      username,
      nickname: roomInfo.owner?.nickname || username,
      avatar: roomInfo.owner?.avatar_thumb?.url_list?.[0] || '',
      title: roomInfo.title || 'TikTok LIVE',
      viewerCount: roomInfo.user_count || 0,
      streams
    });
  } catch (err) {
    console.error('Error fetchRoomInfo:', err.message);
    res.status(500).json({
      isLive: false,
      error: `Gagal mengambil data @${username}. Pastikan username benar atau sedang live.`
    });
  }
});

// 2. Proxy aliran video HTTP-FLV agar bisa diputar di browser tanpa terblokir CORS/Referer
function pipeStream(targetUrl, req, res, redirectCount = 0) {
  if (redirectCount > 5) {
    return res.status(502).end('Too many redirects');
  }

  const client = targetUrl.startsWith('https') ? https : http;
  const upstreamReq = client.get(
    targetUrl,
    {
      headers: {
        'Referer': 'https://www.tiktok.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
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

// 3. Socket.IO untuk Live Chat, Gift, Like, dan Jumlah Penonton
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

  socket.on('watch', async (rawUsername) => {
    cleanup();
    const username = String(rawUsername || '').replace(/^@/, '').trim();
    if (!username) return;

    tiktokConn = new TikTokLiveConnection(username, {
      processInitialData: false,
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
      await tiktokConn.connect();
      socket.emit('chatStatus', 'Terhubung ke Live Chat');
    } catch (err) {
      // Jika chat gagal/rate-limit, video monitor tetap berjalan normal
      socket.emit('chatStatus', 'Chat tidak tersedia (Video tetap berjalan)');
    }
  });

  socket.on('disconnect', cleanup);
});

server.listen(PORT, () => {
  console.log(`Monitor TikTok Live berjalan di http://localhost:${PORT}`);
});
