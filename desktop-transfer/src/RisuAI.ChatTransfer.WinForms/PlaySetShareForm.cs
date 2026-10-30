using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

namespace RisuAI.ChatTransfer.WinForms;

/// <summary>Owns the WinRT share contract until Windows/the user closes it. Opening it is not delivery.</summary>
internal sealed class PlaySetShareForm : Form
{
    private readonly string path;
    private DataTransferManager? manager;
    private readonly Label status = new() { AutoSize = true, MaximumSize = new Size(480, 0), Text = "시스템 공유창에서 받을 기기 또는 앱을 선택해 주세요." };
    public PlaySetShareForm(string file)
    {
        path = Path.GetFullPath(file);
        if (!File.Exists(path) || !Path.GetExtension(path).Equals(".risuplay", StringComparison.OrdinalIgnoreCase)) throw new IOException("플레이 세트 파일을 찾을 수 없습니다.");
        Text = "RisuAI 플레이 세트 공유"; Width = 540; Height = 180; StartPosition = FormStartPosition.CenterScreen;
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), FlowDirection = FlowDirection.TopDown };
        panel.Controls.Add(status);
        var button = new Button { Text = "시스템 공유창 다시 열기", AutoSize = true }; button.Click += (_, _) => ShowShare(); panel.Controls.Add(button); Controls.Add(panel);
        Shown += (_, _) => {
            manager = DataTransferManagerInterop.GetForWindow(Handle);
            manager.DataRequested += OnRequested;
            ShowShare();
        };
        FormClosed += (_, _) => { if (manager is not null) manager.DataRequested -= OnRequested; };
    }
    private void ShowShare()
    {
        try { DataTransferManagerInterop.ShowShareUIForWindow(Handle); }
        catch (Exception e) { status.Text = "공유창을 열지 못했습니다: " + e.Message; }
    }
    private async void OnRequested(DataTransferManager sender, DataRequestedEventArgs args)
    {
        var deferral = args.Request.GetDeferral();
        try {
            var file = await StorageFile.GetFileFromPathAsync(path);
            args.Request.Data.Properties.Title = "RisuAI 플레이 세트";
            args.Request.Data.Properties.Description = "받은 .risuplay 파일을 RisuAI에서 열어 이어서 플레이하세요.";
            args.Request.Data.SetStorageItems(new[] { file });
        } catch (Exception e) { args.Request.FailWithDisplayText("파일을 공유하지 못했습니다: " + e.Message); }
        finally { deferral.Complete(); }
    }
}
