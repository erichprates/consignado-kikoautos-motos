# Integração RVops — vendasuamoto.kikoautos.com.br

Documenta o fluxo de captação de leads da LP de venda/consignação de **motos**, do submit do formulário até a criação do contato no CRM RVops.

## Stack

- **Hospedagem:** Hostinger Node.js (Passenger), Node 20.x
- **Backend:** Express 4 (`server.js`)
- **Domínio:** https://vendasuamoto.kikoautos.com.br
- **CRM:** RVops (mesmo cliente da LP de carro — apenas `lp_origem` muda)

## Fluxo

```
[Form no /index.html]
        │ POST JSON
        ▼
[/api/lead-consignacao no server.js]      ← honeypot, sanitização, validação
        │ POST com header rvops-apikey
        ▼
[https://app.rvops.com/${RVOPS_CLIENT_ID}/api/v1/contacts]
        │ 200/201 → ok
        │ 409     → recurring (idempotente)
        │ outros  → 502 ao cliente, log com sentProperties
        ▼
[CRM RVops]
```

## API interna

### `GET /api/health`

Retorna status do servidor. Usado pelo warmup do front (combate cold start do Passenger).

```json
{
  "status": "ok",
  "timestamp": "2026-05-08T13:00:00.000Z",
  "uptime_seconds": 1234,
  "node_version": "v20.18.0",
  "app_version": "1.0.0"
}
```

### `POST /api/lead-consignacao`

Recebe o payload do form, valida server-side, normaliza e proxia pro RVops.

**Headers:** `Content-Type: application/json`

**Body de entrada (do front):**

| Campo | Tipo | Obrigatório | Notas |
|---|---|---|---|
| `firstname` | string | sim | trim, max 100 |
| `email` | string | sim | regex `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`, lowercased |
| `phone` | string | sim | só dígitos no front; backend normaliza pra `55` + DDD + número (10 ou 11 dígitos brasileiros) |
| `marca` | string | sim | trim, max 60 |
| `modelo` | string | sim | trim, max 80 |
| `ano` | string/num | sim | inteiro entre 1990 e ano atual |
| `quilometragem` | string/num | sim | inteiro entre 0 e 999999 |
| `website` | string | — | **honeypot** — qualquer valor não-vazio = bot, retorna 200 silencioso e descarta |
| `utm_source/medium/campaign/content/term` | string | não | máx 200 cada |

**Respostas:**

| Status | Quando | Body |
|---|---|---|
| `200` | sucesso (created) | `{ ok: true }` |
| `200` | lead recorrente (RVops 409) | `{ ok: true, recurring: true }` |
| `200` | timeout do upstream (sucesso otimista) | `{ ok: true, deferred: true }` |
| `200` | bot (honeypot preenchido) | `{ ok: true }` (silencioso) |
| `400` | validação client-side falhou | `{ ok: false, error: "invalid_fields", fields: [...] }` |
| `502` | upstream com erro 4xx/5xx, rede ou config faltando | `{ ok: false, error: "upstream_error" \| "upstream_unavailable" \| "upstream_misconfigured" }` |

A API key **nunca** aparece em response — apenas no header `rvops-apikey` da chamada outbound.

## Endpoint RVops

```
POST https://app.rvops.com/${RVOPS_CLIENT_ID}/api/v1/contacts
Headers:
  Content-Type: application/json
  rvops-apikey: <RVOPS_API_KEY>
```

**Timeout:** 12 segundos via `AbortController` no backend (vs. 30 s no front, que cobre cold start + processamento).

**Rate limit RVops:** 100 requisições / 10 segundos por API key. Suficiente pra picos de tráfego de campanha; se ultrapassar, RVops responde 429 e o backend devolve 502 ao cliente.

## Mapeamento de campos (front → RVops)

Atenção aos separadores — os nomes abaixo são **exatos** e foram validados em produção da LP gêmea de carro. Hífens, underscores e ausência de separadores **importam**.

### Campos de contato (nomes nativos do RVops)

| Front | RVops | Observação |
|---|---|---|
| `firstname` | `firstname` | nativo |
| `email` | `email` | identificador único — base do 409 |
| `phone` | `phone` | normalizado: `55` + DDD + número |

### Campos custom do veículo (criados no schema do RVops)

| Front | RVops | Observação |
|---|---|---|
| `marca` | `marca-do-veiculo` | hífens entre palavras, sem `_` |
| `modelo` | `modelo-do-veiculo` | hífens entre palavras |
| `ano` | `ano-de-fabricacaomodelo` | hífens entre `ano-de-` e depois `fabricacaomodelo` colado, **sem hífen entre fabricacao e modelo** |
| `quilometragem` | `quilometragem` | sem separador |
| (env) | `lp_origem` | underscore — vem de `RVOPS_LP_ORIGEM` (`vendasuamoto-kikoautos`) |

### UTMs (renomeação obrigatória — front com `_`, RVops sem separador)

| Front | RVops |
|---|---|
| `utm_source` | `utmsource` |
| `utm_medium` | `utmmedium` |
| `utm_campaign` | `utmcampaign` |
| `utm_content` | `utmcontent` |
| `utm_term` | `utmterm` |

UTMs vazias são **omitidas** do payload (não enviadas como string vazia).

## Tratamento de duplicidade (409)

O RVops trata `email` (e `phone` como secundário) como identificador único. Tentar criar um contato que já existe retorna `409 ConflictError`. O backend interpreta isso como **sucesso recorrente** — o lead já está no CRM, então:

```js
return res.status(200).json({ ok: true, recurring: true });
```

Isso garante:
- O usuário recebe a UX de sucesso (redirect para `/obrigado`)
- O time comercial não recebe lead duplicado no funil
- Retentativas (do usuário ou do safety net) são idempotentes

## Sucesso otimista por timeout

Em produção da LP de carro, observou-se uma race condition: às vezes o RVops processa o lead, mas a resposta HTTP demora mais que o timeout. Solução adotada (e replicada aqui):

```js
catch (err) {
  if (err.name === 'AbortError') {
    console.warn('[lead-consignacao] upstream timeout — assuming success', { email, phone });
    return res.status(200).json({ ok: true, deferred: true });
  }
  ...
}
```

Trade-off: pode haver casos raros de "sucesso reportado, lead não criado". Mitigação: o `lead_deferred` ia ao dataLayer pra distinguir, mas foi removido por bug do iOS Safari em `await res.json()` (ver `index.html`). Aceito.

## Variáveis de ambiente

Ver `.env.example`. As três obrigatórias:

| Var | Valor | Notas |
|---|---|---|
| `RVOPS_CLIENT_ID` | (compartilhado com LP de carro) | mesmo cliente RVops |
| `RVOPS_API_KEY` | dedicada por deploy | `vendasuamoto-kikoautos-prod` |
| `RVOPS_LP_ORIGEM` | `vendasuamoto-kikoautos` | distingue origem dos leads |

Boot do server avisa via `console.warn` se qualquer uma estiver ausente.

## Logs e observabilidade

Eventos relevantes que vão pro `console`:

- `[boot] env X ausente` — qualquer env obrigatória faltando
- `[lead-consignacao] created` — sucesso normal, com id (quando o RVops devolve)
- `[lead-consignacao] recurring lead` — 409, lead já existia
- `[lead-consignacao] upstream timeout — assuming success` — sucesso otimista
- `[lead-consignacao] upstream error` — log com `sentProperties` (sem API key) pra debug
- `[lead-consignacao] network error` — falha de rede real
- `[lead-consignacao] config faltando` — env vars não configuradas

Em Hostinger, esses logs aparecem na aba **Logs** do app Node.js no painel.
