process.env.YTDL_NO_UPDATE = '1';
import express from "express";
import https from "https";
import fetch from "node-fetch";
import ytdl from "@distube/ytdl-core";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);
const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = process.env.BASE_URL || "https://proxy-siawaseok.duckdns.org";
const CONFIG_URL = "https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json";

// Netscape形式のCookieを解析
const parseCookies = (txt) => {
  if (!txt) return [];
  return txt.split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const parts = line.split('\t');
      if (parts.length >= 7) {
        return {
          name: parts[5],
          value: parts[6].trim(),
          domain: parts[0],
          path: parts[2]
        };
      }
      return null;
    })
    .filter(Boolean);
};

// 最新のytdl-core仕様に基づいたAgent作成
const cookies = parseCookies(process.env.YOUTUBE_COOKIES_TXT);
const agent = ytdl.createAgent(cookies);

const YTDL_OPTIONS = {
  agent,
  // 複数のクライアントを試すことで解析エラーを回避
  playerClients: ['WEB_EMBEDDED_PLAYER', 'IOS', 'ANDROID', 'TV'],
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept-Language': 'ja-JP,ja;q=0.9',
    }
  }
};

function validateYouTubeId(req, res, next) {
  const { id } = req.params;
  if (!/^[\w-]{11}$/.test(id)) {
    return res.status(400).json({ error: "Invalid YouTube ID" });
  }
  next();
}

app.get("/api/video/:id", validateYouTubeId, async (req, res) => {
  const { id } = req.params;
  try {
    const response = await fetch(CONFIG_URL);
    const config = await response.json();
    const params = config.params || "";
    res.json({ url: `https://www.youtubeeducation.com/embed/${id}${params}` });
  } catch (e) {
    console.error("Type1 Error:", e.message);
    res.status(500).json({ error: "Type1 取得エラー" });
  }
});

app.get("/api/video/download/:id", validateYouTubeId, async (req, res) => {
  const { id } = req.params;
  console.log(`[Info] 取得開始: ${id}`);
  
  try {
    const info = await ytdl.getInfo(id, YTDL_OPTIONS);
    const result = { "audio only": [], "video only": [], "audio&video": [], "m3u8 raw": [], "m3u8 proxy": [] };
    
    if (!info.formats || info.formats.length === 0) {
      return res.status(404).json({ error: "No formats found" });
    }

    for (const f of info.formats) {
      if (!f.url) continue;
      const url = f.url.toLowerCase();
      
      // m3u8形式の判定を強化
      const isM3U8 = url.includes("m3u8") || f.protocol === 'm3u8-fast' || f.isHLS;

      if (isM3U8) {
        const m3u8Data = { 
          url: f.url, 
          quality: f.qualityLabel || f.quality, 
          vcodec: f.vcodec, 
          acodec: f.acodec 
        };
        result["m3u8 raw"].push(m3u8Data);
        result["m3u8 proxy"].push({ 
          ...m3u8Data, 
          url: `${BASE_URL}/proxy/m3u8?url=${encodeURIComponent(f.url)}` 
        });
        continue;
      }

      if (!f.hasVideo) result["audio only"].push(f);
      else if (!f.hasAudio) result["video only"].push(f);
      else result["audio&video"].push(f);
    }
    
    console.log("[Success] データを送信します");
    res.json(result);
  } catch (err) {
    console.error("❌ Download Error:", err.message);
    res.status(500).json({ 
      error: "Internal server error", 
      details: err.message,
      tip: "If 403 or Decipher error, update ytdl-core or check cookies." 
    });
  }
});

app.get("/proxy/m3u8", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("url パラメータが必要です");

  try {
    const response = await fetch(targetUrl, YTDL_OPTIONS.requestOptions);
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/vnd.apple.mpegurl") || targetUrl.includes(".m3u8")) {
      let body = await response.text();
      body = body.replace(/^([^#\n\r]+\.ts[^\n\r]*)$/gm, (match) => {
        const url = new URL(match.trim(), targetUrl);
        return `${BASE_URL}/proxy/m3u8?url=${encodeURIComponent(url.href)}`;
      });
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Access-Control-Allow-Origin", "*");
      res.send(body);
    } else {
      res.set("Content-Type", contentType);
      res.set("Access-Control-Allow-Origin", "*");
      await streamPipeline(response.body, res);
    }
  } catch (err) {
    console.error("Proxy Error:", err.message);
    res.status(500).send("Proxy Error");
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
