#!/bin/sh
# Interleaved A/B runs of both apps (so system load hits both alike), then medians. Usage: bench/e2e/run.sh [N]
cd "$(dirname "$0")/../.." || exit 1
N=${1:-5}
OUT=$(mktemp)
i=0; while [ $i -lt $N ]; do i=$((i+1))
  BENCH=1 timeout 300 npx electron bench/e2e/xterm-app/main.js 2>&1 | grep '^RESULT' >> "$OUT"
  BENCH=1 timeout 300 npx electron . 2>&1 | grep '^RESULT' >> "$OUT"
done
python3 - "$OUT" <<'PY'
import sys, json, statistics as st
runs = {}
for l in open(sys.argv[1]):
    d = json.loads(l[7:]); runs.setdefault(d['label'], []).append(d)
for label, rs in runs.items():
    ok = [r for r in rs if r['done']]
    f = lambda k: ' '.join('%.1f' % r[k] for r in rs)
    print('%s  (%d/%d completed)' % (label, len(ok), len(rs)))
    print('   seconds     :', f('seconds'), ' median %.2f' % st.median(r['seconds'] for r in ok))
    print('   MB/s        :', f('MBps'), ' median %.1f' % st.median(r['MBps'] for r in ok))
    print('   idle MB     :', f('idleMB'), ' median %.1f' % st.median(r['idleMB'] for r in rs))
    print('   settled MB  :', f('settledMB'), ' median %.1f' % st.median(r['settledMB'] for r in rs))
PY
