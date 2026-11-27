#!/usr/bin/env node
/* 抓取 Civitai Krea 2 / Krea 2 Turbo 热门 LoRA 榜单（日 / 周 / 月），
   生成静态数据文件 civitai-krea2-loras-data.json 供 civitai-krea2-loras.html 读取。
   口径与 Flux 搜集器一致：
   - 接口 https://civitai.com/api/v1/models，无需凭据，公开榜
   - types=LORA，sort=Most Downloaded，period=Day/Week/Month，nsfw=false
   - 底模必须用重复参数 baseModels=Krea 2&baseModels=Krea 2 Turbo；
     逗号写法 "Krea 2,Krea 2 Turbo" 在模型接口上会返回 0 条（2026-11-26 实测）
   - 每榜取前 50 名；下载量/点赞是累计值，排名是该周期内的热门顺序
   - 注意：一个模型可能有多个底模的版本，列表接口只返回匹配 Krea 的版本，
     主版本取第一个底模为 Krea 2 / Krea 2 Turbo 的版本；很多 Krea 版本
     没有触发词，如实留空，不编造
   示例图（v2，2026-11-27）：
   - 列表接口的版本图经常只有 1-4 张（旧数据平均每条 1.7 张，16 条为 0），
     所以每条先取版本图，再用 /api/v1/images?modelId=…&sort=Most Reactions
     拿社区高赞图补齐，目标每条共 8 张图（封面 + 7 张示例）
   - 视频（.mp4/.webm）不进图片画廊，单独记 videoUrl；封面优先选第一张图片，
     实在没有图片才用视频当封面
   用法：node scripts/fetch-civitai-krea2-loras.mjs
*/
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API_BASE = "https://civitai.com/api/v1/models";
const IMAGES_API = "https://civitai.com/api/v1/images";
const API_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const KREA_BASES = ["Krea 2", "Krea 2 Turbo"];
const BOARD_LIMIT = 50; // 每榜保留条数（日 / 周 / 月），v2 由 20 扩到 50
const GALLERY_TARGET = 8; // 每条图库总数（封面 + 示例）
const EXAMPLE_TARGET = GALLERY_TARGET - 1; // 示例图目标数
const IMAGE_TOPUP_LIMIT = 12; // 图片接口每次取多少张社区图来补
const IMAGE_POOL = 5; // 补图并发数，别太高以免触发限流

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripHtml(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, 600);
}

function sizedUrl(url, width) {
  if (!url || typeof url !== "string") return "";
  if (url.includes("/original=true/")) return url.replace("/original=true/", `/width=${width}/`);
  return url;
}

function isVideoUrl(url) {
  return typeof url === "string" && /\.(mp4|webm)(\?|$)/i.test(url);
}

function imageKey(url) {
  // 去重用：取 URL 最后一段文件名（同一张图 original/width 两种写法算同一张）
  if (!url || typeof url !== "string") return "";
  const m = url.match(/\/([0-9a-f-]{8,}\.(?:jpeg|jpg|png|webp|mp4|webm))/i);
  return m ? m[1].toLowerCase() : url.split("?")[0];
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// 从标签推一个中文分类，供页面筛选和展示；命中多个时按优先级取第一个
const CATEGORY_RULES = [
  ["人物", ["character", "face", "girl", "woman", "man", "boy", "person", "portrait"]],
  ["风格", ["style", "artist style", "art style", "aesthetic"]],
  ["概念", ["concept"]],
  ["服装", ["clothing", "fashion", "uniform", "outfit", "dress"]],
  ["场景", ["background", "landscape", "scenery", "environment", "interior"]],
];
function deriveCategory(tags) {
  const lower = (Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase());
  for (const [label, keys] of CATEGORY_RULES) {
    if (keys.some((k) => lower.includes(k))) return label;
  }
  return "其他";
}

function toGalleryImage(im) {
  const url = im?.url || "";
  if (!url || isVideoUrl(url)) return null;
  return {
    url,
    thumbUrl: sizedUrl(url, 512),
    width: num(im.width) || null,
    height: num(im.height) || null,
  };
}

function normalizeModel(raw) {
  if (typeof raw.id !== "number" || typeof raw.name !== "string") return null;
  const versions = Array.isArray(raw.modelVersions) ? raw.modelVersions : [];
  // 列表接口已按底模过滤，但仍以第一个 Krea 版本为准，防混入其他底模版本
  const primary =
    versions.find((v) => KREA_BASES.includes(v.baseModel)) || versions[0] || {};
  const stats = raw.stats || {};
  const versionImages = Array.isArray(primary.images) ? primary.images : [];
  const imageList = [];
  const seen = new Set();
  let videoUrl = "";
  for (const im of versionImages) {
    const url = im?.url || "";
    if (!url) continue;
    if (isVideoUrl(url)) {
      if (!videoUrl) videoUrl = url;
      continue;
    }
    const g = toGalleryImage(im);
    if (!g) continue;
    const k = imageKey(g.url);
    if (seen.has(k)) continue;
    seen.add(k);
    imageList.push(g);
  }
  const files = (Array.isArray(primary.files) ? primary.files : [])
    .filter((f) => f && typeof f.name === "string")
    .map((f) => ({
      name: f.name,
      sizeMB: f.sizeKB ? Math.round((f.sizeKB / 1024) * 10) / 10 : null,
      format: f.metadata?.format || null,
      fp: f.metadata?.fp || null,
      primary: Boolean(f.primary),
    }));
  const tags = Array.isArray(raw.tags) ? raw.tags.slice(0, 12) : [];
  const cover = imageList[0] || null;
  return {
    id: raw.id,
    name: raw.name,
    author: raw.creator?.username || "佚名",
    type: raw.type || "LORA",
    tags,
    category: deriveCategory(tags),
    description: stripHtml(raw.description),
    version: primary.name || null,
    baseModel: primary.baseModel || null,
    publishedAt: primary.publishedAt || null,
    triggerWords: Array.isArray(primary.trainedWords)
      ? primary.trainedWords.filter(Boolean)
      : [],
    files,
    versions: versions
      .filter((v) => KREA_BASES.includes(v.baseModel))
      .map((v) => ({ name: v.name, baseModel: v.baseModel, publishedAt: v.publishedAt || null })),
    downloads: num(stats.downloadCount),
    likes: num(stats.thumbsUpCount),
    comments: num(stats.commentCount),
    // 封面优先用第一张图片；没有任何图片时才用视频当封面
    coverUrl: cover ? cover.url : videoUrl,
    coverIsVideo: !cover && Boolean(videoUrl),
    thumbUrl: cover ? cover.thumbUrl : videoUrl,
    videoUrl,
    // 画廊 = 封面 + 示例图，补图后再填满；旧版页面只读 coverUrl/exampleImages，仍兼容
    gallery: imageList.slice(0, GALLERY_TARGET),
    exampleImages: imageList.slice(1, GALLERY_TARGET),
    pageUrl: `https://civitai.com/models/${raw.id}`,
    allowCommercialUse: raw.allowCommercialUse ?? null,
    ranks: { day: null, week: null, month: null },
    _seenKeys: seen, // 内部用，写盘前删掉
  };
}

async function fetchJson(url, timeoutMs = 30000) {
  const res = await fetch(url, { headers: API_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchBoard(period) {
  const params = new URLSearchParams();
  params.set("types", "LORA");
  params.set("sort", "Most Downloaded");
  params.set("period", period);
  params.set("nsfw", "false");
  params.set("limit", String(BOARD_LIMIT));
  for (const b of KREA_BASES) params.append("baseModels", b);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await fetchJson(`${API_BASE}?${params.toString()}`);
      return (Array.isArray(raw.items) ? raw.items : [])
        .map(normalizeModel)
        .filter(Boolean);
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(5000 * (attempt + 1));
    }
  }
  throw new Error(`Civitai 模型接口请求失败：period=${period} ${lastErr}`);
}

// 用图片接口的社区高赞图把图库补到 8 张；失败不致命，保留版本图
async function topUpImages(item) {
  if (item.gallery.length >= GALLERY_TARGET) return;
  const params = new URLSearchParams();
  params.set("modelId", String(item.id));
  params.set("limit", String(IMAGE_TOPUP_LIMIT));
  params.set("nsfw", "false");
  params.set("sort", "Most Reactions");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await fetchJson(`${IMAGES_API}?${params.toString()}`, 20000);
      for (const im of Array.isArray(raw.items) ? raw.items : []) {
        if (item.gallery.length >= GALLERY_TARGET) break;
        if (im?.type && im.type !== "image") continue;
        const g = toGalleryImage(im);
        if (!g) continue;
        const k = imageKey(g.url);
        if (item._seenKeys.has(k)) continue;
        item._seenKeys.add(k);
        item.gallery.push(g);
      }
      return;
    } catch (e) {
      if (attempt === 0) await sleep(2000);
    }
  }
}

// 简单并发池
async function runPool(items, worker, concurrency) {
  let idx = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const item = items[idx++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const PERIODS = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
];

const boards = {};
for (const [key, apiPeriod] of PERIODS) {
  boards[key] = await fetchBoard(apiPeriod);
  console.log(`${key}: 接口返回 ${boards[key].length} 条`);
  await sleep(1000);
}

const byId = new Map();
const counts = {};
for (const [key] of PERIODS) {
  const top = boards[key].slice(0, BOARD_LIMIT);
  top.forEach((item, i) => {
    const existing = byId.get(item.id);
    if (existing) {
      existing.ranks[key] = i + 1;
    } else {
      item.ranks[key] = i + 1;
      byId.set(item.id, item);
    }
  });
  counts[key] = { total: top.length };
}

const items = [...byId.values()];
console.log(`去重后共 ${items.length} 个 LoRA，开始补图（目标每条 ${GALLERY_TARGET} 张，并发 ${IMAGE_POOL}）…`);
let topped = 0;
await runPool(items, async (item) => {
  const before = item.gallery.length;
  await topUpImages(item);
  if (item.gallery.length > before) topped++;
}, IMAGE_POOL);
console.log(`补图完成：${topped} 条补到了新图`);

// 补图后定稿：封面/示例图与画廊一致，删内部字段
for (const item of items) {
  item.gallery = item.gallery.slice(0, GALLERY_TARGET);
  const cover = item.gallery[0] || null;
  if (cover) {
    item.coverUrl = cover.url;
    item.thumbUrl = cover.thumbUrl;
    item.coverIsVideo = false;
  }
  item.exampleImages = item.gallery.slice(1);
  item.imageCount = item.gallery.length;
  delete item._seenKeys;
}

const totalGallery = items.reduce((s, x) => s + x.gallery.length, 0);
const zeroImage = items.filter((x) => x.gallery.length === 0).length;
const data = {
  generatedAt: new Date().toISOString(),
  baseModels: KREA_BASES,
  sort: "Most Downloaded",
  limitPerBoard: BOARD_LIMIT,
  galleryTarget: GALLERY_TARGET,
  notes: "下载量/点赞/评论为累计值；排名为该周期内按 Most Downloaded 返回的顺序；示例图为模型版本图 + 社区高赞图，最多 8 张。",
  counts,
  items,
};

const outPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "civitai-krea2-loras-data.json"
);
await writeFile(outPath, JSON.stringify(data, null, 1) + "\n", "utf8");
console.log(`已写入 ${outPath}：共 ${data.items.length} 个不重复 LoRA`);
console.log(
  `各榜条数：日 ${counts.day.total} / 周 ${counts.week.total} / 月 ${counts.month.total}`
);
console.log(
  `图库：平均每条 ${(totalGallery / items.length).toFixed(1)} 张，0 张的 ${zeroImage} 条`
);
