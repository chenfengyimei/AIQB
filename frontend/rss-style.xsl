<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" encoding="UTF-8" doctype-system="about:legacy-compat" />
  <xsl:template match="/">
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title><xsl:value-of select="rss/channel/title" /> · RSS 订阅</title>
        <style>
          :root{color-scheme:light dark;--bg:#f5f7fb;--card:#fff;--text:#101828;--muted:#667085;--line:#e4e7ec;--brand:#0b5cff;--tag:#edf4ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.wrap{width:min(920px,calc(100% - 32px));margin:auto}.hero{padding:42px 0 26px}.eyebrow{font-size:12px;color:var(--brand);font-weight:800;letter-spacing:.08em}.hero h1{font-size:clamp(28px,5vw,42px);line-height:1.22;margin:8px 0 12px}.hero p{color:var(--muted);margin:0;max-width:720px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}.btn{display:inline-flex;padding:9px 15px;border-radius:9px;background:var(--brand);color:#fff;text-decoration:none;font-weight:700}.btn.alt{color:var(--brand);background:var(--card);border:1px solid var(--line)}.notice{padding:12px 15px;border:1px solid #b2ccff;background:var(--tag);border-radius:11px;color:#175cd3;margin-bottom:18px}.list{display:grid;gap:12px;padding-bottom:50px}.item{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;text-decoration:none;color:inherit;box-shadow:0 5px 20px rgba(16,24,40,.04)}.item:hover{border-color:#84adff;transform:translateY(-1px)}.title{font-size:18px;line-height:1.45;font-weight:750}.meta{display:flex;gap:9px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin:7px 0}.desc{color:var(--muted);font-size:14px}.tag{background:var(--tag);color:var(--brand);padding:2px 8px;border-radius:999px}@media(prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#121834;--text:#e7ecf8;--muted:#a4afc8;--line:#27304f;--brand:#70a5ff;--tag:#182d56}.notice{border-color:#294d85;color:#9bc0ff}}
        </style>
      </head>
      <body>
        <main class="wrap">
          <section class="hero">
            <div class="eyebrow">AI圈报 · RSS FEED</div>
            <h1><xsl:value-of select="rss/channel/title" /></h1>
            <p><xsl:value-of select="rss/channel/description" /></p>
            <div class="actions"><a class="btn" href="/">返回 AI圈报</a><a class="btn alt" href="/feed.xml">打开标准 RSS XML</a></div>
          </section>
          <div class="notice">这是标准 RSS 订阅源。浏览器中会以阅读界面展示；RSS 阅读器仍可正常读取原始 XML 数据。</div>
          <section class="list">
            <xsl:for-each select="rss/channel/item">
              <a class="item" href="{link}">
                <div class="title"><xsl:value-of select="title" /></div>
                <div class="meta"><span class="tag"><xsl:value-of select="category" /></span><span><xsl:value-of select="pubDate" /></span></div>
                <div class="desc"><xsl:value-of select="description" /></div>
              </a>
            </xsl:for-each>
          </section>
        </main>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
