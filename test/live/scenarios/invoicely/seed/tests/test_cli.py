import json
import os
import subprocess
import sys
import tempfile
import unittest


def run(store, *args):
    env = dict(os.environ, PYTHONPATH=os.getcwd())
    return subprocess.run([sys.executable, "-m", "invoicely", "--store", store, *args], capture_output=True, text=True, env=env)


class CliTests(unittest.TestCase):
    def test_round_trip_through_the_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = os.path.join(tmp, "s.json")
            added = run(store, "customer", "add", "Ada", "ada@example.com")
            self.assertEqual(added.returncode, 0, added.stderr)
            cid = json.loads(added.stdout)["id"]
            created = run(store, "invoice", "create", cid, "--issued", "2026-01-01", "--due", "2026-01-31", "--tax", "0.2", "--item", "hours:2:50")
            self.assertEqual(created.returncode, 0, created.stderr)
            listed = run(store, "invoice", "list")
            rows = [json.loads(line) for line in listed.stdout.splitlines()]
            self.assertEqual(rows[0]["total"], 120.0)
            self.assertEqual(rows[0]["status"], "open")

    def test_errors_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = os.path.join(tmp, "s.json")
            missing = run(store, "invoice", "create", "CUS-9999", "--issued", "2026-01-01", "--due", "2026-01-31", "--item", "x:1:1")
            self.assertEqual(missing.returncode, 2)


if __name__ == "__main__":
    unittest.main()
