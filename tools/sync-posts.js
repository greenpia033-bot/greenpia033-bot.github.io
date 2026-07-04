/**
 * 自动从外部论坛拉取文章，转换为 Hexo Markdown 格式。
 *
 * 使用方法：
 *   1. 修改下方 SOURCES 配置，填入你的用户名
 *   2. 本地测试：node scripts/sync-posts.js
 *   3. 推送到 GitHub，Actions 会每天自动运行
 */

const RssParser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
//  ⚙️ 配置：修改这里的用户名即可
// ============================================================
const SOURCES = {
  // 博客园 RSS —— 把 YOUR_USERNAME 换成你的博客园用户名
  cnblogs: {
    enabled: true,  // 暂时关闭，有了文章再开
    name: '博客园',
    rss: 'https://www.cnblogs.com/greenpia/rss',  // ← 去 i.cnblogs.com/settings 查看
  },
  // 简书主页 —— 把 YOUR_USER_ID 换成你的简书用户 ID
  // （打开你的简书主页，URL 里 /u/ 后面那串就是）
  jianshu: {
    enabled: true,  // 暂时关闭，有了文章再开
    name: '简书',
    userId: 'YOUR_USER_ID',
    homeUrl: 'https://www.jianshu.com/u/afd28858c582',
  },
};

const POSTS_DIR = path.join(__dirname, '..', 'source', '_posts');
const SYNC_LOG = path.join(__dirname, '..', '.sync-log.json');

/** 将中文等字符 URL 编码，防止请求失败 */
function encodeUrl(url) {
  // 分离协议+域名 和 路径部分，只编码路径
  const match = url.match(/^(https?:\/\/[^\/]+)(\/.*)$/);
  if (match) {
    return match[1] + encodeURI(match[2]);
  }
  return encodeURI(url);
}

/** 解析简书等各种格式的日期字符串 */
function parseDate(str) {
  if (!str || str.trim() === '') return new Date();
  // 尝试直接解析
  let d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  // 简书格式: "2026.07.04 00:53" → 把点换成横线
  const normalized = str.replace(/\./g, '-').replace(/\s+/g, 'T');
  d = new Date(normalized);
  if (!isNaN(d.getTime())) return d;
  // 如果都失败，用当前时间
  console.warn(`   ⚠️ 无法解析日期: "${str}", 使用当前时间`);
  return new Date();
}

// ============================================================
//  工具函数
// ============================================================

/** 读取已同步记录，防止重复导入 */
function loadSyncLog() {
  try {
    if (fs.existsSync(SYNC_LOG)) {
      return JSON.parse(fs.readFileSync(SYNC_LOG, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

/** 保存同步记录 */
function saveSyncLog(log) {
  fs.writeFileSync(SYNC_LOG, JSON.stringify(log, null, 2), 'utf-8');
}

/** 生成文章唯一标识（URL 的 MD5） */
function makeId(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
}

/** 生成 Hexo 兼容的文件名 */
function slugify(title) {
  return title
    .replace(/[【】《》？?！!，,。.：:；;、""''（）()\[\]{}]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[\/\\:*?"<>|]/g, '')
    .slice(0, 50)
    || 'untitled';
}

/** 写入 Hexo Markdown 文件 */
function writePost(post) {
  const date = new Date(post.date);
  const dateStr = date.toISOString().split('T')[0];      // 2026-07-04
  const timeStr = date.toTimeString().split(' ')[0];     // 10:30:00
  const fileName = `${dateStr}-${slugify(post.title)}.md`;
  const filePath = path.join(POSTS_DIR, fileName);

  const frontMatter = [
    '---',
    `title: ${JSON.stringify(post.title)}`,
    `date: ${dateStr} ${timeStr}`,
    `updated: ${dateStr} ${timeStr}`,
    `categories:`,
    `  - ${post.source}`,
    `tags:`,
    ...(post.tags || []).map(t => `  - ${t}`),
    `source_url: ${post.url}`,
    `source_name: ${post.sourceName}`,
    `---`,
  ].join('\n');

  const content = `${frontMatter}\n\n> 本文自动同步自 [${post.sourceName}](${post.url})\n\n${post.content}`;

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`  ✅ 已写入: ${fileName}`);
  return filePath;
}

// ============================================================
//  博客园：通过 RSS 抓取
// ============================================================
async function fetchCnblogs(config) {
  const parser = new RssParser();
  const url = encodeUrl(config.rss);
  console.log(`📡 正在拉取 ${config.name} RSS: ${url}`);

  const feed = await parser.parseURL(url);
  console.log(`   获取到 ${feed.items.length} 篇文章`);

  return feed.items.map(item => ({
    title: item.title,
    url: item.link,
    date: item.pubDate || item.isoDate || new Date().toISOString(),
    content: item['content:encoded'] || item.content || item.summary || '',
    source: 'cnblogs',
    sourceName: config.name,
    tags: (item.categories || []).slice(0, 5),
  }));
}

// ============================================================
//  简书：爬取用户主页文章列表
// ============================================================
async function fetchJianshu(config) {
  console.log(`📡 正在拉取 ${config.name}: ${config.homeUrl}`);

  const posts = [];
  let page = 1;
  const maxPages = 5; // 最多拉 5 页

  while (page <= maxPages) {
    const url = `${config.homeUrl}?order_by=shared_at&page=${page}`;
    console.log(`   抓取第 ${page} 页...`);

    try {
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: 10000,
      });

      const $ = cheerio.load(data);
      const items = $('.note-list li, .note-list .content');

      if (items.length === 0) break;

      items.each((_, el) => {
        const $el = $(el);
        const $title = $el.find('.title, a.title');
        const title = $title.text().trim();
        const href = $title.attr('href');
        const $time = $el.find('.time');
        const dateStr = $time.attr('data-shared-at') || $time.text().trim();

        if (title && href) {
          const fullUrl = href.startsWith('http') ? href : `https://www.jianshu.com${href}`;
          posts.push({
            title,
            url: fullUrl,
            date: parseDate(dateStr).toISOString(),
            content: '', // 简书 RSS 不提供全文，留空引导读者跳转
            source: 'jianshu',
            sourceName: config.name,
            tags: [],
          });
        }
      });

      page++;
      // 礼貌等待，避免被限流
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`   ⚠️ 第 ${page} 页抓取失败: ${err.message}`);
      break;
    }
  }

  console.log(`   获取到 ${posts.length} 篇文章`);
  return posts;
}

// ============================================================
//  主流程
// ============================================================
async function main() {
  console.log('🚀 开始同步外部文章...\n');

  // 确保目录存在
  if (!fs.existsSync(POSTS_DIR)) {
    fs.mkdirSync(POSTS_DIR, { recursive: true });
  }

  const syncLog = loadSyncLog();
  let newCount = 0;

  // ---- 博客园 ----
  if (SOURCES.cnblogs.enabled) {
    try {
      const posts = await fetchCnblogs(SOURCES.cnblogs);
      for (const post of posts) {
        const id = makeId(post.url);
        if (syncLog[id]) {
          console.log(`  ⏭ 跳过（已同步）: ${post.title}`);
          continue;
        }
        writePost(post);
        syncLog[id] = { title: post.title, url: post.url, date: post.date };
        newCount++;
      }
    } catch (err) {
      console.error(`❌ 博客园拉取失败: ${err.message}`);
    }
  }

  // ---- 简书 ----
  if (SOURCES.jianshu.enabled) {
    try {
      const posts = await fetchJianshu(SOURCES.jianshu);
      for (const post of posts) {
        const id = makeId(post.url);
        if (syncLog[id]) {
          console.log(`  ⏭ 跳过（已同步）: ${post.title}`);
          continue;
        }
        // 简书只有标题和链接，正文需手动写或从原文获取
        post.content = `> 本文转载自简书，[点击阅读原文](${post.url})`;
        writePost(post);
        syncLog[id] = { title: post.title, url: post.url, date: post.date };
        newCount++;
      }
    } catch (err) {
      console.error(`❌ 简书拉取失败: ${err.message}`);
    }
  }

  // 保存同步记录
  saveSyncLog(syncLog);

  console.log(`\n🎉 同步完成！新增 ${newCount} 篇文章。`);
}

main().catch(err => {
  console.error('同步失败:', err);
  process.exit(1);
});
