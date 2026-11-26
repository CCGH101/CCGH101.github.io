# 工具站

个人工具站，地址：https://bea27.loc.cc/

## 工具

- [随机账号 · 密码 · 名字生成器](account-generator.html) — 一次生成成套组合：单个英文词名字 + 10 位以内短账号（可选自定义后缀，符号可输）+ 特殊字符只有「.」的 16 位密码。全部在浏览器本地生成，不经过服务器。
- [Krea2 提示词生成工具](krea-prompt-generator.html) — 点选媒介、风格、主体、场景、光线等分类，拼出 Krea2 自然语言提示词，带冲突检查、智能随机 / 补齐和 LoRA 推荐，一键复制。
- [Illustrious 插画系提示词生成工具](illustrious-prompt-generator.html) — Illustrious 版：点选拼出 Danbooru 风格英文标签串，带负面提示词区、冲突检查和 Illustrious LoRA 推荐，复制即可喂进 ComfyUI / WebUI。
- [C站 Krea2 热门新图](civitai-krea2.html) — 每天由 GitHub Actions 自动从 Civitai 拉取 Krea 2 / Krea 2 Turbo 的日、周、月热门榜（数据在 `civitai-krea2-data.json`，抓取脚本 `scripts/fetch-civitai-krea2.mjs`），图片为 Civitai CDN 直链可直接下载，可看大图、复制提示词，带去城堡过滤和浏览器本地收藏。
- [C站 Krea2 热门 LoRA](civitai-krea2-loras.html) — 每天由 GitHub Actions 自动从 Civitai 拉取 Krea 2 / Krea 2 Turbo 的 LoRA 热门榜，按 Most Downloaded 排序，日、周、月各 Top 20（数据在 `civitai-krea2-loras-data.json`，抓取脚本 `scripts/fetch-civitai-krea2-loras.mjs`），可搜名字、作者、触发词，点开看介绍、文件大小、示例图和一键复制触发词，带浏览器本地收藏。
