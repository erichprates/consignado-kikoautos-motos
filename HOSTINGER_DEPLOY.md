# Deploy na Hostinger Node.js — vendasuamoto.kikoautos.com.br

Checklist passo a passo do deploy da LP de venda/consignação de **motos** na hospedagem Node.js da Hostinger (Passenger). Adaptado a partir do procedimento da LP de carro.

## Pré-requisitos

- Conta Hostinger com plano Business+ (ou outro que suporte Node.js)
- Domínio `kikoautos.com.br` apontando para a Hostinger (nameservers já configurados)
- Repositório Git acessível pelo painel Hostinger (GitHub)
- Credenciais do RVops em mãos:
  - `RVOPS_CLIENT_ID` (mesmo da LP de carro)
  - `RVOPS_API_KEY` **dedicada** desta LP — criar antes do deploy (ver passo 3)
- Aprovação do `MEMORY.md`/CLAUDE.md sobre rotação de credenciais

## Passo 1 — Conectar o repositório Git

1. Painel Hostinger → **Sites** → escolher o domínio principal `kikoautos.com.br`
2. **Git** → **Criar repositório** → autenticar com GitHub
3. Selecionar `erichprates/<repo-da-moto>` e branch `main`
4. Diretório de instalação: `domains/kikoautos.com.br/public_html/vendasuamoto` (ou pasta dedicada)
5. Ativar **Auto-deploy on push** se desejar (recomendado)

## Passo 2 — Configurar app Node.js

1. Painel Hostinger → **Avançado** → **Node.js**
2. **Criar aplicativo Node.js** com:

| Campo | Valor |
|---|---|
| **Versão Node.js** | `20.x` (LTS) |
| **Modo de execução** | `Production` |
| **Application root** | (mesmo diretório do passo 1) |
| **Application URL** | `vendasuamoto.kikoautos.com.br` |
| **Application startup file** | `server.js` |
| **Start command** | `npm start` |

3. Após criar, abra o terminal Node do app e rode `npm install` para instalar as dependências.

## Passo 3 — Variáveis de ambiente

> **Importante — segregação de credenciais.** Antes de configurar abaixo, **crie uma API key dedicada** no painel RVops com nome `vendasuamoto-kikoautos-prod`. Não reutilize a API key da LP de carro: assim, se uma vazar, a outra não é afetada e a rotação fica isolada.

No painel Node.js da Hostinger → **Environment Variables** → adicionar:

| Nome | Valor |
|---|---|
| `RVOPS_CLIENT_ID` | `843790ca` |
| `RVOPS_API_KEY` | `<chave criada acima — vendasuamoto-kikoautos-prod>` |
| `RVOPS_LP_ORIGEM` | `vendasuamoto-kikoautos` |

Após salvar, reinicie o app pelo painel pra carregar as envs.

## Passo 4 — Subdomínio e SSL

1. Painel Hostinger → **Domínios** → `kikoautos.com.br` → **Subdomínios**
2. Criar subdomínio `vendasuamoto`
3. Pasta apontando pra o mesmo `Application root` do passo 2
4. **SSL** → ativar **Let's Encrypt** pra `vendasuamoto.kikoautos.com.br`
5. **Force HTTPS** → ativado

A propagação leva até alguns minutos. Confira `dig vendasuamoto.kikoautos.com.br` antes de prosseguir.

## Passo 5 — Validação por curl

Depois do deploy + SSL ativo, valida cada rota:

```bash
# Health
curl -s https://vendasuamoto.kikoautos.com.br/api/health | jq
# Esperado: { "status": "ok", "uptime_seconds": ..., "node_version": "v20.x.x", ... }

# Home
curl -sI https://vendasuamoto.kikoautos.com.br/ | head -5
# Esperado: HTTP/2 200, content-type text/html

# Página de obrigado
curl -sI https://vendasuamoto.kikoautos.com.br/obrigado | head -5
# Esperado: HTTP/2 200

# Política de privacidade
curl -sI https://vendasuamoto.kikoautos.com.br/privacidade | head -5
# Esperado: HTTP/2 200

# Lead de teste (com email descartável — vai parar no CRM)
curl -s -X POST https://vendasuamoto.kikoautos.com.br/api/lead-consignacao \
  -H 'Content-Type: application/json' \
  -d '{
    "firstname": "Teste Deploy",
    "email": "deploy-test@kikoautos.com",
    "phone": "12999999999",
    "marca": "Honda",
    "modelo": "CG 160",
    "ano": "2024",
    "quilometragem": "0"
  }'
# Esperado: { "ok": true } (primeira vez) ou { "ok": true, "recurring": true } (segunda em diante)
```

> Aviso: o lead de teste vai pro CRM real. Marque como teste ou delete depois.

## Passo 6 — Logs e troubleshooting

- Painel Node.js → **Logs** mostra stdout/stderr da aplicação
- Procure pelo prefixo `[boot]` na primeira linha — confirma startup
- Se `[lead-consignacao] config faltando` aparecer, alguma env não foi carregada → reiniciar o app
- Se `[lead-consignacao] upstream timeout` for frequente, considere subir o timeout em `server.js` (atualmente 12s)

### Cold start do Passenger

Passenger suspende a app após ~5 min idle. O front faz `fetch('/api/health')` no carregamento (warmup), o que aquece o backend antes do submit. Mesmo assim, a primeira chamada do dia pode levar 10–30s. O front cobre isso com timeout de 30s + safety net de 40s.

## Passo 7 — UptimeRobot (opcional, recomendado)

Mantém a app aquecida e alerta em queda:

1. Conta gratuita em https://uptimerobot.com
2. **Add New Monitor** → tipo `HTTP(s)`
3. URL: `https://vendasuamoto.kikoautos.com.br/api/health`
4. Intervalo: 5 minutos
5. Alerta por email para queda

Bônus: ping a cada 5 min mantém o Passenger aquecido, eliminando cold starts em horário comercial.

## Rollback

Esta LP é deployada via Git push, não há build de Netlify pra reverter — o rollback é via Git.

```bash
# 1. Identificar o commit ruim
git log --oneline

# 2. Reverter (cria um novo commit que desfaz o anterior — preferível a reset)
git revert <hash-do-commit-ruim>
git push origin main

# 3. Hostinger detecta o push e re-deploya automaticamente (se auto-deploy estiver ligado).
#    Caso contrário, rodar deploy manual no painel Git.
```

Se for **emergência** e auto-deploy estiver desligado:

1. Painel Git → **Pull from remote** → escolhe o commit anterior
2. Painel Node.js → **Restart application**

Nunca use `git push --force` em main — sempre `revert` para preservar o histórico de incidente.

## Checklist final

- [ ] Repositório conectado e em `main`
- [ ] App Node.js com `server.js` como startup
- [ ] 3 env vars configuradas (com API key dedicada)
- [ ] Subdomínio + SSL ativos
- [ ] Os 4 curls do passo 5 passaram
- [ ] UptimeRobot configurado (opcional)
- [ ] Tag de mensuração (GTM) recebendo eventos no preview mode
