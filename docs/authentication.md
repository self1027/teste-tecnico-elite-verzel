# Seed, autenticacao e autorizacao

## Preparacao

Node.js 22+, npm e Docker Compose. A instalacao reproduzivel utiliza
`npm ci` e o unico lockfile do projeto, `package-lock.json`.

```sh
npm ci
docker compose up -d postgres
npm run db:migrate
```

Copie `.env.example` para `.env` apenas se ainda nao houver um `.env`. Defina:

| Variavel | Uso |
| --- | --- |
| DATABASE_URL | PostgreSQL do backend e do seed local |
| TEST_DATABASE_URL | Banco exclusivo para testes de integracao |
| JWT_SECRET | Segredo aleatorio com pelo menos 32 bytes, obrigatorio para a API |
| JWT_EXPIRES_IN_SECONDS | Expiracao inteira entre 1 e 86400 segundos; padrao 3600 |
| PORT | Porta HTTP; padrao 3000 |
| SEED_AUCTIONEER_PASSWORD | Senha de demonstracao do leiloeiro |
| SEED_BIDDER1_PASSWORD | Senha de demonstracao do primeiro participante |
| SEED_BIDDER2_PASSWORD | Senha de demonstracao do segundo participante |

As tres senhas do seed sao obrigatorias (12 a 1024 caracteres). A API nao precisa
das senhas do seed para iniciar. Gere o segredo local, por exemplo, com
`node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`.
O `.env` e ignorado pelo Git e excluido do contexto Docker.

## Seed manual

```sh
npm run db:seed
# Ou, usando a rede interna do Compose:
docker compose run --rm --build seed
```

O servico `seed` usa o profile `tools`: nao executa com `docker compose up` padrao.
Ele utiliza `postgres:5432/verzel_auction` na rede Docker, e recebe somente as tres
senhas do ambiente. Nao aplica migrations automaticamente. Para um banco vazio:

```sh
docker compose run --rm --build seed npm run db:migrate
docker compose run --rm seed
```

Usuarios criados:

| Email | Papel | Senha |
| --- | --- | --- |
| auctioneer@verzel.local | AUCTIONEER | SEED_AUCTIONEER_PASSWORD |
| bidder1@verzel.local | BIDDER | SEED_BIDDER1_PASSWORD |
| bidder2@verzel.local | BIDDER | SEED_BIDDER2_PASSWORD |

Cada usuario recebe uma carteira com saldo/reserva zero e uma conta USER_WALLET;
ha uma unica conta SIMULATION_CLEARING sem carteira. Uma transacao e advisory lock
garantem atomicidade e serializacao entre seeds concorrentes. Reexecucoes completam
relacionamentos ausentes, preservando IDs, hashes, saldos e reservas existentes.
Trocar uma senha no `.env` nao redefine a senha de um usuario ja criado. Papéis ou
tipos contabeis conflitantes e multiplas clearing accounts fazem rollback completo.
Nenhum schema, CHECK ou constraint foi alterado.

## API

```sh
npm run dev
# Ou:
npm run build
npm start
```

Login (substitua a senha pelo valor configurado no ambiente):

```sh
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"auctioneer@verzel.local","password":"AuctioneerDemo2026!"}'
```

```json
{
  "accessToken": "<JWT>",
  "tokenType": "Bearer",
  "expiresIn": 3600,
  "user": {
    "id": "<UUID>",
    "email": "auctioneer@verzel.local",
    "displayName": "Demo Auctioneer",
    "role": "AUCTIONEER"
  }
}
```

```sh
curl http://localhost:3000/auth/me -H 'Authorization: Bearer <JWT>'
```

`GET /auth/me` responde `{ "user": { ... } }` com os mesmos quatro campos publicos.
Email e normalizado para minusculas sem espacos externos; senha nao sofre trim.
Zod rejeita campos extras no login. O token HS256 contem somente sub, iat, exp,
issuer e audience; hash e dados de credenciais nunca sao serializados. Toda
requisicao autenticada consulta o usuario atual pelo UUID validado: claims extras,
headers ou corpo do cliente nao substituem identidade ou papel. Mudancas de papel
entram em vigor imediatamente; usuarios removidos perdem acesso.

Erros usam `{ "error": { "code": "...", "message": "...", "details": [] } }`
(details somente em erros de validacao, com caminhos/codigos, sem valores de entrada).
Status: 400 entrada/JSON invalidos; 401 credenciais/token ausentes ou invalidos;
403 papel negado; 404 rota ausente; 413 corpo acima de 16 KiB; 500 erro interno generico.

O middleware `authorize('AUCTIONEER')` ou `authorize('BIDDER')` e aplicado depois
de `authenticate`, disponibilizado pelo modulo de auth. Sem identidade autenticada,
authorize retorna 401. Nenhuma rota de catalogo, lances ou operacoes financeiras foi criada.

## Validacao

```sh
npm test
npm run test:db
npm run lint
npm run typecheck
npm run build
```

Os novos testes de integracao criam schemas PostgreSQL temporarios em
TEST_DATABASE_URL, aplicam migrations reais e removem seus schemas ao final.
Cobrem seed repetido/concorrente, relacionamentos, rollback, reparo de registros
ausentes, Argon2id, login, expiracao/assinatura de JWT, autorizacao por papel,
alteracao/remocao de identidade, validacao e ausencia de dados sensiveis.
O teste de schema existente usa transacao com rollback no banco de testes.

Senhas de demonstracao e contas do seed sao para desenvolvimento. Sem registro,
refresh token, logout, recuperacao de senha ou regras financeiras nesta etapa.
