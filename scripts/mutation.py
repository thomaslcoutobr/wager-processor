"""Hand-written mutation test: plants one bug at a time in a COPY of src/, runs the whole suite in
Docker with that copy mounted over the test image, and records whether any test went red. The real
src/ is never written. A mutant that survives points to a weak test for that rule.

Usage (Docker running, from solucao/):  python scripts/mutation.py [M01 M02 ...]
Output: scripts/mutation-result.json and one line per mutant on stdout.
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = Path(__file__).with_name("mutation-result.json")
INITIAL_MIGRATION = "infrastructure/persistence/migrations/Migration20261107000100_schema.ts"

# (name, [(file under src/, exact text, replacement)])
MUTANTS = [
    ("M01 no pessimistic lock on the wallet", [("infrastructure/persistence/mikro-unit-of-work.ts",
        "{ id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE }", "{ id: walletId }")]),
    ("M02 domain debits without funds", [("domain/wallet.ts",
        'if (this._balance.isLessThan(m.money)) return { ok: false, reason: "INSUFFICIENT_FUNDS" };',
        'if (false) return { ok: false, reason: "INSUFFICIENT_FUNDS" };')]),
    ("M03 inbox ignored (fast path and in the transaction)", [("application/submit-wager-transaction.ts",
        "if (seen) return seen.matchesPayload(hash)", "if (false) return seen!.matchesPayload(hash)"),
        ("application/submit-wager-transaction.ts",
        "if (existing) return existing.matchesPayload(hash)", "if (false) return existing!.matchesPayload(hash)")]),
    ("M04 different payload hash becomes a replay", [("application/submit-wager-transaction.ts",
        'if (byKey?.matchesPayload(hash)) return { type: "decided"', 'if (byKey) return { type: "decided"')]),
    ("M05 domain skips ALREADY_REVERSED", [("domain/wager-settlement.ts",
        'if (input.referenceAlreadyReversed) return reject("ALREADY_REVERSED", ref.id);', "")]),
    ("M06 schema without CHECK balance >= 0", [(INITIAL_MIGRATION,
        "balance    numeric(20,2) NOT NULL CHECK (balance >= 0),", "balance    numeric(20,2) NOT NULL,")]),
    ("M07 ledger accepts UPDATE (trigger only on DELETE)", [(INITIAL_MIGRATION,
        "BEFORE UPDATE OR DELETE ON wallet_ledger_entries", "BEFORE DELETE ON wallet_ledger_entries")]),
    ("M08 consumer acks on retry", [("infrastructure/messaging/sqs-consumer.ts",
        'if (outcome.action === "ack") {', 'if (outcome.action === "ack" || outcome.action === "retry") {')]),
    ("M09 outbox never marks published", [("application/publish-outbox-batch.ts",
        "message.markPublished(now);", "")]),
    ("M10 outbox without SKIP LOCKED", [("infrastructure/persistence/mikro-unit-of-work.ts",
        "for update of o skip locked", "for update of o")]),
    ("M11 reconciliation always consistent", [("application/reconcile-wallet.ts",
        "const consistent = difference.isZero() && r.chainBreaks === 0;", "const consistent = true;")]),
    ("M12 pending TTL never expires", [("domain/pending-reference-policy.ts",
        "return now.getTime() >= deadlineAt.getTime();", "return false;")]),
    ("M13 Money accepts 3 decimals", [("domain/money.ts",
        r"const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;", r"const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2,3}$/;")]),
    ("M14 503 without Retry-After", [("interfaces/http/problem.ts",
        'return new ProblemException(503, exception.code, exception.message, "SAME_REQUEST", {}, { "Retry-After": "1" });',
        'return new ProblemException(503, exception.code, exception.message, "SAME_REQUEST", {}, {});')]),
    ("M15 no lock_timeout", [("infrastructure/persistence/mikro-unit-of-work.ts",
        "await em.execute(`set local lock_timeout = '${Math.trunc(this.lockTimeoutMs)}ms'`);", "")]),
    ("M16 REFUND accepts a WIN as reference", [("domain/wager-settlement.ts",
        "[Kind.Refund]: new Set([Kind.Bet]),", "[Kind.Refund]: new Set([Kind.Bet, Kind.Win]),")]),
    ("M17 SIGTERM does not wait for messages in flight", [("infrastructure/messaging/sqs-consumer.ts",
        "Promise.allSettled(this.loops).then(() => true),", "Promise.resolve(true),")]),
    ("M18 missing reference is REJECTED at once", [("domain/wager-settlement.ts",
        'if (!ref) return waitOrExpire("REFERENCE_NOT_FOUND");', 'if (!ref) return reject("REFERENCE_NOT_FOUND");')]),
    ("M19 reversal without funds uses the BET code", [("domain/wager-settlement.ts",
        'return reject(tx.requiresReference() ? "REVERSAL_INSUFFICIENT_FUNDS" : "INSUFFICIENT_FUNDS", reference?.id);',
        'return reject("INSUFFICIENT_FUNDS", reference?.id);')]),
    ("M20 reversal with another amount accepted", [("domain/wager-settlement.ts",
        'if (!tx.money.equals(ref.money)) return reject("AMOUNT_MISMATCH", ref.id);', "")]),
]


def run_suite(name: str, src_copy: Path) -> dict:
    cname = "mut_" + re.sub(r"[^a-z0-9]", "", name.lower())[:20]
    cmd = ["docker", "compose", "--profile", "test", "run", "--rm", "--name", cname,
           "-v", f"{src_copy.as_posix()}:/app/src:ro",
           "-v", f"{(REPO / 'test').as_posix()}:/app/test:ro",
           "tests", "bun", "test", "--timeout", "120000"]
    started = time.time()
    try:
        p = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
        out = p.stdout + p.stderr
        timed_out = False
    except subprocess.TimeoutExpired as e:
        subprocess.run(["docker", "rm", "-f", cname], capture_output=True)
        raw = e.stdout or ""
        out = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
        timed_out = True
    m_pass = re.search(r"^\s*(\d+) pass", out, re.M)
    m_fail = re.search(r"^\s*(\d+) fail", out, re.M)
    failed = [line.strip() for line in out.splitlines() if line.strip().startswith("(fail)")]
    return {
        "pass": int(m_pass.group(1)) if m_pass else None,
        "fail": int(m_fail.group(1)) if m_fail else None,
        "timed_out": timed_out,
        "seconds": round(time.time() - started),
        "failed_tests": failed[:12],
    }


def main() -> None:
    only = set(sys.argv[1:])
    commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"],
                            capture_output=True, text=True).stdout.strip()
    results = []
    work = Path(tempfile.mkdtemp(prefix="mutation-"))
    try:
        for name, edits in MUTANTS:
            if only and name.split()[0] not in only:
                continue
            src_copy = work / name.split()[0] / "src"
            shutil.copytree(REPO / "src", src_copy)
            invalid = None
            for rel, old, new in edits:
                path = src_copy / rel
                text = path.read_text(encoding="utf-8")
                if text.count(old) != 1:
                    invalid = f"snippet found {text.count(old)}x in {rel}"
                    break
                path.write_text(text.replace(old, new), encoding="utf-8", newline="")
            if invalid:
                results.append({"mutant": name, "invalid": invalid})
                print(f"{name}: INVALID ({invalid})", flush=True)
                continue
            r = run_suite(name, src_copy)
            killed = r["timed_out"] or (r["fail"] or 0) > 0 or r["pass"] is None
            results.append({"mutant": name, "killed": killed, **r})
            print(f"{name}: {'KILLED' if killed else 'SURVIVED'} pass={r['pass']} fail={r['fail']} t={r['seconds']}s", flush=True)
            OUT.write_text(json.dumps({"commit": commit, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    finally:
        shutil.rmtree(work, ignore_errors=True)
        OUT.write_text(json.dumps({"commit": commit, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    killed = sum(1 for r in results if r.get("killed"))
    print(f"{killed} of {len(results)} killed (commit {commit})", flush=True)


if __name__ == "__main__":
    main()
