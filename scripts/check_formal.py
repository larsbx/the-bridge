#!/usr/bin/env python3
"""Fail-closed TLC safety checks and named counterexample controls (stdlib only)."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = "1.7.4"
URL = f"https://github.com/tlaplus/tlaplus/releases/download/v{VERSION}/tla2tools.jar"
SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
CONTROLS = {
    "StaleAccounts": "ActiveMatchesSnapshot",
    "DeleteHistory": "HistoryMatchesSync",
    "CrossItem": "ItemIsolation",
    "EarlyCursor": "CursorAtomic",
    "NoLock": "PerItemMutex",
    "EarlyNotification": "NoEarlyNotification",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    output = ROOT / "_build" / "formal"
    output.mkdir(parents=True, exist_ok=True)
    # Never upload a previous successful receipt after a failed rerun.
    for name in ["report.json", "None.log", *(f"{m}.log" for m in CONTROLS)]:
        (output / name).unlink(missing_ok=True)
    # An override changes the location, never the accepted tool digest.
    jar = Path(os.environ.get("TLA2TOOLS_JAR", output / "tla2tools.jar")).resolve()
    if not jar.exists():
        jar.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(URL, timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != SHA256:
            raise RuntimeError("Downloaded TLC archive checksum mismatch")
        jar.write_bytes(data)
    if digest(jar) != SHA256:
        raise RuntimeError("TLC archive checksum mismatch")

    spec = ROOT / "formal" / "Reconciliation.tla"
    config = ROOT / "formal" / "Reconciliation.cfg"
    report = {
        "tool": {"version": VERSION, "url": URL, "sha256": SHA256},
        "inputs": {str(p.relative_to(ROOT)): digest(p) for p in (spec, config, Path(__file__).resolve())},
        "scope": "2 Items, 2 workers, 2 account/transaction identities, 6 request shapes, cursor parity",
        "checks": [],
    }
    for mutation, violation in {"None": None, **CONTROLS}.items():
        with tempfile.TemporaryDirectory(prefix="bridge-tlc-") as temp:
            work = Path(temp)
            (work / spec.name).write_bytes(spec.read_bytes())
            (work / config.name).write_text(
                config.read_text().replace('Mutation = "None"', f'Mutation = "{mutation}"')
            )
            command = [
                "java", "-XX:+UseParallelGC", "-Xmx2g", "-cp", str(jar), "tlc2.TLC",
                "-workers", "1", "-seed", "1", "-fp", "0",
                "-metadir", str(work / "states"), "-config", config.name, spec.name,
            ]
            result = subprocess.run(command, cwd=work, text=True, capture_output=True, timeout=180)
            log = result.stdout + result.stderr
            (output / f"{mutation}.log").write_text(log)
            stats = re.search(r"([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left", log)
            if violation is None:
                valid = (result.returncode == 0 and
                         "Model checking completed. No error has been found." in log and
                         stats is not None and int(stats[3].replace(",", "")) == 0)
            else:
                # A parser error, timeout, unrelated invariant, or missing tool is NOT a successful control.
                valid = (result.returncode == 12 and
                         f"Invariant {violation} is violated." in log and
                         "The behavior up to this point is:" in log)
            if not valid:
                print(log, flush=True)
                raise RuntimeError(f"{mutation}: expected {violation or 'complete successful exploration'}, exit {result.returncode}")
            entry = {"mutation": mutation, "expected_violation": violation, "exit_code": result.returncode}
            if stats:
                entry.update(generated=int(stats[1].replace(",", "")), distinct=int(stats[2].replace(",", "")))
            report["checks"].append(entry)
            print(f"PASS {mutation}: {violation or 'complete safety exploration'} ({entry.get('distinct', '?')} states)", flush=True)
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Evidence: {output.relative_to(ROOT)}/report.json", flush=True)


if __name__ == "__main__":
    main()
