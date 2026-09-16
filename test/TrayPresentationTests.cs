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
        Assert(TrayPresentation.PluginStatus("{\"installed\":true,\"enabled\":true,\"version\":\"0.5.2\"}", true).Contains("v0.5.2"), "plugin enabled version");
        Assert(TrayPresentation.PluginStatus("{\"installed\":true,\"enabled\":false}", false).Contains("未启用"), "plugin disabled");
        Assert(TrayPresentation.PluginStatus("{\"installed\":false,\"enabled\":false}", false).Contains("未安装"), "plugin missing despite status exit code");
        Assert(TrayPresentation.PluginStatus("", false).Contains("检测失败"), "plugin status failure");
        Console.WriteLine("Tray presentation: 15 assertions passed");
        return 0;
    }
    private static void Assert(bool value, string label) { if (!value) throw new Exception(label); }
}
