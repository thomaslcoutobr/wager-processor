#!/bin/bash
# Cria as filas FIFO com DLQ FIFO e redrive policy:
#   wager-transactions.fifo -> wager-transactions-dlq.fifo  (entrada de comandos)
#   wager-events.fifo       -> wager-events-dlq.fifo        (saida dos eventos da outbox)
# Roda no estagio "ready" (LocalStack e MiniStack usam o mesmo caminho /etc/localstack/init/ready.d).
set -euo pipefail

# LocalStack traz `awslocal`; MiniStack injeta AWS_ENDPOINT_URL e traz o `aws` CLI.
if command -v awslocal >/dev/null 2>&1; then AWS="awslocal"; else AWS="aws"; fi

MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-5}"

create_pair() {
  local main="$1" dlq="$2"
  local dlq_url dlq_arn attr_file
  dlq_url=$($AWS sqs create-queue --queue-name "$dlq" \
    --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true","MessageRetentionPeriod":"1209600"}' \
    --query QueueUrl --output text)
  dlq_arn=$($AWS sqs get-queue-attributes --queue-url "$dlq_url" \
    --attribute-names QueueArn --query Attributes.QueueArn --output text)

  # RedrivePolicy e uma string JSON dentro do JSON de atributos -> arquivo para nao brigar com aspas.
  attr_file="$(mktemp)"
  cat > "$attr_file" <<EOF
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "true",
  "VisibilityTimeout": "30",
  "ReceiveMessageWaitTimeSeconds": "20",
  "MessageRetentionPeriod": "345600",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
EOF
  $AWS sqs create-queue --queue-name "$main" --attributes "file://${attr_file}" >/dev/null
  rm -f "$attr_file"
  echo "[init] filas criadas: $main -> $dlq (maxReceiveCount=${MAX_RECEIVE_COUNT})"
}

create_pair "wager-transactions.fifo" "wager-transactions-dlq.fifo"
create_pair "wager-events.fifo" "wager-events-dlq.fifo"
