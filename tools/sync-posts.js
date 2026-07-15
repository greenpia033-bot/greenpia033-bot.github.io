/**
 * sync-posts.js — 从博客园和简书自动拉取文章到 Hexo
 *
 * 博客园：RSS 获取文章列表 → 逐篇抓取全文（#cnblogs_post_body）
 * 简书：  爬取用户主页文章列表 → 逐篇抓取文章页正文
 *
 * 去重：通过 frontmatter 中的 cnblogs_url / jianshu_url 匹配已有文件
 * 更新：已有文章如果正文为空或与原文不一致，自动更新为全文
 *
 * 用法：node tools/sync-posts.js
 * GitHub Actions 每天 UTC 20:00（北京时间次日 04:00）自动执行
 */

const fs = require('fs');
const path = require('path');

// ============================================================
//  ⚙️ 配置
// ============================================================
const SOURCES = {
  cnblogs: {
    enabled: true,
    name: '博客园',
    rss: 'https://feed.cnblogs.com/blog/u/871804/rss/',
    username: 'greenpia',
  },
  jianshu: {
    enabled: false,
    name: '简书',
    homeUrl: 'https://www.jianshu.com/u/afd28858c582',
  },
};

const POSTS_DIR = path.join(__dirname, '..', 'source', '_posts');
const USER_AGENT = 'Hexo-Blog-Sync/1.0';
const REQUEST_DELAY = 800;

// ============================================================
//  工具函数
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) return await res.text();
      console.warn(`  ⚠ HTTP ${res.status} (第 ${i + 1}/${retries} 次)`);
    } catch (e) {
      console.warn(`  ⚠ 请求失败: ${e.message} (第 ${i + 1}/${retries} 次)`);
    }
    if (i < retries - 1) await sleep(1000 * (i + 1));
  }
  return null;
}

function extractXmlTag(xml, tag) {
  const regex = new RegExp(
    `<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*<\\/${tag}>`,
    'i'
  );
  const m = xml.match(regex);
  return m ? (m[1] || m[2] || '').trim() : '';
}

function extractXmlAttr(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*${attr}\\s*=\\s*"([^"]*)"[^>]*/?>`, 'i');
  const m = xml.match(regex);
  return m ? m[1] : '';
}

function parseAtomFeed(xml) {
  const items = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const entry = m[1];
    const title = extractXmlTag(entry, 'title');
    let link = extractXmlAttr(entry, 'link', 'href') || extractXmlTag(entry, 'id');
    const pubDate = extractXmlTag(entry, 'published') || extractXmlTag(entry, 'updated');
    const summary = extractXmlTag(entry, 'summary');
    const content = extractXmlTag(entry, 'content') || summary;
    const categories = [];
    const catRe = /<category[^>]*term\s*=\s*"([^"]*)"[^>]*\/?>/g;
    let cm;
    while ((cm = catRe.exec(entry)) !== null) categories.push(cm[1]);
    if (title && link) items.push({ title, link, pubDate, content, categories });
  }
  return items;
}

function parseRssFeed(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const item = m[1];
    const title = extractXmlTag(item, 'title');
    const link = extractXmlTag(item, 'link');
    const pubDate = extractXmlTag(item, 'pubDate');
    const description = extractXmlTag(item, 'description');
    const contentEncoded = extractXmlTag(item, 'content:encoded') || description;
    const categories = [];
    const catRe = /<category>([\s\S]*?)<\/category>/g;
    let cm;
    while ((cm = catRe.exec(item)) !== null) categories.push(cm[1].trim());
    if (title && link) items.push({ title, link, pubDate, content: contentEncoded, categories });
  }
  return items;
}

function parseFeed(xml) {
  if (xml.includes('<entry>')) return parseAtomFeed(xml);
  return parseRssFeed(xml);
}

function extractCnblogsPostId(url) {
  // 随笔: /p/123456  文章: /articles/123456
  const m = url.match(/\/(?:p|articles)\/(\d+)/);
  return m ? m[1] : null;
}

function extractJianshuPostId(url) {
  const m = url.match(/\/p\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

function slugify(title, maxLen = 50) {
  return title
    .replace(/[【】《》？?！!，,。.：:；、""''（）()\[\]{}]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen)
    || 'untitled';
}

function generateExcerpt(html, maxLen = 300) {
  let text = html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLen) {
    text = text.substring(0, maxLen - 3).replace(/\s+\S*$/, '') + '...';
  }
  return text;
}

function formatDate(dateStr) {
  if (!dateStr) return new Date().toISOString().replace('T', ' ').substring(0, 19);
  // 处理 HTML 实体和超长小数秒
  const cleaned = dateStr.replace(/&#x2B;/gi, '+').replace(/\.(\d{3})\d+/, '.$1');
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return new Date().toISOString().replace('T', ' ').substring(0, 19);
  // 转换为本地时间字符串（东八区）
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().replace('T', ' ').substring(0, 19);
}
function extractLocalDate(dateStr) {
  // 从带时区的日期字符串直接提取本地日期部分
  if (!dateStr) return new Date().toISOString().split('T')[0];
  const cleaned = dateStr.replace(/&#x2B;/gi, '+');
  const m = cleaned.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().split('T')[0];
}

// ============================================================
//  去重
// ============================================================

function findPostByCnblogsUrl(postId) {
  if (!fs.existsSync(POSTS_DIR)) return null;
  const editUrlPosts = `https://i.cnblogs.com/posts/edit;postId=${postId}`;
  const editUrlArticles = `https://i.cnblogs.com/articles/edit;postId=${postId}`;
  const essayUrl = `https://www.cnblogs.com/${SOURCES.cnblogs.username}/p/${postId}`;
  const articleUrl = `https://www.cnblogs.com/${SOURCES.cnblogs.username}/articles/${postId}`;

  for (const f of fs.readdirSync(POSTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const filepath = path.join(POSTS_DIR, f);
    const content = fs.readFileSync(filepath, 'utf-8');
    if (content.includes(editUrlPosts) || content.includes(editUrlArticles) || content.includes(essayUrl) || content.includes(articleUrl)) {
      return { filename: f, filepath, content };
    }
  }
  return null;
}


function extractJianshuUserId(homeUrl) {
  const m = homeUrl.match(/\/u\/([a-f0-9]+)/i);
  return m ? m[1] : null;
}

function findPostByJianshuUrl(postId) {
  if (!fs.existsSync(POSTS_DIR)) return null;
  const url = `https://www.jianshu.com/p/${postId}`;

  for (const f of fs.readdirSync(POSTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const filepath = path.join(POSTS_DIR, f);
    const content = fs.readFileSync(filepath, 'utf-8');
    if (content.includes(url)) {
      return { filename: f, filepath, content };
    }
  }
  return null;
}

function hasFullContent(postContent) {
  if (postContent.includes('[阅读原文]') || postContent.includes('点击阅读原文')) return false;
  if (postContent.includes('<!-- more -->')) return true;
  const parts = postContent.split('---');
  const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : postContent.trim();
  return body.length > 200;
}

// ============================================================
//  博客园
// ============================================================

function extractCnblogsBody(html) {
  const startMatch = html.match(/<div[^>]*id="cnblogs_post_body"[^>]*>/);
  if (!startMatch) return null;

  const startIdx = startMatch.index + startMatch[0].length;
  const rest = html.substring(startIdx);
  const endMatch = rest.match(/<div[^>]*id="blog_post_info_block"[^>]*>/);
  const endIdx = endMatch ? startIdx + endMatch.index : html.length;

  let content = html.substring(startIdx, endIdx);

  content = content.replace(
    /(?:\s*<\/div>\s*|\s*<div[^>]*class="clear"[^>]*><\/div>\s*)+$/,
    ''
  );

  content = content.replace(
    /(src|href)="(\/[^"]+)"/g,
    (_, attr, rel) => rel.startsWith('//')
      ? `${attr}="https:${rel}"`
      : `${attr}="https://www.cnblogs.com${rel}"`
  );

  return content.trim() || null;
}

async function syncCnblogs() {
  console.log('════ 博客园同步 ════\n');

  console.log(`📡 获取 RSS: ${SOURCES.cnblogs.rss}`);
  const rssXml = await fetchWithRetry(SOURCES.cnblogs.rss);
  if (!rssXml) {
    console.error('❌ 无法获取博客园 RSS');
    return { created: 0, updated: 0, skipped: 0 };
  }

  const items = parseFeed(rssXml);
  console.log(`📋 RSS 中有 ${items.length} 篇文章\n`);

  let created = 0, updated = 0, skipped = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const progress = `[${i + 1}/${items.length}]`;
    console.log(`${progress} ${item.title}`);

    const postId = extractCnblogsPostId(item.link);
    if (!postId) {
      console.log(`       ⚠ 无法提取 postId，跳过\n`);
      skipped++;
      continue;
    }

    const existing = findPostByCnblogsUrl(postId);

    if (existing && hasFullContent(existing.content)) {
      console.log(`       ⏭ 已有全文，跳过\n`);
      skipped++;
      continue;
    }

    console.log(`       ⬇ 抓取全文: ${item.link}`);
    const pageHtml = await fetchWithRetry(item.link);
    let body = null;
    if (pageHtml) {
      body = extractCnblogsBody(pageHtml);
      if (body) {
        console.log(`       ✓ 正文提取成功 (${body.length} 字符)`);
      } else {
        console.log(`       ⚠ 无法提取正文`);
      }
    }

    const postContent = buildCnblogsPost(item, body, postId);

    let targetPath;
    if (existing) {
      targetPath = existing.filepath;
      updated++;
      console.log(`       ✏ 更新已有文章`);
    } else {
      const dateStr = new Date(item.pubDate).toISOString().split('T')[0];
      const filename = `${dateStr}-${slugify(item.title)}.md`;
      targetPath = path.join(POSTS_DIR, filename);
      created++;
      console.log(`       ✨ 新文章`);
    }

    fs.writeFileSync(targetPath, postContent, 'utf-8');
    console.log('');

    await sleep(REQUEST_DELAY);
  }

  console.log(`✅ 博客园: 新增 ${created}, 更新 ${updated}, 跳过 ${skipped}\n`);
  return { created, updated, skipped };
}

function buildCnblogsPost(item, body, postId) {
  const allLabels = item.categories || [];
  const tags = allLabels.filter(l => !l.includes('/'));
  const categories = allLabels
    .filter(l => l.includes('/'))
    .map(l => l.split('/').map(s => s.trim()).filter(Boolean));

  const tagsYaml = tags.length > 0
    ? `tags:\n${tags.map(t => `  - ${t}`).join('\n')}`
    : 'tags: []';

  let categoriesYaml = '';
  if (categories.length > 0) {
    categoriesYaml = '\ncategories:\n'
      + categories.map(parts => parts.map(p => `  - ${p}`).join('\n')).join('\n');
  }

  const dateStr = formatDate(item.pubDate);
  const cnblogsUrl = item.link;

  let bodyContent;
  if (body) {
    const excerpt = generateExcerpt(body);
    bodyContent = `${excerpt}\n<!-- more -->\n\n${body}`;
  } else {
    const desc = item.content || '';
    const excerpt = generateExcerpt(desc);
    bodyContent = `${excerpt}\n<!-- more -->\n\n> 原文地址: [${item.title}](${item.link})`;
    console.log(`       ⚠ 使用 RSS 摘要作为正文`);
  }

  return `---
title: ${item.title}
${tagsYaml}${categoriesYaml}
date: ${dateStr}
cnblogs_url: ${cnblogsUrl}
---

${bodyContent}
`;
}

// ============================================================
//  简书
// ============================================================

function extractJianshuBody(html) {
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
  if (articleMatch) return articleMatch[1].trim();

  const contentMatch = html.match(
    /<div[^>]*class="[^"]*show-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div|$)/
  );
  if (contentMatch) return contentMatch[1].trim();

  return null;
}

function extractJianshuMeta(html) {
  const titleMatch = html.match(/<title>(.*?)(?:\s*-\s*简书)?\s*<\/title>/);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

  let dateStr = '';
  const dateMatch = html.match(/"datePublished":\s*"([^"]+)"/)
    || html.match(/<time[^>]*datetime="([^"]+)"/)
    || html.match(/<span[^>]*class="[^"]*publish-time[^"]*"[^>]*>([^<]+)<\/span>/);
  if (dateMatch) dateStr = dateMatch[1].trim();
  if (dateStr.includes('.')) {
    dateStr = dateStr.replace(/\./g, '-').replace(/\s+/, 'T');
  }

  return { title, pubDate: dateStr };
}

async function fetchJianshuList() {
  const posts = [];
  const seen = new Set(); // 跨页去重
  let page = 1;
  const maxPages = 5;

  while (page <= maxPages) {
    const url = `${SOURCES.jianshu.homeUrl}?order_by=shared_at&page=${page}`;
    console.log(`   第 ${page} 页...`);

    const html = await fetchWithRetry(url);
    if (!html) break;

    const itemRe = /<a[^>]*class="[^"]*title[^"]*"[^>]*href="(\/p\/[a-f0-9]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    let foundOnPage = 0;

    while ((m = itemRe.exec(html)) !== null) {
      const href = m[1];
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (title && !seen.has(href)) {
        seen.add(href);
        posts.push({ title, url: `https://www.jianshu.com${href}`, date: '' });
        foundOnPage++;
      }
    }

    console.log(`       找到 ${foundOnPage} 篇`);
    if (foundOnPage === 0) break;

    page++;
    await sleep(2000);
  }

  return posts;
}

async function syncJianshu() {
  console.log('════ 简书同步 ════\n');

  console.log(`📡 获取文章列表: ${SOURCES.jianshu.homeUrl}`);
  const listItems = await fetchJianshuList();
  console.log(`📋 共找到 ${listItems.length} 篇文章\n`);

  if (listItems.length === 0) {
    console.log('⚠ 未找到文章，简书页面结构可能已变更\n');
    return { created: 0, updated: 0, skipped: 0 };
  }

  let created = 0, updated = 0, skipped = 0;

  for (let i = 0; i < listItems.length; i++) {
    const item = listItems[i];
    const progress = `[${i + 1}/${listItems.length}]`;
    console.log(`${progress} ${item.title}`);

    const postId = extractJianshuPostId(item.url);
    if (!postId) {
      console.log(`       ⚠ 无法提取 postId\n`);
      skipped++;
      continue;
    }

    const existing = findPostByJianshuUrl(postId);
    if (existing && hasFullContent(existing.content)) {
      console.log(`       ⏭ 已有全文，跳过\n`);
      skipped++;
      continue;
    }

    console.log(`       ⬇ 抓取全文: ${item.url}`);
    const pageHtml = await fetchWithRetry(item.url);
    // 校验作者是否是本人
    if (pageHtml) {
      const myUserId = extractJianshuUserId(SOURCES.jianshu.homeUrl);
      const authorMatch = pageHtml.match(/\/u\/([a-f0-9]+)/);
      if (myUserId && authorMatch && authorMatch[1] !== myUserId) {
        console.log(`       ⏭ 非本人文章 (作者: ${authorMatch[1]})，跳过\n`);
        skipped++;
        continue;
      }
    }
    let body = null;
    let meta = { title: item.title, pubDate: item.date };

    if (pageHtml) {
      meta = { ...meta, ...extractJianshuMeta(pageHtml) };
      body = extractJianshuBody(pageHtml);
      if (body) {
        console.log(`       ✓ 正文提取成功 (${body.length} 字符)`);
      } else {
        console.log(`       ⚠ 无法提取正文，仅保留链接`);
      }
    }

    const postContent = buildJianshuPost(meta, body, item.url);

    let targetPath;
    if (existing) {
      targetPath = existing.filepath;
      updated++;
      console.log(`       ✏ 更新已有文章`);
    } else {
      const dateStr = meta.pubDate
        ? new Date(meta.pubDate).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];
      const filename = `${dateStr}-${slugify(meta.title)}.md`;
      targetPath = path.join(POSTS_DIR, filename);
      created++;
      console.log(`       ✨ 新文章`);
    }

    fs.writeFileSync(targetPath, postContent, 'utf-8');
    console.log('');

    await sleep(REQUEST_DELAY);
  }

  console.log(`✅ 简书: 新增 ${created}, 更新 ${updated}, 跳过 ${skipped}\n`);
  return { created, updated, skipped };
}

function buildJianshuPost(meta, body, url) {
  const dateStr = formatDate(meta.pubDate);

  let bodyContent;
  if (body) {
    const excerpt = generateExcerpt(body);
    bodyContent = `${excerpt}\n<!-- more -->\n\n${body}`;
  } else {
    bodyContent = `> 本文自动同步自 [简书](${url})，点击查看原文`;
  }

  return `---
title: ${meta.title}
tags: []
categories:
  - 简书
date: ${dateStr}
jianshu_url: ${url}
---

${bodyContent}
`;
}

// ============================================================
//  主流程
// ============================================================

async function main() {
  console.log('🚀 开始同步外部文章...\n');

  if (!fs.existsSync(POSTS_DIR)) {
    fs.mkdirSync(POSTS_DIR, { recursive: true });
  }

  const results = {};

  if (SOURCES.cnblogs.enabled) {
    try {
      results.cnblogs = await syncCnblogs();
    } catch (err) {
      console.error(`❌ 博客园同步失败: ${err.message}`);
      results.cnblogs = { created: 0, updated: 0, skipped: 0, error: err.message };
    }
  }

  if (SOURCES.jianshu.enabled) {
    try {
      results.jianshu = await syncJianshu();
    } catch (err) {
      console.error(`❌ 简书同步失败: ${err.message}`);
      results.jianshu = { created: 0, updated: 0, skipped: 0, error: err.message };
    }
  }

  const totalCreated = (results.cnblogs?.created || 0) + (results.jianshu?.created || 0);
  const totalUpdated = (results.cnblogs?.updated || 0) + (results.jianshu?.updated || 0);
  const totalSkipped = (results.cnblogs?.skipped || 0) + (results.jianshu?.skipped || 0);

  console.log('═══════════════════════════════════');
  console.log(`🎉 同步完成！`);
  console.log(`   新创建: ${totalCreated}  更新: ${totalUpdated}  跳过: ${totalSkipped}`);
  console.log('═══════════════════════════════════');
}

main().catch(err => {
  console.error('同步失败:', err);
  process.exit(1);
});
