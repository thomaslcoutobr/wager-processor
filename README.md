# Wager Processor

Serviço de carteira e apostas para o desafio de backend da Jungle Gaming. Ele recebe `BET`, `WIN`,
`LOSS`, `REFUND` e `ROLLBACK` por HTTP e por fila SQS FIFO e aplica cada operação **uma vez só**. Guarda
um ledger imutável, publica eventos por outbox e roda com várias instâncias ao mesmo tempo.

Stack: Bun 1.4.4 · NestJS 12 · MikroORM 7 · PostgreSQL 17 · SQS (MiniStack 1.5.38 no lugar da AWS).

As decisões, os trade-offs e as limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**. Este
arquivo explica como rodar.

## Pré-requisitos

- Docker com Compose v2. Só isso: app, migrations e testes rodam em containers Linux.
- Bun 1.4.4 só para rodar fora do container (não é o caminho documentado).

Portas usadas no host: 3000 (app), 5433 (Postgres) e 4566 (SQS). Para trocar, use `APP_HOST_PORT`,
`POSTGRES_HOST_PORT` e `SQS_HOST_PORT`.

## Subir

```bash
docker compose up -d --wait
```

Isso sobe o Postgres e o MiniStack, que cria as filas FIFO `wager-transactions.fifo` e
`wager-events.fifo`, cada uma com a sua DLQ. Depois roda as migrations uma vez, como dono das tabelas,
e sobe o app como o papel `wager_app`, que não tem `UPDATE`, `DELETE` nem `TRUNCATE` no ledger. O
`--wait` só volta quando `/health/ready` responde 200.

```bash
curl -s localhost:3000/health/ready     # {"status":"ok","checks":{...}}
docker compose down -v                  # derruba tudo e apaga os dados
```

### Três instâncias

```bash
docker compose --profile multi up -d --wait     # instâncias nas portas 3000, 3001 e 3002
```

Toda instância roda HTTP, consumidor SQS, publisher da outbox e worker de pendências. Elas não
conversam entre si: a exclusão mútua fica toda no Postgres (lock de linha da wallet, `SKIP LOCKED`
na outbox e unicidades).

## Testes

```bash
docker compose --profile test run --rm tests
```

Roda o `tsc` em modo estrito e depois a suíte inteira (unidade, integração e concorrência) dentro do
Linux, contra o Postgres e o MiniStack reais do compose. Não há mock de banco nem de fila. Cada arquivo
de teste cria e apaga o próprio banco. Leva uns 2 minutos.

Um arquivo só:

```bash
docker compose --profile test run --rm tests bun test test/concurrency/hot-wallet.test.ts --timeout 120000
```

A imagem de teste copia o código no build. Depois de mudar o código, rode
`docker compose --profile test build tests` antes.

Benchmarks (opcionais), no mesmo container: `bun run bench:locking` e `bun run bench:triggers`.

## Exemplos de uso

Crie uma wallet. O saldo inicial vira uma transação interna `OPENING`, com lançamento no ledger.

```bash
curl -s -X POST localhost:3000/wallets -H 'Content-Type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# 201 {"id":"<WALLET_ID>","playerId":"player-1","balance":{"amount":"100.00","currency":"BRL"},"version":1,...}
WALLET=<WALLET_ID>
```

Aposta (`BET`). O header `Idempotency-Key` é obrigatório; o padrão sugerido é
`providerId:externalTransactionId`.

```bash
curl -s -X POST localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1",
       "walletId":"'"$WALLET"'","roundId":"round-1","gameId":"fortune-chimp",
       "kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# 200 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}
```

Repetir o mesmo pedido devolve a mesma resposta, sem debitar de novo, com `idempotentReplay: true` e
o header `Idempotent-Replayed: true`. A mesma chave com outro corpo dá 409.

Ganho e estorno:

```bash
# WIN de 40,00 na mesma rodada
curl -s -X POST localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-2' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-2","playerId":"player-1",
       "walletId":"'"$WALLET"'","roundId":"round-1","gameId":"fortune-chimp",
       "kind":"WIN","money":{"amount":"40.00","currency":"BRL"}}'

# ROLLBACK da aposta tx-1 (mesmo valor e referência obrigatória)
curl -s -X POST localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-3' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-3","playerId":"player-1",
       "walletId":"'"$WALLET"'","roundId":"round-1","gameId":"fortune-chimp",
       "kind":"ROLLBACK","referenceExternalTransactionId":"tx-1","money":{"amount":"25.00","currency":"BRL"}}'
```

Uma reversão que chega antes da transação que ela referencia responde **202** com `Location` e fica
`PENDING_REFERENCE`. Ela é aplicada quando a referência chega, ou rejeitada depois do TTL (10 min).

Consultas:

```bash
curl -s localhost:3000/wallets/$WALLET                                   # saldo e versão
curl -s "localhost:3000/wallets/$WALLET/ledger?limit=50"                 # ledger paginado (próxima página: ?cursor=<nextCursor>)
curl -s localhost:3000/wagering/transactions/<TRANSACTION_ID>            # transação pelo nosso id
curl -s localhost:3000/providers/provider-a/wagering/transactions/tx-1   # transação pelo id do provedor
curl -s -X POST localhost:3000/wallets/$WALLET/reconciliation            # saldo x ledger
curl -s localhost:3000/health/live
curl -s localhost:3000/metrics                                           # Prometheus
```

Pela fila (o mesmo use case do HTTP, deduplicado pela inbox por `messageId`):

```bash
# o aws CLI que vem no container do MiniStack; credenciais falsas, o emulador não confere
AWSX="docker compose exec -T -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_DEFAULT_REGION=us-east-1 aws aws --endpoint-url http://localhost:4566"
QUEUE=$($AWSX sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)
$AWSX sqs send-message --queue-url "$QUEUE" \
  --message-group-id "$WALLET" --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-11-09T12:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"tx-4","idempotencyKey":"provider-a:tx-4",
    "playerId":"player-1","walletId":"'"$WALLET"'","roundId":"round-2","gameId":"fortune-chimp",
    "kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

## Regra de reenvio para o provedor

O código HTTP sozinho diz o que fazer:

| Código | Significa | O provedor |
|---|---|---|
| 200 | aplicada | segue |
| 202 | aceita e pendente (`PENDING_REFERENCE`) | consulta o `Location` ou espera o evento |
| 422 | rejeitada por regra de negócio (saldo, moeda, referência...); é final | não reenvia |
| 400 / 404 / 409 | o pedido está errado (payload, wallet inexistente, chave reutilizada) | corrige; não reenvia igual |
| 503 (com `Retry-After`), outro 5xx ou queda de rede | falha transitória | reenvia **a mesma chave e o mesmo corpo**, com backoff |

O corpo traz `status`, `failureCode` (taxonomia na ARCHITECTURE §11) e `retry` (`NEVER`, `AFTER_FIX`,
`SAME_REQUEST` ou `POLL`). Erros vêm em `application/problem+json` (RFC 9457). O único 5xx que não se
reenvia é o replay de uma transação `FAILED`, que traz `retry: "NEVER"` (ARCHITECTURE §10.2).

## Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `DATABASE_URL` | obrigatória | conexão do app, como `wager_app` |
| `DATABASE_MIGRATION_URL` | obrigatória no `migrate` | conexão do dono das tabelas, só para as migrations |
| `PORT` | 3000 | porta HTTP |
| `DB_POOL_MAX` | 10 | conexões no pool |
| `LOCK_TIMEOUT_MS` | 5000 | espera máxima pelo lock da wallet; passou, 503 `LOCK_TIMEOUT` |
| `DB_CONNECT_TIMEOUT_MS` / `DB_QUERY_TIMEOUT_MS` | 5000 / 15000 | prazos do cliente do Postgres |
| `SQS_ENDPOINT` | vazio (AWS) | endpoint do emulador |
| `AWS_REGION` | us-east-1 | região |
| `SQS_QUEUE_NAME` / `SQS_DLQ_NAME` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` | fila de entrada |
| `SQS_EVENTS_QUEUE_NAME` / `SQS_EVENTS_DLQ_NAME` | `wager-events.fifo` / `wager-events-dlq.fifo` | fila dos eventos |
| `SQS_CONSUMER_CONCURRENCY` | 4 | laços de recebimento (no máximo metade do pool) |
| `SQS_VISIBILITY_TIMEOUT_S` / `SQS_WAIT_TIME_S` / `SQS_MAX_RECEIVE_COUNT` | 30 / 20 / 5 | fila de entrada |
| `SQS_RETRY_BASE_MS` / `SQS_RETRY_MAX_MS` | 1000 / 30000 | backoff das retentativas |
| `OUTBOX_POLL_MS` / `OUTBOX_BATCH_SIZE` / `OUTBOX_PASS_BUDGET_MS` | 200 / 10 / 5000 | publisher da outbox |
| `PENDING_REFERENCE_TTL_SECONDS` | 600 | quanto tempo uma reversão espera a referência |
| `PENDING_POLL_MS` / `PENDING_BATCH_SIZE` | 500 / 20 | worker de pendências |
| `ENABLE_SQS_CONSUMER` / `ENABLE_OUTBOX_PUBLISHER` / `ENABLE_PENDING_WORKER` | true | liga cada papel da instância |
| `SHUTDOWN_GRACE_MS` | 8000 | prazo do dreno no SIGTERM (o compose dá 20 s antes do SIGKILL) |
| `LOG_LEVEL` | info | nível do log |
| `FAILPOINTS` | vazio | injeção de falha para testes; com `NODE_ENV=production`, o app recusa subir |

## Logs e métricas

- **Logs:** JSON (pino) no stdout, em `docker compose logs -f app`. Toda linha de uma requisição ou
  mensagem traz o `correlationId` (header `X-Correlation-Id`, aceito ou gerado) e, quando houver,
  `messageId`, `transactionId`, `walletId` e `providerId`. O corpo da requisição e os valores não vão
  para o log.
- **Métricas:** `GET /metrics` (Prometheus). As principais:
  - `wager_transactions_total`, por status, kind e origem;
  - `wager_duplicates_total`;
  - `wallet_lock_wait_seconds` e `db_lock_conflicts_total`;
  - `sqs_retries_total`, `sqs_dlq_total` e `sqs_consumer_paused`;
  - `outbox_pending` e `outbox_lag_seconds`;
  - `pending_reference_total`;
  - `reconciliation_divergence_total`.
- **Saúde:** `/health/live` diz que o processo está de pé. `/health/ready` diz que o Postgres e as duas
  filas respondem, e dá 503 durante o desligamento.

## Estrutura

```
src/domain           Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox e eventos (sem framework)
src/application      use cases (SubmitWagerTransaction, PublishOutboxBatch, ResolvePendingReference...) e portas
src/infrastructure   MikroORM (schemas, mappers, migration em SQL), SQS (consumidor próprio), workers, logs e métricas
src/interfaces/http  controllers NestJS, mapa de status e problem+json
test/                unit, integration e concurrency
```
