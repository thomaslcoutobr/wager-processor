# ARCHITECTURE — Wager Processor

> **Status deste documento:** a primeira versão foi escrita e aprovada em 07/11/2026, antes do código,
> e o documento foi mantido junto com a implementação. Ele descreve o que o código faz hoje; cada
> decisão aponta o teste que a prova ([§19](#19-estratégia-de-testes)). O que ficou de fora ou mudou de
> rumo está em [§20](#20-limitações-conhecidas-e-trade-offs).
>
> Legenda de evidência: **[medido]** = rodei em laboratório (Bun 1.4.4, Postgres 17, MiniStack 1.5.38)
> durante a pesquisa; **[doc]** = documentação oficial citada em [§21](#21-referências);
> **[decisão]** = escolha minha, justificada no texto.
>
> **Por onde ler:** a [§1](#1-decisões-em-uma-tela) resume tudo numa tela; o resto é o detalhe de cada
> decisão. Marcas como **[ajuste na F4, Lb-02]** ou `R1-05` no texto e nos comentários do código são
> códigos da revisão interna feita depois da implementação (F4: revisões por lentes, cada achado com
> teste vermelho antes do conserto). O código só identifica o achado; o texto ao lado diz o que mudou.

---

## 1. Decisões em uma tela

| Tema | Decisão | Por quê (curto) |
|---|---|---|
| Runtime / framework | Bun 1.4.4 + NestJS 12 + TypeScript estrito | Stack obrigatória. |
| ORM | **MikroORM 7** (`em.transactional`, `LockMode`), entidades com `defineEntity` **só na infraestrutura** | Preferencial no enunciado. O domínio fica sem ORM e sem decorators. A escrita é explícita (`em.insert`, `nativeUpdate`), sem o Unit of Work; o motivo está na [§3](#3-camadas-e-pastas). |
| Dinheiro | `decimal.js` (clone com precisão 40) + regex de entrada `^(0\|[1-9]\d{0,17})\.\d{2}$`; coluna `numeric(20,2)` lida como **string** | Nunca `number`. A regex barra `NaN`, `Infinity`, `1e3`, `0x10` e 3 casas, que o `decimal.js` aceitaria **[medido]**. |
| Concorrência | **Lock pessimista por wallet** (`SELECT … FOR UPDATE`) em READ COMMITTED, `lock_timeout` de 5 s | A unidade de concorrência é a wallet. O lock serializa também as regras que cruzam linhas (reverter uma vez só, referência fora de ordem). |
| Rede de segurança no schema | `CHECK (balance >= 0)`, ledger append-only por trigger e privilégio, `UNIQUE (wallet_id, wallet_version)`, **trigger diferido que amarra cada mudança de saldo a um lançamento** | Restrição 9: as garantias vivem no banco, não só no código. |
| Idempotência | A própria `wager_transactions`: `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`, gravadas **na mesma transação** do saldo | Sem cache em memória e sem estado "em andamento". |
| Hash do payload | `v1:sha256:` + SHA-256 do JSON canônico **RFC 8785** (lib `canonicalize`) de uma lista fechada de campos de negócio | Algoritmo padronizado e versionado. |
| HTTP | 200 PROCESSED · **422 REJECTED** · 202 PENDING_REFERENCE · 400 · 404 · 409 · 503 + `Retry-After` | As 5 situações da seção 9 têm códigos distintos; o provedor decide reenviar só pelo código, e o corpo traz `status`, `failureCode` e `retry`. |
| Fila | **MiniStack** (SQS FIFO + DLQ), imagem trocável por `AWS_EMULATOR_IMAGE` | O LocalStack exige token desde 23/03/2026; sem token o container sai com código 55 **[medido]**. |
| Consumidor SQS | Próprio (`sqs-consumer.ts`, ~300 linhas), inbox por `(consumer_name, message_id)`, ack só depois do commit, 3 classes de erro, DLQ com motivo | As decisões que o enunciado avalia ficam visíveis no código. |
| Outbox | Linha gravada na mesma transação; publishers concorrentes com `FOR UPDATE SKIP LOCKED`; `MessageDeduplicationId = eventId` | Pelo menos uma vez, de propósito; o consumidor dos eventos deduplica por `eventId`. |
| Referência fora de ordem | `PENDING_REFERENCE` + worker com backoff exponencial e **TTL de 10 min** (configurável) | Ver [§14](#14-worker-de-pending_reference). |
| Autenticação | **Não implementada.** Ponto de extensão `ProviderIdentityPort` + `AuthGuard` no-op | Vale 0 pontos; o desenho com Keycloak está em [§18](#18-autenticação-ponto-de-extensão). |
| Testes | `bun test` contra Postgres e MiniStack reais; 3 processos com `Bun.spawn`; failpoints que fazem SIGKILL no próprio processo | Sem mocks de banco ou fila nos testes de integração e concorrência. |

---

## 2. Visão geral

```
            HTTP (provedor)                     SQS wager-transactions.fifo
                 │                                        │  (MessageGroupId = walletId)
                 ▼                                        ▼
        WageringController                     SqsConsumer ── inbox (consumer_name, message_id)
                 │                                        │
                 └──────────────► SubmitWagerTransaction ◄┘   (o MESMO use case)
                                         │
                       uma transação SQL (READ COMMITTED):
                       lock da wallet → [inbox] → claim idempotente →
                       wager_transactions + wallets + ledger + outbox
                                         │ COMMIT
                                         ▼
                   OutboxPublisher (N instâncias, SKIP LOCKED) ──► SQS wager-events.fifo
                   PendingReferenceWorker (backoff + TTL)  ──► mesmo caminho de decisão
```

Toda instância da aplicação roda os mesmos componentes: HTTP, consumidor, publisher da outbox e
worker de pendências. Cada um pode ser desligado por variável de ambiente, o que os testes usam para
montar cenários com papéis diferentes. Não existe coordenação em memória entre instâncias: tudo o que
precisa ser exclusivo é exclusivo no Postgres.

---

## 3. Camadas e pastas

```
src/
  domain/           puro: Money, Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage,
                    OutboxMessage, IntegrationEvent e subclasses, WagerSettlement (regras),
                    FailureCode, erros de domínio. Sem import de @nestjs nem de @mikro-orm.
  application/      use cases (SubmitWagerTransaction, CreateWallet, ResolvePendingReference,
                    ReconcileWallet, PublishOutboxBatch, consultas), payloadHash e as portas:
                    UnitOfWork, TransactionalStore, Clock, IdGenerator, EventBus, ProviderIdentityPort.
  infrastructure/   persistence/ (schemas defineEntity, *Record, mappers, migrations em SQL cru,
                    MikroUnitOfWork), messaging/ (cliente SQS, consumidor, publisher),
                    observability/ (pino, prom-client, AsyncLocalStorage), workers/, config, failpoint.
  interfaces/http/  controllers, validação de entrada, mapa de status, problem+json, AuthGuard.
test/unit · test/integration · test/concurrency · test/helpers
```

A regra de dependência aponta para dentro: `interfaces → application → domain`, e `infrastructure`
implementa as portas da `application`. O use case recebe um `TransactionalStore` já ligado à transação
aberta, então ele não sabe que existe MikroORM; a implementação usa sempre o `em` da transação
(pegadinha medida: `conn.execute()` dentro de `em.transactional` pega outra conexão do pool e, sob
carga, trava o pool **[medido]**).

**O que o MikroORM faz aqui, e o que ele não faz [revisto na F4, R1-07].** A persistência escreve com
`em.insert` e `em.nativeUpdate`, sem `persist`/`flush`, então o Unit of Work e o identity map do ORM
ficam sem uso. É escolha, não descuido:
- o saldo muda com `UPDATE … WHERE id = $1 AND version = $2` e o código confere que mudou 1 linha. O
  flush gera o UPDATE pelo que mudou na entidade e não deixa o código afirmar essa condição;
- o ledger, a outbox e a inbox só aceitam `INSERT`. Com o change tracking, uma entidade do ledger
  alterada por engano viraria um `UPDATE` no flush (o trigger barraria, mas como 500 tardio);
- a ordem dos statements dentro da transação é parte da correção (lock da wallet primeiro, §7.2). Com
  escrita explícita, a ordem é a do código, e não a que o flush calcula.

O que o ORM entrega e é usado: a transação com a conexão amarrada (`em.transactional`), o `LockMode`
que vira `FOR UPDATE` e `FOR UPDATE SKIP LOCKED`, o mapeamento tipado das colunas (`defineEntity`),
o runner de migrations com `up/down` e o ciclo de vida integrado ao NestJS. O domínio não conhece o ORM,
então trocar o ORM mexeria só em `infrastructure/persistence`.

---

## 4. Modelo de domínio

Regra comum: construtor `private`, factories `create`/`open`/`from` que validam, e `rehydrate` que só
reconstrói o estado persistido, sem revalidar transições (seção 6.0 do enunciado).

### 4.1 Money

- Imutável; guarda um `Decimal` de um clone isolado (`Decimal.clone({ precision: 40, rounding: ROUND_HALF_UP })`)
  e a moeda. A precisão padrão do `decimal.js` (20 dígitos) é igual à da coluna `numeric(20,2)`, sem folga;
  com 40, `add` e `subtract` nunca arredondam em silêncio.
- `Money.from({ amount, currency })` aceita só string que casa com `^(0|[1-9]\d{0,17})\.\d{2}$` e moeda
  com 3 letras maiúsculas presente em `Intl.supportedValuesOf('currency')` (o BRL está na lista no
  Bun 1.4.4 **[medido]**). Rejeita negativo, vazio, notação científica, hexadecimal, `NaN`, `Infinity`
  e mais de 2 casas.
- Valores negativos só existem por dentro (`negate()`), nunca pela entrada.
- Operações entre moedas diferentes lançam `CurrencyMismatchError`.
- `toJSON()` devolve `{ amount: value.toFixed(2), currency }`. Esse é o único formato que sai em API,
  evento e log.
- Escala fixa de 2 casas para toda moeda (o enunciado permite assumir BRL). Uma moeda de 0 ou 3 casas
  (JPY, BHD) exigiria uma escala por moeda; está em [§20](#20-limitações-conhecidas-e-trade-offs).

### 4.2 Wallet (aggregate root)

- `Wallet.open({ id, playerId, initialBalance, at, openingTransactionId, openingEntryId })` devolve
  `{ wallet, openingEntry? }`: a wallet com `version = 1` e, se o saldo inicial for maior que zero, o
  lançamento `CREDIT` da abertura (de 0,00 até o saldo inicial, `wallet_version = 1`). A assinatura
  difere do enunciado de propósito ([§4.6](#46-assinaturas-adaptadas-do-enunciado)).
- `debit(money, transactionId, at)` e `credit(...)` devolvem um resultado, não lançam exceção para
  regra de negócio: `{ ok: true, entry }` ou `{ ok: false, reason: 'INSUFFICIENT_FUNDS' | 'BALANCE_LIMIT_EXCEEDED' }`. Saldo
  insuficiente é desfecho normal do protocolo, não erro de programação.
- Toda mudança de saldo incrementa `version` e produz exatamente um `WalletLedgerEntry` com
  `balanceBefore`, `balanceAfter` e `walletVersion`. Sem mudança de saldo, `version` não muda.
- `assertSameCurrency` em toda operação.

### 4.3 WagerTransaction e estados

```
                 create()
                    │
                    ▼
                 PENDING ──────────────┬───────────────┬──────────────┐
                    │                  │               │              │
       markPendingReference()   markProcessed()     reject(code)   fail(code)
                    │                  │               │              │
                    ▼                  ▼               ▼              ▼
          PENDING_REFERENCE ──►    PROCESSED       REJECTED        FAILED
             │  scheduleRetry()        (terminal)     (terminal)     (terminal)
             └──► (continua PENDING_REFERENCE, attempts+1)
             PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
```

- Terminais: `PROCESSED`, `REJECTED`, `FAILED`. Chamar uma transição num terminal lança
  `InvalidTransactionStateError` (erro de programação). O banco repete a regra por trigger ([§6.3](#63-wager_transactions)).
- `FAILED` é reservado para erro **determinístico** que não é de negócio: o domínio aceitou, mas o
  banco recusou (um `CHECK` ou trigger que deveria ter sido impossível de violar), numa mensagem da fila
  que não tem quem receba um 500. Falha **transitória** que esgota as tentativas **não** vira `FAILED`:
  a mensagem vai para a DLQ sem gravar nada e pode ser reprocessada com segurança depois do incidente
  ([§12](#12-consumidor-sqs)). Assim uma operação legítima não se perde por causa de cinco
  `lock_timeout` seguidos.
- `PENDING` existe no domínio porque é o estado de nascimento, mas **nunca é gravado**: o use case
  decide o desfecho com a wallet já travada e grava a linha uma vez, no estado final ou em
  `PENDING_REFERENCE`. Se o processo morrer antes do commit, não existe linha nenhuma.
- `affectsBalance()` é falso para `LOSS`; `requiresReference()` é verdadeiro para `REFUND` e `ROLLBACK`.
- `ledgerDirectionFor(reference)`: BET → DEBIT; WIN, REFUND e OPENING → CREDIT; LOSS → nenhuma;
  ROLLBACK → o inverso da direção da referência (ROLLBACK de BET credita; de WIN ou de REFUND debita).
- `OPENING` é interno: só o `CreateWallet` o cria, com `provider_id = '__internal__'` e
  `external_transaction_id = 'opening:<walletId>'`. A API e a fila rejeitam `kind = OPENING` com 400, e
  o schema impede `OPENING` com outro provedor.

### 4.4 WalletLedgerEntry

Sem campos mutáveis e sem métodos de transição. `create` confere `balanceBefore ± money = balanceAfter`
e lança erro se não fechar. O banco repete a conta num `CHECK`.

### 4.5 Inbox, Outbox e eventos

- `InboxMessage.receive({ consumerName, messageId, payloadHash, at })` e `markProcessed(at)`. Como a
  inbox é gravada na mesma transação do efeito, ela é gravada já processada.
- `OutboxMessage.enqueue(event, { messageGroupId })` guarda o envelope `event.toJSON()` em `jsonb`.
  `scheduleRetry(now, error, random?)` incrementa `attempts`, guarda o erro (até 500 caracteres) e
  calcula `nextAttemptAt = now + min(300 s, 2^attempts s) × jitter(0,5..1)`.
- `IntegrationEvent<T>` é a classe abstrata do enunciado; cada evento é uma subclasse com `eventType` e
  `version` no tipo. `data` só carrega `MoneyProps` (string).

| Evento | Quando | `aggregateId` |
|---|---|---|
| `WagerTransactionProcessed` | toda transação aplicada, inclusive `LOSS` e `OPENING` | transactionId |
| `WagerTransactionRejected` | rejeição de negócio, inclusive TTL esgotado | transactionId |
| `WalletBalanceChanged` | **só** quando o saldo muda; leva `walletVersion` | walletId |
| `WagerTransactionPendingReference` | uma vez, ao entrar em `PENDING_REFERENCE` | transactionId |

Todo evento leva `correlationId` (do header `X-Correlation-Id`, da mensagem SQS ou gerado) e
`causationId` (o `messageId` da fila, o id da requisição ou o id da transação pendente).

### 4.6 Assinaturas adaptadas do enunciado

A seção 6 do enunciado diz que nomes e assinaturas podem ser adaptados, desde que as garantias fiquem.
Onde o código difere do esqueleto, o motivo é um destes três:

| Enunciado | Código | Por quê |
|---|---|---|
| `Wallet.open(...)`: `Wallet` | `Wallet.open({ ..., openingTransactionId, openingEntryId })`: `{ wallet, openingEntry? }` | O saldo inicial precisa nascer com lançamento (saldo = soma do ledger desde a versão 1). O domínio não gera id (a porta `IdGenerator` fica na aplicação), então os ids entram prontos, e o lançamento sai junto para ser gravado na mesma transação. |
| `markProcessed(ref, at)`, `markPendingReference()`, `reject(code)`, `fail(code)` | os mesmos métodos, recebendo um objeto (`{ referenceTransactionId?, resultBalance, at }`, `{ code, resultBalance, at }`...) | Toda transição grava o `resultBalance` e o instante (a resposta e o replay devolvem o saldo daquele momento). Com 3 ou 4 argumentos, objeto nomeado evita trocar a ordem sem o compilador ver. |
| `ledgerDirectionFor(): LedgerDirection` | `ledgerDirectionFor(reference?): LedgerDirection \| undefined` | `LOSS` não move saldo (não há direção) e a direção do `ROLLBACK` depende da operação revertida. |
| `roundId` e `gameId` obrigatórios | opcionais no domínio | Só o `OPENING` interno não tem rodada nem jogo; a API e a fila continuam exigindo os dois nas operações do provedor. |
| `OutboxMessage.enqueue(event)`, `scheduleRetry(now)` | `enqueue(event, { messageGroupId })`, `scheduleRetry(now, error, random?)` | O grupo FIFO (a wallet) é decidido por quem gera o evento; o erro fica guardado para diagnóstico; o `random` injetável deixa o jitter determinístico no teste. |

---

## 5. Regras de negócio e interpretações

As regras da seção 7 do enunciado viram uma função pura de domínio, `WagerSettlement.decide(wallet,
transaction, reference, referenceAlreadyReversed)`. Ela devolve o desfecho e os lançamentos, e é
testada em unidade sem banco. A ordem de checagem é fixa, para o mesmo pedido dar sempre o mesmo código:

1. moeda da operação diferente da moeda da wallet → `REJECTED CURRENCY_MISMATCH`;
2. `playerId` diferente do dono da wallet → `REJECTED PLAYER_WALLET_MISMATCH`;
3. se há referência (obrigatória em REFUND e ROLLBACK, opcional em WIN e LOSS), resolvida por
   `(providerId, referenceExternalTransactionId)`:
   - não existe → `PENDING_REFERENCE`;
   - existe, mas é de outra wallet, player, moeda ou rodada → `REJECTED REFERENCE_MISMATCH`;
   - tipo não permitido (REFUND só de BET; ROLLBACK de BET, WIN ou REFUND; WIN e LOSS só de BET) →
     `REJECTED REFERENCE_KIND_NOT_ALLOWED`;
   - referência ainda em `PENDING_REFERENCE` → esta também fica `PENDING_REFERENCE`;
   - referência `REJECTED` ou `FAILED` → `REJECTED REFERENCE_NOT_PROCESSED`;
   - REFUND/ROLLBACK de referência já revertida → `REJECTED ALREADY_REVERSED`;
   - valor de REFUND/ROLLBACK diferente do valor da referência → `REJECTED AMOUNT_MISMATCH`;
4. aplica no saldo: BET sem saldo → `REJECTED INSUFFICIENT_FUNDS`; reversão que deixaria o saldo
   negativo → `REJECTED REVERSAL_INSUFFICIENT_FUNDS` (código distinto, regra 9);
5. senão → `PROCESSED`, com no máximo um lançamento.

Interpretações que adotei (o enunciado pede que fiquem documentadas):

- **Uma transação é revertida no máximo uma vez, por qualquer tipo.** O texto diz "não pode ser
  revertida duas vezes pelo **mesmo tipo**". Ao pé da letra, uma BET poderia receber um REFUND **e**
  um ROLLBACK, e o jogador seria creditado duas vezes, o que fere a invariante "não duplicar créditos".
  Para desfazer um REFUND, o provedor manda ROLLBACK do REFUND (permitido). Garantido no schema por
  índice único parcial ([§6.3](#63-wager_transactions)).
- **WIN e LOSS podem trazer referência** à BET da rodada. Se trouxerem, ela é validada pelas mesmas
  regras e pode deixar a transação pendente. Se não trouxerem, são aceitas sem referência.
- **Valor zero é aceito** em todo `kind` externo (prêmio zero e rodada grátis existem no mercado). A
  operação de valor `0.00` é registrada como `PROCESSED`, **sem lançamento** e sem mudar saldo nem
  `version`, igual a um `LOSS`. O ledger só guarda valor maior que zero.
- **Escala fixa:** `"25"`, `"25.5"` e `"25.005"` são 400 `INVALID_AMOUNT`. O enunciado manda receber
  sempre com 2 casas; aceitar `"25"` seria normalizar em silêncio.
- **Replay de pendente** devolve o estado **atual**: 202 enquanto pendente e 200 com o desfecho final
  depois. A regra 7 (resultado original) vale para o que já é terminal.
- **Mesmo `externalTransactionId` com outra `Idempotency-Key`:** é sempre 409
  `EXTERNAL_TRANSACTION_ID_CONFLICT`, com o `transactionId` da operação que já existe, mesmo com o
  payload igual. Sem essa unicidade, um provedor que trocasse a chave duplicaria o débito.
  **[ajuste na F4, La-02]** A primeira versão respondia replay quando o payload era igual. Só que a
  chave nova não ficava gravada em lugar nenhum: depois, a mesma chave com outro
  `externalTransactionId` passava como operação nova, e o provedor nunca recebia o 409 que avisa
  "essa chave já respondeu outra coisa". Como a chave é a fonte da verdade (seção 9 do enunciado),
  uma chave só responde pela operação que ela criou. O provedor que perdeu a resposta consulta
  `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
- **Rejeição de negócio consome a chave.** `REJECTED` é terminal; tentar de novo é operação nova (outro
  `externalTransactionId`). Já um 400 não grava nada, e a mesma chave pode ser reenviada corrigida.
- **Preenchidas na implementação (fatia 1):** `BET` com `referenceExternalTransactionId` é 400 (aposta não
  referencia nada); uma transação que referencia o próprio `externalTransactionId` é 400; o `walletId` é
  normalizado para minúsculas antes do hash (UUID não diferencia caixa, e o Postgres já guarda assim);
  o `FAILED` também gera evento, `WagerTransactionFailed`, para a falha ficar visível a quem consome.

---

## 6. Schema

Migrations em SQL escrito à mão (`migration:create --blank`), com `up` e `down` testados em ciclo
`up → down → up`. Nada de `schema:update` nem de diff automático: o schema tem `CHECK`, trigger e
índice parcial que o diff dos metadados não entende **[medido na pesquisa]**.

São duas migrations, e o SQL desta seção mostra o resultado das duas juntas:
- `Migration20261107000100_schema`: o schema da F3;
- `Migration20261108000100_review_hardening`: o que a revisão da F4 endureceu (`result_currency` com
  backfill a partir da wallet, CHECKs contra `NaN`, o `ledger_entry_is_backed` mais estrito e o
  `wallet_guard`).

Migration aplicada não se edita, nem em projeto novo: a 1ª versão destes consertos mexeu na migration
inicial, e o banco do compose, que já a tinha aplicado, ficou sem a coluna nova (500 na criação de
wallet). Teste do caminho de atualização, com dado gravado na 1ª migration:
`test/integration/schema.test.ts`, "upgrades in place".

### 6.1 Papéis

- `wager` é o dono das tabelas e roda as migrations.
- `wager_app` é o papel com que a aplicação conecta. Ele não é dono de nada: tem `SELECT, INSERT, UPDATE`
  em `wallets`, `wager_transactions`, `inbox_messages` e `outbox_messages`, e **só `SELECT, INSERT` no
  ledger**. Sem `DELETE` nem `TRUNCATE` em lugar nenhum.
- Motivo: o dono de uma tabela consegue desligar o próprio trigger (`ALTER TABLE … DISABLE TRIGGER`),
  e isso aconteceu no laboratório **[medido]**. Com papel separado, nem bug nem SQL injection da
  aplicação apagam o ledger.
- Papel é objeto do **cluster**, não do banco. Por isso a migration cria o `wager_app` com
  `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_roles …) … $$` e o `down` só faz `REVOKE`, sem `DROP ROLE`.
  Sem isso, o segundo banco de teste (um por arquivo de teste) falharia com
  "role already exists", e o `down` falharia porque o papel tem privilégio em outros bancos.

### 6.2 wallets

```sql
CREATE TABLE wallets (
  id         uuid          PRIMARY KEY,
  player_id  text          NOT NULL CHECK (char_length(player_id) BETWEEN 1 AND 64),
  currency   char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance    numeric(20,2) NOT NULL CHECK (balance >= 0 AND balance <> 'NaN'),
  version    integer       NOT NULL CHECK (version >= 1),
  created_at timestamptz   NOT NULL,
  updated_at timestamptz   NOT NULL,
  CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
  CONSTRAINT uq_wallets_id_currency     UNIQUE (id, currency)   -- alvo da FK de moeda do ledger
);
```

`version` é `integer` e não `bigint` de propósito: o driver `pg` devolve `int8` como string.
`player_id` é `text` porque é a identidade do jogador **no provedor**: o enunciado mostra UUIDs nos
exemplos, mas não exige o formato. Já `wallets.id` é nosso (UUIDv7 gerado pelo serviço).

Trigger `wallet_guard` (`BEFORE UPDATE`, por linha) **[ajuste na F4, Lc-02]**: recusa mudança de `id`,
`player_id`, `currency` e `created_at`. Só `balance`, `version` e `updated_at` mudam, e saldo e versão
ainda passam pelo `wallet_change_is_backed` (§6.5). Antes, o papel da app conseguia trocar o dono de
uma wallet com histórico, ou a moeda de uma wallet zerada, e o mesmo já era barrado em
`wager_transactions` pelo `wtx_guard`.

### 6.3 wager_transactions

```sql
CREATE TABLE wager_transactions (
  id                                uuid          PRIMARY KEY,
  provider_id                       text          NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' OR provider_id = '__internal__'),
  external_transaction_id           text          NOT NULL CHECK (char_length(external_transaction_id) BETWEEN 1 AND 128),
  idempotency_key                   text          NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  payload_hash                      text          NOT NULL,
  wallet_id                         uuid          NOT NULL REFERENCES wallets (id),
  player_id                         text          NOT NULL,
  round_id                          text,
  game_id                           text,
  kind                              text          NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                            numeric(20,2) NOT NULL CHECK (amount >= 0 AND amount <> 'NaN'),
  currency                          char(3)       NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id          uuid          REFERENCES wager_transactions (id),
  status                            text          NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                      text,
  result_balance                    numeric(20,2) CHECK (result_balance >= 0 AND result_balance <> 'NaN'),
  result_currency                   char(3),      -- moeda da WALLET (difere da operação no CURRENCY_MISMATCH)
  attempts                          integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at                   timestamptz,
  pending_deadline_at               timestamptz,
  created_at                        timestamptz   NOT NULL,
  processed_at                      timestamptz,

  CONSTRAINT uq_wtx_provider_idempotency_key UNIQUE (provider_id, idempotency_key),
  CONSTRAINT uq_wtx_provider_external_id     UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT uq_wtx_id_wallet                UNIQUE (id, wallet_id),  -- alvo da FK composta do ledger
  CONSTRAINT ck_wtx_opening_is_internal  CHECK ((kind = 'OPENING') = (provider_id = '__internal__')),
  CONSTRAINT ck_wtx_round_and_game       CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
  CONSTRAINT ck_wtx_reversal_has_ref     CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT ck_wtx_failure_code         CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT ck_wtx_terminal_has_time    CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
  CONSTRAINT ck_wtx_result_balance       CHECK (status NOT IN ('PROCESSED','REJECTED','PENDING_REFERENCE') OR result_balance IS NOT NULL),
  CONSTRAINT ck_wtx_result_currency      CHECK ((result_balance IS NULL) = (result_currency IS NULL)),
  CONSTRAINT ck_wtx_pending_schedule     CHECK (status <> 'PENDING_REFERENCE' OR (next_attempt_at IS NOT NULL AND pending_deadline_at IS NOT NULL)),
  CONSTRAINT ck_wtx_processed_ref_known  CHECK (NOT (status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')) OR reference_transaction_id IS NOT NULL)
);

-- regra 4 (na versão estrita da §5): cada transação é revertida no máximo uma vez
CREATE UNIQUE INDEX uq_wtx_reversed_once ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
-- fila do worker de pendências
CREATE INDEX ix_wtx_pending_due ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';
-- "cutucar" as pendências quando a referência chega
CREATE INDEX ix_wtx_pending_by_ref ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';
```

Trigger `wtx_guard` (`BEFORE UPDATE OR DELETE`, por linha, mais `BEFORE TRUNCATE` por statement):

- recusa `DELETE` e `TRUNCATE`;
- recusa `UPDATE` de linha cujo `status` antigo é terminal;
- recusa mudança de qualquer coluna de identidade ou de negócio (`provider_id`, `external_transaction_id`,
  `idempotency_key`, `payload_hash`, `wallet_id`, `player_id`, `round_id`, `game_id`, `kind`, `amount`,
  `currency`, `reference_external_transaction_id`, `created_at`);
- aceita só as transições do diagrama de [§4.3](#43-wagertransaction-e-estados).

### 6.4 wallet_ledger_entries

```sql
CREATE TABLE wallet_ledger_entries (
  id             uuid          PRIMARY KEY,
  wallet_id      uuid          NOT NULL,
  transaction_id uuid          NOT NULL,
  direction      text          NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount         numeric(20,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'),
  currency       char(3)       NOT NULL,
  balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0 AND balance_before <> 'NaN'),
  balance_after  numeric(20,2) NOT NULL CHECK (balance_after  >= 0 AND balance_after  <> 'NaN'),
  wallet_version integer       NOT NULL CHECK (wallet_version >= 1),
  created_at     timestamptz   NOT NULL,

  CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),   -- 1 lançamento por transação por wallet
  CONSTRAINT uq_ledger_wallet_version     UNIQUE (wallet_id, wallet_version),   -- cada versão nasce de 1 lançamento
  CONSTRAINT fk_ledger_wallet_currency    FOREIGN KEY (wallet_id, currency)       REFERENCES wallets (id, currency),
  CONSTRAINT fk_ledger_transaction        FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
  CONSTRAINT ck_ledger_arithmetic CHECK (
    balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END)
);
```

Triggers do ledger:

- `ledger_append_only`: `BEFORE UPDATE OR DELETE` por linha e `BEFORE TRUNCATE` por statement, que
  lançam exceção. O trigger de linha não cobre `TRUNCATE`, por isso são dois **[doc]**.
- `ledger_entry_is_backed` (constraint trigger `DEFERRABLE INITIALLY DEFERRED`, roda no commit): a
  transação dona do lançamento tem de estar `PROCESSED` e não pode ser `LOSS`, e
  `wallet_version <= wallets.version`. Assim, transação `REJECTED` nunca tem lançamento, nem por bug.
  **[ajuste na F4, La-03]** Ele também confere o **valor e a direção**: `amount` e `currency` iguais
  aos da transação; `BET` é `DEBIT`; `WIN` e `OPENING` são `CREDIT`; `REFUND` e `ROLLBACK` vão contra
  o lançamento que revertem. Antes, uma wallet aberta com 0,00 (versão 1 sem lançamento) e uma
  transação `PROCESSED` de valor 0,00 deixavam o papel da app gravar um lançamento "fantasma" de
  qualquer valor na versão 1, e o commit passava. A reconciliação pegava, mas a promessa do §6.5 é
  "por construção".
  **[ajuste na F4, Lc-01]** E a versão 1 é só do `OPENING`: `wallet_version = 1` se e somente se a
  transação é `OPENING`. Sem isso, a mesma wallet zerada aceitava uma `WIN` nova de 500,00 com
  lançamento na versão 1, sem mexer na wallet. Como as versões de 2 até a atual já têm lançamento e
  versão acima da atual é recusada, não sobra versão livre para um lançamento sem par.
  **[ajuste na 2ª rodada, R2a-01/R2c-01]** Faltava uma ponta: um `OPENING` **tardio** ainda cabia na
  versão 1 de uma wallet aberta com 0,00. Agora o lançamento de um `OPENING` só passa com a wallet
  ainda na versão 1 e com saldo igual ao `balance_after`, ou seja, gravado junto com a abertura.
- **[ajuste na 2ª rodada, R2c-03]** `result_currency` é a moeda da wallet (FK `(wallet_id, result_currency)`).
- Toda coluna de dinheiro recusa `NaN` num CHECK próprio **[ajuste na F4, C4]**. O `numeric` do
  Postgres aceita `'NaN'` e o ordena acima de qualquer número, então `CHECK (balance >= 0)` sozinho
  deixava passar. A regex do `Money` já barra na entrada; o CHECK fecha a porta do SQL direto.

### 6.5 O laço saldo ↔ ledger no banco

Constraint trigger diferido `wallet_change_is_backed` em `wallets` (`AFTER INSERT OR UPDATE`, roda no commit):

- no `INSERT`: `version = 1` e, se `balance > 0`, existe o lançamento `wallet_version = 1` com
  `balance_before = 0` e `balance_after = balance`;
- no `UPDATE` que muda saldo ou versão: `version = OLD.version + 1` e existe o lançamento com
  `wallet_version = NEW.version`, `balance_before = OLD.balance` e `balance_after = NEW.balance`.

Com isso mais `uq_ledger_wallet_version` e o `ledger_entry_is_backed`, cada versão da wallet
corresponde a exatamente um lançamento, e a cadeia `balance_before → balance_after` fecha. Logo
**`wallets.balance = soma do ledger` vale por construção**, não só por disciplina do código. O custo é
uma busca por índice no commit. A reconciliação ([§15](#15-reconciliação)) continua existindo para
detectar o que só um papel privilegiado consegue fazer por fora.

**[ajuste na 2ª rodada, R2c-02]** As funções dos triggers citam as tabelas sem schema, e o Postgres
procura primeiro no schema temporário da sessão quando ele não está no `search_path` **[doc]**. Com o
`TEMPORARY` que todo papel tem por padrão, o papel da aplicação criava uma `wallet_ledger_entries`
temporária e o trigger lia a tabela falsa. Agora são duas barreiras, cada uma testada sozinha em
`test/integration/schema-integrity.test.ts`: todas as funções de trigger rodam com
`search_path = public, pg_temp`, e o `PUBLIC` perde `TEMPORARY` no banco (`Migration20261108000200_trigger_integrity`).

**[medido na fatia 2]** `test/integration/schema.test.ts` prova que um `UPDATE` de saldo sem lançamento,
um lançamento sem `UPDATE`, um lançamento de transação `REJECTED` e um lançamento com `balance_before`
errado falham no commit. Custo na wallet quente (`bun run bench:triggers`, dentro do compose: 300 apostas
concorrentes de 1,00 numa wallet, pool de 10, 3 rodadas alternando ligado/desligado): mediana de 1.804 ms
ligado contra 1.713 ms desligado, cerca de **5% a mais** (166 contra 175 operações por segundo). A medida
é ruidosa e vale só a razão. Com esse custo, os triggers ficam ligados.

### 6.6 inbox_messages e outbox_messages

```sql
CREATE TABLE inbox_messages (
  consumer_name text        NOT NULL,
  message_id    text        NOT NULL,
  payload_hash  text        NOT NULL,
  received_at   timestamptz NOT NULL,
  processed_at  timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id               uuid        PRIMARY KEY,          -- = eventId (UUIDv7, ordena no tempo)
  aggregate_id     text        NOT NULL,
  message_group_id text        NOT NULL,             -- walletId: ordem FIFO por wallet
  event_type       text        NOT NULL,
  event_version    integer     NOT NULL,
  payload          jsonb       NOT NULL,             -- envelope IntegrationEvent.toJSON()
  occurred_at      timestamptz NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL,
  published_at     timestamptz,
  last_error       text,
  seq              bigint      NOT NULL DEFAULT nextval(...) -- ordem no grupo, sorteada sob o lock da wallet (R2b-02)
);
CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at, id) WHERE published_at IS NULL;
CREATE INDEX ix_outbox_group_pending ON outbox_messages (message_group_id, seq) WHERE published_at IS NULL;
```

---

## 7. Concorrência

### 7.1 Estratégia

Toda transação que escreve faz, **como primeiro comando**, `SELECT … FROM wallets WHERE id = $1 FOR UPDATE`
(`LockMode.PESSIMISTIC_WRITE` no MikroORM), em READ COMMITTED (o padrão do Postgres; o código não
muda o nível de isolamento), com `SET LOCAL lock_timeout = '5s'`.

- Duas apostas na mesma wallet ficam em fila no lock da linha; a segunda lê o saldo **depois** do
  commit da primeira. Em READ COMMITTED, `SELECT FOR UPDATE` que encontra a linha alterada espera e
  relê a versão nova **[doc]**. Não há `read → calculate → update` sem controle (restrição 7).
- Wallets diferentes não disputam nada: o lock é por linha, nunca global (restrição 6).
- Funciona com qualquer número de instâncias, porque o lock é do Postgres.
- O `UPDATE` da wallet ainda leva `WHERE version = $expected` (cinto e suspensório); 0 linhas afetadas
  seria bug e vira erro 500 com rollback.

### 7.2 Ordem de locks (sem deadlock)

1. Cada transação trava **no máximo uma wallet**, e sempre primeiro.
2. Só depois disso vêm a inbox, o claim idempotente, o ledger, a outbox e a "cutucada" das pendências,
   que se limita às pendências **da mesma wallet**.
3. A referência de outra wallet só é lida, nunca travada.

Com uma única ordem de aquisição não há ciclo **[doc]**. Mesmo assim, `40P01` (deadlock) e `40001` são
tratados como transitórios, com até 3 tentativas internas e, depois, 503 ou retry da fila. O
mapeamento de `40P01` pelo MikroORM não foi testado na pesquisa; o código decide pelo `error.code` do
Postgres.

### 7.3 Por que não as alternativas

- **Otimista (versão + retry):** numa wallet quente (o teste das 50 apostas iguais, ou o 100/80/80),
  quase toda tentativa colide e volta; o retry vira tempestade e precisa de limite e jitter. O
  pessimista enfileira de forma justa no próprio banco. A `version` continua existindo, porque o
  enunciado a pede, mas como dado e como rede (`uq_ledger_wallet_version`), não como mecanismo principal.
- **UPDATE atômico condicionado** (`UPDATE … SET balance = balance - $x WHERE id = $w AND balance >= $x`):
  correto e um pouco mais rápido na wallet quente: 1,08x e 1,28x em duas execuções de
  `test/bench/hot-wallet-locking.ts` (500 débitos concorrentes, pool de 10, mediana de 5 rodadas)
  **[medido na F4]**. Vale só a razão, não o número. O "1,6x a 2x" da pesquisa vinha de um protótipo com
  ORM fora deste repositório e não se reproduziu aqui; o script novo substitui aquela medida (Lb-09). Ficou como **plano B**, porque leva a regra "saldo suficiente" para o SQL e não serializa
  as regras que cruzam linhas (reverter uma vez, referência pendente), que no pessimista vêm de graça. A
  troca fica isolada num método do repositório.
- **SERIALIZABLE:** exige retry de `40001` em todo caminho, sem ganho sobre o lock de linha.
- **Ordem do SQS FIFO:** é otimização (uma mensagem por wallet por vez dentro da fila), não garantia.
  A entrada HTTP não passa pela fila, retry e DLQ quebram a ordem, e a deduplicação vale só 5 minutos
  **[doc]**. Restrição 3.

---

## 8. Idempotência

### 8.1 Onde mora

Na própria `wager_transactions`. Toda requisição válida que chega até a decisão vira uma linha,
inclusive `REJECTED` e `PENDING_REFERENCE`. As duas unicidades:

- `(provider_id, idempotency_key)`: a chave é a fonte da verdade e vale por provedor (um provedor não
  envenena a chave do outro);
- `(provider_id, external_transaction_id)`: a invariante de negócio (a mesma operação do provedor não
  vira duas, mesmo que a chave mude).

Retenção permanente, porque a unicidade é regra de negócio e o histórico é auditável.

### 8.2 Hash do payload

```
payloadHash = "v1:sha256:" + hex(sha256(utf8(JCS(subconjunto))))
subconjunto = { providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
                money: { amount, currency }, referenceExternalTransactionId? }
```

- JCS = RFC 8785, pela lib `canonicalize` (5.1.0, Apache-2.0). Ordena as chaves e fixa a serialização.
- Calculado sobre o comando **já validado** (o `amount` já está com 2 casas), nunca sobre o body cru.
- Campo opcional ausente é omitido (nunca `null`), para `{a}` e `{a, b: null}` darem o mesmo hash.
- Fora do hash: o header `Idempotency-Key`, o `messageId`, `occurredAt` e qualquer metadado de
  transporte. Por isso HTTP e SQS geram o mesmo hash para a mesma operação.
- Todos os valores são string; a parte frágil do JCS (serialização de número IEEE-754) nem é usada.
- O prefixo `v1` permite mudar o subconjunto no futuro sem transformar hashes antigos em falso conflito.

### 8.3 Replay e conflito

- Mesma chave e mesmo hash → replay: devolve o resultado guardado (`status`, `failure_code`,
  `result_balance` com `result_currency`, o saldo observado sob o lock no momento da decisão, na moeda da wallet **[ajuste na F4, La-01]**), com `idempotentReplay: true`
  e header `Idempotent-Replayed: true`. A resposta é reconstruída das colunas, não de um body salvo.
- Mesma chave e hash diferente → 409 `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, sem gravar nada.
- Requisições idênticas concorrentes não geram estado "em andamento": a segunda espera o lock da wallet
  (ou o índice único, se vier com outra wallet) e, quando passa, enxerga a linha já commitada e vira
  replay. Por isso este desenho não precisa de `locked_at` nem do 409 "em andamento" da Stripe.

---

## 9. O use case `SubmitWagerTransaction`, passo a passo

Entrada: o comando validado, o `payloadHash` e, quando vem da fila, os dados da inbox.

```
0. caminho rápido (sem transação): busca por (provider_id, idempotency_key)
   → achou: replay ou 409, e acabou.
1. BEGIN (READ COMMITTED); SET LOCAL lock_timeout = '5s'
2. SELECT wallet FOR UPDATE                        → não existe: 404, rollback
   now = Clock.now()                               (só depois do lock)
3. [SQS] INSERT inbox ON CONFLICT (consumer_name, message_id) DO NOTHING
   → 0 linhas: lê o payload_hash guardado
       igual     → duplicata; commit e ack
       diferente → MESSAGE_ID_PAYLOAD_MISMATCH; rollback e DLQ
4. relê por chave OU por external id               → achou pela chave: replay ou 409; só pelo external id: 409
5. lê a referência (se houver) e se ela já foi revertida
6. WagerSettlement.decide(...)                     → desfecho + lançamento (domínio puro)
7. INSERT wager_transactions (INSERT simples, sem ON CONFLICT)
8. se o saldo mudou: UPDATE wallets … WHERE version = $v; INSERT ledger
9. INSERT outbox (os eventos do desfecho)
10. se PROCESSED: UPDATE pendências da mesma wallet que referenciam esta transação → next_attempt_at = $now
11. COMMIT                                        → triggers diferidos conferem saldo ↔ ledger
12. resposta HTTP, ou ack da mensagem
```

- O passo 0 tira o lock do caminho dos reenvios tardios. **[ajuste na fatia 4]** Na fila, o passo 0
  consulta primeiro a inbox por `(consumer_name, message_id)`: a reentrega da mesma mensagem é reconhecida
  pela inbox (como o enunciado pede), e a chave só decide quando a mensagem é outra com a mesma operação.
  O passo 3 continua existindo para as reentregas que chegam ao mesmo tempo.
- O passo 4 é o que decide nas rajadas, porque roda depois do lock, num statement novo que já enxerga o
  commit anterior **[doc]**.
- O passo 7 é a garantia final, no schema. Ele é um `INSERT` simples de propósito: um
  `ON CONFLICT DO NOTHING` sem alvo engoliria **qualquer** violação de unicidade, inclusive a de
  `uq_wtx_reversed_once`, e daria o desfecho errado. Se der `23505`, a transação inteira é desfeita
  (o MikroORM não deixa engolir o erro dentro do `em.transactional` **[medido]**), e o use case roda
  **mais uma vez** do zero. Na segunda rodada, o passo 0, 4 ou 5 classifica o caso (replay, 409 ou
  `ALREADY_REVERSED`). Na prática, o `23505` só aparece quando a mesma chave chega ao mesmo tempo
  em wallets diferentes, porque na mesma wallet o lock já serializa.
- Todo instante usado em regra (TTL, backoff, `processed_at`, cutucada) vem do `Clock` como
  parâmetro do SQL, nunca do `now()` do banco. Assim o teste avança o relógio sem esperar tempo real.
  **[ajuste na F4, R1-05]** O relógio é lido **depois** do lock da wallet, nos quatro lugares que
  decidem (submit, pendência, expiração e registro de FAILED). Antes era lido no `BEGIN`: quem
  esperava o lock gravava um `created_at` anterior ao de quem o segurava, e o tempo do ledger andava
  para trás em relação à `wallet_version`. Teste: `test/integration/clock-after-lock.test.ts`.
- Antes de qualquer SQL, a validação de entrada barra o que o schema recusaria com erro genérico:
  `providerId` fora do formato (inclusive o reservado `__internal__`), `walletId` que não é UUID,
  chave com mais de 255 caracteres e `kind = OPENING`. Tudo vira 400, nas duas portas (HTTP e fila).

---

## 10. API HTTP

### 10.1 Endpoints

| Método e rota | Sucesso | Observação |
|---|---|---|
| `POST /wallets` | 201 | Saldo inicial > 0 gera `OPENING` + `CREDIT` na mesma transação. Duplicata (`playerId` + `currency`) → 409 `WALLET_ALREADY_EXISTS` com o `walletId` existente. |
| `GET /wallets/:walletId` | 200 | 404 se não existe. |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | 200 | Keyset por `wallet_version` (decrescente). O cursor é `base64url({"v":<wallet_version>})`: estável e opaco. `limit` de 1 a 200. |
| `POST /wagering/transactions` | 200 ou 202 | Header `Idempotency-Key` obrigatório (1 a 255 caracteres). |
| `GET /wagering/transactions/:transactionId` | 200 | Visão completa, em qualquer status. |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 · 400 · 404 | Usa `uq_wtx_provider_external_id`. Os dois parâmetros do caminho seguem as mesmas regras dos campos do corpo (formato do `providerId`; 1 a 128 caracteres, sem caractere de controle); fora disso é 400, nunca 503 **[ajuste na F4, Lc-03]**. |
| `POST /wallets/:walletId/reconciliation` | 200 | `consistent: false` também é 200: divergência é resultado, não erro de requisição. |
| `GET /health/live`, `GET /health/ready` | 200 / 503 | Abertos, sem autenticação. |
| `GET /metrics` | 200 | Prometheus. |

### 10.2 Mapa de status

| Situação | HTTP | Corpo | Grava? | O que o provedor faz |
|---|---|---|---|---|
| `PROCESSED` (inclusive `LOSS` e valor zero) | 200 | `transactionId`, `status`, `balance`, `idempotentReplay` | sim | segue |
| `REJECTED` (regra de negócio) | **422** | o mesmo corpo de transação + `failureCode` + `retry: "NEVER"` | sim | não reenvia; é a resposta final |
| `PENDING_REFERENCE` | 202 + `Location` | idem + `retry: "POLL"` | sim | consulta o GET ou aguarda o evento |
| Replay idêntico | o mesmo código do estado atual (200, 422 ou 202) | idem + `idempotentReplay: true` | já existia | segue |
| `FAILED` (replay do POST) | 500 | o corpo da transação com `status: "FAILED"`, `failureCode: "PROCESSING_FAILED"`, `retry: "NEVER"` | já existia | não reenvia; aciona o suporte |
| `GET` de transação, em qualquer status | 200 | a transação completa | — | — |
| Payload inválido ou header ausente | 400 | problem+json com `code` e `errors[]` | não | corrige; a mesma chave serve |
| Corpo acima de 64 KiB | 413 | problem+json, `code: "VALIDATION_ERROR"`, `retry: "AFTER_FIX"` | não | corrige o corpo |
| Wallet ou transação inexistente | 404 | problem+json | não | corrige o id |
| Conflito de idempotência / wallet duplicada | 409 | problem+json, `retry: "NEVER"` | não | corrige a geração da chave |
| Falha transitória (Postgres fora, `lock_timeout`, deadlock esgotado, desligando) | 503 + `Retry-After` | problem+json, `retry: "SAME_REQUEST"` | não (rollback) | reenvia a mesma chave e o mesmo corpo, com backoff |
| Bug inesperado | 500 | `INTERNAL_ERROR`, `retry: "SAME_REQUEST"` | não (rollback) | pode reenviar: a transação é atômica |

**Por que o replay de `FAILED` continua 500 [revisto na F4, R1-06].** O revisor apontou que ele usa o
mesmo código do bug inesperado. Ficou assim de propósito: `FAILED` é falha **do servidor** (o schema
recusou o que o domínio aceitou), e um 4xx diria ao provedor que o erro foi dele. 422 também não serve,
porque 422 é "regra de negócio" e o provedor trataria como saldo insuficiente. O que separa os dois
casos é o corpo, que o provedor já lê para decidir: o replay traz o recurso (`transactionId`,
`status: "FAILED"`) com `retry: "NEVER"`; o bug traz problem+json `INTERNAL_ERROR` com
`retry: "SAME_REQUEST"`. Teste do caminho inteiro (fila grava `FAILED`, DLQ, replay HTTP e GET):
`test/integration/sqs-retry-dlq.test.ts`.

Regra para o provedor (vai para o README): **200 = aplicada; 202 = aceita e pendente; 422 = rejeitada
por regra, é final; 400/404/409 = seu pedido está errado, não reenvie igual; 503, 5xx ou queda de rede
= reenvie a mesma chave e o mesmo corpo, com backoff.** O código sozinho já diz se pode reenviar.

**Trade-off do 422.** A seção 9 do enunciado pede que rejeição de negócio tenha código próprio, para o
provedor não precisar ler o corpo. O 422 faz isso e falha fechado: um cliente que só olha o 2xx nunca
trata rejeição como aprovação (a Stripe usa 402 para recusa de cartão pelo mesmo motivo). O preço é que
uma rejeição é um desfecho **gravado** com código 4xx, e o replay também devolve 422, com
`idempotentReplay: true`. O `GET` continua 200, porque ler um recurso que existe é outra situação.
A alternativa, 200 com `status: "REJECTED"`, também é defensável (provedores de jogo costumam pôr o
desfecho no corpo), e a troca é uma linha no mapeador.

O 409 (e não o 422 do rascunho IETF) para conflito de idempotência quer dizer "isso já está ligado a
outra coisa", igual à wallet duplicada. O 409 de "em andamento" não existe neste desenho, então o 409
nunca quer dizer "tente de novo". Assim, o 422 fica exclusivo da rejeição de negócio.

Erros seguem a RFC 9457 (`application/problem+json`), com as extensões `code` e `retry`.

---

## 11. Taxonomia de `failureCode`

Campo `retry`: `NEVER` (desista), `AFTER_FIX` (nada foi gravado; corrija e reenvie, a mesma chave
serve), `SAME_REQUEST` (reenvie igual, com backoff), `POLL` (consulte depois).

| Grupo | Códigos | HTTP | Status gravado | `retry` | Na fila |
|---|---|---|---|---|---|
| A. Validação | `VALIDATION_ERROR`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `FORBIDDEN_KIND`, `MISSING_REFERENCE` | 400 | nenhum | `AFTER_FIX` | DLQ (permanente) |
| B. Conflito ou inexistente | `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS`, `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `MESSAGE_ID_PAYLOAD_MISMATCH` (só na fila) | 409 / 404 | nenhum | `NEVER` / `AFTER_FIX` | DLQ (permanente) |
| C. Rejeição de negócio | `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `PLAYER_WALLET_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_NOT_PROCESSED`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `BALANCE_LIMIT_EXCEEDED` | 422 | `REJECTED` | `NEVER` | ack |
| D. Falha permanente | `PROCESSING_FAILED` | 500 (replay) | `FAILED` | `NEVER` | DLQ |
| E. Transitório | `SERVICE_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `LOCK_TIMEOUT`, `CONCURRENCY_RETRY_EXHAUSTED` | 503 + `Retry-After` | nenhum | `SAME_REQUEST` | retry com backoff; esgotou → DLQ com motivo `RETRY_LIMIT_EXCEEDED`, sem gravar nada |

Pendência não é falha: `PENDING_REFERENCE` responde 202 com `retry: "POLL"` e não leva `failureCode`.

`BALANCE_LIMIT_EXCEEDED` **[ajuste na F4, H3]**: o maior saldo que `numeric(20,2)` guarda é
999.999.999.999.999.999,99. Um crédito que passaria disso chegava ao Postgres como `22003`
(estouro numérico), que é "bug" na tabela abaixo: 500 no HTTP e `FAILED` na fila. Agora o domínio
recusa antes (`Money.isStorable`, conferido em `Wallet.credit`), e o desfecho é uma rejeição de
negócio gravada, com o saldo intacto.

SQLSTATE → grupo: `23505` no `INSERT` da transação aborta a transação e o use case roda mais uma vez
([§9](#9-o-use-case-submitwagertransaction-passo-a-passo)), e a segunda rodada classifica (replay, 409 ou
`ALREADY_REVERSED`); classes `08`, `53` e `57`, `25006` (banco que só lê, janela de failover;
**[ajuste na F4, R2b-03]**), `55P03` e `40xxx` são transitórias; `23514`, `23503`,
`22P02` e `P0001` (trigger) são bug, porque a validação e o domínio deveriam ter barrado antes. No HTTP
viram 500 com alerta e nada gravado; na fila viram `FAILED PROCESSING_FAILED` ([§12](#12-consumidor-sqs)).

Erros de rede do driver também são `DATABASE_UNAVAILABLE`, e dois deles só existem porque o cliente tem
prazo **[ajuste na F4, Lb-06]**. O `pg` vem sem limite nenhum: esperar uma conexão do pool ou a resposta
de uma consulta podia durar para sempre, e um banco que pendura sem fechar o socket (pausado, ou atrás de
uma rede que descarta pacotes) deixava o POST sem resposta. Agora:
- esperar ou abrir uma conexão desiste em `DB_CONNECT_TIMEOUT_MS` (5 s), e o erro é
  `timeout exceeded when trying to connect`. Isso também limita a fila do pool quando muitos pedidos
  esperam a mesma wallet (R1-02);
- cada consulta desiste em `DB_QUERY_TIMEOUT_MS` (15 s) do lado do cliente, e o erro é
  `Query read timeout`. A config exige que esse prazo seja maior que o `lock_timeout` (5 s), para que
  a espera de lock responda primeiro com o seu próprio erro;
- `keepAlive` no socket, para o sistema operacional notar um par que sumiu.

Se o tempo esgotar num `COMMIT` que o servidor chegou a gravar, o cliente recebe 503 e reenvia, e a
chave de idempotência devolve o resultado gravado. É o mesmo caminho do desfecho desconhecido.

---

## 12. Consumidor SQS

- Fila `wager-transactions.fifo`, DLQ `wager-transactions-dlq.fifo` (FIFO também, exigência da AWS
  **[doc]**), `maxReceiveCount = 5`, visibilidade de 30 s, long polling de até 20 s (limitado à metade
  do grace, ver Desligamento), **uma mensagem por recebimento**, em `SQS_CONSUMER_CONCURRENCY` laços
  por instância (padrão 4, no máximo metade de `DB_POOL_MAX`).
- O `messageId` da inbox é o do **envelope** (`messageId` do JSON), não o `MessageId` do SQS: um
  reenvio do produtor ganha outro `MessageId` no SQS, mas é a mesma mensagem lógica.
- Grupos (wallets) diferentes rodam em paralelo, um por laço; o mesmo grupo roda em sequência, e quem
  garante isso é o próprio FIFO: enquanto a cabeça do grupo está em voo (inclusive no backoff do
  retry), o SQS não entrega a seguinte daquele grupo a ninguém **[doc]** (o MiniStack faz o mesmo: o
  `_collect_fifo` pula grupo com mensagem em voo e roda sem `await` no meio, então dois laços não
  pegam o mesmo grupo **[lido no código do MiniStack 1.5.38]**).
- Cada mensagem roda num `em.fork()` próprio (o EM global do MikroORM recusa operação fora de contexto
  **[medido]**) e num `AsyncLocalStorage` com `correlationId` e `messageId`.

| Resultado | Ação |
|---|---|
| Commit (PROCESSED, REJECTED, PENDING_REFERENCE, replay) ou duplicata da inbox | `DeleteMessage` |
| Falha do `DeleteMessage` **depois** do commit | Só loga. A mensagem volta e a inbox descarta. Não é falha de processamento. |
| Permanente (JSON inválido, tipo desconhecido, grupos A e B) | Envia à DLQ com o motivo nos atributos e apaga |
| Erro determinístico que não é de negócio (o banco recusou com `23514`, `23503`, `22P02` ou trigger) | Grava `FAILED PROCESSING_FAILED` numa transação própria, **travando a wallet primeiro** como qualquer escrita, com o evento na outbox; depois DLQ com motivo e apaga. A transação fica auditável e consultável pelo GET. |
| Transitório (grupo E, ou erro desconhecido) com `ApproximateReceiveCount < 5` | `ChangeMessageVisibility` com backoff exponencial e *equal jitter* (base 1 s, teto 30 s): metade do teto é fixa e metade é sorteada, em segundos inteiros, então a 1ª retentativa nunca sai com 0 s **[ajuste na F4, R1-04]**. Com o *full jitter* de antes, metade das 1ªs retentativas voltava na hora e gastava as 5 entregas numa rajada. Fonte: AWS Architecture Blog, "Exponential Backoff And Jitter" (2015). O teto é baixo porque, no FIFO, a mensagem em backoff segura a wallet inteira. |
| Transitório na 5ª tentativa | DLQ com motivo `RETRY_LIMIT_EXCEEDED` e apaga, **sem gravar nada**. Depois do incidente, a mensagem pode voltar da DLQ para a fila (redrive): o processamento é idempotente, então reprocessar é seguro. |

**Banco fora [ajuste na F4, Lb-02].** Cada recebimento conta para o limite do redrive. Com o backoff da
tabela, a mensagem gastava as 5 tentativas em no máximo 15 s e ia para a DLQ: uma queda longa do
Postgres mandaria tudo o que chegasse para lá. Agora o primeiro `DATABASE_UNAVAILABLE` pausa todos os
laços da instância. Uma sonda (a mesma da readiness, com prazo de 1 s; ela confere que o banco
**escreve**, `transaction_read_only = off`, porque um banco que só lê não processa nada, R2b-03) roda a cada
0,5 s, dobrando até 5 s, e os laços só voltam a receber quando ela passa. Cada mensagem em voo na hora
da queda gasta 1 tentativa, e as outras nenhuma. O `lock_timeout` não pausa nada, porque é de uma
wallet só.

O redrive automático do SQS (`maxReceiveCount = 5`) fica como rede: se o processo morrer cinco vezes
na mesma mensagem antes de tratá-la, o próprio SQS a move para a DLQ. Ele não incrementa a contagem
num `ChangeMessageVisibility` **[medido]**.

**Desligamento (SIGTERM):** o `/health/ready` passa a responder 503; nenhum recebimento novo sai; o
recebimento que já está aberto **termina** (não é abortado) e o que ele trouxer volta na hora com
visibilidade 0; as mensagens em voo terminam dentro de `SHUTDOWN_GRACE_MS` (8 s); as que não
terminarem voltam com visibilidade 0 para outra instância pegar na hora. O dreno fica em
`beforeApplicationShutdown`, porque em `onApplicationShutdown` o MikroORM já fecha o pool, e a
mensagem em voo cairia num pool fechado (bug reproduzido na pesquisa **[medido]**). O
`stop_grace_period` do compose (20 s) é maior que o grace. O app sobe como PID 1 em forma exec e sai
com código 0 no `docker compose stop`, em 0,9 a 3,6 s conforme o ponto do long poll **[medido na F4]**.
Os dois pollers (outbox e pendências) olham a parada entre um lote e outro, e entre uma candidata e
outra: o dreno espera só a unidade em voo, e o resto fica para a próxima instância. Antes, um backlog
fazia o dreno esperar o tick inteiro e cair no prazo duro com código 1 **[ajuste na F4, Lb-07]**.

**[ajuste na F4] Uma mensagem por recebimento, em N laços.** A revisão provou com teste que o lote de
até 10 punha dinheiro válido na DLQ sem tentativa. O SQS conta **recebimentos**, não tentativas: o lote
trazia as seguintes do grupo junto com a cabeça, e cada devolução somava 1 na
`ApproximateReceiveCount` delas. Com a cabeça falhando 5 vezes (erro transitório) ou com 5 mensagens
ruins na frente (caminho da DLQ), a válida de trás chegava ao limite do redrive e ia para a DLQ sem
`failureReason` e sem nunca ter rodado. Agora cada laço recebe 1 mensagem, e uma mensagem só é recebida
quando vai ser tentada. De quebra:
- uma wallet presa no lock não segura as outras da instância, porque o lote antigo esperava o grupo mais
  lento antes de receber de novo;
- no SIGTERM não sobram seguidoras em voo sem dono;
- cada mensagem ganha os seus próprios 30 s de visibilidade.

O número de laços fica limitado a metade do pool: cada laço pode segurar uma conexão esperando lock,
e o resto fica para o HTTP e os dois pollers (a config recusa mais que isso).

O desligamento segue o padrão das bibliotecas de referência (bbc/sqs-consumer para com `abort: false`
por padrão e espera o poll em curso **[doc]**). Abortar um long poll não para o servidor, que ainda pode
entregar uma mensagem a um pedido que ninguém lê, e ela fica invisível durante toda a visibilidade.
Por isso o long poll é limitado à metade do grace: o laço ocioso termina dentro dele. O custo é que o
desligamento ocioso leva até 4 s em vez de ~1 s, e há mais recebimentos vazios com a fila parada.
Só quando o grace estoura o recebimento aberto é cortado.

Testes em `test/concurrency/sqs-consumer-loops.test.ts`, todos vermelhos no código antigo, exceto o de
ordem, que é a guarda do desenho novo:
- R1-01, transitória na cabeça;
- Lb-01, 5 venenos na frente;
- wallet presa não trava outra;
- 20 apostas da mesma wallet aplicadas na ordem do envio com 4 laços;
- 10 wallets presas não esgotam o pool do HTTP;
- SIGTERM com o grace estourado deixa as 3 do grupo visíveis.

**[ajuste na fatia 5] Dreno do HTTP.** O teste de reinício sob carga mostrou que o `server.close()` não
retorna enquanto o cliente continua reusando conexões keep-alive: a instância só saía pelo prazo duro,
com código 1. Agora, no SIGTERM, requisição nova de negócio recebe 503 `SERVICE_UNAVAILABLE` com
`Retry-After` e toda resposta leva `Connection: close`; as requisições em voo terminam, e só então as
conexões ociosas são fechadas. O sinal é tratado no `main.ts` (sem `enableShutdownHooks`), para um
dreno limpo sair com 0.

---

## 13. Outbox publisher

```
loop a cada OUTBOX_POLL_MS (200 ms, com jitter), em toda instância:
  BEGIN; SET LOCAL statement_timeout = '10s'
  -- passo 1: a cabeça (evento não publicado mais antigo) de cada grupo, quando devida
  SELECT o.message_group_id FROM outbox_messages o
   WHERE o.published_at IS NULL AND o.next_attempt_at <= $now
     AND NOT EXISTS (um evento não publicado do mesmo grupo com seq menor)
   ORDER BY o.next_attempt_at, o.id LIMIT 10
   FOR UPDATE OF o SKIP LOCKED
  -- passo 2: os eventos não publicados desses grupos, do mais antigo ao mais novo
  SELECT … WHERE message_group_id IN (…) AND published_at IS NULL
   ORDER BY seq LIMIT 10 FOR UPDATE
  para cada linha (o grupo para no primeiro evento que falha ou ainda não está devido):
    SendMessage(wager-events.fifo, MessageGroupId = message_group_id, MessageDeduplicationId = id)
    ok   → published_at = $now
    erro → OutboxMessage.scheduleRetry(now) e PARA o lote (o resto fica intacto para a próxima passada)
    passou de OUTBOX_PASS_BUDGET_MS (5 s)? → PARA o lote
  COMMIT
```

- `SKIP LOCKED` faz cada publisher pegar um lote disjunto. Com 3 publishers sobre 300 eventos, nenhuma
  linha foi publicada por dois publishers e nenhuma ficou pendente **[medido]**. A documentação do
  Postgres indica `SKIP LOCKED` justamente para tabelas em forma de fila **[doc]**; para a wallet ele
  seria errado.
- **Pelo menos uma vez, de propósito.** Se o processo morre entre o `SendMessage` e o commit, o
  Postgres desfaz a transação e solta os locks; outro publisher reenvia. O `MessageDeduplicationId =
  eventId` colapsa a repetição na janela de 5 min do FIFO, e o consumidor dos eventos deduplica por
  `eventId`. Cenário 5 da seção 11 do enunciado.
- **[ajuste na F4, Lb-08] A ordem por wallet é garantida, também entre publishers.** Antes, o "pula o
  resto do grupo" só valia dentro de um lote: depois da falha da cabeça, o lote seguinte publicava os
  eventos de trás antes dela, e um 2º publisher podia pegar o evento 11 enquanto o 1º segurava o 1 a 10.
  Agora o claim tem dois passos:
  1. trava com `SKIP LOCKED` a **cabeça** de cada grupo, o evento não publicado mais antigo, quando está
     devido. Um evento de trás nunca é cabeça enquanto a cabeça não sai, então ninguém mais pega nada
     daquele grupo;
  2. trava os eventos pendentes desses grupos, do mais antigo ao mais novo. O publisher para o grupo no
     primeiro que falha ou ainda está em backoff.

  **[ajuste na F4, R2b-02] "Mais antigo" é a coluna `seq` (de uma sequência), não o `occurred_at`.** O
  `occurred_at` vem do relógio da instância que decidiu; com duas instâncias a 5 ms uma da outra, a
  versão 3 de uma wallet saía antes da 2. O `seq` é sorteado pelo `INSERT`, dentro da transação de
  negócio e depois do lock da wallet, então para uma wallet ele segue a ordem do lock, diga o relógio o
  que disser. O índice parcial `(message_group_id, seq) WHERE published_at IS NULL` atende os dois
  passos sem varrer o backlog inteiro (Migration20261108000300_outbox_sequence;
  `test/integration/outbox-order-clock.test.ts`, vermelho no código anterior). As linhas que já estavam
  na tabela são numeradas pela regra antiga, `(occurred_at, id)`, antes de a sequência assumir; um
  `ADD COLUMN ... bigserial` numeraria pela ordem física, e uma cabeça já retentada (o `UPDATE` move a
  linha) ficaria depois das seguidoras **[ajuste na F4, R3-01]**; `test/integration/outbox-seq-backfill.test.ts`.

  O `WalletBalanceChanged` continua carregando `walletVersion` como rede para o consumidor, porque a
  entrega é "pelo menos uma vez": um reenvio pode chegar depois de um evento mais novo. Testes em
  `test/integration/outbox-order.test.ts`, os dois vermelhos no código anterior.
- Custo aceito: a transação do publisher fica aberta durante a chamada ao SQS. É mitigado com lote
  pequeno, timeout do cliente SQS (5 s) e `statement_timeout`. A alternativa com "lease" (`locked_until`
  e publicação fora da transação) tem locks mais curtos, mas é mais código; fica registrada.
- Publicar nunca acontece antes do commit: o evento só existe como linha da outbox até a transação de
  negócio terminar (restrição 4).
- **Destino dos eventos:** a fila `wager-events.fifo`, com a DLQ `wager-events-dlq.fifo`, criadas no
  mesmo script de init. O enunciado lista só as duas filas de entrada; a de eventos é decisão minha,
  porque o desafio não diz para onde vão os eventos. Publicar na fila de entrada misturaria eventos com
  comandos. Em produção seria um tópico SNS com várias filas assinando.
- **"Publicação duplicada continua segura para o consumidor"** (seção 11, passo 5): o contrato é
  deduplicar por `eventId`. Para provar isso, os testes têm um **consumidor de referência** que lê
  `wager-events.fifo` e usa a mesma tabela `inbox_messages` (com outro `consumer_name`). O teste força a
  duplicata real, republicando o mesmo envelope com outro `MessageDeduplicationId` para o FIFO não
  escondê-la, e confere que o efeito do consumidor acontece uma vez só.

---

## 14. Worker de `PENDING_REFERENCE`

```
loop a cada PENDING_POLL_MS (500 ms, com jitter), em toda instância:
  SELECT id, wallet_id FROM wager_transactions
   WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= $now
   ORDER BY next_attempt_at LIMIT 20                 -- sem lock: só candidatos
  para cada candidato, ResolvePendingReference(id), numa transação própria:
    trava a wallet (sempre primeiro); relê a pendência; se já não está pendente, sai
    referência terminal  → WagerSettlement.decide (o mesmo do caminho principal)
    ausente ou pendente e now >= pending_deadline_at → REJECTED REFERENCE_NOT_FOUND
                                                       (ou REFERENCE_NOT_PROCESSED) + evento
    senão → attempts + 1; next_attempt_at = now + min(60 s, 1 s × 2^attempts) × jitter(0,5..1)
```

- **Limite = TTL de 10 minutos** a partir do aceite (`PENDING_REFERENCE_TTL_SECONDS = 600`). Escolhi o
  tempo, e não um número de tentativas, porque a regra que faz sentido para o negócio é "a referência
  precisa chegar em até X minutos"; o número de tentativas sai do backoff (cerca de 15 em 10 min).
  - Por que 10 minutos: a referência que falta é a BET (ou o WIN) da mesma rodada, e o provedor a
    reenvia pelo próprio retry, que leva de segundos a poucos minutos; 10 minutos cobrem várias
    rodadas desse retry.
  - Por que não mais: enquanto a reversão espera, o crédito do jogador fica parado e existe um passivo
    em aberto. Ao esgotar o prazo, o provedor recebe `REJECTED REFERENCE_NOT_FOUND` e o evento, e pode
    reconciliar.
  - O valor é um ponto de partida, não um número de mercado: em produção ele seria calibrado pela janela
    de reenvio dos provedores. Nos testes cai para segundos por variável de ambiente.
- **A cutucada** (passo 10 do [§9](#9-o-use-case-submitwagertransaction-passo-a-passo)): quando a
  referência chega e é processada, as pendências da mesma wallet que apontam para ela ganham
  `next_attempt_at = $now`. O caso comum (a referência chega segundos depois) se resolve no próximo
  ciclo do worker, e continua existindo **um só** caminho de decisão. **[ajuste na fatia 3]** A cutucada
  também dispara quando a referência termina `REJECTED`, para a reversão dependente falhar logo
  (`REFERENCE_NOT_PROCESSED`) em vez de esperar o próximo backoff. Vale no caminho principal e no worker,
  o que resolve cadeias (ROLLBACK de um REFUND que esperava a BET) em ordem.
- Se o banco recusar a decisão de uma pendência (erro determinístico, que seria bug), o worker grava
  `FAILED PROCESSING_FAILED` numa transação própria, para não repetir para sempre. Erro transitório (wallet
  ocupada, banco fora) deixa a linha intacta, e **esta instância** deixa a **wallet** de fora por um
  tempo, com o mesmo backoff exponencial com jitter da pendência: as outras candidatas dela são puladas
  na passada e ficam fora das próximas consultas. Sem isso, as mesmas candidatas ocupadas viriam
  primeiro em todo ciclo e encheriam o lote, e as reversões pendentes de outras wallets nunca seriam
  tentadas **[ajuste na F4, Lb-05]**. O primeiro conserto recuava uma candidata por vez e só segurava
  com o relógio de teste parado: com relógio real, cada candidata ocupada gastava um `lock_timeout`, a
  passada durava mais que o recuo, e uma wallet com mais pendências que o lote voltava a enchê-lo.
  Recuando a wallet, uma wallet ocupada custa no máximo um `lock_timeout` por passada, tenha quantas
  pendências tiver **[ajuste na F4, R2b-01]**. O backoff fica em memória de propósito: gravá-lo seria
  uma escrita sem a trava da wallet, o que o desenho nunca faz.
- Várias instâncias podem pegar o mesmo candidato; a segunda espera o lock da wallet, relê, vê que já
  não está pendente e sai. É trabalho perdido, mas correto.

---

## 15. Reconciliação

Um único statement (um único snapshot: em READ COMMITTED cada statement enxerga o banco no seu início
**[doc]**, e a wallet e o ledger são commitados juntos):

```sql
SELECT w.balance, w.currency,
       COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS calculated,
       COUNT(l.id) AS checked_entries
  FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
 WHERE w.id = $1
 GROUP BY w.id;
```

Mais uma checagem de cadeia (`balance_before` = `balance_after` do lançamento anterior, por
`wallet_version`), que pega um buraco que a soma sozinha esconderia. Divergência **não é corrigida**: vai
para log de erro (ids e valores, sem payload), para a métrica `reconciliation_divergence_total` e para a
resposta (`consistent: false`, `difference` e o campo extra `chainBreaks`). Todos os testes de
integração e concorrência terminam rodando essa reconciliação em cada wallet usada.

---

## 16. Falhas e recuperação

| Onde o processo morre ou falha | O que fica | Como se recupera |
|---|---|---|
| Antes do commit (HTTP ou SQS) | nada (rollback) | o provedor reenvia a mesma chave, ou a mensagem volta |
| Depois do commit, antes da resposta HTTP | tudo commitado | reenvio da mesma chave → replay |
| Depois do commit, antes do ack SQS | efeito + inbox | a mensagem volta depois da visibilidade → inbox detecta → ack |
| No publisher, depois do `SendMessage`, antes do commit | evento na fila e linha ainda pendente | outro publisher republica; dedup no FIFO e no consumidor |
| No publisher, antes do `SendMessage` | linha pendente | outro publisher pega (o lock cai com a conexão) |
| Postgres fora | — | HTTP 503; `ready` 503; o consumidor **pausa** os laços no 1º `DATABASE_UNAVAILABLE` (métrica `sqs_consumer_paused` = 1) e sonda o banco a cada 0,5 s a 5 s; as mensagens esperam na fila sem gastar tentativa, e ele volta sozinho **[ajuste na F4, Lb-02]** |
| Postgres que lê mas não escreve (janela de failover, `25006`) | — | o mesmo do "Postgres fora": HTTP 503, `ready` 503 e consumidor pausado, porque a sonda confere a escrita; antes a mensagem ia à DLQ em ~15 s **[ajuste na F4, R2b-03]** |
| SQS fora | o POST HTTP continua funcionando; a outbox acumula | publisher em backoff; `outbox_lag_seconds` sobe; `ready` 503 |
| SIGTERM | dreno ou devolução de visibilidade ([§12](#12-consumidor-sqs)) | outra instância continua |
| SIGKILL / OOM | igual à queda antes ou depois do commit | visibilidade expira e a mensagem volta |

Os pontos de queda são exercitados por **failpoints** (`FAILPOINTS=consumer.after_commit_before_ack=crash`),
que fazem `process.kill(process.pid, 'SIGKILL')` exatamente naquele ponto. No Bun 1.4.4 o processo sai
com 137 **[medido]**. O app se recusa a subir com `FAILPOINTS` definido e `NODE_ENV=production`.
Pontos previstos: `consumer.after_commit_before_ack`, `http.after_commit_before_response`,
`outbox.after_send_before_commit`, `usecase.before_commit=transient` (para o teste de retry e DLQ).

---

## 17. Observabilidade

- **Logs:** pino em JSON no stdout, com `correlationId`, `messageId`, `transactionId`,
  `walletId` e `providerId` injetados de um `AsyncLocalStorage` em toda linha (o use case enriquece o
  contexto ao descobrir os ids). `redact` em `authorization` e `cookie`; o log de requisição fica
  reduzido a método, rota, status e duração. Na fila, cada mensagem aplicada deixa uma linha
  `message processed` com `messageId`, `sqsMessageId`, `transactionId`, desfecho e duração (o par da
  linha `request` do HTTP); duplicata, retry e DLQ têm linhas próprias. Nunca loga body nem valor financeiro completo (testado em
  `test/integration/observability.test.ts`). **[implementação]** Usei o pino direto, sem `nestjs-pino`,
  porque o mesmo logger serve HTTP, fila e workers; a escrita é síncrona, para a linha logada logo
  antes de um `process.exit` ou de uma queda não se perder.
- **Métricas** (`GET /metrics`, prom-client), com rótulos de baixa cardinalidade (nunca walletId):

| Exigência | Métrica |
|---|---|
| transações por status | `wager_transactions_total{status,kind,source}` |
| duplicatas detectadas | `wager_duplicates_total{source,kind="idempotency\|inbox"}` |
| retries | `sqs_retries_total`, `db_transaction_retries_total` |
| mensagens em DLQ | `sqs_dlq_total{reason}` |
| conflitos de lock | `db_lock_conflicts_total{sqlstate}` (`55P03`, `40P01`, `40001`) e `wallet_lock_wait_seconds` (histograma do tempo até obter o `FOR UPDATE`; com lock pessimista, a disputa aparece como espera, não como erro) |
| outbox lag | `outbox_lag_seconds` (idade da mais antiga pendente) e `outbox_pending` |
| latência | `wager_processing_seconds{source}` (histograma) |
| extras | `pending_reference_total`, `reconciliation_divergence_total` |

- **Health:** `live` responde se o processo está de pé; `ready` faz `SELECT 1` no Postgres e
  `GetQueueAttributes` nas filas, com timeout de 1 s cada, e responde 503 durante o desligamento.

---

## 18. Autenticação (ponto de extensão)

**Não implementada**, por decisão de timebox: a seção 2 do enunciado diz que vale 0 pontos e não deve
competir com correção financeira, concorrência e idempotência.

O que fica no código:

- `ProviderIdentityPort.resolve(headers): Promise<ProviderIdentity>` e o `ProviderAuthGuard`, aplicado
  com `@UseGuards` nos controllers de negócio (wallets e transações; health e métricas ficam de fora),
  em `src/interfaces/http/auth.ts`. Hoje o
  adaptador é no-op: aceita a requisição e pendura a identidade "anônima" em `req.identity`.
- O ponto de checagem "o `providerId` do payload pertence à identidade autenticada", que viraria 403
  `PROVIDER_MISMATCH`, está marcado no guard e **não está implementado**. O use case não recebe a
  identidade: com autenticação de verdade, a checagem ficaria no controller ou no guard, antes do use
  case, e a fila (canal interno) não passa por ela.

Desenho que eu adotaria: **Keycloak** no compose, um *confidential client* OIDC por provedor, fluxo
*client credentials*. O guard valida o JWT pelo JWKS do realm (assinatura, `iss`, `aud`, `exp`) e mapeia
o `azp` (o client id) para o `providerId`. Mensagens da fila são canal interno confiável, mas a
identidade do provedor contida nelas passa pelas mesmas validações de domínio (seção 2 do enunciado).

---

## 19. Estratégia de testes

Tudo roda com `bun test`. Os testes de integração e concorrência sobem contra o Postgres e o MiniStack
do compose, **dentro do Linux dos containers**: o SIGTERM no Windows não é confiável, e o avaliador
roda em Linux ou Mac. **Cada arquivo de teste cria o seu próprio banco** (`t_<rótulo>_<worker>_<carimbo>`),
com as migrations, e o apaga no fim **[corrigido na F4, R1-08]**. O `bun test` padrão roda os arquivos
em série; o banco por arquivo é o que deixaria rodar em paralelo sem estado compartilhado, mas o modo
paralelo não foi medido e não é o caminho documentado.

| Exigência (seção 13) | Onde |
|---|---|
| Money: escala, arredondamento, entradas inválidas | `test/unit/money.test.ts` |
| Invariantes da Wallet; regras de BET, WIN, LOSS, REFUND, ROLLBACK; conflito de moeda | `test/unit/wallet.test.ts`, `test/unit/wager-settlement.test.ts` |
| Transições da WagerTransaction (inclusive `InvalidTransactionStateError` em terminal) | `test/unit/wager-transaction.test.ts` |
| `WalletLedgerEntry.create` recusa conta que não fecha | `test/unit/ledger-entry.test.ts` |
| Backoff da `OutboxMessage`, `InboxMessage`, envelope dos eventos (`toJSON` só com `MoneyProps`) | `test/unit/outbox-inbox-events.test.ts` |
| Chave com payload divergente; hash canônico | `test/unit/payload-hash.test.ts` + integração |
| Migrations (`up → down → up`) e cada constraint e trigger, como `wager_app` e como dono | `test/integration/schema.test.ts` |
| Atomicidade wallet + ledger + inbox + outbox (falha injetada antes do commit) | `test/integration/atomicity.test.ts` |
| Inbox e redelivery (mesmo `messageId` com `MessageDeduplicationId` diferente, para o FIFO não esconder a duplicata) | `test/integration/sqs-inbox.test.ts` |
| Publishers concorrentes sobre a mesma outbox | `test/integration/outbox.test.ts` |
| Retry e DLQ (failpoint transitório até a 5ª tentativa) | `test/integration/sqs-retry-dlq.test.ts` |
| Recuperação após reinício | `test/concurrency/restart.test.ts` |
| 1. A mesma aposta 50 vezes em paralelo → 1 débito | `test/concurrency/same-bet-50x.test.ts` |
| 2. 100,00 e duas apostas de 80,00 → 1 PROCESSED, 1 REJECTED, saldo 20,00, 1 débito | `test/concurrency/hot-wallet.test.ts` |
| 3. Wallets distintas em paralelo | `test/concurrency/many-wallets.test.ts` |
| 4. 3 ou mais instâncias (`Bun.spawn`, rajada distribuída) | `test/concurrency/multi-instance.test.ts` |
| 5. Morto depois do commit e antes do ack (failpoint com SIGKILL) | `test/concurrency/crash-after-commit.test.ts` |
| 6. Dois publishers sobre a mesma outbox (um morre no meio) + publicação duplicada segura para o consumidor de referência | `test/concurrency/outbox-publishers.test.ts` |
| 7. REFUND ou ROLLBACK antes da referência | `test/concurrency/out-of-order.test.ts` |
| 8. Reinício com consistência final comprovada | `test/concurrency/restart.test.ts` |

Testes além da lista mínima da seção 13:

| O que prova | Onde |
|---|---|
| Saldo = soma do ledger e a cadeia de **todas** as wallets, conferidos ao apagar o banco de **todo** arquivo de teste (o arquivo falha se não fechar) | `test/helpers/test-db.ts`, provado em `test/integration/test-db-invariant.test.ts` |
| Contrato HTTP de ponta a ponta (criação, consulta, 400, 404, 409, 422, replay) | `test/integration/wagering-http.test.ts` |
| REFUND e ROLLBACK: reverte uma vez só, valor igual, tipo de referência permitido, mesma wallet e rodada, mesmo provedor | `test/integration/reversals.test.ts`, `test/concurrency/out-of-order.test.ts` |
| REFUND pela fila antes da aposta: `PENDING_REFERENCE`, ack, aplicado quando a aposta chega | `test/integration/sqs-inbox.test.ts` |
| Dois `POST /wallets` iguais ao mesmo tempo (10×10): um 201, nove 409, nunca 500 | `test/concurrency/wallet-creation-race.test.ts` |
| Rajada HTTP maior que o pool numa wallet: outra wallet e `ready` respondem 503 no prazo, `live` 200, tudo volta depois ([§20](#20-limitações-conhecidas-e-trade-offs)) | `test/concurrency/hot-wallet-burst.test.ts` |
| Hora da decisão lida depois do lock (o tempo do ledger nunca anda para trás) | `test/integration/clock-after-lock.test.ts` |
| Ordem dos eventos por wallet entre lotes, entre publishers e entre instâncias com relógios diferentes; publisher com SQS lento tem teto de tempo | `test/integration/outbox-order.test.ts`, `test/integration/outbox-order-clock.test.ts`, `test/integration/outbox-seq-backfill.test.ts`, `test/integration/outbox-slow-bus.test.ts` |
| Consumidor com N laços, 1 mensagem por vez, nunca mais que a metade do pool | `test/concurrency/sqs-consumer-loops.test.ts`, `test/unit/config.test.ts` |
| Postgres fora por 20 s: a mensagem espera e é aplicada, não vai à DLQ; Postgres pendurado: 503 no prazo | `test/integration/database-outage.test.ts`, `test/integration/database-hang.test.ts` |
| SIGTERM: dreno, devolução de visibilidade, publisher e worker param entre itens, exit 0 | `test/integration/shutdown.test.ts` |
| Worker de pendências recua a wallet ocupada e não trava as outras, com relógio parado e com relógio real | `test/concurrency/pending-backoff.test.ts`, `test/concurrency/pending-backoff-realclock.test.ts` |
| Banco que só lê (failover): fila pausa, HTTP 503, nada vai à DLQ e aplica quando a escrita volta | `test/integration/database-read-only.test.ts` |
| Borda HTTP: 413 acima de 64 KiB, sem `X-Powered-By`, `ready` sem detalhe interno | `test/integration/http-edge.test.ts` |
| Reconciliação reporta a divergência feita por papel privilegiado, sem corrigir, com log e métrica | `test/integration/reconciliation.test.ts` |
| Valor das métricas (status, duplicados, latência, conflito de lock 55P03) e `messageId` no log da fila; log sem body nem valor | `test/integration/observability-values.test.ts`, `test/integration/observability.test.ts` |
| Fronteira das camadas: domínio e aplicação só importam da lista fechada (sem `@nestjs`, sem `@mikro-orm`) | `test/unit/architecture-boundaries.test.ts` |
| Atraso da retentativa da fila nunca é 0 s com teto acima de zero | `test/unit/retry-delay.test.ts` |

Como os testes ficam determinísticos:

- asserções sobre **invariantes finais** (1 débito, `saldo = soma do ledger`, contagens), nunca sobre
  ordem de chegada nem sobre qual das duas apostas venceu;
- largada com **barreira** (todas as requisições esperam uma promessa liberada de uma vez);
- contenção forçada: o teste segura `SELECT … FOR UPDATE` na wallet, espera `pg_stat_activity` mostrar
  N backends esperando lock e só então solta;
- failpoints em vez de `kill -9` por tempo;
- espera por condição (`waitFor(condição, prazo)`), não por relógio. As exceções são os cenários que
  são de tempo por natureza: a queda de 20 s do Postgres (`database-outage.test.ts`) e as janelas do
  SIGKILL e do SIGTERM em `restart.test.ts`. Neste último, a garantia é o estado final consistente, não
  que o SIGKILL tenha pegado trabalho em voo (quem prova isso é o failpoint de
  `crash-after-commit.test.ts`);
- os limites de tempo absolutos (por exemplo "outra wallet responde em menos de 2 s") foram medidos na
  minha máquina com folga; numa máquina bem mais lenta eles são o primeiro lugar a olhar;
- `Clock` injetável e prazos curtos por variável de ambiente (TTL, backoff, visibilidade);
- dados novos por teste (wallet e player com UUID novo);
- os testes de corrida rodam em laço (20 vezes) antes da entrega; um flake é bug do produto.

Diferencial opcional (`bun run test:load`): ver a situação em [§20](#20-limitações-conhecidas-e-trade-offs).

**README** (vale pontos na documentação): pré-requisitos (Docker; o Bun só se for rodar fora do
container); subir tudo com `docker compose up -d --wait`; rodar os testes com um comando
(`docker compose run --rm tests`, perfil `test` do compose); exemplos de `curl` para cada endpoint;
a regra de reenvio para o provedor ([§10.2](#102-mapa-de-status)); as variáveis de ambiente; como subir
3 instâncias (perfil `multi`); e onde ler logs e métricas.

---

## 20. Limitações conhecidas e trade-offs

- **Sem autenticação** ([§18](#18-autenticação-ponto-de-extensão)).
- **Teste de carga (`bun run test:load`) não feito.** É diferencial opcional da seção 14 do enunciado.
  O que existe é medida pontual: `bun run bench:locking` (lock pessimista contra UPDATE atômico numa
  wallet quente, [§7.3](#73-por-que-não-as-alternativas)) e `bun run bench:triggers` (custo dos
  triggers diferidos, [§6.5](#65-o-laço-saldo--ledger-no-banco)). Não há número de vazão, p50/p95/p99
  nem outbox lag sob carga sustentada.
- **Uma escala (2 casas) para toda moeda.** O modelo é multimoeda e o conflito de moeda é testado,
  mas moedas de 0 ou 3 casas pediriam escala por moeda.
- **Wallet quente:** a vazão de uma única wallet é limitada pelo lock da linha. É o preço da correção
  simples; o plano B medido é o UPDATE atômico ([§7.3](#73-por-que-não-as-alternativas)). Uma rajada
  HTTP numa só wallet também ocupa conexões do pool enquanto espera o lock (R1-02): cada espera dura no
  máximo o `lock_timeout` (5 s) e, com o pool cheio, quem chega desiste em `DB_CONNECT_TIMEOUT_MS`
  (5 s) com 503. O consumidor da fila nunca passa da metade do pool, e há teste disso
  (`sqs-consumer-loops.test.ts`). **Medido** em `test/concurrency/hot-wallet-burst.test.ts` (pool 10,
  40 POSTs numa wallet travada, prazo de conexão 2 s no teste, 3 de 3 rodadas iguais): enquanto a
  rajada segura o pool, um POST em **outra** wallet recebe 503 `DATABASE_UNAVAILABLE` com
  `Retry-After` em ~2,0 s, o `/health/ready` responde 503 em ~1,0 s e o `/health/live` continua 200;
  nada pendura e nada dá 500. Da rajada, 10 aplicam depois que o lock sai e 30 recebem 503 (podem ser
  reenviadas, nada ficou gravado). Com o lock solto, a outra wallet e o `ready` voltam sozinhos. Ou
  seja: uma wallet quente derruba a vazão da **instância** inteira enquanto dura, e o `ready` em 503 a
  tira do balanceador. Isolar a wallet quente (pool próprio ou limite de espera por wallet) ficou de fora.
- **Ordem dos eventos:** garantida por wallet, também entre publishers e entre instâncias com relógios
  diferentes, porque a ordem é a do `seq` gravado sob o lock da wallet (Lb-08 e R2b-02, §13). Ela vale
  para a publicação; a entrega continua "pelo menos uma vez", e um reenvio pode chegar depois de um
  evento mais novo. O `walletVersion`
  vai no `WalletBalanceChanged` para um consumidor futuro poder descartar evento velho ou notar buraco;
  hoje nenhum consumidor nem teste usa esse campo para isso (o consumidor de referência dos testes
  deduplica só por `eventId`).
- **A transação do publisher fica aberta durante o `SendMessage`.** **[ajuste na F4, H4]** Ela agora tem
  teto: cada envio (inclusive a busca da URL da fila) desiste em 5 s, a passada para no primeiro envio
  que falha (o SQS provavelmente caiu; testar os outros grupos só alongaria a transação) e para ao
  gastar `OUTBOX_PASS_BUDGET_MS`. O pior caso é ~10 s de transação aberta segurando só linhas da
  outbox, nunca uma wallet. A alternativa sem transação aberta seria um *lease* (`claimed_until`) com
  envio fora da transação; ficou de fora porque troca um problema de duração por um de expiração.
  Teste: `test/integration/outbox-slow-bus.test.ts`.
- **FIFO deduplica só por 5 min**; depois disso a republicação é duplicata real, coberta pelo `eventId`.
- **O dono do banco ou um superusuário consegue contornar os triggers.** A promessa é que a
  aplicação não consegue; o contorno exige papel privilegiado, que precisa ser auditado à parte.
- **O que os testes não provam sobre a AWS** (rodam no MiniStack 1.5.38, não no SQS real):
  1. a janela de deduplicação de 5 min do FIFO (nenhum teste espera 5 min; a defesa real é a inbox e o `eventId`);
  2. o comportamento sob carga e os limites de vazão do FIFO (sem teste de carga);
  3. o redrive automático por `maxReceiveCount` com processo morrendo de verdade 5 vezes; o caminho
     testado é a DLQ enviada pelo próprio consumidor;
  4. IAM, criptografia, throttling e falha de rede parcial da AWS.
  O "não entrega a seguinte do grupo enquanto a cabeça está em voo" vem da documentação da AWS e foi
  lido no código do MiniStack ([§12](#12-consumidor-sqs)).
- **Reconciliação em escala não existe.** Hoje há o endpoint por wallet e a conferência de todas as
  wallets ao fim de cada teste. Em produção eu faria um job em lotes (paginando wallets pelo id),
  incremental (conferindo só as versões novas desde o último ponto conferido de cada wallet) e com o
  resultado numa tabela, para não varrer o ledger inteiro a cada vez.
- **`ready` depende do SQS** (como pede o enunciado): com o SQS fora, a instância sai do balanceador,
  mesmo podendo atender o POST síncrono. Em produção eu separaria os dois sinais.
- **Senhas de desenvolvimento** no compose e na migration (`wager`, `wager_app`). Em produção, viriam
  de um gerenciador de segredos. Por isso o compose publica as portas só em `127.0.0.1`, e o container
  do app roda com o usuário sem privilégio da imagem (`bun`), não como root.
- **Borda HTTP mínima:** corpo limitado a 64 KiB (413), sem o header `X-Powered-By`, e o
  `/health/ready`, que é aberto, devolve só `ok`/`fail` por dependência (a mensagem do erro vai para o
  log). Não há rate limit nem conferência de `Content-Type`: isso fica no gateway.
- **Ledger e outbox crescem sem poda.** Arquivamento e particionamento estão fora do escopo.
- **`PENDING` não é gravado** ([§4.3](#43-wagertransaction-e-estados)). Se um dia o aceite virar
  assíncrono (202 e depois o processamento), o schema já aceita o estado.
- **Esgotar as tentativas transitórias não grava nada**: a mensagem fica só na DLQ até o redrive. O
  provedor que perguntar pelo GET nesse intervalo recebe 404. Foi escolhido assim para não transformar
  um incidente passageiro num `FAILED` definitivo.
- **A fila de eventos não tem consumidor de produção** neste desafio; o consumidor de referência
  existe só nos testes, para provar o contrato de deduplicação por `eventId`.
- **Pegadinhas da stack que custaram tempo** (todas medidas; detalhe nas seções citadas):
  - MikroORM: dentro de `em.transactional`, `conn.execute()` pega outra conexão e trava o pool; usar
    `em.execute()` ([§3](#3-camadas-e-pastas)). O EM global recusa operação fora de contexto: um
    `em.fork()` por mensagem ([§12](#12-consumidor-sqs)). `PESSIMISTIC_PARTIAL_WRITE` vira
    `SKIP LOCKED` (bom na outbox, nunca na wallet).
  - NestJS + MikroORM: o pool fecha em `onApplicationShutdown`; o dreno do SIGTERM tem de ficar em
    `beforeApplicationShutdown` ([§12](#12-consumidor-sqs)).
  - Bun: `process.kill(process.pid, 'SIGKILL')` sai com 137 e serve de failpoint ([§16](#16-falhas-e-recuperação));
    o SIGTERM no Windows não é confiável, por isso os testes rodam no Linux do container ([§19](#19-estratégia-de-testes)).
  - Postgres: `numeric(20,2)` arredonda casa a mais em silêncio, então a validação de 2 casas no
    `Money` é obrigatória ([§4.1](#41-money)); migration já aplicada não se edita, mudança de schema vai
    numa migration nova.
- **Complexidade:** triggers diferidos, papel separado no banco, failpoints e consumidor próprio são
  mecanismos a mais para manter. Cada um responde a um item avaliado (restrição 9, ledger imutável,
  teste 5 da seção 13, seção 10). Se o prazo apertar, o primeiro a sair é o trigger diferido, que vira
  checagem só no teste.

---

## 21. Referências

- PostgreSQL 17/18: isolamento (READ COMMITTED reavalia a linha travada) — https://www.postgresql.org/docs/current/transaction-iso.html ·
  locks explícitos e deadlock — https://www.postgresql.org/docs/current/explicit-locking.html ·
  `SELECT … FOR UPDATE / SKIP LOCKED` — https://www.postgresql.org/docs/current/sql-select.html ·
  espera no índice único — https://www.postgresql.org/docs/current/index-unique-checks.html ·
  `INSERT … ON CONFLICT` — https://www.postgresql.org/docs/current/sql-insert.html ·
  triggers (TRUNCATE só por statement; constraint trigger diferido) — https://www.postgresql.org/docs/current/sql-createtrigger.html ·
  `numeric` arredonda escala a mais em silêncio — https://www.postgresql.org/docs/current/datatype-numeric.html ·
  SQLSTATE — https://www.postgresql.org/docs/current/errcodes-appendix.html
- MikroORM 7: transações e `LockMode` — https://mikro-orm.io/docs/transactions · migrations — https://mikro-orm.io/docs/migrations ·
  `defineEntity` — https://mikro-orm.io/docs/defining-entities · NestJS — https://mikro-orm.io/docs/usage-with-nestjs
- NestJS, ciclo de vida e shutdown hooks — https://docs.nestjs.com/fundamentals/lifecycle-events
- AWS SQS: FIFO — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html ·
  exactly-once e janela de 5 min — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html ·
  visibilidade — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html ·
  DLQ — https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html
- LocalStack com token desde 23/03/2026 — https://blog.localstack.cloud/localstack-single-image-next-steps/ · MiniStack — https://github.com/ministackorg/ministack
- Transactional Outbox e Idempotent Consumer — https://microservices.io/patterns/data/transactional-outbox.html ·
  https://microservices.io/patterns/communication-style/idempotent-consumer.html
- Idempotência: Stripe — https://docs.stripe.com/api/idempotent_requests · Brandur Leach — https://brandur.org/idempotency-keys ·
  AWS Builders Library — https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/ ·
  rascunho IETF `Idempotency-Key` — https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header
- RFC 8785 (JCS) — https://www.rfc-editor.org/rfc/rfc8785 · `canonicalize` — https://github.com/erdtman/canonicalize ·
  RFC 9457 (problem+json) — https://www.rfc-editor.org/rfc/rfc9457.html
- decimal.js — https://mikemcl.github.io/decimal.js/
- Códigos de mercado de seamless wallet (Hub88) — https://docs.hub88.io/developer-docs/supplier-api-reference/supplier-api-overview/seamless-wallet-response-statuses-supplier-api
- Bun: testes em paralelo — https://bun.com/docs/test/parallel · processos filhos — https://bun.com/docs/runtime/child-process
