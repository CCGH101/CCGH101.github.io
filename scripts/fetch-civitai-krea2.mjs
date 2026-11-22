#!/usr/bin/env node
/* 抓取 Civitai Krea 2 热门图榜单（日 / 周 / 月，Most Reactions），
   生成静态数据文件 civitai-krea2-data.json 供 civitai-krea2.html 读取。
   逻辑与 Muse 空间版收集器（server/src/actions.ts）保持一致：
   - 接口 https://civitai.com/api/v1/images，无需凭据（nsfw=None 的公开榜）
   - 必须带浏览器 User-Agent，否则被 Cloudflare 拦（Error 1010）
   - 每榜翻 2 页（每页 100），只保留前 60 名
   - 城堡题材按提示词判定（原版同款词表）
   用法：node scripts/fetch-civitai-krea2.mjs
*/
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API_BASE = "https://civitai.com/api/v1/images";
const API_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const BOARD_LIMIT = 60; // 每榜保留条数（日 / 周 / 月）
const FETCH_PAGES = 2; // 每页 100 条，跟随 nextCursor 翻一页

/* ------------------------------ 城堡判定 ------------------------------ */
const CASTLE_STRONG = [
  "castle",
  "fortress",
  "citadel",
  "battlement",
  "stronghold",
  "moat",
  "drawbridge",
  "portcullis",
];
const CASTLE_CONTEXT = ["keep", "sea stack", "sea cliff", "turret", "spire"];

function isCastlePrompt(prompt) {
  if (!prompt) return false;
  const p = ` ${prompt.toLowerCase()} `;
  if (CASTLE_STRONG.some((k) => p.includes(k))) return true;
  // "keep" 单独是常见动词，需要城堡语境词陪衬
  const hasKeep = /\bkeep\b/.test(p);
  const hasContext = CASTLE_CONTEXT.some((k) => k !== "keep" && p.includes(k));
  const hasStone = p.includes("stone") || p.includes("medieval");
  return hasKeep && (hasContext || hasStone);
}

/* ------------------------------- 数据清洗 ------------------------------ */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function strOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function sizedUrl(sourceUrl, width) {
  // 接口返回的 url 以 original=true 结尾，换成 width=<n> 即为定尺寸副本
  return sourceUrl.replace("original=true", `width=${width}`);
}

function normalizeImage(raw) {
  if (typeof raw.id !== "number" || typeof raw.url !== "string") return null;
  const meta = raw.meta && typeof raw.meta === "object" ? raw.meta : null;
  const prompt = meta ? strOrNull(meta.prompt) : null;
  const resources = [];
  const rawRes = meta?.resources;
  if (Array.isArray(rawRes)) {
    for (const r of rawRes) {
      if (typeof r?.name === "string") {
        resources.push({
          name: r.name,
          type: typeof r.type === "string" ? r.type : "",
          weight: typeof r.weight === "number" ? r.weight : null,
        });
      }
    }
  }
  const civRes = meta?.civitaiResources;
  if (resources.length === 0 && Array.isArray(civRes)) {
    for (const r of civRes) {
      if (typeof r?.modelName === "string") {
        resources.push({
          name: r.modelName,
          type: typeof r.type === "string" ? r.type : "",
          weight: typeof r.weight === "number" ? r.weight : null,
        });
      }
    }
  }
  const created = typeof raw.createdAt === "string" ? new Date(raw.createdAt) : new Date();
  const likeCount = num(raw.stats?.likeCount);
  const heartCount = num(raw.stats?.heartCount);
  const laughCount = num(raw.stats?.laughCount);
  return {
    civitaiId: raw.id,
    username: typeof raw.username === "string" ? raw.username : "佚名",
    postId: typeof raw.postId === "number" ? raw.postId : null,
    baseModel: typeof raw.baseModel === "string" ? raw.baseModel : "Krea 2",
    width: num(raw.width) || 1024,
    height: num(raw.height) || 1024,
    prompt,
    negativePrompt: meta ? strOrNull(meta.negativePrompt) : null,
    seed: meta && meta.seed != null ? String(meta.seed) : null,
    steps: meta && typeof meta.steps === "number" ? meta.steps : null,
    sampler: meta ? strOrNull(meta.sampler) : null,
    cfgScale: meta && meta.cfgScale != null ? String(meta.cfgScale) : null,
    resources,
    likeCount,
    heartCount,
    laughCount,
    commentCount: num(raw.stats?.commentCount),
    reactions: likeCount + heartCount + laughCount,
    isCastle: isCastlePrompt(prompt),
    sourceUrl: raw.url,
    thumbUrl: sizedUrl(raw.url, 360),
    largeUrl: sizedUrl(raw.url, 1024),
    pageUrl: `https://civitai.com/images/${raw.id}`,
    createdAt: (Number.isNaN(created.getTime()) ? new Date() : created).toISOString(),
    ranks: { day: null, week: null, month: null },
  };
}

async function fetchBoard(period) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < FETCH_PAGES; page++) {
    const params = new URLSearchParams({
      limit: "100",
      period,
      sort: "Most Reactions",
      nsfw: "None",
      type: "image",
      withMeta: "true",
      baseModels: "Krea 2,Krea 2 Turbo",
    });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${API_BASE}?${params.toString()}`, {
      headers: API_HEADERS,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new Error(`Civitai 接口请求失败：period=${period} HTTP ${res.status}`);
    }
    const raw = await res.json();
    if (Array.isArray(raw.items)) {
      for (const r of raw.items) {
        const item = normalizeImage(r);
        if (item) out.push(item);
      }
    }
    cursor = typeof raw.metadata?.nextCursor === "string" ? raw.metadata.nextCursor : null;
    if (!cursor) break;
  }
  return out;
}

/* --------------------------------- 主流程 -------------------------------- */
const PERIODS = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
];

const boards = {};
for (const [key, apiPeriod] of PERIODS) {
  boards[key] = await fetchBoard(apiPeriod);
  console.log(`${key}: 接口返回 ${boards[key].length} 条`);
}

const byId = new Map();
const counts = {};
for (const [key] of PERIODS) {
  const top = boards[key].slice(0, BOARD_LIMIT);
  let castles = 0;
  top.forEach((item, i) => {
    if (item.isCastle) castles += 1;
    const existing = byId.get(item.civitaiId);
    if (existing) {
      existing.ranks[key] = i + 1;
    } else {
      item.ranks[key] = i + 1;
      byId.set(item.civitaiId, item);
    }
  });
  counts[key] = { total: top.length, castles };
}

const data = {
  generatedAt: new Date().toISOString(),
  counts,
  items: [...byId.values()],
};

const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "civitai-krea2-data.json");
await writeFile(outPath, JSON.stringify(data, null, 1) + "\n", "utf8");
console.log(`已写入 ${outPath}：共 ${data.items.length} 张不重复图片`);
console.log(`各榜条数：日 ${counts.day.total}（城堡 ${counts.day.castles}）/ 周 ${counts.week.total}（城堡 ${counts.week.castles}）/ 月 ${counts.month.total}（城堡 ${counts.month.castles}）`);
