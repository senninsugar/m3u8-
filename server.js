process.env.YTDL_NO_UPDATE = '1'; // 自動アップデートチェックを停止して403エラーを回避
import express from "express";
import https from "https";
import fetch from "node-fetch";
import ytdl from "@distube/ytdl-core";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);
const app = express();
const PORT = process.env.PORT || 3000;

// あなたのドメイン（RenderのURLなど）
const BASE_URL = process.env.BASE_URL || "https://proxy-siawaseok.duckdns.org";
const CONFIG_URL = "https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json";

// ================= Utils =================

function validateYouTubeId(req, res, next) {
  const { id } = req.params;
  if (!/^[\w-]{11}$/.test(id)) {
    return res.status(400).json({ error: "validateYouTubeIdでエラー" });
  }
  next();
}

function fetchConfigJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("fetchConfigJsonでエラー"));
      }
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error("fetchConfigJsonでエラー")); }
      });
    }).on("error", () => reject(new Error("fetchConfigJsonでエラー")));
  });
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? xff.split(',')[0] : req.ip)?.trim();
}

const rateLimiters = new Map();
function ipRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const timestamps = (rateLimiters.get(ip) || []).filter(ts => now - ts < 60000);
  if (timestamps.length >= 4) return res.status(429).json({ error: 'Rate limit exceeded' });
  timestamps.push(now);
  rateLimiters.set(ip, timestamps);
  next();
}

// ================= Routes =================

// Type1
app.get("/api/video/:id", validateYouTubeId, async (req, res) => {
  const { id } = req.params;
  try {
    const config = await fetchConfigJson(CONFIG_URL);
    const params = config.params || "";
    res.json({ url: `https://www.youtubeeducation.com/embed/${id}${params}` });
  } catch { res.status(500).json({ error: "type1でエラー" }); }
});

// Type2
app.get("/api/video/:id/type2", validateYouTubeId, async (req, res) => {
  const { id } = req.params;
  
  const parseHeight = (format) => {
    if (typeof format.height === "number") return format.height;
    const match = /x(\d+)/.exec(format.resolution || "");
    return match ? parseInt(match[1]) : null;
  };

  const selectUrlLocal = (urls) => {
    if (!urls?.length) return null;
    const jaUrl = urls.find((u) => decodeURIComponent(u).includes("lang=ja"));
    return jaUrl || urls[0];
  };

  try {
    const info = await ytdl.getInfo(id);
    const formats = info.formats || [];

    const videourl = {};
    const m3u8 = {};

    const audioUrls = formats.filter((f) => f.acodec !== "none" && f.vcodec === "none").map((f) => f.url);
    const audioOnlyUrl = selectUrlLocal(audioUrls);
    const extPriority = ["webm", "mp4", "av1"];

    const formatsByHeight = {};
    for (const f of formats) {
      const height = parseHeight(f);
      if (!height || f.vcodec === "none" || !f.url) continue;
      const label = `${height}p`;
      if (!formatsByHeight[label]) formatsByHeight[label] = [];
      formatsByHeight[label].push(f);
    }

    for (const [label, list] of Object.entries(formatsByHeight)) {
      const m3u8List = list.filter((f) => f.url.includes(".m3u8"));
      if (m3u8List.length > 0) {
        m3u8[label] = { url: { url: selectUrlLocal(m3u8List.map((f) => f.url)) } };
      }
      const normalList = list.filter((f) => !f.url.includes(".m3u8")).sort((a, b) => extPriority.indexOf(a.ext || "") - extPriority.indexOf(b.ext || ""));
      if (normalList.length > 0) {
        videourl[label] = {
          video: { url: selectUrlLocal([normalList[0].url]) },
          audio: { url: audioOnlyUrl },
        };
      }
    }
    res.json({ videourl, m3u8 });
  } catch (e) { res.status(500).json({ error: "type2でエラー" }); }
});

// Download
app.get("/api/video/download/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const info = await ytdl.getInfo(id);
    const result = { "audio only": [], "video only": [], "audio&video": [], "m3u8 raw": [], "m3u8 proxy": [] };
    
    for (const f of info.formats) {
      if (!f.url) continue;
      const url = f.url.toLowerCase();
      if (url.includes("lang=") && !url.includes("lang=ja")) continue;

      if (url.endsWith(".m3u8")) {
        const m3u8Data = { url: f.url, resolution: f.resolution, vcodec: f.vcodec, acodec: f.acodec };
        result["m3u8 raw"].push(m3u8Data);
        result["m3u8 proxy"].push({ ...m3u8Data, url: `${BASE_URL}/proxy/m3u8?url=${encodeURIComponent(f.url)}` });
        continue;
      }
      if (f.resolution === "audio only" || f.vcodec === "none") result["audio only"].push(f);
      else if (f.acodec === "none") result["video only"].push(f);
      else result["audio&video"].push(f);
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: "Internal server error" }); }
});

// Proxy
app.get("/proxy/m3u8", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("url パラメータが必要です");

  try {
    const response = await fetch(targetUrl);
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/vnd.apple.mpegurl") || targetUrl.endsWith(".m3u8")) {
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
      res.set("Access-Control-Allow-Headers", "Range");
      res.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");
      await streamPipeline(response.body, res);
    }
  } catch (err) { res.status(500).send("エラー: " + err.message); }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
