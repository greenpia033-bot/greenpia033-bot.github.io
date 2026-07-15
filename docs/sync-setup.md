# 博客同步设置文档

## 概述

本博客通过 GitHub Actions 每天自动从外部平台拉取文章，生成 Hexo Markdown 文件并部署到 GitHub Pages。

- **博客地址**: https://greenpia033-bot.github.io/
- **同步时间**: 每天 UTC 20:00（北京时间次日凌晨 4:00）

---

## 同步源

### 博客园（已启用）

| 项目 | 值 |
|---|---|
| 用户名 | greenpia |
| RSS 地址 | `https://feed.cnblogs.com/blog/u/871804/rss/` |
| 同步方式 | RSS 获取文章列表 → 逐篇抓取全文（`#cnblogs_post_body`） |
| 支持内容 | 随笔（RSS 自动发现） |
| 不支持 | 文章区（无 RSS，无公开列表页） |

发文章：在 `i.cnblogs.com/posts` 写**随笔**，设为公开。标签自动带入 Hexo。

### 简书（已禁用）

简书页面加了阿里云验证码，无法程序化访问。

---

## 同步脚本

`tools/sync-posts.js`

- 博客园 RSS → 逐篇抓取全文 → 生成 `.md`
- 去重：frontmatter 中的 `cnblogs_url` 字段匹配已有文件
- 更新：已有文章缺全文时自动补全

---

## 本地测试

```bash
node tools/sync-posts.js
```
