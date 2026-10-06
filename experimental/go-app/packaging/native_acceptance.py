"""Five independent native probes; fail first, never retry or execute installers."""
from pathlib import Path
import os
import subprocess


def accept(binary, platform, execute=subprocess.run):
    if platform not in ("Windows", "macOS", "Linux"):
        raise ValueError("unsupported native platform")
    command = [str(binary)]
    if platform == "Linux":
        command = ["timeout", "40s", "xvfb-run", "-a", "dbus-run-session", "--", str(binary)]
    for index in range(1, 6):
        print(f"Native acceptance pass {index}/5 (no retries)", flush=True)
        # Every pass starts a new process and appcheck-owned temporary profile,
        # executes ALL assertions and retains the existing 40s process limit.
        execute(command, check=True, timeout=40)
    print("PASS five independent native WebView probes (no retries)", flush=True)


if __name__ == "__main__":
    platform = os.environ["RUNNER_OS"]
    suffix = ".exe" if platform == "Windows" else ""
    accept(Path(os.environ["RUNNER_TEMP"]) / ("momo-appcheck" + suffix), platform)
