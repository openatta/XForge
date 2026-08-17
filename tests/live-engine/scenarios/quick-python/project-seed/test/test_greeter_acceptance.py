"""Immutable acceptance suite. The Change may implement src/**; it may not edit this file.

The same oracle as the Node `quick` scenario, so the two differ only in the project's language.
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

CLI = str(Path(__file__).resolve().parent.parent / "src" / "cli.py")


def run(*args):
    return subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True)


class GreeterAcceptance(unittest.TestCase):
    def test_greets_by_name(self):
        result = run("greet", "--name", "Ada")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["data"]["message"], "Hello, Ada!")
        self.assertEqual(payload["diagnostics"], [])

    def test_shout_mode(self):
        payload = json.loads(run("greet", "--name", "Ada", "--shout").stdout)
        self.assertEqual(payload["data"]["message"], "HELLO, ADA!!!!")

    def test_blank_name_is_a_usage_error(self):
        result = run("greet", "--name", "   ")
        self.assertEqual(result.returncode, 2)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["diagnostics"][0]["code"], "USAGE_ERROR")

    def test_unknown_argument_is_a_usage_error(self):
        result = run("greet", "--name", "Ada", "--nope")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["diagnostics"][0]["code"], "USAGE_ERROR")


if __name__ == "__main__":
    unittest.main()
