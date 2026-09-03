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
                MessageBox.Show("MOMO API Proxy 托盘程序已在运行中，请在右下角任务栏查看。", "MOMO API", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
        private readonly string installDir;
        private readonly string bridgeBin;
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
            string userHome = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            this.installDir = Path.Combine(userHome, ".momo-codex-bridge", "app");
            this.bridgeBin = Path.Combine(this.installDir, "bin", "momo-codex-bridge.mjs");

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
            viewModels.Click += (s, e) => RunNodeCli("models", true);

            var runDoctor = menu.Items.Add("运行健康诊断 (Doctor)");
            runDoctor.Click += (s, e) => RunNodeCli("doctor", true);

            var viewLogs = menu.Items.Add("查看代理日志 (Logs)");
            viewLogs.Click += (s, e) =>
            {
                string logFile = Path.Combine(userHome, ".momo-codex-bridge", "daemon.log");
                if (!File.Exists(logFile))
                {
                    logFile = Path.Combine(userHome, ".momo-codex-bridge", "bridge.log");
                }
                if (File.Exists(logFile))
                {
                    Process.Start(new ProcessStartInfo("notepad.exe", "\"" + logFile + "\"") { UseShellExecute = true });
                }
                else
                {
                    MessageBox.Show("暂无日志记录", "MOMO API", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
            updateItem.Click += (s, e) => RunNodeCli("update", true);

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

            // Ensure bridge is running
            EnsureBridgeRunning();

            healthTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            healthTimer.Tick += (s, e) => CheckHealthAndUpdateUi();
            healthTimer.Start();

            notifyIcon.ShowBalloonTip(3000, "MOMO API Proxy", "服务已就绪！监听地址：http://127.0.0.1:" + port + "/v1\n已完美支持 ChatGPT 桌面端与 Codex。", ToolTipIcon.Info);
        }

        private void CheckHealthAndUpdateUi()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/healthz");
                req.Timeout = 1200;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    if (resp.StatusCode == HttpStatusCode.OK)
                    {
                        if (!isRunning)
                        {
                            isRunning = true;
                            notifyIcon.Icon = activeIcon;
                            notifyIcon.Text = "MOMO API Proxy: 运行中 (: " + port + ")";
                            titleItem.Text = "MOMO API Proxy: 运行中 (:" + port + ")";
                        }
                        return;
                    }
                }
            }
            catch
            {
                // Fall through to inactive
            }

            if (isRunning)
            {
                isRunning = false;
                notifyIcon.Icon = inactiveIcon;
                notifyIcon.Text = "MOMO API Proxy: 已停止";
                titleItem.Text = "MOMO API Proxy: 已停止 (:" + port + ")";
            }
        }

        private void EnsureBridgeRunning()
        {
            if (!CheckHealthOnce())
            {
                StartBridge();
            }
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

        private void StartBridge()
        {
            if (File.Exists(bridgeBin))
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo("node", "\"" + bridgeBin + "\" serve")
                    {
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    Process.Start(psi);
                }
                catch { }
            }
        }

        private void StopBridge()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("node", "\"" + bridgeBin + "\" stop")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
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

        private void RunNodeCli(string subCommand, bool showResult)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("node", "\"" + bridgeBin + "\" " + subCommand)
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = System.Text.Encoding.UTF8,
                    StandardErrorEncoding = System.Text.Encoding.UTF8
                };
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    string error = p.StandardError.ReadToEnd();
                    p.WaitForExit(8000);
                    if (showResult)
                    {
                        string msg = string.IsNullOrWhiteSpace(output) ? error : output;
                        MessageBox.Show(msg.Trim(), "MOMO API - " + subCommand, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                }
            }
            catch (Exception ex)
            {
                if (showResult)
                {
                    MessageBox.Show("执行出错: " + ex.Message, "MOMO API", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private bool CheckAutostart()
        {
            string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            return File.Exists(Path.Combine(startupDir, "momoapi-tray.lnk")) || File.Exists(Path.Combine(startupDir, "momoapi-tray.cmd"));
        }

        private void ToggleAutostart(bool enable)
        {
            string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            string cmdFile = Path.Combine(startupDir, "momoapi-tray.cmd");
            string currentExe = Application.ExecutablePath;

            try
            {
                if (enable)
                {
                    File.WriteAllText(cmdFile, "@start \"\" \"" + currentExe + "\"\r\n");
                }
                else
                {
                    if (File.Exists(cmdFile)) File.Delete(cmdFile);
                }
            }
            catch { }
        }

        private static Icon CreateBadgeIcon(bool active)
        {
            int size = 32;
            using (Bitmap bmp = new Bitmap(size, size))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;

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

                IntPtr hIcon = bmp.GetHicon();
                return Icon.FromHandle(hIcon);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (healthTimer != null) healthTimer.Dispose();
                if (notifyIcon != null) notifyIcon.Dispose();
                if (activeIcon != null) activeIcon.Dispose();
                if (inactiveIcon != null) inactiveIcon.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
