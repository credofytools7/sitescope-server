const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from any origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'SiteScope server running' });
});

// Main fetch endpoint
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

    // Hide puppeteer / automation fingerprints
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
      window.chrome = { runtime: {} };
    });

    // Realistic headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-GB,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
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

    // Block images/fonts/media to speed up but allow scripts (needed for CF challenge)
    await page.setRequestInterception(true);
    page.on('request', (interceptedReq) => {
      const type = interceptedReq.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        interceptedReq.abort();
      } else {
        interceptedReq.continue();
      }
    });

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // If Cloudflare challenge detected, wait for it to resolve
    const title = await page.title();
    if (
      title.toLowerCase().includes('just a moment') ||
      title.toLowerCase().includes('checking your browser') ||
      title.toLowerCase().includes('attention required')
    ) {
      console.log('Cloudflare challenge detected, waiting...');
      await new Promise(r => setTimeout(r, 8000));
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }

    // Extra wait for JS frameworks
    await new Promise(r => setTimeout(r, 2500));

    const html = await page.content();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (err) {
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`SiteScope server running on port ${PORT}`);
});
