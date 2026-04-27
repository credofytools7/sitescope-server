const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'SiteScope server running' });
});

/* ── 1. PAGE FETCH ─────────────────────────────────── */
app.get('/fetch', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid or missing url parameter' });
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      defaultViewport: { width: 1280, height: 800 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
      window.chrome = { runtime: {} };
    });

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-GB,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="120", "Google Chrome";v="120", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Track redirects
    let finalUrl = url;
    let redirected = false;
    page.on('response', response => {
      if ([301, 302, 303, 307, 308].includes(response.status())) {
        redirected = true;
      }
      if (response.url() !== url) finalUrl = response.url();
    });

    await page.setRequestInterception(true);
    page.on('request', (interceptedReq) => {
      const type = interceptedReq.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        interceptedReq.abort();
      } else {
        interceptedReq.continue();
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Handle Cloudflare challenge
    const title = await page.title();
    if (
      title.toLowerCase().includes('just a moment') ||
      title.toLowerCase().includes('checking your browser') ||
      title.toLowerCase().includes('attention required')
    ) {
      await new Promise(r => setTimeout(r, 8000));
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }

    await new Promise(r => setTimeout(r, 2500));
    const html = await page.content();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Final-Url', finalUrl);
    res.setHeader('X-Redirected', redirected ? 'true' : 'false');
    res.send(html);

  } catch (err) {
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

/* ── 2. LINK CHECKER ───────────────────────────────── */
app.post('/links', async (req, res) => {
  const { links } = req.body;
  if (!links || !Array.isArray(links)) {
    return res.status(400).json({ error: 'links array required' });
  }

  const results = {};

  // Check links in parallel batches of 8
  const batchSize = 8;
  for (let i = 0; i < links.length; i += batchSize) {
    const batch = links.slice(i, i + batchSize);
    await Promise.all(batch.map(async (url) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          }
        });
        clearTimeout(timeout);
        results[url] = {
          status: r.status,
          redirected: r.redirected,
          finalUrl: r.url !== url ? r.url : null,
        };
      } catch (e) {
        if (e.name === 'AbortError') {
          results[url] = { status: 'timeout' };
        } else {
          // Try GET if HEAD failed
          try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 8000);
            const r2 = await fetch(url, {
              method: 'GET',
              redirect: 'follow',
              signal: controller2.signal,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              }
            });
            clearTimeout(timeout2);
            results[url] = {
              status: r2.status,
              redirected: r2.redirected,
              finalUrl: r2.url !== url ? r2.url : null,
            };
          } catch (e2) {
            results[url] = { status: 'error', error: e2.message };
          }
        }
      }
    }));
  }

  res.json(results);
});

/* ── 3. ROBOTS.TXT CHECK ───────────────────────────── */
app.get('/robots', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const parsed = new URL(url);
    const robotsUrl = `${parsed.protocol}//${parsed.hostname}/robots.txt`;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const r = await fetch(robotsUrl, { signal: controller.signal });

    if (!r.ok) {
      return res.json({ exists: false, content: '', blocked: false, robotsUrl });
    }

    const content = await r.text();

    // Check if the path is disallowed for Googlebot or *
    const path = parsed.pathname;
    const lines = content.split('\n').map(l => l.trim());
    let currentAgent = null;
    let blocked = false;
    let sitemapUrl = '';

    for (const line of lines) {
      if (line.toLowerCase().startsWith('user-agent:')) {
        currentAgent = line.split(':')[1].trim().toLowerCase();
      } else if (line.toLowerCase().startsWith('disallow:') && (currentAgent === '*' || currentAgent === 'googlebot')) {
        const disallowedPath = line.split(':')[1].trim();
        if (disallowedPath && path.startsWith(disallowedPath)) {
          blocked = true;
        }
      } else if (line.toLowerCase().startsWith('sitemap:')) {
        sitemapUrl = line.split(':').slice(1).join(':').trim();
      }
    }

    res.json({ exists: true, content: content.substring(0, 3000), blocked, robotsUrl, sitemapUrl });

  } catch (e) {
    res.json({ exists: false, content: '', blocked: false, error: e.message });
  }
});

/* ── 4. SITEMAP CHECK ──────────────────────────────── */
app.get('/sitemap', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const parsed = new URL(url);
    const pagePath = parsed.href;

    // Try common sitemap locations
    const sitemapUrls = [
      `${parsed.protocol}//${parsed.hostname}/sitemap.xml`,
      `${parsed.protocol}//${parsed.hostname}/sitemap_index.xml`,
      `${parsed.protocol}//${parsed.hostname}/sitemap`,
    ];

    let sitemapContent = '';
    let foundAt = '';

    for (const su of sitemapUrls) {
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 8000);
        const r = await fetch(su, { signal: controller.signal });
        if (r.ok) {
          const text = await r.text();
          if (text.includes('<urlset') || text.includes('<sitemapindex')) {
            sitemapContent = text;
            foundAt = su;
            break;
          }
        }
      } catch (e) {}
    }

    if (!sitemapContent) {
      return res.json({ exists: false, urlCount: 0, pageInSitemap: false, sitemapUrl: '' });
    }

    // Count URLs
    const urlMatches = sitemapContent.match(/<loc>/g) || [];
    const urlCount = urlMatches.length;

    // Check if current page is in sitemap
    const pageInSitemap = sitemapContent.includes(pagePath) ||
                          sitemapContent.includes(parsed.protocol + '//' + parsed.hostname + parsed.pathname);

    res.json({ exists: true, urlCount, pageInSitemap, sitemapUrl: foundAt });

  } catch (e) {
    res.json({ exists: false, urlCount: 0, pageInSitemap: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`SiteScope server running on port ${PORT}`);
});
