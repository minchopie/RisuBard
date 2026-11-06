using System.Net.Sockets;
using RisuAI.ChatTransfer.Core;

namespace RisuAI.ChatTransfer.WinForms;

public sealed partial class MainForm
{
    private readonly CheckBox _usbMode = new() { Text = "USB 케이블로 전송 · PIN 입력 없음", AutoSize = true };
    private readonly ComboBox _usbDevices = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 300 };
    private readonly Button _usbRefresh = CreateButton("기기 새로고침");
    private readonly Button _adbSelect = CreateButton("ADB 선택");
    private readonly Label _usbStatus = new() { AutoSize = true, MaximumSize = new Size(680, 0), Text = "USB 디버깅과 PC 신뢰 승인 후 태블릿에서 USB 보내기·받기를 선택하세요." };
    private string? _adbPath;
    private CancellationTokenSource? _usbCancel;
    private bool _usbLoading;
    private Panel? _sendNetworkSection;
    private Panel? _receiveNetworkSection;

    private Control BuildUsbPanel()
    {
        var panel = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Top, ColumnCount = 3, RowCount = 3, Padding = new Padding(0, 0, 0, 8) };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 125));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100));
        panel.Controls.Add(_usbMode, 0, 0); panel.SetColumnSpan(_usbMode, 3);
        _usbDevices.Dock = _usbRefresh.Dock = _adbSelect.Dock = DockStyle.Fill;
        _usbDevices.BackColor = FieldColor; _usbDevices.ForeColor = TextColor;
        panel.Controls.Add(_usbDevices, 0, 1);
        panel.Controls.Add(_usbRefresh, 1, 1);
        panel.Controls.Add(_adbSelect, 2, 1);
        panel.Controls.Add(_usbStatus, 0, 2); panel.SetColumnSpan(_usbStatus, 3);
        return panel;
    }

    private void WireUsbEvents()
    {
        _usbMode.CheckedChanged += async (_, _) => { SetTransferControls(); if (_usbMode.Checked) await RefreshUsbAsync(); };
        _usbDevices.SelectedIndexChanged += (_, _) => SetTransferControls();
        _usbRefresh.Click += async (_, _) => await RefreshUsbAsync();
        _adbSelect.Click += async (_, _) => {
            using var dialog = new OpenFileDialog { Title = "Android SDK platform-tools의 adb.exe 선택", Filter = "ADB (adb.exe)|adb.exe", CheckFileExists = true };
            if (dialog.ShowDialog(this) == DialogResult.OK) { _adbPath = dialog.FileName; await RefreshUsbAsync(); }
        };
    }

    private void SetUsbControls(bool active)
    {
        _usbMode.Enabled = !active;
        _usbDevices.Enabled = !active && _usbMode.Checked;
        _usbRefresh.Enabled = !active && _usbMode.Checked;
        _adbSelect.Enabled = !active;
        _usbDevices.Visible = _usbRefresh.Visible = _adbSelect.Visible = _usbStatus.Visible = _usbMode.Checked;
        if (_sendNetworkSection is not null) _sendNetworkSection.Visible = !_usbMode.Checked;
        if (_receiveNetworkSection is not null) _receiveNetworkSection.Visible = !_usbMode.Checked;
        _sendAddressChoice.Enabled = _sendRefreshButton.Enabled = !active && !_usbMode.Checked;
        _receiveAddress.Parent!.Visible = _receivePin.Parent!.Visible = !_usbMode.Checked;
        _sendAddress.Parent!.Visible = _sendPin.Parent!.Visible = !_usbMode.Checked;
        _sendStartButton.Text = _usbMode.Checked ? "USB로 보내기" : "전송 준비";
        _receiveStartButton.Text = _usbMode.Checked ? "USB로 받기" : "파일 받기";
        if (_usbMode.Checked) {
            _sendStartButton.Enabled = !active && _selectedFile is not null && _usbDevices.SelectedItem is UsbDevice;
            _receiveStartButton.Enabled = !active && Directory.Exists(_receiveFolder.Text) && _usbDevices.SelectedItem is UsbDevice;
            _sendCancelButton.Enabled = _receiveCancelButton.Enabled = _usbCancel is not null;
        }
    }

    private async Task RefreshUsbAsync()
    {
        if (IsTransferActive) return;
        _usbLoading = true;
        SetTransferControls();
        try {
            _usbDevices.Items.Clear();
            _adbPath ??= await Task.Run(UsbAdbTransport.FindAdb);
            if (_adbPath is null) throw new IOException("ADB가 없습니다. Android 공식 platform-tools를 설치하고 ‘ADB 선택’을 누르세요.");
            var devices = await UsbAdbTransport.DiscoverAsync(_adbPath);
            if (_closing || IsDisposed) return;
            foreach (var device in devices) _usbDevices.Items.Add(device);
            if (_usbDevices.Items.Count > 0) _usbDevices.SelectedIndex = 0;
            _usbStatus.Text = _usbDevices.Items.Count == 0 ? "승인된 USB 기기가 없습니다. 케이블·USB 디버깅·태블릿의 PC 신뢰 승인을 확인하세요." : "태블릿의 기존 보내기·받기 메뉴에서 USB를 선택하고 이 화면에서 전송하세요.";
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or OperationCanceledException) {
            if (!_closing && !IsDisposed) _usbStatus.Text = error is OperationCanceledException ? "기기 확인 시간이 초과되었습니다. 케이블과 승인을 확인하세요." : error.Message;
        } finally { _usbLoading = false; if (!_closing && !IsDisposed) SetTransferControls(); }
    }

    private async Task RunUsbAsync(bool sending)
    {
        if (IsTransferActive || _adbPath is null || _usbDevices.SelectedItem is not UsbDevice device || (sending && _selectedFile is null)) return;
        using var cancel = new CancellationTokenSource();
        _usbCancel = cancel;
        var status = sending ? _sendStatus : _receiveStatus;
        var progressBar = sending ? _sendProgress : _receiveProgress;
        status.ForeColor = TextColor;
        status.Text = "USB 기기를 확인하고 연결하는 중…";
        progressBar.Value = 0;
        _sendPin.Clear(); _sendAddress.Clear();
        SetTransferControls();
        try {
            var file = sending ? await ChatFileValidator.ValidateAsync(_selectedFile!.FullPath) : null;
            using var usb = await UsbAdbTransport.ConnectAsync(_adbPath, device, sending, file?.Kind, cancel.Token);
            if (sending) {
                var result = await usb.SendAsync(file!, new Progress<TransferProgress>(UpdateSendProgress), cancel.Token);
                if (!_closing && !IsDisposed) PresentSendResult(result);
            } else {
                using var received = await usb.ReceiveAsync(_receiveFolder.Text, new Progress<TransferProgress>(UpdateReceiveProgress), cancel.Token);
                if (_closing || IsDisposed) return;
                status.ForeColor = SuccessColor;
                status.Text = $"저장 완료 · {received.SavedPath}";
                _receiveInfo.Text = received.Info.Kind == TransferPayloadKind.Persona
                    ? "PC RisuAI 설정 → 페르소나 → Import에서 받은 PNG를 선택하세요."
                    : "PC RisuAI에서 대상 캐릭터의 채팅 가져오기로 받은 JSON을 선택하세요. 새 채팅으로 추가됩니다.";
                progressBar.Value = 100;
            }
        } catch (Exception error) when (error is IOException or SocketException or InvalidDataException or ArgumentException or OperationCanceledException or ObjectDisposedException or UnauthorizedAccessException or System.ComponentModel.Win32Exception) {
            if (!_closing && !IsDisposed) {
                status.ForeColor = cancel.IsCancellationRequested ? MutedColor : ErrorColor;
                status.Text = cancel.IsCancellationRequested ? "USB 전송을 취소했습니다." : $"USB 전송 실패: {error.Message}";
            }
        } finally {
            _usbCancel = null;
            if (!_closing && !IsDisposed) SetTransferControls();
        }
    }
}
