#!/usr/bin/env node
/* 抓取 Civitai Krea 2 / Krea 2 Turbo 热门 LoRA 榜单（日 / 周 / 月），
   生成静态数据文件 civitai-krea2-loras-data.json 供 civitai-krea2-loras.html 读取。
   口径与 Flux 搜集器一致：
   - 接口 https://civitai.com/api/v1/models，无需凭据，公开榜
   - types=LORA，sort=Most Downloaded，period=Day/Week/Month，nsfw=false
   - 底模必须用重复参数 baseModels=Krea 2&baseModels=Krea 2 Turbo；
     逗号写法 "Krea 2,Krea 2 Turbo" 在模型接口上会返回 0 条（2026-11-26 实测）
   - 每榜取前 20 名；下载量/点赞是累计值，排名是该周期内的热门顺序
   - 注意：一个模型可能有多个底模的版本，列表接口只返回匹配 Krea 的版本，
     主版本取第一个底模为 Krea 2 / Krea 2 Turbo 的版本；很多 Krea 版本
     没有触发词，如实留空，不编造
   用法：node scripts/fetch-civitai-krea2-loras.mjs
*/
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API_BASE = "https://civitai.com/api/v1/models";
const API_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const KREA_BASES = ["Krea 2", "Krea 2 Turbo"];
const BOARD_LIMIT = 20; // 每榜保留条数（日 / 周 / 月）

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

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function normalizeModel(raw) {
  if (typeof raw.id !== "number" || typeof raw.name !== "string") return null;
  const versions = Array.isArray(raw.modelVersions) ? raw.modelVersions : [];
  // 列表接口已按底模过滤，但仍以第一个 Krea 版本为准，防混入其他底模版本
  const primary =
    versions.find((v) => KREA_BASES.includes(v.baseModel)) || versions[0] || {};
  const stats = raw.stats || {};
  const images = Array.isArray(primary.images) ? primary.images : [];
  const files = (Array.isArray(primary.files) ? primary.files : [])
    .filter((f) => f && typeof f.name === "string")
    .map((f) => ({
      name: f.name,
      sizeMB: f.sizeKB ? Math.round((f.sizeKB / 1024) * 10) / 10 : null,
      format: f.metadata?.format || null,
      fp: f.metadata?.fp || null,
      primary: Boolean(f.primary),
    }));
  return {
    id: raw.id,
    name: raw.name,
    author: raw.creator?.username || "佚名",
    type: raw.type || "LORA",
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 12) : [],
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
    coverUrl: images[0]?.url || "",
    thumbUrl: sizedUrl(images[0]?.url || "", 512),
    exampleImages: images.slice(1, 4).map((im) => ({
      url: im.url || "",
      thumbUrl: sizedUrl(im.url || "", 512),
      width: num(im.width) || null,
      height: num(im.height) || null,
    })),
    pageUrl: `https://civitai.com/models/${raw.id}`,
    allowCommercialUse: raw.allowCommercialUse ?? null,
    ranks: { day: null, week: null, month: null },
  };
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
      const res = await fetch(`${API_BASE}?${params.toString()}`, {
        headers: API_HEADERS,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
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

const data = {
  generatedAt: new Date().toISOString(),
  baseModels: KREA_BASES,
  sort: "Most Downloaded",
  limitPerBoard: BOARD_LIMIT,
  notes: "下载量/点赞/评论为累计值；排名为该周期内按 Most Downloaded 返回的顺序。",
  counts,
  items: [...byId.values()],
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
