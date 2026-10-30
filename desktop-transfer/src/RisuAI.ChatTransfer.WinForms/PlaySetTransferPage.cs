using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json.Nodes;
using RisuAI.ChatTransfer.Core;

namespace RisuAI.ChatTransfer.WinForms;

internal sealed class PlaySetTransferPage : TabPage
{
    private readonly FlowLayoutPanel panel = new() { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(16) };
    private readonly ComboBox devices = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 510 };
    private readonly ComboBox usbDevices = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 510 };
    private readonly TextBox code = new() { MaxLength = 6, Width = 120 };
    private readonly Label status = new() { AutoSize = true, MaximumSize = new Size(560, 0), Text = "같은 Wi-Fi에서 RisuAI 앱을 열어 주세요." };
    private readonly ProgressBar progress = new() { Width = 510 };
    private string? file;
    private string? transfer;
    private string? peer;
    private bool working;
    private readonly System.Windows.Forms.Timer lease = new() { Interval = 15_000 };
    private sealed record Device(string Id, string Name, bool Registered) { public override string ToString() => Name + (Registered ? " · 내 기기" : " · 등록 필요"); }
    public PlaySetTransferPage() : base("플레이 세트")
    {
        Controls.Add(panel);
        panel.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(560, 0), Text = "캐릭터·대화·페르소나·모듈·프리셋을 함께 옮깁니다. 자료 검증과 가져오기는 MGE Fix 앱에서 처리합니다." });
        Add("MGE Fix 열기 · 받은 세트 가져오기", async () => { await Call("application.open"); status.Text = "MGE Fix에서 가져오기 결과와 ‘이어서 플레이’를 확인해 주세요."; });
        Add("MGE Fix 실행 파일 등록", async () => { using var picker = new OpenFileDialog { Filter = "RisuAI MGE Fix|RisuAI-MGE-Fix.exe" }; if (picker.ShowDialog(this) == DialogResult.OK) { await Call("application.register", new() { ["path"] = picker.FileName, ["profile"] = PlaySetService.Profile }); status.Text = "MGE Fix 실행 경로를 등록했습니다."; } });
        Add("보낼 .risuplay 파일 선택", async () => { using var picker = new OpenFileDialog { Filter = "RisuAI 플레이 세트|*.risuplay" }; if (picker.ShowDialog(this) == DialogResult.OK) { file = (await Call("file.stage", new() { ["path"] = picker.FileName }))!.GetValue<string>(); status.Text = "선택: " + Path.GetFileName(picker.FileName); } });
        Add("같은 Wi-Fi 기기 새로 고침", RefreshDevices);
        panel.Controls.Add(devices);
        Add("이 PC의 6자리 등록 코드 표시", async () => { var value = await Call("network.registration"); status.Text = "등록 코드: " + value!["code"]!.GetValue<string>() + " · 5분 동안 1회 사용"; });
        panel.Controls.Add(new Label { AutoSize = true, Text = "상대 기기에 표시된 6자리 코드" }); panel.Controls.Add(code);
        Add("선택한 기기 등록", async () => { var d = Selected(); if (code.Text.Length != 6 || code.Text.Any(c => !char.IsAsciiDigit(c))) throw new IOException("6자리 숫자를 입력해 주세요."); await Call("network.pair", new() { ["device"] = d.Id, ["code"] = code.Text }); code.Clear(); await RefreshDevices(); status.Text = "내 기기로 등록했습니다."; });
        Add("선택한 기기로 보내기", Send);
        Add("받는 기기의 가져오기 상태 확인", ReceivedStatus);
        Add("선택한 기기 등록 해제", async () => { await Call("network.forget", new() { ["device"] = Selected().Id }); await RefreshDevices(); });
        Add("Quick Share · 시스템 공유", async () => { if (file is null) throw new IOException("보낼 파일을 먼저 선택해 주세요."); await Call("file.share", new() { ["handle"] = file }); status.Text = "시스템 공유창을 요청했습니다. 전송 결과는 공유 화면에서 확인해 주세요."; });
        Add("연결된 USB 기기 찾기", async () => { usbDevices.Items.Clear(); foreach (var d in (await Call("usb.devices"))!.AsArray()) usbDevices.Items.Add(new UsbDevice(d!["serial"]!.GetValue<string>(), d["model"]!.GetValue<string>(), d["transportId"]!.GetValue<string>())); if (usbDevices.Items.Count > 0) usbDevices.SelectedIndex = 0; status.Text = usbDevices.Items.Count == 0 ? "USB 디버깅 승인과 케이블을 확인해 주세요." : "Android에서 RisuAI 앱을 열어 주세요."; });
        panel.Controls.Add(usbDevices);
        Add("USB로 플레이 세트 보내기", () => Usb(false));
        Add("Android에서 준비한 플레이 세트 USB 받기", () => Usb(true));
        panel.Controls.Add(progress); panel.Controls.Add(status);
        lease.Tick += async (_, _) => { try { await Call("network.start"); } catch (Exception e) { status.Text = e.Message; } };
        lease.Start(); Disposed += (_, _) => lease.Dispose();
    }
    private void Add(string label, Func<Task> action)
    {
        var button = new Button { Text = label, AutoSize = true, MinimumSize = new Size(280, 32) };
        button.Click += async (_, _) => {
            if (working) return; working = true;
            foreach (Control child in panel.Controls) if (child is Button) child.Enabled = false;
            try { await action(); } catch (Exception e) { status.Text = e.Message; }
            finally { working = false; if (!IsDisposed) foreach (Control child in panel.Controls) if (child is Button) child.Enabled = true; }
        }; panel.Controls.Add(button);
    }
    private Device Selected() => devices.SelectedItem as Device ?? throw new IOException("기기를 먼저 선택해 주세요.");
    private async Task RefreshDevices()
    {
        var current = (devices.SelectedItem as Device)?.Id;
        var found = (await Call("network.devices"))!.AsArray(); devices.Items.Clear();
        foreach (var item in found) devices.Items.Add(new Device(item!["id"]!.GetValue<string>(), item["name"]!.GetValue<string>(), item["registered"]!.GetValue<bool>()));
        if (devices.Items.Count > 0) devices.SelectedIndex = Math.Max(0, devices.Items.Cast<Device>().ToList().FindIndex(d => d.Id == current));
        status.Text = devices.Items.Count == 0 ? "검색된 기기가 없습니다. 앱을 열고 잠시 후 새로 고침해 주세요." : "기기 목록을 갱신했습니다.";
    }
    private async Task Send()
    {
        if (file is null) throw new IOException("보낼 파일을 먼저 선택해 주세요.");
        var device = Selected(); if (!device.Registered) throw new IOException("먼저 내 기기로 등록해 주세요.");
        peer = device.Id; transfer = Guid.NewGuid().ToString();
        await Call("network.send", new() { ["device"] = peer, ["transfer"] = transfer, ["handle"] = file });
        while (!IsDisposed) {
            var result = await Call("network.progress", new() { ["transfer"] = transfer });
            if (result!["state"]!.GetValue<string>() == "failed") throw new IOException(result["error"]!.GetValue<string>());
            if (result["state"]!.GetValue<string>() == "delivered") { progress.Value = 100; await ReceivedStatus(); return; }
            var total = result["total"]!.GetValue<long>(); var sent = result["sent"]!.GetValue<long>();
            progress.Value = total == 0 ? 0 : (int)Math.Clamp(sent * 100.0 / total, 0, 100); status.Text = "전달 중 · " + progress.Value + "%";
            await Task.Delay(700);
        }
    }
    private async Task ReceivedStatus()
    {
        if (transfer is null || peer is null) throw new IOException("보낸 세트가 없습니다.");
        var state = (await Call("network.status", new() { ["device"] = peer, ["transfer"] = transfer }))!.GetValue<string>();
        status.Text = state == "applied" ? "전달 완료 · 가져오기 완료" : state == "failed" ? "전달 완료 · 받는 기기에서 가져오기 확인 필요" : "전달 완료 · 가져오기 대기";
    }
    private async Task Usb(bool receive)
    {
        var d = usbDevices.SelectedItem as UsbDevice ?? throw new IOException("USB 기기를 먼저 선택해 주세요.");
        if (!receive && file is null) throw new IOException("보낼 파일을 먼저 선택해 주세요.");
        var device = new JsonObject { ["serial"] = d.Serial, ["model"] = d.Model, ["transportId"] = d.TransportId };
        var job = Guid.NewGuid().ToString();
        await Call(receive ? "usb.receive" : "usb.send", new() { ["device"] = device, ["handle"] = file, ["transfer"] = job });
        while (!IsDisposed) {
            var result = await Call("usb.progress", new() { ["transfer"] = job });
            var state = result!["state"]!.GetValue<string>();
            if (state == "failed") throw new IOException(result["error"]!.GetValue<string>());
            if (state == "delivered") {
                progress.Value = 100; status.Text = "USB 전달 완료 · 가져오기 대기";
                if (receive) await Call("application.open");
                else { var imported = (await Call("usb.status", new() { ["device"] = device.DeepClone(), ["transfer"] = job }))!.GetValue<string>(); if (imported == "applied") status.Text = "USB 전달 완료 · 가져오기 완료"; }
                return;
            }
            var total = result["total"]?.GetValue<long>() ?? 0; var sent = result["sent"]?.GetValue<long>() ?? 0;
            progress.Value = total == 0 ? 0 : (int)Math.Clamp(sent * 100.0 / total, 0, 100); status.Text = "USB 전송 중 · " + progress.Value + "%"; await Task.Delay(700);
        }
    }
    internal static async Task<JsonNode?> Call(string op, JsonObject? args = null)
    {
        using var pipe = new NamedPipeClientStream(".", PlaySetService.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try { await pipe.ConnectAsync(100); }
        catch (TimeoutException) {
            var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true }; start.ArgumentList.Add("--play-set-service"); Process.Start(start);
            await pipe.ConnectAsync(10_000);
        }
        var bytes = System.Text.Encoding.UTF8.GetBytes(new JsonObject { ["op"] = op, ["args"] = args ?? new() }.ToJsonString());
        var prefix = new byte[4]; BinaryPrimitives.WriteInt32BigEndian(prefix, bytes.Length);
        await pipe.WriteAsync(prefix); await pipe.WriteAsync(bytes); await pipe.FlushAsync();
        await pipe.ReadExactlyAsync(prefix); var length = BinaryPrimitives.ReadInt32BigEndian(prefix);
        if (length is < 1 or > 12 * 1024 * 1024) throw new InvalidDataException("Invalid broker response");
        var response = new byte[length]; await pipe.ReadExactlyAsync(response); var value = JsonNode.Parse(response)!;
        if (value["error"] is not null) throw new IOException(value["error"]!.GetValue<string>());
        return value["value"]?.DeepClone();
    }
}
