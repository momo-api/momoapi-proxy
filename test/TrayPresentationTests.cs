using System;
using MomoApi.Tray;

public static class TrayPresentationTests
{
    public static int Main()
    {
        Assert(TrayPresentation.VersionFromJson("{\"version\":\"0.13.12\"}") == "0.13.12", "health version");
        Assert(TrayPresentation.VersionFromJson("{\"version\": \"0.14.0-rc.1\"}") == "0.14.0-rc.1", "prerelease");
        Assert(TrayPresentation.VersionFromJson("{\"version\":null}") == "", "null");
        Assert(TrayPresentation.VersionFromJson("{\"version\":\"junk\"}") == "", "invalid");
        Assert(TrayPresentation.Title(true, "0.13.12", "0.13.13", 19999).Contains("v0.13.12"), "running beats installed");
        Assert(TrayPresentation.Title(true, "0.13.13", "0.13.13", 19999).Contains("v0.13.13"), "hot update");
        Assert(TrayPresentation.Title(false, "0.13.12", "0.13.13", 19999).Contains("v0.13.13"), "stopped installed fallback");
        Assert(TrayPresentation.Title(true, "", "0.13.13", 19999).Contains("版本未知"), "no false runtime version");
        Assert(TrayPresentation.Title(true, "0.13.12", "", 19999).Contains("19999"), "custom port");
        Assert(TrayPresentation.Tooltip(new string('x', 100)).Length == 63, "tooltip bound");
        Assert(TrayPresentation.StartupName == "MOMO API Proxy Tray.lnk", "startup branding");
        Console.WriteLine("Tray presentation: 11 assertions passed");
        return 0;
    }
    private static void Assert(bool value, string label) { if (!value) throw new Exception(label); }
}
