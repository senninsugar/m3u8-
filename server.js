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

// Cookieをパースし、Netscape形式をオブジェクトに変換
const parseCookies = (txt) => {
  if (!txt) return [];
  return txt.split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const parts = line.split('\t');
      if (parts.length >= 7) {
        return { name: parts[5], value: parts[6].trim(), domain: parts[0], path: parts[2] };
      }
      return null;
    }).filter(Boolean);
};

// 起動時に一度だけAgentを作成
const cookies = parseCookies(process.env.YOUTUBE_COOKIES_TXT);
const agent = ytdl.createAgent(cookies);

const YTDL_OPTIONS = {
  agent,
  // 認証エラーを避けるため、モバイルアプリ版の挙動を模倣
  playerClients: ['ANDROID', 'IOS', 'WEB_EMBEDDED_PLAYER'],
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'ja-JP,ja;q=0.9',
    }
  }
};

app.get("/api/video/download/:id", async (req, res) => {
  const { id } = req.params;
  console.log(`[Info] 取得開始: ${id}`);
  
  try {
    // getInfoの実行
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
      error: "Bot detected", 
      details: err.message,
      tip: "RenderのIPが規制されています。Cookieを新しくするか、Region(地域)を変えてください。" 
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
