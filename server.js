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

// Cookie解析をより精密に修正
const parseCookies = (txt) => {
  if (!txt) return [];
  const lines = txt.split('\n');
  const cookieJar = [];
  for (const line of lines) {
    const parts = line.trim().split('\t');
    if (parts.length >= 7) {
      cookieJar.push({
        name: parts[5],
        value: parts[6],
        domain: parts[0].startsWith('.') ? parts[0] : `.${parts[0]}`,
        path: parts[2],
        secure: parts[3].toUpperCase() === 'TRUE',
        expires: parts[4] !== '0' ? parseInt(parts[4]) : undefined
      });
    }
  }
  return cookieJar;
};

// Agentの作成をリクエストごとではなく1回に固定
const cookiesTxt = process.env.YOUTUBE_COOKIES_TXT || "";
const cookies = parseCookies(cookiesTxt);
let agent;
try {
  agent = ytdl.createAgent(cookies);
} catch (e) {
  console.error("Agent Creation Error:", e.message);
}

const YTDL_OPTIONS = {
  agent,
  // 認証エラー時は WEB_EMBEDDED_PLAYER を優先すると通る場合があります
  playerClients: ['WEB_EMBEDDED_PLAYER', 'IOS', 'ANDROID', 'TV'],
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept-Language': 'ja-JP,ja;q=0.9',
      'Accept': '*/*',
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/'
    }
  }
};

app.get("/api/video/download/:id", async (req, res) => {
  const { id } = req.params;
  console.log(`[Info] 取得開始: ${id}`);
  
  try {
    // getInfo の前に Cookie がセットされているかログで確認（デバッグ用）
    if (!cookies.length) console.warn("[Warn] Cookie string is empty! Check Environment Variables.");

    const info = await ytdl.getInfo(id, YTDL_OPTIONS);
    const result = { "audio only": [], "video only": [], "audio&video": [], "m3u8 raw": [], "m3u8 proxy": [] };

    info.formats.forEach(f => {
      if (!f.url) return;
      const isM3U8 = f.url.includes("m3u8") || f.protocol === 'm3u8-fast' || f.isHLS;

      if (isM3U8) {
        const data = { url: f.url, quality: f.qualityLabel || f.quality, vcodec: f.vcodec, acodec: f.acodec };
        result["m3u8 raw"].push(data);
        result["m3u8 proxy"].push({ ...data, url: `${BASE_URL}/proxy/m3u8?url=${encodeURIComponent(f.url)}` });
      } else if (f.hasVideo && f.hasAudio) {
        result["audio&video"].push({ url: f.url, quality: f.qualityLabel });
      } else if (!f.hasVideo) {
        result["audio only"].push({ url: f.url, bitrate: f.audioBitrate });
      } else {
        result["video only"].push({ url: f.url, quality: f.qualityLabel });
      }
    });

    res.json(result);
  } catch (err) {
    console.error("❌ Error Details:", err.message);
    res.status(500).json({ 
      error: "Bot detected or session expired", 
      details: err.message,
      tip: "ブラウザでYouTubeにログインし直して、新しいCookieを取得してください。" 
    });
  }
});

app.get("/proxy/m3u8", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("No URL");
  try {
    const response = await fetch(targetUrl, { headers: YTDL_OPTIONS.requestOptions.headers });
    const body = await response.text();
    const newBody = body.replace(/^([^#\n\r]+\.ts[^\n\r]*)$/gm, (m) => {
      return `${BASE_URL}/proxy/m3u8?url=${encodeURIComponent(new URL(m.trim(), targetUrl).href)}`;
    });
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.send(newBody);
  } catch (err) { res.status(500).send(err.message); }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
