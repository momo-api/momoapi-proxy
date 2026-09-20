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
        string mediaStatus = "{\"plugins\":{\"momo-image\":{\"installed\":true,\"enabled\":true,\"version\":\"0.6.0\"},\"momo-video\":{\"installed\":true,\"enabled\":true,\"version\":\"0.1.0\"}}}";
        Assert(TrayPresentation.PluginStatus(mediaStatus, "momo-image", "MOMO Image", true).Contains("v0.6.0"), "image plugin enabled version");
        Assert(TrayPresentation.PluginStatus(mediaStatus, "momo-video", "MOMO Video", true).Contains("v0.1.0"), "video plugin enabled version");
        Assert(TrayPresentation.PluginStatus("{\"plugins\":{\"momo-video\":{\"installed\":true,\"enabled\":false}}}", "momo-video", "MOMO Video", false).Contains("未启用"), "video plugin disabled");
        Assert(TrayPresentation.PluginStatus("{\"plugins\":{\"momo-video\":{\"installed\":false,\"enabled\":false}}}", "momo-video", "MOMO Video", false).Contains("未安装"), "video plugin missing despite status exit code");
        Assert(TrayPresentation.PluginStatus("", "momo-video", "MOMO Video", false).Contains("检测失败"), "video plugin status failure");
        Assert(TrayPresentation.RouteModeFromConfig("model_provider = \"momo-route\"\n[model_providers.momo-route]\nbase_url = \"http://127.0.0.1:18789/v1\"") == "proxy", "managed proxy route");
        Assert(TrayPresentation.RouteModeFromConfig("model_provider = \"Codex\"\n[model_providers.Codex]\nbase_url = \"https://momoapi.us/v1\"") == "direct", "legacy direct route");
        Assert(TrayPresentation.RouteModeFromConfig("model_provider = \"Codex\"\n# MOMOAPI_ROUTE_MODE=proxy\n[model_providers.Codex]\nbase_url = \"https://momoapi.us/v1\"\n[model_providers.momo-route]\nbase_url = \"http://127.0.0.1:18789/v1\"") == "direct", "active provider beats unrelated proxy section");
        Assert(TrayPresentation.RouteTitle("proxy").Contains("本地 Proxy"), "proxy route title");
        Assert(TrayPresentation.RouteTitle("proxy").Contains("重启生效"), "route restart warning");
        Console.WriteLine("Tray presentation: 21 assertions passed");
        return 0;
    }
    private static void Assert(bool value, string label) { if (!value) throw new Exception(label); }
}
