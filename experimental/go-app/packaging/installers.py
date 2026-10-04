"""Build and CI-check unsigned native installers. No credentials or runtime downloads."""
import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, timeout=120, **kwargs)


def check_binary(path, version):
    result = run(path, "--version", capture_output=True, text=True)
    assert result.stdout.strip() == version + "-preview", "installed version mismatch"


def same_file(a, b):
    assert hashlib.sha256(a.read_bytes()).digest() == hashlib.sha256(b.read_bytes()).digest(), "installed payload mismatch"


def windows(preview, download, temp, version):
    import winreg
    uninstall_key = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\us.momoapi.go.preview_is1"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, uninstall_key):
            raise RuntimeError("refuse to replace an existing registered installation")
    except FileNotFoundError:
        pass
    compiler = Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Inno Setup 6/ISCC.exe"
    if not compiler.is_file():
        raise RuntimeError("Inno Setup 6 is required; no unverified bootstrap download")
    run(compiler, "/DPreviewDir=" + str(preview), "/DDownloadDir=" + str(download),
        "/DAppVersion=" + version, Path(__file__).with_name("windows.iss"))
    installer = download / "momo-preview-Windows-X64-setup.exe"
    target = (temp / "momo-installer-ci" / "installed").resolve()
    assert target.is_relative_to(temp.resolve()) and not target.exists(), "unsafe/reused CI target"
    # Test only in the caller's fresh CI temp directory, never an existing install.
    group = "MOMO Preview CI " + os.urandom(8).hex()
    run(installer, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-",
        "/DIR=" + str(target), "/GROUP=" + group)
    try:
        same_file(target / "momo-preview.exe", preview / "momo-preview.exe")
        check_binary(target / "momo-preview.exe", version)
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, uninstall_key) as key:
            assert winreg.QueryValueEx(key, "DisplayVersion")[0] == version
            assert Path(winreg.QueryValueEx(key, "InstallLocation")[0]).resolve() == target
        shortcut = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs" / group / "MOMO API Preview.lnk"
        assert shortcut.is_file(), "missing Start menu shortcut"
    finally:
        run(target / "unins000.exe", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART")
    assert not (target / "momo-preview.exe").exists(), "uninstall left executable"
    assert not shortcut.exists(), "uninstall left shortcut"
    print("PASS Windows current-user setup/payload/version/uninstall (CI-only temp target)")


def macos(preview, download, temp, version):
    source = temp / "momo-dmg-source"
    source.mkdir()
    shutil.copytree(preview / "MOMO Preview.app", source / "MOMO Preview.app")
    shutil.copyfile(preview / "README.md", source / "README.md")
    (source / "Applications").symlink_to("/Applications", target_is_directory=True)
    dmg = download / "momo-preview-macOS-ARM64.dmg"
    run("hdiutil", "create", "-volname", "MOMO Preview", "-srcfolder", source,
        "-format", "UDZO", dmg)
    run("hdiutil", "verify", dmg)
    mount = temp / "momo-dmg-ci-mount"
    mount.mkdir()
    run("hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg)
    try:
        app = mount / "MOMO Preview.app/Contents"
        info = plistlib.loads((app / "Info.plist").read_bytes())
        assert info["CFBundleShortVersionString"] == version
        executable = app / "MacOS/momo-preview"
        same_file(executable, preview / "MOMO Preview.app/Contents/MacOS/momo-preview")
        check_binary(executable, version)
        assert (mount / "Applications").is_symlink()
    finally:
        run("hdiutil", "detach", mount)
    print("PASS macOS DMG verification/mount/payload/version/detach; drag install not automated")


def linux(preview, download, temp, version):
    root = temp / "momo-deb-root"
    (root / "DEBIAN").mkdir(parents=True)
    (root / "usr/bin").mkdir(parents=True)
    (root / "usr/share/applications").mkdir(parents=True)
    (root / "usr/share/doc/momo-api-preview").mkdir(parents=True)
    binary = root / "usr/bin/momo-api-preview"
    shutil.copyfile(preview / "momo-preview", binary)
    binary.chmod(0o755)
    shutil.copyfile(Path(__file__).with_name("momo-preview.desktop"), root / "usr/share/applications/momo-api-preview.desktop")
    shutil.copyfile(preview / "README.md", root / "usr/share/doc/momo-api-preview/README.md")
    (root / "DEBIAN/control").write_text(
        "Package: momo-api-preview\nVersion: " + version + "\nArchitecture: amd64\n"
        "Maintainer: MOMO API <support@momoapi.us>\nSection: utils\nPriority: optional\n"
        "Depends: libc6 (>= 2.34), libgtk-3-0, libwebkit2gtk-4.1-0\n"
        "Recommends: gnome-keyring\nDescription: MOMO local API desktop unsigned preview\n"
        " Same-protocol Responses and Chat proxy, with optional OS secure store.\n", encoding="utf-8")
    deb = download / "momo-preview-Linux-X64.deb"
    run("dpkg-deb", "--root-owner-group", "--build", root, deb)
    # Disposable GitHub runner only. Never replace a pre-existing package.
    existing = subprocess.run(["dpkg-query", "-W", "momo-api-preview"], capture_output=True)
    assert existing.returncode != 0, "refuse to replace an existing installation"
    run("sudo", "dpkg", "--install", deb)
    try:
        same_file(Path("/usr/bin/momo-api-preview"), preview / "momo-preview")
        check_binary(Path("/usr/bin/momo-api-preview"), version)
        assert Path("/usr/share/applications/momo-api-preview.desktop").is_file()
    finally:
        run("sudo", "dpkg", "--remove", "momo-api-preview")
    assert not Path("/usr/bin/momo-api-preview").exists(), "uninstall left binary"
    print("PASS Linux DEB install/payload/version/desktop entry/remove (disposable runner)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ci", action="store_true", required=True)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("installer install/remove checks are CI-only")
    temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    preview, download = temp / "momo-app-preview", temp / "momo-app-download"
    version = plistlib.loads(Path(__file__).with_name("Info.plist").read_bytes())["CFBundleShortVersionString"]
    platform = os.environ["RUNNER_OS"]
    {"Windows": windows, "macOS": macos, "Linux": linux}[platform](preview, download, temp, version)
    rows = [hashlib.sha256(f.read_bytes()).hexdigest() + "  " + f.name
            for f in sorted(download.iterdir()) if f.is_file() and f.name != "SHA256SUMS"]
    (download / "SHA256SUMS").write_text("\n".join(rows) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
