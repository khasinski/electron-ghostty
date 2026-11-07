#!/bin/sh
# Interleaved A/B of the write path (xterm.js vs electron-ghostty xterm-style facade) with a NOOP baseline per engine
# to subtract the page's own copy of the corpus. Usage: bench/write-path/run.sh [N]   (needs bench/e2e/corpus.txt)
cd "$(dirname "$0")/../.." || exit 1
N=${1:-5}
OUT=$(mktemp)
i=0; while [ $i -lt $N ]; do i=$((i+1))
  for e in xterm ghostty; do
    ENGINE=$e timeout 200 npx electron bench/write-path/main.js 2>&1 | grep '^RESULT' >> "$OUT"
    NOOP=1 ENGINE=$e timeout 200 npx electron bench/write-path/main.js 2>&1 | grep '^RESULT' >> "$OUT"
  done
done
python3 - "$OUT" <<'PY'
import sys, json, statistics as st
runs = {}
for l in open(sys.argv[1]):
    d = json.loads(l[7:]); runs.setdefault(d['engine'], []).append(d)
med = lambda e, k: st.median(r[k] for r in runs[e])
for e in ('xterm', 'ghostty'):
    base = med(e + '(noop)', 'settledMB')
    print('%-8s seconds %.2f  MB/s %.1f  settled %.0f MB  (noop baseline %.0f)  => terminal memory %.0f MB  [%d runs]' %
          (e, med(e, 'seconds'), med(e, 'MBps'), med(e, 'settledMB'), base, med(e, 'settledMB') - base, len(runs[e])))
PY
