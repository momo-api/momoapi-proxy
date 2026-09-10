using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
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

            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                try
                {
                    string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                    string log = Path.Combine(home, ".momoapi-proxy", "tray-crash.log");
                    File.AppendAllText(log, "[" + DateTime.Now.ToString("s") + "] Crash: " + e.ExceptionObject + "\r\n");
                }
                catch { }
            };

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
        private readonly Icon activeIcon;
        private readonly Icon inactiveIcon;
        private readonly ToolStripMenuItem titleItem;
        private readonly ToolStripMenuItem updateItem;
        private readonly ToolStripMenuItem autostartItem;
        private readonly SynchronizationContext syncContext;
        private readonly CancellationTokenSource cts = new CancellationTokenSource();
        private IntPtr jobHandle = IntPtr.Zero;
        private bool isRunning = false;
        private bool isCliRunning = false;
        private string lastNotifiedVersion = "";

        public TrayApplicationContext(int port)
        {
            this.port = port;
            this.userHome = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            this.proxyHome = Path.Combine(userHome, ".momoapi-proxy");
            this.syncContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();

            InitJobObject();

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
            viewModels.Click += async (s, e) => await RunCliAsync("models", true);

            var syncModels = menu.Items.Add("同步模型列表 (Sync)");
            syncModels.Click += async (s, e) => await RunCliAsync("sync", true);

            var runDoctor = menu.Items.Add("运行健康诊断 (Doctor)");
            runDoctor.Click += async (s, e) => await RunCliAsync("doctor", true);

            var viewLogs = menu.Items.Add("查看代理日志 (Logs)");
            viewLogs.Click += (s, e) =>
            {
                string logFile = Path.Combine(proxyHome, "daemon.log");
                if (!File.Exists(logFile)) logFile = Path.Combine(proxyHome, "proxy.log");
                if (!File.Exists(logFile)) logFile = Path.Combine(userHome, ".momo-codex-bridge", "daemon.log");
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
            restartService.Click += async (s, e) =>
            {
                notifyIcon.ShowBalloonTip(2000, "MOMO API Proxy", "服务正在重启...", ToolTipIcon.Info);
                await RestartBridgeAsync();
            };

            updateItem = (ToolStripMenuItem)menu.Items.Add("检查并更新版本 (Update)");
            updateItem.Click += async (s, e) => await RunCliAsync("update", true);

            autostartItem = new ToolStripMenuItem("开机自动启动");
            autostartItem.CheckOnClick = true;
            autostartItem.Checked = CheckAutostart();
            autostartItem.Click += (s, e) => ToggleAutostart(autostartItem.Checked);
            menu.Items.Add(autostartItem);

            menu.Items.Add(new ToolStripSeparator());

            var exitTrayOnly = menu.Items.Add("仅退出托盘 (服务保持后台)");
            exitTrayOnly.Click += (s, e) =>
            {
                notifyIcon.Visible = false;
                cts.Cancel();
                Application.Exit();
            };

            var exitItem = menu.Items.Add("退出托盘与服务 (Exit)");
            exitItem.Click += async (s, e) =>
            {
                notifyIcon.Visible = false;
                cts.Cancel();
                await StopBridgeAsync();
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

            // 启动独立异步退避心跳任务
            Task.Run(() => StartHealthLoopAsync(cts.Token));
        }

        private async Task StartHealthLoopAsync(CancellationToken token)
        {
            // 首次启动时确保后台服务已运行
            if (!await CheckHealthOnceAsync(400))
            {
                await StartBridgeAsync();
            }

            while (!token.IsCancellationRequested)
            {
                bool healthy = await CheckHealthOnceAsync(300);
                syncContext.Post(_ => UpdateHealthUI(healthy), null);
                CheckUpdateStatus();

                int delay = healthy ? 8000 : 1500;
                try
                {
                    await Task.Delay(delay, token);
                }
                catch (TaskCanceledException)
                {
                    break;
                }
            }
        }

        private static string ReadJsonString(string json, string key)
        {
            string marker = "\"" + key + "\"";
            int idx = json.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return "";
            int colon = json.IndexOf(':', idx + marker.Length);
            int start = colon >= 0 ? json.IndexOf('\"', colon + 1) : -1;
            int end = start >= 0 ? json.IndexOf('\"', start + 1) : -1;
            return end > start ? json.Substring(start + 1, end - start - 1) : "";
        }

        private static bool ReadJsonBool(string json, string key)
        {
            string marker = "\"" + key + "\"";
            int idx = json.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return false;
            int colon = json.IndexOf(':', idx + marker.Length);
            if (colon < 0) return false;
            string tail = json.Substring(colon + 1).TrimStart();
            return tail.StartsWith("true", StringComparison.OrdinalIgnoreCase);
        }

        private void CheckUpdateStatus()
        {
            try
            {
                string path = Path.Combine(proxyHome, "update-status.json");
                if (!File.Exists(path)) return;
                string json = File.ReadAllText(path);
                bool failed = ReadJsonBool(json, "checkFailed");
                bool available = ReadJsonBool(json, "hasUpdate");
                string latest = ReadJsonString(json, "latest");
                syncContext.Post(_ =>
                {
                    if (failed)
                    {
                        updateItem.Text = "更新检查失败，点击重试 (Update)";
                        return;
                    }
                    if (available && !string.IsNullOrWhiteSpace(latest))
                    {
                        updateItem.Text = "发现新版本 v" + latest + "，点击更新";
                        if (!string.Equals(lastNotifiedVersion, latest, StringComparison.OrdinalIgnoreCase))
                        {
                            lastNotifiedVersion = latest;
                            notifyIcon.ShowBalloonTip(5000, "MOMO API Proxy", "发现新版本 v" + latest + "，可从托盘菜单更新。", ToolTipIcon.Info);
                        }
                    }
                    else
                    {
                        updateItem.Text = "检查并更新版本 (Update)";
                    }
                }, null);
            }
            catch { }
        }

        private void UpdateHealthUI(bool healthy)
        {
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

        private async Task<bool> CheckHealthOnceAsync(int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/healthz");
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                using (var resp = (HttpWebResponse)await req.GetResponseAsync())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        public static string EscapeWindowsArgument(string arg)
        {
            if (string.IsNullOrEmpty(arg)) return "\"\"";
            if (!arg.Contains(" ") && !arg.Contains("\t") && !arg.Contains("\n") && !arg.Contains("\v") && !arg.Contains("\""))
            {
                return arg;
            }
            var sb = new StringBuilder();
            sb.Append('"');
            for (int i = 0; i < arg.Length; i++)
            {
                int backslashes = 0;
                while (i < arg.Length && arg[i] == '\\')
                {
                    backslashes++;
                    i++;
                }
                if (i == arg.Length)
                {
                    sb.Append('\\', backslashes * 2);
                    break;
                }
                if (arg[i] == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(arg[i]);
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        private string FindNodeExe()
        {
            string[] directCandidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
            };
            foreach (var path in directCandidates)
            {
                if (File.Exists(path)) return path;
            }

            var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in pathEnv.Split(';'))
            {
                try
                {
                    if (string.IsNullOrWhiteSpace(dir)) continue;
                    var cand = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(cand)) return cand;
                }
                catch { }
            }
            return "node";
        }

        private ProcessStartInfo ResolveCliProcessInfo(string subCommand)
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

            string[] possibleMjs = new string[]
            {
                Path.Combine(home, ".momoapi-proxy", "app", "bin", "momoapi-proxy.mjs"),
                Path.Combine(home, ".momoapi-proxy", "bin", "momoapi-proxy.mjs"),
                Path.Combine(home, ".momo-codex-bridge", "app", "bin", "momoapi-proxy.mjs"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "momoapi-proxy.mjs"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "app", "bin", "momoapi-proxy.mjs"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "bin", "momoapi-proxy.mjs")
            };

            string nodeExe = FindNodeExe();

            foreach (string mjs in possibleMjs)
            {
                if (File.Exists(mjs))
                {
                    string args = EscapeWindowsArgument(mjs) + " " + EscapeWindowsArgument(subCommand);
                    return new ProcessStartInfo(nodeExe, args);
                }
            }

            return new ProcessStartInfo(nodeExe, EscapeWindowsArgument(subCommand));
        }

        private async Task StartBridgeAsync()
        {
            try
            {
                ProcessStartInfo psi = ResolveCliProcessInfo("start");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;

                await Task.Run(() =>
                {
                    using (Process p = Process.Start(psi))
                    {
                        if (p != null) p.WaitForExit(5000);
                    }
                });
            }
            catch { }
        }

        private string ResolveLocalToken()
        {
            try
            {
                string customHome = Environment.GetEnvironmentVariable("MOMO_PROXY_HOME");
                string[] possibleSettings = new string[]
                {
                    !string.IsNullOrEmpty(customHome) ? Path.Combine(customHome, "settings.json") : null,
                    Path.Combine(proxyHome, "settings.json"),
                    Path.Combine(userHome, ".momo-codex-bridge", "settings.json")
                };

                foreach (var settingsPath in possibleSettings)
                {
                    if (!string.IsNullOrEmpty(settingsPath) && File.Exists(settingsPath))
                    {
                        string json = File.ReadAllText(settingsPath);
                        int idx = json.IndexOf("\"localToken\":", StringComparison.OrdinalIgnoreCase);
                        if (idx >= 0)
                        {
                            int start = json.IndexOf('"', idx + 13);
                            if (start >= 0)
                            {
                                int end = json.IndexOf('"', start + 1);
                                if (end > start)
                                {
                                    return json.Substring(start + 1, end - start - 1).Trim();
                                }
                            }
                        }
                    }
                }
            }
            catch { }
            return "";
        }

        private async Task<bool> IsPortListeningAsync(int timeoutMs)
        {
            try
            {
                using (var tcpClient = new System.Net.Sockets.TcpClient())
                {
                    var connectTask = tcpClient.ConnectAsync("127.0.0.1", port);
                    var completedTask = await Task.WhenAny(connectTask, Task.Delay(timeoutMs));
                    if (completedTask == connectTask && tcpClient.Connected)
                    {
                        return true;
                    }
                    return false;
                }
            }
            catch
            {
                return false;
            }
        }

        private async Task StopBridgeAsync()
        {
            try
            {
                // 1. 先尝试通过 HTTP 异步调用优雅停机
                string token = ResolveLocalToken();
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/internal/shutdown");
                    req.Method = "POST";
                    req.Timeout = 1500;
                    req.ReadWriteTimeout = 1500;
                    if (!string.IsNullOrEmpty(token)) req.Headers["x-local-token"] = token;
                    using (var resp = (HttpWebResponse)await req.GetResponseAsync()) { }
                }
                catch { }

                // 2. 轮询等待 TCP 端口彻底释放 (最多等待 3.5 秒)
                for (int i = 0; i < 7; i++)
                {
                    await Task.Delay(500);
                    if (!await IsPortListeningAsync(200))
                    {
                        return; // 端口已释放，服务优雅退出完成
                    }
                }

                // 3. 超时仍未退出则执行兜底 CLI stop
                ProcessStartInfo psi = ResolveCliProcessInfo("stop");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;

                await Task.Run(() =>
                {
                    using (Process p = Process.Start(psi))
                    {
                        if (p != null) p.WaitForExit(3000);
                    }
                });
            }
            catch { }
        }

        private async Task RestartBridgeAsync()
        {
            await StopBridgeAsync();
            // 确保旧端口彻底释放，避免端口冲突
            for (int i = 0; i < 10; i++)
            {
                if (!await IsPortListeningAsync(200)) break;
                await Task.Delay(500);
            }
            await StartBridgeAsync();
            // 等待新服务健康恢复
            for (int i = 0; i < 12; i++)
            {
                if (await CheckHealthOnceAsync(300)) break;
                await Task.Delay(500);
            }
            UpdateHealthUI(await CheckHealthOnceAsync(300));
        }

        private async Task RunCliAsync(string subCommand, bool showResult)
        {
            if (isCliRunning)
            {
                if (showResult) MessageBox.Show("已有任务正在执行中，请稍候...", "MOMO API Proxy", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            isCliRunning = true;
            try
            {
                ProcessStartInfo psi = ResolveCliProcessInfo(subCommand);
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;

                string output = "";
                string error = "";

                await Task.Run(() =>
                {
                    using (Process p = Process.Start(psi))
                    {
                        if (p != null)
                        {
                            // 短生命周期 CLI 加入 Job Object (排除 update)
                            if (subCommand != "update" && jobHandle != IntPtr.Zero)
                            {
                                try { AssignProcessToJobObject(jobHandle, p.Handle); } catch { }
                            }

                            var outTask = Task.Run(() => p.StandardOutput.ReadToEnd());
                            var errTask = Task.Run(() => p.StandardError.ReadToEnd());
                            Task.WaitAll(new Task[] { outTask, errTask }, 15000);
                            p.WaitForExit(2000);

                            output = outTask.IsCompleted ? outTask.Result : "";
                            error = errTask.IsCompleted ? errTask.Result : "";
                        }
                    }
                });

                if (showResult)
                {
                    string msg = string.IsNullOrWhiteSpace(output) ? error : output;
                    MessageBox.Show(msg.Trim(), "MOMO API Proxy - " + subCommand, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                if (showResult)
                {
                    MessageBox.Show("执行出错: " + ex.Message, "MOMO API Proxy", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            finally
            {
                isCliRunning = false;
            }
        }

        private void InitJobObject()
        {
            try
            {
                jobHandle = CreateJobObject(IntPtr.Zero, null);
                var basicLimit = new JOBOBJECT_BASIC_LIMIT_INFORMATION
                {
                    LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                };
                var extendedInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
                {
                    BasicLimitInformation = basicLimit
                };
                int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr pInfo = Marshal.AllocHGlobal(length);
                try
                {
                    Marshal.StructureToPtr(extendedInfo, pInfo, false);
                    SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation, pInfo, (uint)length);
                }
                finally
                {
                    Marshal.FreeHGlobal(pInfo);
                }
            }
            catch { }
        }

        private bool CheckAutostart()
        {
            string startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            return File.Exists(Path.Combine(startupDir, "momoapi-proxy-tray.lnk"));
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

        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryLimit;
            public UIntPtr PeakJobMemoryLimit;
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        [DllImport("user32.dll")]
        private static extern IntPtr CreateIconIndirect(ref ICONINFO icon);

        [StructLayout(LayoutKind.Sequential)]
        private struct ICONINFO
        {
            public bool fIcon;
            public int xHotspot;
            public int yHotspot;
            public IntPtr hbmMask;
            public IntPtr hbmColor;
        }

        [DllImport("gdi32.dll")]
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
                cts.Cancel();
                cts.Dispose();
                if (notifyIcon != null) notifyIcon.Dispose();
                if (jobHandle != IntPtr.Zero)
                {
                    CloseHandle(jobHandle);
                    jobHandle = IntPtr.Zero;
                }
            }
            base.Dispose(disposing);
        }
    }
}
