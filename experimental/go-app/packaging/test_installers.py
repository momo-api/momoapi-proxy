"""Side-effect-free packaging regression checks; native install checks run in CI."""
from pathlib import Path
import unittest


class WindowsSetupPolicyTest(unittest.TestCase):
    def test_current_user_setup_accepts_isolated_group_override(self):
        text = Path(__file__).with_name("windows.iss").read_text(encoding="utf-8")
        settings = {}
        section = None
        for raw in text.splitlines():
            line = raw.strip()
            if line.startswith("["):
                section = line
            elif section == "[Setup]" and "=" in line and not line.startswith(";"):
                key, value = line.split("=", 1)
                settings[key] = value
        # Inno ignores /GROUP when this is 'yes'. Keep CI out of the real group.
        self.assertIn(settings["DisableProgramGroupPage"], ("auto", "no"))
        self.assertEqual(settings["PrivilegesRequired"], "lowest")
        self.assertEqual(settings["DefaultDirName"], r"{localappdata}\Programs\MOMO API Preview")
        self.assertEqual(settings["RestartApplications"], "no")
        self.assertNotIn("[Run]", text)
        self.assertNotIn("[UninstallDelete]", text)


if __name__ == "__main__":
    unittest.main()
