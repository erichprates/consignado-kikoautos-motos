const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = '1.0.0';

// Boot check — avisa se as envs do RVops estiverem ausentes.
['RVOPS_CLIENT_ID', 'RVOPS_API_KEY', 'RVOPS_LP_ORIGEM'].forEach(k => {
  if (!process.env[k]) console.warn(`[boot] env ${k} ausente — POST /api/lead-consignacao falhará até configurar.`);
});

app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));

// Cache forte pra estáticos — precisa rodar ANTES do express.static.
app.use((req, res, next) => {
  if (req.path.startsWith('/assets/') || /\.(webp|svg)$/.test(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

app.use('/assets', express.static(path.join(__dirname, 'assets')));

// ---------- /api/health ----------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    node_version: process.version,
    app_version: APP_VERSION
  });
});

// ---------- POST /api/lead-consignacao ----------
app.post('/api/lead-consignacao', async (req, res) => {
  const body = req.body || {};

  // Honeypot — bot preenchendo. 200 silencioso.
  if (body.website && String(body.website).trim().length > 0) {
    return res.status(200).json({ ok: true });
  }

  const trim = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

  const firstname = trim(body.firstname, 100);
  const email = trim(body.email, 200).toLowerCase();
  const phoneRaw = trim(body.phone, 30).replace(/\D/g, '');
  const marca = trim(body.marca, 60);
  const modelo = trim(body.modelo, 80);
  const anoStr = trim(body.ano, 8);
  const kmStr = trim(body.quilometragem, 10);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const yearNow = new Date().getFullYear();
  const anoInt = parseInt(anoStr, 10);
  const kmInt = parseInt(kmStr, 10);

  const errors = [];
  if (!firstname) errors.push('firstname');
  if (!EMAIL_RE.test(email)) errors.push('email');
  if (phoneRaw.length < 10 || phoneRaw.length > 11) errors.push('phone');
  if (!marca) errors.push('marca');
  if (!modelo) errors.push('modelo');
  if (Number.isNaN(anoInt) || anoInt < 1990 || anoInt > yearNow) errors.push('ano');
  if (Number.isNaN(kmInt) || kmInt < 0 || kmInt > 999999) errors.push('quilometragem');

  if (errors.length) {
    return res.status(400).json({ ok: false, error: 'invalid_fields', fields: errors });
  }

  // Phone com prefixo 55 (RVops espera o telefone normalizado em E.164-ish).
  const phoneNormalized = phoneRaw.startsWith('55') ? phoneRaw : ('55' + phoneRaw);

  const { RVOPS_CLIENT_ID, RVOPS_API_KEY, RVOPS_LP_ORIGEM } = process.env;
  if (!RVOPS_CLIENT_ID || !RVOPS_API_KEY || !RVOPS_LP_ORIGEM) {
    console.error('[lead-consignacao] config faltando — checa env vars.');
    return res.status(502).json({ ok: false, error: 'upstream_misconfigured' });
  }

  // Mapa UTM: front manda utm_* com underscore → RVops espera utmsource/utmmedium/etc (sem separador).
  const utmMap = {
    utm_source: 'utmsource',
    utm_medium: 'utmmedium',
    utm_campaign: 'utmcampaign',
    utm_content: 'utmcontent',
    utm_term: 'utmterm'
  };
  const utms = {};
  for (const [src, dst] of Object.entries(utmMap)) {
    const v = trim(body[src], 200);
    if (v) utms[dst] = v;
  }

  // Properties RVops com nomes EXATOS (validados em produção da LP de carro).
  const sentProperties = Object.assign({
    firstname,
    email,
    phone: phoneNormalized,
    'marca-do-veiculo': marca,
    'modelo-do-veiculo': modelo,
    'ano-de-fabricacaomodelo': String(anoInt),
    quilometragem: String(kmInt),
    lp_origem: RVOPS_LP_ORIGEM
  }, utms);

  const url = `https://app.rvops.com/${RVOPS_CLIENT_ID}/api/v1/contacts`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'rvops-apikey': RVOPS_API_KEY
      },
      body: JSON.stringify({ properties: sentProperties }),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      // Sucesso otimista justificado por race condition observada em prod (LP carro):
      // o RVops às vezes processa o lead mas a resposta demora além do timeout.
      // Como o 409 é idempotente, eventual retentativa do usuário não duplica.
      console.warn('[lead-consignacao] upstream timeout — assuming success', { email, phone: phoneNormalized });
      return res.status(200).json({ ok: true, deferred: true });
    }
    console.error('[lead-consignacao] network error', err && err.message);
    return res.status(502).json({ ok: false, error: 'upstream_unavailable' });
  }
  clearTimeout(timer);

  if (upstream.status === 409) {
    // ConflictError — lead com mesmo email/phone já existe. Tratado como sucesso.
    console.info('[lead-consignacao] recurring lead', { email, phone: phoneNormalized });
    return res.status(200).json({ ok: true, recurring: true });
  }

  if (upstream.status === 200 || upstream.status === 201) {
    let id = null;
    try {
      const data = await upstream.json();
      id = (data && (data.id || (data.contact && data.contact.id))) || null;
    } catch (_) { /* body opcional */ }
    console.info('[lead-consignacao] created', { id, email, phone: phoneNormalized });
    return res.status(200).json({ ok: true });
  }

  // Outros status — log com sentProperties pra debug, sem expor a API key.
  let upstreamBody = '';
  try { upstreamBody = await upstream.text(); } catch (_) {}
  console.error('[lead-consignacao] upstream error', {
    status: upstream.status,
    body: upstreamBody && upstreamBody.slice(0, 500),
    sentProperties
  });
  return res.status(502).json({ ok: false, error: 'upstream_error' });
});

// ---------- /api/* não encontrado ----------
app.all('/api/*', (req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

// ---------- páginas ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/obrigado', (req, res) => res.sendFile(path.join(__dirname, 'obrigado.html')));
app.get('/privacidade', (req, res) => res.sendFile(path.join(__dirname, 'privacidade.html')));

// catch-all → 404 servindo o index como fallback amigável.
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'index.html'));
});

// ---------- error handler global ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', (err && err.stack) || err);
  res.status(500).json({ ok: false, error: 'server_error' });
});

app.listen(PORT, () => {
  console.log(`[boot] vendasuamoto-kikoautos rodando em :${PORT} (node ${process.version})`);
});
