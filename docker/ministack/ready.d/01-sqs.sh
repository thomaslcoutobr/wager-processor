#!/bin/bash
# Cria a DLQ FIFO e a fila principal FIFO com redrive policy.
# Roda no estagio "ready" (LocalStack e MiniStack usam o mesmo caminho /etc/localstack/init/ready.d).
set -euo pipefail

# LocalStack traz `awslocal`; MiniStack injeta AWS_ENDPOINT_URL e traz o `aws` CLI.
if command -v awslocal >/dev/null 2>&1; then AWS="awslocal"; else AWS="aws"; fi

MAIN="wager-transactions.fifo"
DLQ="wager-transactions-dlq.fifo"
MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-5}"

DLQ_URL=$($AWS sqs create-queue --queue-name "$DLQ" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true","MessageRetentionPeriod":"1209600"}' \
  --query QueueUrl --output text)

DLQ_ARN=$($AWS sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# RedrivePolicy e uma string JSON dentro do JSON de atributos -> grava em arquivo para nao brigar com aspas.
ATTR_FILE="$(mktemp)"
cat > "$ATTR_FILE" <<EOF
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "true",
  "VisibilityTimeout": "30",
  "ReceiveMessageWaitTimeSeconds": "20",
  "MessageRetentionPeriod": "345600",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
EOF

$AWS sqs create-queue --queue-name "$MAIN" --attributes "file://${ATTR_FILE}" >/dev/null
rm -f "$ATTR_FILE"
echo "[init] filas criadas: $MAIN -> $DLQ (maxReceiveCount=${MAX_RECEIVE_COUNT})"
