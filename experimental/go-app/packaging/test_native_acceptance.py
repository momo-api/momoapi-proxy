import subprocess
import unittest
from unittest.mock import Mock

from native_acceptance import accept


class NativeAcceptanceTest(unittest.TestCase):
    def test_five_full_processes_with_unchanged_deadline(self):
        for platform in ("Windows", "macOS", "Linux"):
            with self.subTest(platform=platform):
                execute = Mock()
                accept("synthetic-probe", platform, execute)
                self.assertEqual(execute.call_count, 5)
                for call in execute.call_args_list:
                    self.assertEqual(call.kwargs, {"check": True, "timeout": 40})
                    command = call.args[0]
                    self.assertEqual(command[-1], "synthetic-probe")
                    if platform == "Linux":
                        self.assertEqual(command[:-1], ["timeout", "40s", "xvfb-run", "-a", "dbus-run-session", "--"])
                    else:
                        self.assertEqual(len(command), 1)

    def test_first_failure_or_timeout_aborts_without_retry(self):
        for failure in (subprocess.CalledProcessError(1, ["synthetic"]), subprocess.TimeoutExpired(["synthetic"], 40)):
            execute = Mock(side_effect=[None, failure])
            with self.assertRaises(type(failure)):
                accept("synthetic-probe", "Linux", execute)
            self.assertEqual(execute.call_count, 2)

    def test_unknown_platform_does_not_launch(self):
        execute = Mock()
        with self.assertRaises(ValueError):
            accept("synthetic-probe", "unknown", execute)
        execute.assert_not_called()
