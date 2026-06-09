// Servidor Express — Hostinger Node.js (Node 20+).
// Serve a LP estática + proxy /api/lead-consignacao para o CRM (Supabase Edge
// Function leads-ingest). O front NUNCA chama o CRM direto: a x-api-key fica só
// aqui (env var).

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = '1.0.0'; // hardcoded — espelha o package.json. Bumpar manualmente no release.

// Hostinger usa proxy reverso na frente — habilita req.ip / X-Forwarded-For corretos.
app.set('trust proxy', true);

// JSON body parser com limite (anti-payload-bomb).
app.use(express.json({ limit: '10kb' }));

// Boot-time env check — apenas warning. O erro real só dispara em /api/lead-consignacao
// (assim o servidor sobe mesmo se as envs ainda não tiverem sido configuradas).
const { KCRM_API_KEY, KCRM_ENDPOINT } = process.env;
if (!KCRM_API_KEY || !KCRM_ENDPOINT) {
  console.warn('[boot] env vars do CRM faltando', {
    hasApiKey: !!KCRM_API_KEY,
    hasEndpoint: !!KCRM_ENDPOINT
  });
}

// String que identifica esta LP no CRM. A origem ("Site") é fixada pela própria
// API key e NÃO trafega no payload — o que distingue cada LP é o tipo_conversao.
// "consignacao_moto" pra separar da LP de consignação de carros (mesmo CRM).
const TIPO_CONVERSAO = 'consignacao_moto';

// Cache headers — convertido do _headers Netlify:
//   /assets/*   → 1 ano immutable
//   /*.webp     → 1 ano immutable
//   /*.svg      → 1 ano immutable
// Roda antes do express.static, que só seta Cache-Control se ainda não existir.
app.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith('/assets/') || /\.(webp|svg)$/i.test(p)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

// Static — pasta /assets/ (única pasta de assets do projeto).
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Health check — enriquecido pra debug remoto sem SSH. Não inclui envs/paths
// (segurança) nem chamada ao CRM (custo/quota a cada ping).
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: process.uptime(),
    node_version: process.version,
    app_version: APP_VERSION
  });
});

// === Helpers ===
function normalizeWhatsapp(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 10 && digits.length !== 11) return null;
  return digits.startsWith('55') ? digits : '55' + digits;
}
function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function sanitize(s, max = 200) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

// POST /api/lead-consignacao — proxy server-side pro CRM (leads-ingest).
app.post('/api/lead-consignacao', async (req, res) => {
  if (!KCRM_API_KEY || !KCRM_ENDPOINT) {
    console.error('[lead-consignacao] missing env vars', {
      hasApiKey: !!KCRM_API_KEY,
      hasEndpoint: !!KCRM_ENDPOINT
    });
    return res.status(500).json({ error: 'Configuração indisponível, tente novamente em instantes.' });
  }

  const body = req.body || {};

  // Honeypot — preenchido = bot, simula sucesso e descarta.
  if (body.website && String(body.website).trim() !== '') {
    console.warn('[lead-consignacao] honeypot triggered — discarded', { ip: req.ip });
    return res.status(200).json({ ok: true });
  }

  const nome = sanitize(body.firstname, 120);   // nome completo (front manda em firstname)
  const email = sanitize(body.email, 200).toLowerCase();
  const phone = normalizeWhatsapp(body.phone);  // só dígitos + prefixo 55
  const marca = sanitize(body.marca, 80);
  const modelo = sanitize(body.modelo, 120);
  const ano = sanitize(body.ano, 4);
  const quilometragem = sanitize(body.quilometragem, 10);

  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Email inválido.' });
  if (!phone) return res.status(400).json({ error: 'WhatsApp inválido.' });
  if (!marca) return res.status(400).json({ error: 'Marca é obrigatória.' });
  if (!modelo) return res.status(400).json({ error: 'Modelo é obrigatório.' });
  const anoInt = parseInt(ano, 10);
  const currentYear = new Date().getFullYear();
  if (Number.isNaN(anoInt) || anoInt < 1990 || anoInt > currentYear) {
    return res.status(400).json({ error: 'Ano inválido.' });
  }
  const kmInt = parseInt(quilometragem, 10);
  if (Number.isNaN(kmInt) || kmInt < 0 || kmInt > 999999) {
    return res.status(400).json({ error: 'Quilometragem inválida.' });
  }

  // observacoes = texto livre persistido e visível pro consultor. É onde vão os
  // campos sem coluna dedicada: as UTMs e (por segurança) a quilometragem — o
  // CRM pode não ter coluna de km. Uma info por linha, com rótulo em PT.
  // TODO: confirmar com o dev se km tem campo dedicado; se tiver, sai daqui.
  const obs = [];
  obs.push(`Veículo oferecido (consignação): ${marca} ${modelo} ${anoInt}`);
  obs.push(`Quilometragem: ${kmInt} km`);
  const utmLabels = {
    utm_source: 'UTM Source',
    utm_medium: 'UTM Medium',
    utm_campaign: 'UTM Campaign',
    utm_content: 'UTM Content',
    utm_term: 'UTM Term'
  };
  for (const [from, label] of Object.entries(utmLabels)) {
    const v = sanitize(body[from]);
    if (v) obs.push(`${label}: ${v}`);
  }

  // Contrato leads-ingest: campos numéricos descartam string (ano/km vão como
  // Number — "2022" com aspas é ignorado silenciosamente pelo CRM); whatsapp só
  // dígitos com prefixo 55; origem é fixada pela API key.
  //
  // IMPORTANTE: na consignação o cliente está OFERECENDO a moto, não comprando.
  // marca/modelo/ano "puros" no CRM são o veículo de INTERESSE (compra) — por isso
  // vão nos campos de veículo de troca/oferecido. O veículo também é repetido em
  // observacoes como rede de segurança (caso a chave do CRM tenha outro nome,
  // pegadinha conhecida) — quando o dev confirmar as keys, dá pra tirar de lá.
  // quilometragem mandada como número: se houver coluna dedicada o CRM usa.
  // Chaves vazias são omitidas via spread condicional.
  // O booleano de "tem veículo" é o que ATIVA os campos dedicados no CRM (sem
  // ele a moto só cai em observacoes). Na consignação é sempre true. O dev
  // mandou dois nomes pro flag — enviamos os dois (o CRM ignora o que não usa).
  // TODO: confirmar com o dev se a consignação de moto usa os mesmos campos
  // *_veiculo_troca da de carro ou se há um campo próprio.
  const leadPayload = {
    nome_completo: nome,
    email,
    whatsapp: phone,
    tem_veiculo_troca: true,
    possui_carro_troca: true,
    marca_veiculo_troca: marca,
    modelo_veiculo_troca: modelo,
    ano_veiculo_troca: anoInt,
    quilometragem: kmInt,
    tipo_conversao: TIPO_CONVERSAO,
    ...(obs.length ? { observacoes: obs.join('\n') } : {})
  };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 12000);

  let upstream;
  try {
    upstream = await fetch(KCRM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': KCRM_API_KEY
      },
      body: JSON.stringify(leadPayload),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timeout);
    const aborted = e && e.name === 'AbortError';

    if (aborted) {
      // Timeout do nosso lado, mas o CRM provavelmente processou. Sucesso
      // otimista — evita o usuário reenviar e duplicar o lead.
      console.warn('[lead-consignacao] upstream timeout — assuming success', {
        email,
        phone
      });
      return res.status(200).json({ ok: true, deferred: true });
    }

    // Erro de rede real (DNS, TLS, conexão derrubada).
    console.error('[lead-consignacao] upstream fetch failed', {
      aborted: false,
      message: e && e.message,
      email
    });
    return res.status(502).json({ error: 'Não conseguimos registrar agora, tente novamente.' });
  }
  clearTimeout(timeout);

  let upstreamBody = null;
  try { upstreamBody = await upstream.json(); } catch (_) { /* CRM pode devolver não-JSON em erro */ }

  // Sucesso: 201 com { success, contact_id, deal_id }.
  if (upstream.status >= 200 && upstream.status < 300) {
    console.info('[lead-consignacao] created', {
      contact_id: upstreamBody && upstreamBody.contact_id,
      deal_id: upstreamBody && upstreamBody.deal_id,
      email
    });
    return res.status(200).json({ ok: true });
  }

  // Erro upstream — log detalhado pro server (inclui payload pra debug).
  // A x-api-key NUNCA aparece no response.
  console.error('[lead-consignacao] upstream error', {
    status: upstream.status,
    upstreamBody,
    email,
    phone,
    sentPayload: leadPayload
  });
  return res.status(502).json({ error: 'Não conseguimos registrar agora, tente novamente.' });
});

// /api/* não-encontrado → JSON 404 (não cair no SPA fallback).
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Index na raiz.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Página de obrigado (destino do redirect pós-submit do form).
app.get('/obrigado', (req, res) => {
  res.sendFile(path.join(__dirname, 'obrigado.html'));
});

// Política de privacidade (LGPD).
app.get('/privacidade', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacidade.html'));
});

// Catch-all 404 — qualquer rota não-API não-encontrada retorna 404 com a home.
// (Hoje o site é single-page; se virar SPA com rotas client-side no futuro, troca o status pra 200.)
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'index.html'));
});

// Error handler global.
app.use((err, req, res, next) => {
  console.error('[server] unhandled error', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
