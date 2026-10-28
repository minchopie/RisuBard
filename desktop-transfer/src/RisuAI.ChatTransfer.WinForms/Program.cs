namespace RisuAI.ChatTransfer.WinForms;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.FirstOrDefault() == "--risubard-service") {
            var owned = args.Length >= 4 && args[2] == "--owner";
            if ((!owned && args.Length is < 2 or > 3) || (owned && args.Length > 5) || !Path.IsPathFullyQualified(args[1])) throw new InvalidDataException("RisuBard data root required");
            PlaySetService.BardDataRoot = Path.GetFullPath(args[1]);
            using var owner = new Mutex(true, "Local\\" + PlaySetService.PipeName, out var created);
            if (!created) return;
            using var lifetime = new CancellationTokenSource();
            using var parent = owned ? System.Diagnostics.Process.GetProcessById(int.Parse(args[3])) : null;
            if (parent is not null) _ = parent.WaitForExitAsync().ContinueWith(_ => lifetime.Cancel(), TaskScheduler.Default);
            using var service = new PlaySetService(owned ? (args.Length == 5 ? args[4] : null) : (args.Length == 3 ? args[2] : null));
            try { service.Run(lifetime.Token).GetAwaiter().GetResult(); }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
            return;
        }
        if (args.FirstOrDefault() == "--nas-settings") {
            using var output = new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
            try {
                // The secret travels over inherited stdin/stdout pipes, never command-line arguments.
                if (args.Length != 2) throw new InvalidDataException("올바르지 않은 NAS 설정 명령입니다.");
                using var inputStream = new StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false, true));
                var buffer = new char[65537]; var count = 0;
                while (count < buffer.Length) { var n = inputStream.Read(buffer, count, buffer.Length - count); if (n == 0) break; count += n; }
                if (count > 65536) throw new InvalidDataException("NAS 설정 입력이 너무 큽니다.");
                var input = System.Text.Json.Nodes.JsonNode.Parse(new string(buffer, 0, count))!.AsObject();
                Array.Clear(buffer);
                var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RisuAI-PlaySet", PlaySetService.Profile);
                var value = NasSettingsStore.Command(root, args[1], input);
                output.Write(new System.Text.Json.Nodes.JsonObject { ["protocol"] = "risu-nas-settings-v1", ["value"] = value }.ToJsonString());
            } catch (Exception e) {
                output.Write(new System.Text.Json.Nodes.JsonObject { ["protocol"] = "risu-nas-settings-v1", ["error"] = e is InvalidDataException ? e.Message : "NAS 설정을 읽거나 저장하지 못했습니다." }.ToJsonString());
            }
            return;
        }
        if (args.FirstOrDefault() == "--play-set-selftest" && args.Length == 3) { PlaySetSelfTest.Run(args[1], args[2]).GetAwaiter().GetResult(); return; }
        if (args.FirstOrDefault() == "--play-set-service") {
            using var owner = new Mutex(true, "Global\\" + PlaySetService.PipeName, out var created);
            if (!created) return;
            using var service = new PlaySetService(args.Length > 1 ? args[1] : null);
            service.Run(CancellationToken.None).GetAwaiter().GetResult();
            return;
        }
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.FirstOrDefault() == "--play-set-share" && args.Length == 2) { Application.Run(new PlaySetShareForm(args[1])); return; }
        Application.Run(new MainForm(args.FirstOrDefault()));
    }
}
