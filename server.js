const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRODUCTS_PATH = path.join(PUBLIC_DIR, 'data', 'products.json');

const PRICE_CONFIG = {
  targetMargin: 0.48,
  processingFixed: 0.3,
  processingPct: 0.029,
  opsOverheadPct: 0.08,
  shippingBuffer: 3.5,
  roundingIncrement: 0.5
};

const mimeTypes = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

const products = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));

function roundUpToIncrement(value, inc) {
  return Math.ceil(value / inc) * inc;
}

function calculatePrice(baseCost) {
  const costWithOverhead = baseCost * (1 + PRICE_CONFIG.opsOverheadPct) + PRICE_CONFIG.shippingBuffer;
  const denominator = 1 - PRICE_CONFIG.targetMargin - PRICE_CONFIG.processingPct;
  const breakEvenWithMargin = (costWithOverhead + PRICE_CONFIG.processingFixed) / denominator;
  return roundUpToIncrement(Math.max(breakEvenWithMargin, baseCost + 1), PRICE_CONFIG.roundingIncrement);
}

function enrichProduct(product) {
  const hasExplicitPrice = Number.isFinite(product.price) && product.price > 0;
  const price = hasExplicitPrice ? product.price : calculatePrice(product.baseCost);
  const estimatedNet = price - (price * PRICE_CONFIG.processingPct + PRICE_CONFIG.processingFixed) - (product.baseCost * (1 + PRICE_CONFIG.opsOverheadPct) + PRICE_CONFIG.shippingBuffer);
  return {
    ...product,
    price,
    estimatedNet: Number(estimatedNet.toFixed(2))
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8') || '{}';
}

function getBaseUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto || 'http';
  return process.env.BASE_URL || `${proto}://${req.headers.host}`;
}

async function createStripeCheckoutSession(items, req) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return { demo: true, url: `${getBaseUrl(req)}/success.html?demo=1` };
  }

  const productMap = new Map(products.map((p) => [p.id, enrichProduct(p)]));
  const lineItems = items
    .map((item) => {
      const p = productMap.get(item.id);
      if (!p || !item.qty || item.qty < 1) return null;
      return {
        name: p.name,
        quantity: Number(item.qty),
        amount: Math.round(p.price * 100)
      };
    })
    .filter(Boolean);

  if (!lineItems.length) {
    throw new Error('No valid checkout items were provided.');
  }

  const baseUrl = getBaseUrl(req);
  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('success_url', `${baseUrl}/success.html`);
  form.append('cancel_url', `${baseUrl}/?cancelled=1`);

  lineItems.forEach((item, index) => {
    form.append(`line_items[${index}][quantity]`, String(item.quantity));
    form.append(`line_items[${index}][price_data][currency]`, 'usd');
    form.append(`line_items[${index}][price_data][unit_amount]`, String(item.amount));
    form.append(`line_items[${index}][price_data][product_data][name]`, item.name);
  });

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || 'Stripe checkout creation failed.';
    throw new Error(message);
  }
  return { demo: false, url: data.url };
}

async function handleApi(req, res, parsedUrl) {
  if (req.method === 'GET' && parsedUrl.pathname === '/api/products') {
    return sendJson(res, 200, {
      pricing: PRICE_CONFIG,
      products: products.map(enrichProduct)
    });
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/checkout') {
    try {
      const payload = JSON.parse(await readBody(req));
      const method = payload.method || 'stripe_card';
      const items = Array.isArray(payload.items) ? payload.items : [];

      if (method === 'stripe_card') {
        const session = await createStripeCheckoutSession(items, req);
        return sendJson(res, 200, {
          ok: true,
          method,
          checkoutUrl: session.url,
          demoMode: session.demo
        });
      }

      return sendJson(res, 200, {
        ok: true,
        method,
        message: method === 'bank_transfer'
          ? 'Bank transfer selected. A confirmation email workflow can be attached next.'
          : 'Cash on delivery selected. Order is captured and payable on arrival.'
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error.message });
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

function safeJoin(base, target) {
  const targetPath = '.' + path.normalize('/' + target);
  return path.join(base, targetPath);
}

function serveStatic(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  const filePath = safeJoin(PUBLIC_DIR, pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.pathname.startsWith('/api/')) {
    return handleApi(req, res, parsedUrl);
  }
  return serveStatic(req, res, parsedUrl);
});

server.listen(PORT, () => {
  console.log(`Ugandan handmade store running on http://localhost:${PORT}`);
});
