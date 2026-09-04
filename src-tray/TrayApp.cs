using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace MomoApi.Tray
{
    static class Program
    {
        private static Mutex singleMutex;

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            bool createdNew = false;
            try
            {
                singleMutex = new Mutex(true, "Local\\MomoApiProxyTrayMutex_" + Environment.UserName, out createdNew);
            }
            catch
            {
                createdNew = true;
            }

            if (!createdNew)
            {
                return;
            }

            int port = 18789;
            for (int i = 0; i < args.Length; i++)
            {
                if ((args[i] == "-p" || args[i] == "--port") && i + 1 < args.Length)
                {
                    int.TryParse(args[i + 1], out port);
                }
            }

            Application.Run(new TrayApplicationContext(port));
        }
    }

    public class TrayApplicationContext : ApplicationContext
    {
        private readonly int port;
        private readonly string userHome;
        private readonly string proxyHome;
        private readonly NotifyIcon notifyIcon;
        private readonly System.Windows.Forms.Timer healthTimer;
        private readonly Icon activeIcon;
        private readonly Icon inactiveIcon;
        private readonly ToolStripMenuItem titleItem;
        private readonly ToolStripMenuItem autostartItem;
        private bool isRunning = false;

        public TrayApplicationContext(int port)
        {
            this.port = port;
            this.userHome = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            this.proxyHome = Path.Combine(userHome, ".momoapi-proxy");

            this.activeIcon = CreateBadgeIcon(true);
            this.inactiveIcon = CreateBadgeIcon(false);

            ContextMenuStrip menu = new ContextMenuStrip();

            titleItem = new ToolStripMenuItem("MOMO API Proxy (: " + port + ")");
            titleItem.Enabled = false;
            titleItem.Font = new Font(menu.Font, FontStyle.Bold);
            menu.Items.Add(titleItem);

            menu.Items.Add(new ToolStripSeparator());

            var openPortal = menu.Items.Add("打开 MOMO 控制台 (momoapi.us)");
            openPortal.Click += (s, e) => Process.Start(new ProcessStartInfo("https://momoapi.us") { UseShellExecute = true });

            var viewModels = menu.Items.Add("查看可用模型列表 (Models)");
            viewModels.Click += (s, e) => RunCli("models", true);

            var runDoctor = menu.Items.Add("运行健康诊断 (Doctor)");
            runDoctor.Click += (s, e) => RunCli("doctor", true);

            var viewLogs = menu.Items.Add("查看代理日志 (Logs)");
            viewLogs.Click += (s, e) =>
            {
                string logFile = Path.Combine(proxyHome, "daemon.log");
                if (!File.Exists(logFile))
                {
                    logFile = Path.Combine(proxyHome, "proxy.log");
                }
                if (!File.Exists(logFile))
                {
                    logFile = Path.Combine(userHome, ".momo-codex-bridge", "daemon.log");
                }
                if (File.Exists(logFile))
                {
                    Process.Start(new ProcessStartInfo("notepad.exe", "\"" + logFile + "\"") { UseShellExecute = true });
                }
                else
                {
                    MessageBox.Show("暂无日志记录", "MOMO API Proxy", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            };

            menu.Items.Add(new ToolStripSeparator());

            var restartService = menu.Items.Add("重启代理服务 (Restart)");
            restartService.Click += (s, e) =>
            {
                RestartBridge();
                notifyIcon.ShowBalloonTip(2000, "MOMO API Proxy", "服务正在重启...", ToolTipIcon.Info);
            };

            var updateItem = menu.Items.Add("检查并更新版本 (Update)");
            updateItem.Click += (s, e) => RunCli("update", true);

            autostartItem = new ToolStripMenuItem("开机自动启动");
            autostartItem.CheckOnClick = true;
            autostartItem.Checked = CheckAutostart();
            autostartItem.Click += (s, e) => ToggleAutostart(autostartItem.Checked);
            menu.Items.Add(autostartItem);

            menu.Items.Add(new ToolStripSeparator());

            var exitItem = menu.Items.Add("退出托盘与服务 (Exit)");
            exitItem.Click += (s, e) =>
            {
                notifyIcon.Visible = false;
                StopBridge();
                Application.Exit();
            };

            notifyIcon = new NotifyIcon
            {
                Icon = this.activeIcon,
                ContextMenuStrip = menu,
                Text = "MOMO API Proxy (127.0.0.1:" + port + ")",
                Visible = true
            };

            notifyIcon.DoubleClick += (s, e) => Process.Start(new ProcessStartInfo("https://momoapi.us") { UseShellExecute = true });

            EnsureBridgeRunning();

            healthTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            healthTimer.Tick += (s, e) => UpdateHealthStatus();
            healthTimer.Start();
        }

        private void UpdateHealthStatus()
        {
            bool healthy = CheckHealthOnce();
            if (healthy != isRunning)
            {
                isRunning = healthy;
                notifyIcon.Icon = isRunning ? activeIcon : inactiveIcon;
                titleItem.Text = isRunning
                    ? "MOMO API Proxy (运行中 :" + port + ")"
                    : "MOMO API Proxy (已停止)";
                notifyIcon.Text = isRunning
                    ? "MOMO API Proxy 运行中 (127.0.0.1:" + port + ")"
                    : "MOMO API Proxy 服务已停止";
            }
        }

        private void EnsureBridgeRunning()
        {
            if (!CheckHealthOnce())
            {
                StartBridge();
            }
            UpdateHealthStatus();
        }

        private bool CheckHealthOnce()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/healthz");
                req.Timeout = 1000;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch { return false; }
        }

        private ProcessStartInfo ResolveCliProcessInfo(string subCommand)
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string[] possibleExes = new string[]
            {
                Path.Combine(home, ".momoapi-proxy", "bin", "momoapi-proxy.exe"),
                Path.Combine(home, ".momo-codex-bridge", "bin", "momoapi-proxy.exe"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "momoapi-proxy.exe")
            };

            foreach (string exe in possibleExes)
            {
                if (File.Exists(exe))
                {
                    return new ProcessStartInfo(exe, subCommand);
                }
            }

            string[] possibleMjs = new string[]
            {
                Path.Combine(home, ".momoapi-proxy", "app", "bin", "momoapi-proxy.mjs"),
                Path.Combine(home, ".momoapi-proxy", "app", "bin", "momo-codex-bridge.mjs"),
                Path.Combine(home, ".momo-codex-bridge", "app", "bin", "momoapi-proxy.mjs"),
                Path.Combine(home, ".momo-codex-bridge", "app", "bin", "momo-codex-bridge.mjs")
            };

            foreach (string mjs in possibleMjs)
            {
                if (File.Exists(mjs))
                {
                    return new ProcessStartInfo("node", "\"" + mjs + "\" " + subCommand);
                }
            }

            string[] possibleCmds = new string[]
            {
                Path.Combine(home, ".momoapi-proxy", "bin", "momoapi.cmd"),
                Path.Combine(home, ".momo-codex-bridge", "bin", "momoapi.cmd")
            };

            foreach (string cmd in possibleCmds)
            {
                if (File.Exists(cmd))
                {
                    return new ProcessStartInfo("cmd.exe", "/c \"" + cmd + "\" " + subCommand);
                }
            }

            return new ProcessStartInfo("cmd.exe", "/c momoapi " + subCommand);
        }

        private void StartBridge()
        {
            try
            {
                ProcessStartInfo psi = ResolveCliProcessInfo("serve");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
            catch { }
        }

        private void StopBridge()
        {
            try
            {
                ProcessStartInfo psi = ResolveCliProcessInfo("stop");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process p = Process.Start(psi);
                if (p != null)
                {
                    p.WaitForExit(2000);
                }
            }
            catch { }
        }

        private void RestartBridge()
        {
            StopBridge();
            Thread.Sleep(500);
            StartBridge();
        }

        private void RunCli(string subCommand, bool showResult)
        {
            try
            {
                ProcessStartInfo psi = ResolveCliProcessInfo(subCommand);
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = System.Text.Encoding.UTF8;
                psi.StandardErrorEncoding = System.Text.Encoding.UTF8;

                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    string error = p.StandardError.ReadToEnd();
                    p.WaitForExit(10000);
                    if (showResult)
                    {
                        string msg = string.IsNullOrWhiteSpace(output) ? error : output;
                        MessageBox.Show(msg.Trim(), "MOMO API Proxy - " + subCommand, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                }
            }
            catch (Exception ex)
            {
                if (showResult)
                {
                    MessageBox.Show("执行出错: " + ex.Message, "MOMO API Proxy", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private bool CheckAutostart()
        {
            string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            return File.Exists(Path.Combine(startupDir, "momoapi-proxy.lnk")) || File.Exists(Path.Combine(startupDir, "momoapi-proxy-tray.lnk"));
        }

        private void ToggleAutostart(bool enable)
        {
            string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            string lnkPath = Path.Combine(startupDir, "momoapi-proxy-tray.lnk");
            string currentExe = Application.ExecutablePath;

            try
            {
                if (enable)
                {
                    CreateShortcut(lnkPath, currentExe, "MOMO API Proxy Tray Companion");
                }
                else
                {
                    if (File.Exists(lnkPath)) File.Delete(lnkPath);
                }
            }
            catch { }
        }

        private static void CreateShortcut(string shortcutPath, string targetPath, string description)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = targetPath;
                shortcut.Description = description;
                shortcut.Save();
            }
            catch { }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr CreateIconIndirect(ref ICONINFO icon);

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct ICONINFO
        {
            public bool fIcon;
            public int xHotspot;
            public int yHotspot;
            public IntPtr hbmMask;
            public IntPtr hbmColor;
        }

        [System.Runtime.InteropServices.DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        private static Icon CreateBadgeIcon(bool active)
        {
            int size = 32;
            using (Bitmap bmp = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;

                Color bgColor = active ? Color.FromArgb(255, 99, 102, 241) : Color.FromArgb(255, 100, 116, 139);
                using (SolidBrush bgBrush = new SolidBrush(bgColor))
                {
                    g.FillEllipse(bgBrush, 2, 2, 28, 28);
                }

                using (Font font = new Font("Segoe UI", 13, FontStyle.Bold, GraphicsUnit.Pixel))
                using (SolidBrush textBrush = new SolidBrush(Color.White))
                using (StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                {
                    g.DrawString("M", font, textBrush, new RectangleF(0, 1, 32, 30), sf);
                }

                Color dotColor = active ? Color.FromArgb(255, 16, 185, 129) : Color.FromArgb(255, 239, 68, 68);
                using (SolidBrush dotBrush = new SolidBrush(dotColor))
                using (Pen whitePen = new Pen(Color.White, 1.5f))
                {
                    g.FillEllipse(dotBrush, 20, 20, 10, 10);
                    g.DrawEllipse(whitePen, 20, 20, 10, 10);
                }

                IntPtr hbmColor = bmp.GetHbitmap(Color.FromArgb(0, 0, 0, 0));
                using (Bitmap maskBmp = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                {
                    IntPtr hbmMask = maskBmp.GetHbitmap();
                    try
                    {
                        ICONINFO iconInfo = new ICONINFO
                        {
                            fIcon = true,
                            xHotspot = 0,
                            yHotspot = 0,
                            hbmColor = hbmColor,
                            hbmMask = hbmMask
                        };
                        IntPtr hIcon = CreateIconIndirect(ref iconInfo);
                        Icon icon = Icon.FromHandle(hIcon);
                        return (Icon)icon.Clone();
                    }
                    finally
                    {
                        if (hbmColor != IntPtr.Zero) DeleteObject(hbmColor);
                        if (hbmMask != IntPtr.Zero) DeleteObject(hbmMask);
                    }
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (healthTimer != null) healthTimer.Dispose();
                if (notifyIcon != null) notifyIcon.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
