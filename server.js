const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load .env from workspace root (API keys)
try {
  const envPath = path.join(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && key.trim() && !key.startsWith('#')) {
      process.env[key.trim()] = val.join('=').trim();
    }
  });
} catch(e) { /* no .env */ }

const PORT = 3098;

// ===== CACHED PRICES (refresh every 60s, avoid rate limits) =====
let cachedPrices = { SOL: 0, USDC: 1, USDT: 1, USD1: 1 };
let priceReady = false;

function refreshPrices() {
  const cgUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin,tether&vs_currencies=usd';
  https.get(cgUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'Ciego/1.0' } }, (cgRes) => {
    let data = '';
    cgRes.on('data', c => data += c);
    cgRes.on('end', () => {
      try {
        const j = JSON.parse(data);
        if (j.solana?.usd) {
          cachedPrices = {
            SOL: j.solana.usd,
            USDC: j['usd-coin']?.usd || 1,
            USDT: j.tether?.usd || 1,
            USD1: 1
          };
          priceReady = true;
          console.log('[Prices] Updated:', JSON.stringify(cachedPrices));
        } else {
          console.log('[Prices] No SOL price in response (status ' + cgRes.statusCode + '), retrying in 10s...');
          if (!priceReady) setTimeout(refreshPrices, 10000);
        }
      } catch(e) {
        console.log('[Prices] Parse error:', e.message, '— retrying in 10s...');
        if (!priceReady) setTimeout(refreshPrices, 10000);
      }
    });
  }).on('error', (e) => {
    console.log('[Prices] Fetch error:', e.message, '— retrying in 10s...');
    if (!priceReady) setTimeout(refreshPrices, 10000);
  });
}

// Fetch on startup with retry, then every 60s
setTimeout(refreshPrices, 1000); // slight delay to avoid immediate rate limit
setInterval(refreshPrices, 60000);

// RPC endpoints to rotate through
const RPC_ENDPOINTS = [
  'https://rpc.ankr.com/solana',
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
  'https://solana.public-rpc.com',
  'https://solana-rpc.publicnode.com',
  'https://mainnet.helius-rpc.com/?api-key=1d8740dc-e5f4-421c-b823-e1bad1889eff',
];
let currentRpcIndex = 0;

function getNextRpc() {
  const rpc = RPC_ENDPOINTS[currentRpcIndex];
  currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
  return rpc;
}

// Forward JSON-RPC to Solana with rotation + retry
async function proxyRpc(body) {
  const maxAttempts = RPC_ENDPOINTS.length;
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    const endpoint = getNextRpc();
    try {
      const result = await fetchPost(endpoint, body);
      return result;
    } catch (err) {
      console.warn(`RPC ${endpoint} failed: ${err.message}`);
      lastErr = err;
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr || new Error('All RPCs failed');
}

function fetchPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(endpoint);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// === SECURITY: Rate limiting ===
const rateMap = new Map();
const RATE_LIMIT = 30; // max requests per window
const RATE_WINDOW = 60000; // 1 minute

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateMap) {
    if (now - entry.start > RATE_WINDOW) rateMap.delete(ip);
  }
}, 300000);

const server = http.createServer(async (req, res) => {
  // === SECURITY: Block path traversal at entry point ===
  const rawUrl = decodeURIComponent(req.url);
  if (rawUrl.includes('..') || rawUrl.includes('\0')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // Rate limit API proxy endpoints
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const parsedPath = url.parse(req.url).pathname;
  if (parsedPath.startsWith('/transactions/') || parsedPath.startsWith('/exchange/') || parsedPath === '/rpc') {
    if (isRateLimited(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests. Try again later.' }));
      return;
    }
  }

  // CORS — restrict to same origin for HTML, allow * only for API proxy endpoints
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Remove any X-Frame-Options so it works in both iframe and standalone
  res.removeHeader('X-Frame-Options');
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // CSP — allow wallet extensions + CDN scripts but restrict connect-src
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://bundle.run https://unpkg.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://bundle.run https://unpkg.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self' https://*.solana.com https://*.helius-rpc.com https://*.coingecko.com https://*.jup.ag https://cdn.jsdelivr.net https://cdn.isdelivr.net https://bundle.run https://unpkg.com wss://*.solana.com https://*.solana-mainnet.quiknode.pro wss://*.solana-mainnet.quiknode.pro; img-src 'self' data: blob:;");

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // RPC proxy endpoint
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const result = await proxyRpc(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result);
      } catch (err) {
        console.error('RPC proxy error:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  // Price API proxy (CoinGecko free)
  const parsedUrl = url.parse(req.url);
  if (parsedUrl.pathname === '/api/prices') {
    // Return cached prices (updated in background)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(cachedPrices));
    return;
  }

  // Bridge proxy (no CORS on their API)
  if (parsedUrl.pathname.startsWith('/bridge-ext/')) {
    const bridgePath = parsedUrl.pathname.replace('/bridge-ext', '');
    const query = parsedUrl.search || '';

    if (req.method === 'GET') {
      const opts = {
        hostname: 'exolix.com',
        path: `/api/v2${bridgePath}${query}`,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 15000,
      };
      const proxy = https.request(opts, (pRes) => {
        let data = '';
        pRes.on('data', c => data += c);
        pRes.on('end', () => {
          res.writeHead(pRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(data);
        });
      });
      proxy.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      proxy.end();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const opts = {
          hostname: 'exolix.com',
          path: `/api/v2${bridgePath}${query}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 15000,
        };
        const proxy = https.request(opts, (pRes) => {
          let data = '';
          pRes.on('data', c => data += c);
          pRes.on('end', () => {
            res.writeHead(pRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        proxy.on('error', (e) => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        proxy.write(body);
        proxy.end();
      });
      return;
    }

    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return;
    }
  }

  // Swap API proxy
  if (parsedUrl.pathname.startsWith('/swap/')) {
    const jupPath = parsedUrl.pathname.replace('/swap', '');
    const query = parsedUrl.search || '';

    if (req.method === 'GET') {
      const opts = {
        hostname: 'public.jupiterapi.com',
        path: `${jupPath}${query}`,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 15000,
      };
      const proxy = https.request(opts, (pRes) => {
        let data = '';
        pRes.on('data', c => data += c);
        pRes.on('end', () => {
          res.writeHead(pRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(data);
        });
      });
      proxy.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      proxy.end();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const opts = {
          hostname: 'public.jupiterapi.com',
          path: `${jupPath}${query}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 15000,
        };
        const proxy = https.request(opts, (pRes) => {
          let data = '';
          pRes.on('data', c => data += c);
          pRes.on('end', () => {
            res.writeHead(pRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        proxy.on('error', (e) => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        proxy.write(body);
        proxy.end();
      });
      return;
    }
  }

  // Bridge proxy (API key stays server-side)
  if (parsedUrl.pathname.startsWith('/bridge/')) {
    const cnPath = parsedUrl.pathname.replace('/bridge', '');
    const CN_KEY = process.env.CHANGENOW_API_KEY || '';
    const query = parsedUrl.search || '';

    if (req.method === 'GET') {
      // Status check: /transactions/{id}/status → /v1/transactions/{id}/{apiKey}
      let finalPath;
      const statusMatch = cnPath.match(/^\/transactions\/([^/]+)\/bridge-status$/);
      if (statusMatch) {
        finalPath = `/v1/transactions/${statusMatch[1]}/${CN_KEY}`;
      } else {
        const sep = query ? '&' : '?';
        finalPath = `/v1${cnPath}${query}${sep}api_key=${CN_KEY}`;
      }
      const opts = {
        hostname: 'api.changenow.io',
        path: finalPath,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 20000,
      };
      const proxy = https.request(opts, (pRes) => {
        let data = '';
        pRes.on('data', c => data += c);
        pRes.on('end', () => {
          res.writeHead(pRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(data);
        });
      });
      proxy.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      proxy.end();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const opts = {
          hostname: 'api.changenow.io',
          path: `/v1/transactions/${CN_KEY}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 20000,
        };
        const proxy = https.request(opts, (pRes) => {
          let data = '';
          pRes.on('data', c => data += c);
          pRes.on('end', () => {
            res.writeHead(pRes.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(data);
          });
        });
        proxy.on('error', (e) => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        proxy.write(body);
        proxy.end();
      });
      return;
    }
  }

  // Jito proxy endpoint
  if (req.method === 'POST' && (parsedUrl.pathname === '/jito/bundles' || parsedUrl.pathname === '/jito/transactions' || parsedUrl.pathname.startsWith('/jito/'))) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const jitoBase = 'https://mainnet.block-engine.jito.wtf/api/v1';
        const jitoPath = parsedUrl.pathname === '/jito/bundles' ? '/bundles' : '/transactions';
        const query = parsedUrl.search || '';
        const result = await fetchPost(jitoBase + jitoPath + query, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result);
      } catch (err) {
        console.error('Jito proxy error:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  // Static file serving
  let filePath = req.url === '/' ? '/index.html' : url.parse(req.url).pathname;

  // === SECURITY: Decode + normalize to catch encoded traversal ===
  filePath = decodeURIComponent(filePath);
  // Strip any null bytes, double dots patterns
  filePath = filePath.replace(/\0/g, '').replace(/\.\.\./g, '');

  // === SECURITY: Block sensitive files ===
  const blocked = ['.env', '.git', '.bak', '.log', '.sh', '.gitignore', 'server.js', 'changenow-bridge.js', 'package.json', 'package-lock.json', 'node_modules'];
  const lowerPath = filePath.toLowerCase();
  if (blocked.some(b => lowerPath.includes(b))) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // === SECURITY: Block dotfiles and hidden files ===
  const segments = filePath.split('/').filter(Boolean);
  if (segments.some(s => s.startsWith('.'))) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  filePath = path.join(__dirname, filePath);

  // === SECURITY: Path traversal protection ===
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(__dirname))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    // SPA fallback
    if (ext === '' || ext === '.html') {
      try {
        const index = fs.readFileSync(path.join(__dirname, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(index);
      } catch (e2) {
        res.writeHead(404);
        res.end('Not found');
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Ciego server running on http://127.0.0.1:${PORT}`);
});
