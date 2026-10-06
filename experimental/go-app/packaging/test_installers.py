"""Side-effect-free packaging regression checks; native install checks run in CI."""
from pathlib import Path
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch
import plistlib
import os

import installers


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


class MacOSMountedPayloadTest(unittest.TestCase):
    def test_runtime_uses_byte_verified_copy_not_mounted_binary(self):
        with TemporaryDirectory() as directory:
            temp = Path(directory)
            preview, download = temp / "preview", temp / "download"
            download.mkdir()
            contents = preview / "MOMO Preview.app/Contents"
            (contents / "MacOS").mkdir(parents=True)
            (contents / "Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": "0.4.0"}))
            payload = contents / "MacOS/momo-preview"
            payload.write_bytes(b"synthetic executable")
            payload.chmod(0o755)
            (preview / "README.md").write_text("synthetic preview", encoding="utf-8")
            commands = []

            def command(*args, **kwargs):
                commands.append(args)
                if args[1] == "attach":
                    import shutil
                    mount = args[args.index("-mountpoint") + 1]
                    shutil.copytree(preview / "MOMO Preview.app", mount / "MOMO Preview.app")

            def runtime(executable):
                self.assertFalse(executable.is_relative_to(temp / "momo-dmg-ci-mount"))
                self.assertTrue(executable.is_relative_to(temp))
                self.assertEqual(executable.read_bytes(), payload.read_bytes())
                if os.name != "nt":
                    self.assertTrue(executable.stat().st_mode & 0o111)
                self.assertEqual(commands[-1], ("hdiutil", "detach", temp / "momo-dmg-ci-mount"))

            with patch.object(Path, "symlink_to"), patch.object(Path, "is_symlink", return_value=True), patch.object(installers, "run", side_effect=command), patch.object(installers, "check_binary") as version, patch.object(installers, "check_runtime", side_effect=runtime):
                installers.macos(preview, download, temp, "0.4.0")
            self.assertEqual(commands[-1], ("hdiutil", "detach", temp / "momo-dmg-ci-mount"))
            self.assertNotIn("-force", commands[-1])
            self.assertEqual(version.call_count, 1)


if __name__ == "__main__":
    unittest.main()
