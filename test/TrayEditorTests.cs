using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using MomoApi.Tray;

public static class TrayEditorTests
{
    private static int assertions;
    [STAThread]
    public static int Main()
    {
        try { return Run(); }
        catch (Exception error) { Console.WriteLine(error.GetType().Name + ": " + error.Message); return 1; }
    }
    private static int Run()
    {
        Application.EnableVisualStyles();
        int calls = 0;
        using (var dialog = new ApiKeyEditorDialog(key => { calls++; return Task.FromResult(true); }))
        {
            dialog.Show(); Application.DoEvents();
            var input = (TextBox)dialog.Controls["keyInput"];
            Assert(input.UseSystemPasswordChar, "masked input");
            ((Button)dialog.Controls["saveKey"]).PerformClick(); Application.DoEvents();
            Assert(calls == 0, "blank never saves");
            ((Button)dialog.Controls["cancelKey"]).PerformClick(); Application.DoEvents();
            Assert(calls == 0 && !dialog.Visible, "cancel never saves");
        }
        var pending = new TaskCompletionSource<bool>();
        using (var dialog = new ApiKeyEditorDialog(key => { Assert(key == "synthetic-new-key", "candidate delivery"); return pending.Task; }))
        {
            dialog.Show(); Application.DoEvents();
            var input = (TextBox)dialog.Controls["keyInput"];
            input.Text = "synthetic-new-key";
            var save = (Button)dialog.Controls["saveKey"];
            save.PerformClick(); Application.DoEvents();
            Assert(input.Text == "" && !input.Enabled && !save.Enabled, "cleared and disabled during save");
            dialog.Close(); Application.DoEvents();
            Assert(dialog.Visible && !dialog.IsDisposed, "X cannot dispose pending save");
            pending.SetResult(true); Application.DoEvents();
            Assert(dialog.DialogResult == DialogResult.OK && !dialog.Visible, "successful save closes");
        }
        using (var dialog = new ApiKeyEditorDialog(key => Task.FromResult(false)))
        {
            dialog.Show(); Application.DoEvents();
            dialog.Controls["keyInput"].Text = "synthetic-rejected";
            ((Button)dialog.Controls["saveKey"]).PerformClick(); Application.DoEvents();
            Assert(dialog.Visible && dialog.Controls["saveKey"].Enabled, "failure stays open and usable");
            dialog.Close();
        }
        string root = Path.Combine(Path.GetTempPath(), "momo-tray-editor-" + Guid.NewGuid().ToString("N"));
        try
        {
            string selected = Path.Combine(root, "selected");
            string cli = Path.Combine(selected, "app", "bin", "momoapi-proxy.mjs");
            Directory.CreateDirectory(Path.GetDirectoryName(cli)); File.WriteAllText(cli, "// fixture");
            Assert(TrayCli.ResolveScript(root, selected, root) == cli, "custom CLI selected");
            bool refused = false;
            try { TrayCli.ResolveScript(root, Path.Combine(root, "missing"), root); }
            catch (FileNotFoundException) { refused = true; }
            Assert(refused, "missing custom home cannot fall back to real profile");
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
        Console.WriteLine("Tray editor: " + assertions + " native WinForms assertions passed");
        return 0;
    }
    private static void Assert(bool value, string label) { assertions++; if (!value) throw new Exception(label); }
}
