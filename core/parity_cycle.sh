#!/usr/bin/env bash
# velab-parity cycle: deterministic parity check, then the LLM triage of any NEW
# deletions it found. parity.py exit 2 = crash (fails the service -> visible in
# systemctl + caught as stale by the Auditor). Triage is advisory and never fails
# the cycle. Findings are surfaced to the operator via parity.json/deletion-triage.json
# -> the Auditor's audit.json banner on the digest and console.
set -uo pipefail
cd /opt/velab/core || exit 3
/usr/bin/python3 /opt/velab/core/parity.py
rc=$?
/usr/bin/python3 /opt/velab/core/deletion_triage.py || true
exit $rc
