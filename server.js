const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.json({ status: 'SiteScope server running' });
});

/* ── SHARED FETCH HELPER ───────────────────────────── */
async function safeFetch(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    clearTimeout(timer);
    return r;
  } catch(e) {
    clearTimeout(timer);
    throw e;
  }
}

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
      Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
      window.chrome = { runtime: {} };
    });

    await page.setExtraHTTPHeaders({
      'Accept-Language':           'en-GB,en;q=0.9',
      'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding':           'gzip, deflate, br',
      'Cache-Control':             'no-cache',
      'Sec-Ch-Ua':                 '"Chromium";v="120", "Google Chrome";v="120", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile':          '?0',
      'Sec-Ch-Ua-Platform':        '"Windows"',
      'Sec-Fetch-Dest':            'document',
      'Sec-Fetch-Mode':            'navigate',
      'Sec-Fetch-Site':            'none',
      'Sec-Fetch-User':            '?1',
      'Upgrade-Insecure-Requests': '1',
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    let finalUrl = url;
    let redirected = false;
    page.on('response', response => {
      if ([301, 302, 303, 307, 308].includes(response.status())) redirected = true;
      if (response.url() !== url) finalUrl = response.url();
    });

    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (['image', 'font', 'media'].includes(r.resourceType())) r.abort();
      else r.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const title = await page.title();
    if (title.toLowerCase().includes('just a moment') ||
        title.toLowerCase().includes('checking your browser') ||
        title.toLowerCase().includes('attention required')) {
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
  const delay = ms => new Promise(r => setTimeout(r, ms));

  const byDomain = {};
  for (const url of links) {
    try {
      const domain = new URL(url).hostname;
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(url);
    } catch(e) {
      results[url] = { status: 'error', error: 'Invalid URL' };
    }
  }

  const checkUrl = async (url) => {
    try {
      const r = await safeFetch(url, 8000);
      return { status: r.status, redirected: r.redirected, finalUrl: r.url !== url ? r.url : null };
    } catch (e) {
      if (e.name === 'AbortError') return { status: 'timeout' };
      try {
        const r2 = await safeFetch(url, 8000);
        return { status: r2.status, redirected: r2.redirected, finalUrl: r2.url !== url ? r2.url : null };
      } catch (e2) {
        return { status: 'error', error: e2.message };
      }
    }
  };

  await Promise.all(Object.entries(byDomain).map(async ([domain, urls]) => {
    for (const url of urls) {
      results[url] = await checkUrl(url);
      if (urls.length > 3) await delay(200);
    }
  }));

  res.json(results);
});

/* ── 3. SITEMAP CHECK ──────────────────────────────── */
app.get('/sitemap', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const parsed = new URL(url);
    const base = `${parsed.protocol}//${parsed.hostname}`;

    // Step 1: Check robots.txt first — most reliable way to find sitemap URL
    let sitemapFromRobots = '';
    try {
      const robotsRes = await safeFetch(`${base}/robots.txt`, 8000);
      if (robotsRes.ok) {
        const robotsText = await robotsRes.text();
        const match = robotsText.match(/^Sitemap:\s*(.+)$/mi);
        if (match) sitemapFromRobots = match[1].trim();
      }
    } catch(e) {}

    // Step 2: Build candidates list — robots.txt URL first, then common paths
    const candidates = [];
    if (sitemapFromRobots) candidates.push(sitemapFromRobots);
    candidates.push(
      `${base}/sitemap.xml`,
      `${base}/sitemap_index.xml`,
      `${base}/sitemap`,
      `${base}/sitemap.php`,
      `${base}/wp-sitemap.xml`,
      `${base}/news-sitemap.xml`,
    );

    // Step 3: Try each candidate
    let sitemapContent = '';
    let foundAt = '';

    for (const su of candidates) {
      try {
        const r = await safeFetch(su, 8000);
        if (r.ok) {
          const text = await r.text();
          if (text.includes('<urlset') || text.includes('<sitemapindex') || text.includes('<sitemap>')) {
            sitemapContent = text;
            foundAt = su;
            break;
          }
        }
      } catch(e) { continue; }
    }

    if (!sitemapContent) {
      return res.json({ exists: false, urlCount: 0, pageInSitemap: false, sitemapUrl: '', robotsSitemap: sitemapFromRobots });
    }

    // Count URLs — handle both urlset and sitemapindex
    const locMatches = sitemapContent.match(/<loc>[^<]+<\/loc>/gi) || [];
    const urlCount = locMatches.length;

    // Check if this page is in sitemap
    const pagePath = parsed.href;
    const pageInSitemap = sitemapContent.includes(pagePath) ||
                          sitemapContent.includes(`${base}${parsed.pathname}`);

    res.json({ exists: true, urlCount, pageInSitemap, sitemapUrl: foundAt, robotsSitemap: sitemapFromRobots });

  } catch (e) {
    res.json({ exists: false, urlCount: 0, pageInSitemap: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`SiteScope server running on port ${PORT}`);
});
