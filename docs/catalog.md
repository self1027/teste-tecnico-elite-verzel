# Catalogo e DummyJSON

O modulo catalog integra https://dummyjson.com com fetch nativo do Node 22.
Dados externos passam por Zod antes de serem devolvidos ou persistidos. A base URL
de producao e fixa; URLs de categorias recebidas do cliente nunca sao seguidas.
O provider aceita uma base diferente apenas na composicao programatica dos testes.
Os arquivos em `temp/` sao referencias, nao uma fonte de dados em producao.

## Endpoints

Todos exigem `Authorization: Bearer <JWT>`. AUCTIONEER e BIDDER podem consultar;
somente AUCTIONEER pode importar.

| Metodo e rota | Parametros | Resposta |
| --- | --- | --- |
| GET /catalog/external | limit, skip, category opcional | products, total, skip, limit |
| GET /catalog/external/search | q obrigatorio, limit, skip | products, total, skip, limit |
| GET /catalog/external/:id | ID externo inteiro positivo | product |
| GET /catalog/categories | nenhum | array de slugs |
| POST /catalog/import/:id | ID externo; corpo vazio | product, created |
| GET /catalog/products | limit, skip | products, total, skip, limit |
| GET /catalog/products/:id | UUID do snapshot | product |

`limit` tem padrao 30 e aceita 1..100. `skip` tem padrao 0 e aceita 0..2147483647.
Inteiros fracionados, queries repetidas e parametros desconhecidos sao rejeitados.
`q` e normalizado com trim, exige 1..200 caracteres; category e um slug de ate 100
caracteres (por exemplo, smartphones). Nao ha busca textual local nesta etapa.

Listagem e pesquisa usam o envelope `{ products, total, skip, limit }`. Um produto
externo normalizado tem `{ id, title, description, imageUrl, attributes }`; o ID
externo e numerico. Categorias sao os slugs retornados por `/products/category-list`.
Listagem por categoria consulta `/products/category/:slug`, com limit/skip.

## Importacao e persistencia

| Campo do snapshot | Origem |
| --- | --- |
| id | UUID gerado pelo backend |
| externalId | ID DummyJSON convertido em string |
| source | dummyjson |
| title | title externo |
| description | description ou null |
| imageUrl | thumbnail, primeira images[] ou null |
| attributes | campos permitidos e validados |
| capturedAt | instante da insercao local |

Os atributos permitidos sao category, brand (opcional), sku, tags, images, dimensions,
weight, stock, availabilityStatus, warrantyInformation, shippingInformation,
returnPolicy, minimumOrderQuantity e meta. Meta permite apenas createdAt, updatedAt,
barcode e qrCode. Chaves desconhecidas sao descartadas tambem em objetos aninhados.
Reviews, nomes/e-mails dos avaliadores, preco e desconto nao sao copiados. URLs de
imagens e QR code devem usar http/https. Preco externo nao define lance inicial.

Criacao retorna 201 com `{ product, created: true }`. Reimportacao retorna 200 com
`{ product, created: false }`, preservando todos os campos originais, incluindo UUID
e capturedAt. Snapshots sao imutaveis mesmo se nao estiverem associados a um leilao;
esta API nao implementa atualizacao, sincronizacao nem versionamento de snapshots.

Antes do HTTP externo, o caso de uso procura um snapshot por source/externalId.
Se existir, devolve-o sem consultar a DummyJSON. Caso contrario, busca/valida o produto
e persiste em uma transacao. Um advisory lock por origem/ID e uma nova verificacao
dentro da transacao serializam importacoes concorrentes sem alterar o schema.
Essa garantia depende de insercoes usarem o mesmo Repository; SQL manual ou futuros
importadores que nao respeitem o lock nao sao cobertos por uma constraint UNIQUE.

Consulta local e reimportacao de um snapshot existente funcionam durante falhas
externas. Novas importacoes e consultas externas dependem da DummyJSON; nao ha
fallback para os JSONs de temp, nem cache externo persistido em disco.

## Timeout e erros

`DUMMYJSON_TIMEOUT_MS` configura o timeout entre 1 e 30000 ms; padrao 5000. O limite
cobre fetch e leitura do corpo da resposta. Nao ha retentativas automaticas.

| Status | Caso |
| --- | --- |
| 400 | parametros invalidos ou corpo de importacao com campos extras |
| 401 | autenticacao ausente/invalida |
| 403 | importacao por BIDDER |
| 404 | produto externo ou snapshot inexistente |
| 502 | HTTP externo nao exitoso (exceto 404), JSON ou formato externo invalido |
| 503 | falha de rede/conexao |
| 504 | timeout externo |

Os erros reutilizam `{ error: { code, message, details? } }`; corpos de erro da
DummyJSON nao sao refletidos na API.

## Uso no PowerShell

Inicie o PostgreSQL, aplique migrations e execute a API:

```powershell
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Em outro terminal, autentique-se com a senha configurada no seed:

```powershell
$login = Invoke-RestMethod http://localhost:3000/auth/login `
  -Method Post -ContentType 'application/json' `
  -Body (@{ email = 'auctioneer@verzel.local'; password = 'AuctioneerDemo2026!' } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.accessToken)" }

Invoke-RestMethod 'http://localhost:3000/catalog/external?limit=10&skip=0' -Headers $headers
Invoke-RestMethod 'http://localhost:3000/catalog/external/search?q=phone' -Headers $headers
Invoke-RestMethod 'http://localhost:3000/catalog/external?category=smartphones' -Headers $headers
Invoke-RestMethod 'http://localhost:3000/catalog/categories' -Headers $headers

$import = Invoke-RestMethod 'http://localhost:3000/catalog/import/1' -Method Post -Headers $headers
Invoke-RestMethod "http://localhost:3000/catalog/products/$($import.product.id)" -Headers $headers
Invoke-RestMethod 'http://localhost:3000/catalog/products?limit=10&skip=0' -Headers $headers
```

## Validacao

```sh
npm test
npm run test:db
npm run lint
npm run typecheck
npm run build
```

Os testes do provider usam servidores HTTP locais simulados, sem depender de acesso
a DummyJSON. Os testes de integracao aplicam migrations em schemas temporarios do
PostgreSQL real indicado por TEST_DATABASE_URL, incluindo FKs e importacoes paralelas.
Os schemas temporarios e servidores HTTP sao removidos ao final.

Contratos ficam em catalog/contracts; provider e Zod em infrastructure; consultas
Drizzle em repositories; casos de uso em services; validacao HTTP em controllers.
O modulo auctions nao importa nem conhece o provider DummyJSON.
