"""Apply each reference overlay onto the seed in a temp dir; run seed tests and the scenario oracle. Exit non-zero on any failure."""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCENARIOS = {"quick": "test_quick.py", "solid": "test_solid.py", "major": "test_major.py"}


def overlay(seed, ref, dest):
    shutil.copytree(seed, dest, ignore=shutil.ignore_patterns("xforge-seed"))
    for root, _, files in os.walk(ref):
        for f in files:
            src = os.path.join(root, f)
            rel = os.path.relpath(src, ref)
            target = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy(src, target)


def main():
    failed = []
    for name, oracle in SCENARIOS.items():
        with tempfile.TemporaryDirectory() as tmp:
            dest = os.path.join(tmp, "proj")
            overlay(os.path.join(HERE, "seed"), os.path.join(HERE, "reference", name), dest)
            shutil.copy(os.path.join(HERE, "oracle", oracle), os.path.join(dest, "tests", "test_oracle.py"))
            r = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=dest, capture_output=True, text=True)
            tail = r.stderr.strip().splitlines()[-1] if r.stderr.strip() else ""
            print(f"{name}: {'ok' if r.returncode == 0 else 'FAIL'} — {tail}")
            if r.returncode != 0:
                print(r.stderr)
                failed.append(name)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
