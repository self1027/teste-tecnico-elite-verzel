# Relatório técnico: infraestrutura de auditoria

Data: 24/10/2026. Repositório: Verzel Auction House.
Referência inicial: `f6ebaa1`. Fonte normativa: `requirements.pdf`, sete páginas
digitalizadas lidas integralmente por renderização visual; extração textual estava vazia.

## A. Resumo executivo

Foi implementada a infraestrutura de auditoria pública por leilão, com compromissos
SHA-256 determinísticos, persistência na transação de negócio, outbox durável,
testemunha HTTP independente com Ed25519, recuperação e verificação cruzada dos
registros operacionais. Criação, edição e cancelamento de lotes já geram eventos.

A prova não depende da tabela local `audit_anchors`: o verificador consulta o head
da testemunha diretamente. Isso permite detectar truncamento ou reescrita de uma
cadeia ancorada mesmo após excluir/falsificar as confirmações locais.

O código da referência externa e sua integração configurável estão concluídos e
testados localmente. **A ancoragem de produção não está concluída/configurada**:
faltam infraestrutura independente, chave, credenciais, TLS e operação reais.
Sem witness configurado, a API informa `VERIFICATION_UNAVAILABLE`.

Persistem BidService, reservas concretas, settlement/worker, comprovantes financeiros,
WebSockets, frontend e deploy. Não foram substituídos os módulos existentes.
Um sufixo íntegro localmente, porém ainda não ancorado, não constitui prova externa.

## B. Orquestração

Foram usados três subagentes reais na primeira onda, além do agente principal:

| Agente | Ownership e entrega |
| --- | --- |
| `audit_domain` | Domínio/criptografia e testes; depois testes independentes do verificador e documentação arquitetural. |
| `audit_persistence` | Repositórios, projeção operacional e testes PostgreSQL; depois testes adversariais integrados. |
| `audit_witness` | Provider/testemunha/journal e testes HTTP; depois revisão cruzada e correção dos aliases do journal. |
| Principal | Contratos, plano, migration, verificador, replay, worker, HTTP, configuração, integração e relatório. |
| `final_audit_review` | Revisão final independente, somente leitura, após a integração. |

O ambiente permite quatro agentes ativos, contando o principal. Por isso os papéis
A–F do pedido foram distribuídos em ondas, sem simular seis agentes simultâneos.
Os contratos foram escritos antes da delegação. Domínio, persistência e witness
foram implementados em paralelo com ownership separado. Depois das interfaces
estáveis, testes adversariais, guia e revisão ocorreram em paralelo.

Migrations e arquivos compartilhados foram alterados apenas pelo principal. Testes
de banco paralelos usaram schemas UUID distintos do helper existente. Não houve
execução concorrente sobre o mesmo schema. Nenhum subagente fez commits ou push.
O principal integrou as entregas, corrigiu achados e executou a suíte conjunta.

Bloqueios: o PDF não tinha camada textual, resolvido por renderização; o CLI graphify
não estava no PATH, então o relatório existente foi consultado e a inspeção direta
foi usada porque o grafo estava desatualizado. O PostgreSQL estava saudável nesta
execução. O teste de symlink de arquivo exigia privilégio Windows indisponível.

## C. Arquitetura

O domínio publica `AuditInput`, `AuditEvent`, `AuditAppender`, `AuditRepository`,
`OperationalState`, compromissos de lote/lance/settlement e portas `AnchorPublisher`
e `AnchorVerifier`. Não depende de Express, Drizzle ou do provider.

O appender concreto recebe `DatabaseTransaction` do chamador. Fluxo já integrado:

1. Serviço valida a operação; persistência bloqueia o lote para edição/cancelamento.
2. A alteração operacional ocorre na transação.
3. Appender readquire o lock do mesmo lote, valida a cadeia e atribui a próxima sequência.
4. Insere evento e checkpoint pendente; qualquer falha faz rollback de tudo.
5. Após commit, o worker consulta head externo e snapshot, valida e publica via CAS.
6. Confirma a referência local sem sobrescrever uma confirmação anterior.

Ordem preservada para futuros serviços: auction; wallets ordenadas por UUID;
reservations; ledger e auditoria. O appender não abre/fecha transação própria e não
publica pela rede enquanto o negócio mantém locks. Snapshots usam REPEATABLE READ.
A testemunha é consultada antes do snapshot, evitando falso truncamento por um
head publicado depois do início da leitura local.

O formato v1 usa JSON canônico com chaves ordenadas recursivamente. Datas são UTC
com milissegundos; dinheiro/sequências são decimais canônicos. Objetos com getters,
classes, ciclos, números inseguros e valores não JSON são rejeitados. O hash inclui
ID do evento, leilão, sequência, tipo, payload, data, hash anterior e versão, com
separador de domínio. Genesis: sequência 1 e hash anterior com 64 zeros.

Payloads têm whitelist por tipo, sem e-mail, senha, token ou chave de idempotência.
Licitantes usam SHA-256 por leilão/UUID; não se publica seu UUID original.
O comprovante futuro contribui por hash do token, nunca pelo token em si.

A testemunha é outro processo, com journal/volume e chave privada inacessíveis ao
backend. Expõe append autorizado e leitura pública; não oferece alteração/exclusão.
Assina recibos Ed25519, vincula namespace, head anterior, hash, data e referência.
Publicação duplicada devolve o recibo original; conflitos não sobrescrevem registros.
`fsync` precede a resposta. Replay valida assinaturas/CAS; corrupção falha fechada.
Há lock exclusivo, verificação de arquivo/identidade e rejeição de aliases inseguros.
HTTP só é aceito em loopback; outros destinos exigem HTTPS validado.

Pendência significa `externalReference = null`. Confirmação exige referência ainda
nula e checkpoint esperado igual ao lido pelo worker. Se a resposta externa se perde,
o próximo ciclo descobre o head persistido e reconcilia a outbox, sem republicar dados.

Estados públicos: `VERIFIED`, `PENDING_ANCHOR`, `TAMPERED` e
`VERIFICATION_UNAVAILABLE`. A resposta informa sequência local, sequência externamente
comprovada, head externo e cobertura operacional. `CONSISTENT` descreve a projeção
local; a cobertura externa é limitada por `externallyVerifiedSequence`.

O replay compara todos os lances comprometidos, valores, sequência, pseudônimo,
datas, `currentBidId`, termos/status do lote e compromisso de settlement/recibo.
Detecta registros operacionais extras, ausentes ou alterados. Não prova transferências
do ledger, saldo disponível/reservado nem autenticidade econômica da operação.
Checks de precisão SQL detectam microssegundos antes da conversão para `Date`.

## D. Alterações no código

Arquivos criados:

- `src/modules/audit/contracts/{audit,anchors,errors}.ts`.
- `src/modules/audit/domain/cryptography.ts`.
- `src/modules/audit/repositories/{audit-record,drizzle-audit-appender,drizzle-audit-repository}.ts`.
- `src/modules/audit/services/{operational-integrity,audit-verifier,anchor-worker}.ts`.
- `src/modules/audit/controllers/audit-controller.ts` e `src/modules/audit/index.ts`.
- `src/modules/audit/infrastructure/{config,http-anchor-provider}.ts`.
- `src/modules/audit/witness/{protocol,journal,server,main}.ts`.
- `src/modules/auctions/repositories/drizzle-auction-audit-reader.ts`.
- `drizzle/20261024195515_orange_inertia/{migration.sql,snapshot.json}`.
- `tests/audit-{config,domain,verification,witness}.test.js`.
- `tests/integration/audit-{persistence,public,adversarial,migration}.test.js`.
- `docs/superpowers/plans/2026-10-24-audit-infrastructure.md`.
- `docs/audit-infrastructure.md`, este relatório e `README.md`.

Arquivos modificados: `.env.example`, `package.json`, `src/app.ts`, `src/server.ts`,
`src/modules/auctions/index.ts`, `src/modules/auctions/repositories/drizzle-auction-repository.ts`,
`src/modules/audit/infrastructure/schema.ts`, `tests/helpers/auctions.js` e
`tests/integration/schema.test.js`.

A migration é aditiva: acrescenta `hash_version`, preserva eventos legados como
versão 0 não verificável e torna o campo obrigatório sem default. Não modifica a
migration original nem reescreve o conteúdo histórico. O snapshot gerado é JSON
compactado para respeitar o limite de linhas dos commits.

Endpoints novos: `GET /auctions/:id/audit` e `GET /auctions/:id/audit/events`.
São públicos, com validação estrita e `Cache-Control: no-store`. O primeiro usa
HTTP 503 em indisponibilidade; adulteração conhecida é resultado HTTP 200/TAMPERED.
Páginas usam cursor `after` e limite máximo 100; não são prova integral sozinhas.

Configuração: `AUDIT_WITNESS_URL`, `AUDIT_WITNESS_NAMESPACE`,
`AUDIT_WITNESS_PUBLIC_KEY_FILE`, `AUDIT_WITNESS_PUBLISH_TOKEN`,
`AUDIT_WITNESS_TIMEOUT_MS` e `AUDIT_ANCHOR_POLL_MS`. Token é opcional para leitura;
sem token, não se agenda publicação. Configuração parcial ou chave inválida falha
no startup. Shutdown aguarda o worker antes de fechar o pool.

O witness usa ambiente próprio: `WITNESS_NAMESPACE`, `WITNESS_JOURNAL_PATH`,
`WITNESS_PRIVATE_KEY_FILE`, `WITNESS_PUBLISH_TOKEN`, `WITNESS_PORT`, `WITNESS_HOST`.
Novo script: `npm run audit:witness`. Nenhuma dependência npm foi adicionada.
Ferramentas Python de leitura de PDF foram usadas apenas no ambiente do agente.

## E. Testes e evidências

Baseline reexecutada: 24/24 unitários e 65/65 PostgreSQL. Verificação integrada final:

| Comando | Resultado |
| --- | --- |
| `npm test` | 55 aprovados, 0 falhos, 1 ignorado; 56 cenários totais. |
| `npm run test:db` | 93 aprovados, 0 falhos, 0 ignorados. |
| `npm run lint` | Código de saída 0, sem warnings permitidos. |
| `npm run typecheck` | Código de saída 0. |
| `npm run build` | Código de saída 0. |

O cenário ignorado é exclusivamente a criação de symlink de arquivo no Windows,
que retornou EPERM. Testes de hardlink e junction foram efetivamente executados.
Não se afirma validação desse cenário ignorado nem execução em Linux/produção.

| Cenário adversarial/concorrente | Evidência |
| --- | --- |
| UPDATE direto de payload/hash de evento | TAMPERED, sem eco de conteúdo sensível. |
| Evento falso inserido por SQL | Sequência/hash/replay rejeitam o histórico. |
| Exclusão intermediária | Gap/hash anterior invalida a cadeia. |
| Exclusão do último evento/âncoras locais | Head externo remanescente acusa divergência. |
| Reescrita integral com hashes recalculados | Hash local incompatível com compromisso externo. |
| Alteração de lance persistido | Projeção operacional diverge do evento comprometido. |
| Alteração de currentBidId/inserção de lance sem evento | Divergência operacional detectada. |
| Confirmação local forjada | Não produz VERIFIED; referência externa continua necessária. |
| Publicação interrompida após commit | Outbox continua pendente e leitura fica indisponível. |
| Resposta perdida após publicação efetiva | Reinício do worker/witness recupera um único recibo durável. |
| Duas operações/appends concorrentes | Lock pai serializa; oito appends de teste geram sequência contígua sem duplicação. |
| Snapshot durante commit concorrente | Lote, lance e eventos mantêm o mesmo ponto REPEATABLE READ. |
| Consulta sem autenticação | Endpoint público acessível sem JWT, com estado real de cobertura. |
| Reescrita consistente ainda não ancorada | PENDING_ANCHOR, sequência externa 0; limite da garantia demonstrado. |
| Exclusão de todo o sufixo não ancorado e rollback operacional | Prefixo restante VERIFIED apenas na sequência externa anterior; inexistência de evidência do sufixo demonstrada. |
| Microssegundo alterado por SQL | Detectado antes de truncamento para milissegundos. |
| Aliases de journal/lock | Escritor conflitante/publicação são recusados. |

Houve ciclos red/green para componentes novos e correções. Revisões identificaram
e corrigiram: vazamento potencial por metadados de hash; CAS local sem checkpoint
esperado; replay de edição/cancelamento tardio; aliases de journal e perda de precisão
temporal. Um teste de migration precisou usar datas canônicas na fixture após essa
última proteção; a suíte foi reexecutada e aprovada. Nenhuma falha final é omitida.
A revisão final independente não identificou achados bloqueantes. Seu comentário
sobre contagem intermediária no guia foi corrigido com os resultados integrados.

## F. Aderência ao desafio

| Referência do PDF | Situação nesta etapa |
| --- | --- |
| P. 2, desafio: qualquer pessoa audita sem login | Endpoints JSON públicos implementados e testados. |
| P. 3, página pública com histórico completo | Histórico paginado/API pronto; página React pendente. |
| P. 4, histórico resistente a alterações/remoções/inserções no banco | Detectado para prefixos ancorados externamente; limites do sufixo não ancorado explícitos. |
| P. 4, privacidade | Whitelists, pseudônimos e ausência de tokens/PII nos eventos públicos. |
| P. 4, indisponibilidade da API de produtos | Auditoria só consulta snapshots/banco local e witness, sem DummyJSON. |
| P. 4, lances/saldo/anti-sniping/liquidação | Contratos e projeções preparados; regras financeiras completas continuam pendentes. |
| P. 5, tecnologias/documentação/dados | Stack preservada e README/guia adicionados; seed de lote aberto ainda pendente. |
| P. 2 e 7, deploy obrigatório | Ainda pendente; não houve push ou publicação. |
| P. 6, opcionais | Compose e testes já existem; não foram tratados como exigência de blockchain/serviço pago. |

O PDF não prescreve algoritmo ou blockchain. A testemunha externa é a decisão
técnica para não reduzir a garantia a hashes que o mesmo atacante SQL pode reescrever.

## G. Riscos e limitações

- SQL pode reescrever um sufixo ainda não ancorado e as projeções correspondentes.
  Não há detecção criptográfica universal desse caso; um publicador pode ancorá-lo
  posteriormente se a adulteração preceder o compromisso independente.
- A exclusão integral desse sufixo, restaurando estado ao último head, permite
  verificar o prefixo restante. VERIFIED não demonstra que o sufixo nunca existiu;
  sua sequência de cobertura é parte indispensável da resposta. Esse caso foi testado.
- Comprometimento do runtime, token de publicação, chave/persistência do witness,
  distribuição da chave pública ou rollback completo do witness não é coberto.
- O serviço precisa ser operado separadamente, com TLS fora de loopback e volume
  sem acesso de escrita pela API. Arquivo local gravável pelo backend não é âncora confiável.
- Assinatura prova um compromisso publicado; não prova identidade econômica, saldo
  ou execução correta de transferência. Ledger/settlement financeiro ainda não integrados.
- Cobertura operacional se restringe aos campos dos contratos, não a toda coluna
  auxiliar das tabelas. Permutações de chaves JSON equivalentes não são adulteração semântica.
- Consulta pode observar head que avançou logo depois; a cobertura é a observada
  na leitura, não uma promessa de frescor posterior à resposta.
- Integração falha fechada em 10.000 eventos/lances por lote. Hash/replay integral
  por append/publicação não foi submetido a benchmark de alto volume.
- Journal tem limite 64 MiB; não há compactação/rotação de chave automática.
  Escrita é serializada; réplicas não podem compartilhar journal como escritores.
- Crash abrupto pode deixar lock: recuperação exige confirmar escritor parado e
  remover só o lock correto. Reinício limpo foi testado; morte de processo/queda de
  energia e recuperação operacional supervisionada não foram ensaiadas integralmente.
- Não há SLA de ancoragem nem alerta externo de backlog implementado. O polling
  registra falhas e tenta novamente; linhas inválidas persistentes exigem investigação.
- O teste específico de symlink foi ignorado por privilégio Windows; não houve teste
  de filesystem hostil com atacante controlando o processo do witness.

## H. Próximos passos

1. Provisionar testemunha independente, TLS, segredo e chave; fixar a chave pública
   fora do banco, definir backups sem rollback silencioso e monitorar backlog.
2. Implementar reservas concretas e testes de reserva/liberação; estabilizar captura
   e contexto transacional antes de BidService. Essa expansão opcional foi avaliada
   e adiada para manter a entrega centrada na auditoria sem antecipar liquidação.
3. Implementar BidService: lock do lote, wallets ordenadas, reservas, bid, ponteiro,
   anti-sniping exato de dois minutos e BID_ACCEPTED na mesma transação.
4. Implementar SettlementService/Worker idempotentes, captura/transferência no ledger,
   evento de encerramento e comprovante; ampliar verificação econômica.
5. Desenvolver frontend de auditoria e WebSockets em paralelo após contratos de
   lance estabilizarem. Provedor externo e interface podem evoluir independentemente
   enquanto a ordem de locks e formatos v1 forem preservados.
6. Completar seed de lote aberto, documentação final de deploy e publicação autorizada.

Aceite da próxima fase: nenhuma reserva/saldo negativo; liberação imediata ao ser
superado; concorrência sem lance perdido; rollback integral de falha financeira/audit;
ponteiro/ledger/eventos consistentes; retry idempotente; prova pública indicando
exatamente o prefixo ancorado. Testes PostgreSQL reais continuam obrigatórios.

Os commits desta execução respeitam o teto de 500 linhas adicionadas + removidas.
Alterações preexistentes em `temp/` foram preservadas fora dos commits. Não houve push.
