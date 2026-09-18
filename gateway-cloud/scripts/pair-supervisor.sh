#!/bin/bash
set -a
source /app/.agents/.env >/dev/null 2>&1
set +a
cd /app/conversations/6aa6589f5d5b4135aed4d2a3/iubcr/gateway-cloud
MAX=10
i=0
while [ $i -lt $MAX ]; do
  i=$((i+1))
  node scripts/pair-sandbox.mjs 923019670950 >> /tmp/pair.log 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then
    echo "SUPERVISOR: PAIRED+imported (cycle $i)" >> /tmp/pair.log
    exit 0
  fi
  echo "SUPERVISOR: cycle $i ended (rc=$rc), restart in 3s" >> /tmp/pair.log
  sleep 3
done
echo "SUPERVISOR: MAX cycles reached — stopped." >> /tmp/pair.log
