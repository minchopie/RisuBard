using System.Diagnostics;
using System.Globalization;
using System.Net.Sockets;
using RisuAI.ChatTransfer.Core;

namespace RisuAI.ChatTransfer.WinForms;

public sealed partial class MainForm : Form
{
    private static readonly Color WindowColor = Color.FromArgb(19, 22, 30);
    private static readonly Color PanelColor = Color.FromArgb(31, 36, 48);
    private static readonly Color FieldColor = Color.FromArgb(49, 57, 76);
    private static readonly Color TextColor = Color.FromArgb(242, 244, 248);
    private static readonly Color MutedColor = Color.FromArgb(177, 184, 198);
    private static readonly Color AccentColor = Color.FromArgb(104, 139, 217);
    private static readonly Color SuccessColor = Color.FromArgb(143, 217, 160);
    private static readonly Color WarningColor = Color.FromArgb(244, 190, 102);
    private static readonly Color ErrorColor = Color.FromArgb(244, 137, 137);

    private readonly TabControl _directionTabs = new();

    private readonly TextBox _sendFilePath = CreateTextBox();
    private readonly Button _sendBrowseButton = CreateButton("파일 선택");
    private readonly Label _sendFileInfo = CreateLabel("표준 PC판에서 내보낸 개별 대화 JSON 또는 페르소나 PNG를 선택하세요.", MutedColor);
    private readonly ComboBox _sendAddressChoice = new();
    private readonly Button _sendRefreshButton = CreateButton("새로 고침");
    private readonly Button _sendStartButton = CreateButton("전송 준비");
    private readonly TextBox _sendAddress = CreateTextBox();
    private readonly TextBox _sendPin = CreateTextBox();
    private readonly Button _sendCopyAddressButton = CreateButton("주소 복사");
    private readonly Button _sendCopyPinButton = CreateButton("PIN 복사");
    private readonly ProgressBar _sendProgress = CreateProgressBar();
    private readonly Label _sendStatus = CreateLabel("대기 중", MutedColor);
    private readonly Label _sendCountdown = CreateLabel(string.Empty, MutedColor);
    private readonly Button _sendCancelButton = CreateButton("전송 취소");
    private readonly System.Windows.Forms.Timer _sendTimer = new() { Interval = 500 };
    private readonly Stopwatch _sendClock = new();

    private readonly TextBox _receiveAddress = CreateTextBox();
    private readonly TextBox _receivePin = CreateTextBox();
    private readonly TextBox _receiveFolder = CreateTextBox();
    private readonly Button _receiveFolderButton = CreateButton("폴더 선택");
    private readonly Button _receiveStartButton = CreateButton("파일 받기");
    private readonly Button _receiveCancelButton = CreateButton("받기 취소");
    private readonly ProgressBar _receiveProgress = CreateProgressBar();
    private readonly Label _receiveStatus = CreateLabel("대기 중", MutedColor);
    private readonly Label _receiveInfo = CreateLabel(
        "받은 파일은 PC RisuAI에 자동 적용하지 않습니다. 검사를 통과한 대화 JSON 또는 페르소나 PNG만 지정 폴더에 저장합니다.", MutedColor);
    private readonly Stopwatch _receiveClock = new();

    private ChatFileInfo? _selectedFile;
    private OneShotChatServer? _server;
    private PeerTransferClient? _receiver;
    private long _validationGeneration;
    private long _lastSendBytes;
    private bool _receiveCancelRequested;
    private bool _closing;

    public MainForm(string? initialFile)
    {
        using var iconStream = typeof(MainForm).Assembly.GetManifestResourceStream("TransferIcon");
        if (iconStream is not null) Icon = new Icon(iconStream);
        Text = "RisuAI 대화·페르소나 직접 전송";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(680, 720);
        Size = new Size(760, 850);
        BackColor = WindowColor;
        ForeColor = TextColor;
        Font = new Font("Segoe UI", 10F);
        AutoScaleMode = AutoScaleMode.Dpi;
        AllowDrop = true;

        _receiveFolder.Text = GetDefaultReceiveDirectory();
        Controls.Add(BuildLayout());
        _directionTabs.TabPages.Add(new PlaySetTransferPage());
        var bard = new TabPage("RisuBard");
        var bardPanel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), FlowDirection = FlowDirection.TopDown };
        bardPanel.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(560, 0), Text = "RisuBard의 캐릭터·대화 옮기기에서 Wi-Fi · USB · NAS · GitHub를 사용하세요. 채팅과 기억 적용은 RisuBard가 처리합니다. 기존 전송 메뉴는 그대로 사용할 수 있어요." });
        var openBard = new Button { Text = "RisuBard 열기", AutoSize = true };
        openBard.Click += (_, _) => {
            var path = Path.Combine(AppContext.BaseDirectory, "RisuBard.exe");
            if (!File.Exists(path)) {
                using var picker = new OpenFileDialog { Filter = "RisuBard|RisuBard.exe", Title = "RisuBard 실행 파일 선택" };
                if (picker.ShowDialog(this) != DialogResult.OK) return;
                path = picker.FileName;
            }
            try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }
            catch (Exception error) { MessageBox.Show(this, error.Message, "RisuBard 실행 실패"); }
        };
        bardPanel.Controls.Add(openBard); bard.Controls.Add(bardPanel); _directionTabs.TabPages.Add(bard);
        WireEvents();
        RefreshSendAddresses();
        SetTransferControls();

        if (!string.IsNullOrWhiteSpace(initialFile))
        {
            Shown += async (_, _) =>
            {
                _directionTabs.SelectedIndex = 0;
                await SelectSendFileAsync(initialFile).ConfigureAwait(true);
            };
        }
    }

    private Control BuildLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(20),
            ColumnCount = 1,
            RowCount = 4,
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        var title = CreateLabel("RisuAI 대화·페르소나 직접 전송", TextColor);
        title.Font = new Font(Font.FontFamily, 19F, FontStyle.Bold);
        title.AutoSize = true;
        title.Margin = new Padding(0, 0, 0, 6);
        root.Controls.Add(title);

        var intro = CreateLabel(
            "한 캐릭터의 현재 대화(risuChat v2) 또는 페르소나 PNG를 PC와 Android/태블릿 사이에서 양방향으로 옮깁니다. " +
            "USB는 기기 선택으로, Wi-Fi·Tailscale은 주소와 PIN으로 암호화해 한 번만 전송합니다.",
            MutedColor);
        intro.AutoSize = true;
        intro.MaximumSize = new Size(690, 0);
        intro.Margin = new Padding(0, 0, 0, 12);
        root.Controls.Add(intro);

        root.Controls.Add(BuildUsbPanel());
        _directionTabs.Dock = DockStyle.Fill;
        _directionTabs.Padding = new Point(18, 7);
        _directionTabs.TabPages.Add(CreateTabPage("PC → Android 보내기", BuildSendPage()));
        _directionTabs.TabPages.Add(CreateTabPage("Android → PC 받기", BuildReceivePage()));
        root.Controls.Add(_directionTabs);
        return root;
    }

    private Control BuildSendPage()
    {
        var root = CreatePageLayout();
        root.Controls.Add(BuildSendFilePanel());
        root.Controls.Add(BuildSendNetworkPanel());
        root.Controls.Add(BuildSendTransferPanel());
        return root;
    }

    private Control BuildSendFilePanel()
    {
        var panel = CreateSection("1. PC 표준판에서 대화 또는 페르소나 내보내기", 205);
        var layout = (TableLayoutPanel)panel.Controls[0];
        var guide = CreateWrappedLabel(
            "대화는 캐릭터의 채팅 목록에서 옮길 행 오른쪽 다운로드(↓) → Export as JSON을 누르세요. " +
            "페르소나는 설정 → 페르소나에서 대상을 선택한 뒤 Export로 PNG를 저장하세요.");
        guide.Margin = new Padding(0, 0, 0, 10);
        layout.Controls.Add(guide);

        _sendFilePath.ReadOnly = true;
        _sendFilePath.AllowDrop = true;
        _sendFilePath.PlaceholderText = "개별 대화 JSON 또는 페르소나 PNG를 끌어놓기";
        _sendBrowseButton.Width = 104;
        layout.Controls.Add(CreateTwoColumnRow(_sendFilePath, _sendBrowseButton));
        _sendFileInfo.AutoSize = true;
        _sendFileInfo.MaximumSize = new Size(640, 0);
        _sendFileInfo.Margin = new Padding(0, 10, 0, 0);
        layout.Controls.Add(_sendFileInfo);
        return panel;
    }

    private Control BuildSendNetworkPanel()
    {
        var panel = CreateSection("2. 보낼 네트워크 선택", 145);
        _sendNetworkSection = panel;
        var layout = (TableLayoutPanel)panel.Controls[0];
        _sendAddressChoice.DropDownStyle = ComboBoxStyle.DropDownList;
        _sendAddressChoice.BackColor = FieldColor;
        _sendAddressChoice.ForeColor = TextColor;
        _sendAddressChoice.FlatStyle = FlatStyle.Flat;
        _sendAddressChoice.Dock = DockStyle.Fill;
        _sendRefreshButton.Width = 104;
        layout.Controls.Add(CreateTwoColumnRow(_sendAddressChoice, _sendRefreshButton));

        var note = CreateWrappedLabel(
            "같은 Wi-Fi/LAN이면 192.168·10·172 주소를, 서로 떨어져 있으면 Tailscale 100.64–100.127 주소를 선택하세요. " +
            "Windows 방화벽 알림이 뜨면 개인 네트워크만 허용하세요.");
        note.Margin = new Padding(0, 10, 0, 0);
        layout.Controls.Add(note);
        return panel;
    }

    private Control BuildSendTransferPanel()
    {
        var panel = CreateSection("3. Android에서 받기 준비", 275);
        var layout = (TableLayoutPanel)panel.Controls[0];
        StylePrimaryButton(_sendStartButton);
        layout.Controls.Add(_sendStartButton);

        _sendAddress.ReadOnly = true;
        _sendPin.ReadOnly = true;
        _sendPin.Font = new Font("Consolas", 15F, FontStyle.Bold);
        _sendPin.TextAlign = HorizontalAlignment.Center;
        layout.Controls.Add(CreateValueRow("주소", _sendAddress, _sendCopyAddressButton));
        layout.Controls.Add(CreateValueRow("PIN", _sendPin, _sendCopyPinButton));
        layout.Controls.Add(_sendProgress);

        var statusRow = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2 };
        statusRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        statusRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _sendStatus.AutoSize = true;
        _sendCountdown.AutoSize = true;
        _sendCountdown.TextAlign = ContentAlignment.MiddleRight;
        statusRow.Controls.Add(_sendStatus, 0, 0);
        statusRow.Controls.Add(_sendCountdown, 1, 0);
        layout.Controls.Add(statusRow);
        _sendCancelButton.Dock = DockStyle.Top;
        _sendCancelButton.Margin = new Padding(0, 10, 0, 0);
        layout.Controls.Add(_sendCancelButton);
        return panel;
    }

    private Control BuildReceivePage()
    {
        var root = CreatePageLayout();
        var source = CreateSection("1. Android/태블릿에서 보내기 시작", 120);
        ((TableLayoutPanel)source.Controls[0]).Controls.Add(CreateWrappedLabel(
            "Android 앱의 계정 & 파일에서 현재 대화 직접 보내기 또는 현재 페르소나 직접 보내기를 누르세요. " +
            "USB는 연결 선택에서 USB 케이블을 고르세요. 네트워크 주소와 PIN은 5분 동안 한 번만 유효합니다."));
        root.Controls.Add(source);

        var connection = CreateSection("2. 네트워크 전송용 주소와 PIN", 180);
        _receiveNetworkSection = connection;
        var connectionLayout = (TableLayoutPanel)connection.Controls[0];
        _receiveAddress.PlaceholderText = "예: 192.168.50.92:45123 또는 device.tailnet.ts.net:45123";
        _receivePin.PlaceholderText = "숫자 10자리";
        _receivePin.MaxLength = 10;
        _receivePin.Font = new Font("Consolas", 14F, FontStyle.Bold);
        _receivePin.TextAlign = HorizontalAlignment.Center;
        connectionLayout.Controls.Add(CreateInputRow("주소", _receiveAddress));
        connectionLayout.Controls.Add(CreateInputRow("PIN", _receivePin));
        root.Controls.Add(connection);

        var destination = CreateSection("3. 받은 파일 저장", 245);
        var destinationLayout = (TableLayoutPanel)destination.Controls[0];
        _receiveFolder.ReadOnly = true;
        _receiveFolderButton.Width = 104;
        destinationLayout.Controls.Add(CreateTwoColumnRow(_receiveFolder, _receiveFolderButton));
        StylePrimaryButton(_receiveStartButton);
        _receiveStartButton.Margin = new Padding(0, 10, 0, 0);
        destinationLayout.Controls.Add(_receiveStartButton);
        destinationLayout.Controls.Add(_receiveProgress);
        _receiveStatus.AutoSize = true;
        _receiveStatus.MaximumSize = new Size(640, 0);
        destinationLayout.Controls.Add(_receiveStatus);
        _receiveInfo.AutoSize = true;
        _receiveInfo.MaximumSize = new Size(640, 0);
        _receiveInfo.Margin = new Padding(0, 8, 0, 0);
        destinationLayout.Controls.Add(_receiveInfo);
        _receiveCancelButton.Dock = DockStyle.Top;
        _receiveCancelButton.Margin = new Padding(0, 10, 0, 0);
        destinationLayout.Controls.Add(_receiveCancelButton);
        root.Controls.Add(destination);
        return root;
    }

    private void WireEvents()
    {
        WireUsbEvents();
        _sendBrowseButton.Click += async (_, _) =>
        {
            using var dialog = new OpenFileDialog
            {
                Title = "RisuAI 개별 대화 JSON 또는 페르소나 PNG 선택",
                Filter = "RisuAI 전송 파일 (*.json;*.png)|*.json;*.png|개별 대화 JSON (*.json)|*.json|페르소나 PNG (*.png)|*.png",
                CheckFileExists = true,
                Multiselect = false,
                InitialDirectory = GetDefaultReceiveDirectory(),
            };
            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                await SelectSendFileAsync(dialog.FileName).ConfigureAwait(true);
            }
        };
        _sendRefreshButton.Click += (_, _) => RefreshSendAddresses();
        _sendStartButton.Click += async (_, _) => await StartSendAsync().ConfigureAwait(true);
        _sendCancelButton.Click += (_, _) => { _server?.Cancel(); _usbCancel?.Cancel(); };
        _sendCopyAddressButton.Click += (_, _) => CopySendText(_sendAddress.Text, "주소");
        _sendCopyPinButton.Click += (_, _) => CopySendText(_sendPin.Text, "PIN");
        _sendTimer.Tick += (_, _) => UpdateSendCountdown();

        _receiveFolderButton.Click += (_, _) => ChooseReceiveFolder();
        _receiveAddress.TextChanged += (_, _) => SetTransferControls();
        _receivePin.TextChanged += (_, _) => SetTransferControls();
        _receiveStartButton.Click += async (_, _) => await StartReceiveAsync().ConfigureAwait(true);
        _receiveCancelButton.Click += (_, _) =>
        {
            _receiveCancelRequested = true;
            _receiver?.Cancel();
            _usbCancel?.Cancel();
        };

        DragEnter += HandleDragEnter;
        DragDrop += HandleDragDrop;
        _sendFilePath.DragEnter += HandleDragEnter;
        _sendFilePath.DragDrop += HandleDragDrop;
        FormClosing += (_, _) =>
        {
            _closing = true;
            _sendTimer.Stop();
            _server?.Cancel();
            _server?.Dispose();
            _receiver?.Cancel();
            _usbCancel?.Cancel();
            _receiver?.Dispose();
        };
    }

    private void HandleDragEnter(object? sender, DragEventArgs eventArgs)
    {
        eventArgs.Effect = !IsTransferActive && TryGetSingleDroppedFile(eventArgs.Data, out _)
            ? DragDropEffects.Copy
            : DragDropEffects.None;
    }

    private async void HandleDragDrop(object? sender, DragEventArgs eventArgs)
    {
        if (!IsTransferActive && TryGetSingleDroppedFile(eventArgs.Data, out var path))
        {
            _directionTabs.SelectedIndex = 0;
            await SelectSendFileAsync(path).ConfigureAwait(true);
        }
    }

    private static bool TryGetSingleDroppedFile(IDataObject? data, out string path)
    {
        path = string.Empty;
        if (data?.GetData(DataFormats.FileDrop) is not string[] { Length: 1 } files) return false;
        path = files[0];
        var extension = Path.GetExtension(path);
        return File.Exists(path) && (extension.Equals(".json", StringComparison.OrdinalIgnoreCase) ||
            extension.Equals(".png", StringComparison.OrdinalIgnoreCase));
    }

    private async Task SelectSendFileAsync(string path)
    {
        var generation = Interlocked.Increment(ref _validationGeneration);
        _selectedFile = null;
        _sendFileInfo.ForeColor = MutedColor;
        _sendFileInfo.Text = "RisuAI 전송 파일을 검사하는 중…";
        SetTransferControls();
        try
        {
            _sendFilePath.Text = Path.GetFullPath(path);
            var info = await ChatFileValidator.ValidateAsync(path).ConfigureAwait(true);
            if (generation != Volatile.Read(ref _validationGeneration)) return;
            _selectedFile = info;
            _sendFileInfo.ForeColor = SuccessColor;
            if (info.Kind == TransferPayloadKind.Persona)
            {
                _sendFileInfo.Text = $"확인됨 · 페르소나 {info.PersonaName} · 프롬프트 {info.PersonaPromptCharacters:N0}자 · {FormatBytes(info.Bytes)}" +
                    (info.PersonaHasNote ? " · 노트 있음" : " · 노트 없음") +
                    "\n받는 기기에는 새 페르소나로 추가되며 현재 선택은 바꾸지 않습니다.";
            }
            else
            {
                var character = string.IsNullOrWhiteSpace(info.CharacterName) ? string.Empty : $" · 캐릭터 {info.CharacterName}";
                _sendFileInfo.Text = $"확인됨 · {info.ChatName}{character} · 메시지 {info.MessageCount:N0}개 · {FormatBytes(info.Bytes)}" +
                    (info.ReferencedInlayCount > 0 ? $" · 인레이 참조 {info.ReferencedInlayCount:N0}개" : string.Empty) +
                    (string.IsNullOrWhiteSpace(info.CharacterName) ? "\nAndroid에서 먼저 이 대화의 대상 캐릭터를 열어 두세요." : string.Empty);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException or
            System.Text.Json.JsonException or ArgumentException or NotSupportedException)
        {
            if (generation != Volatile.Read(ref _validationGeneration)) return;
            _sendFileInfo.ForeColor = ErrorColor;
            _sendFileInfo.Text = error.Message;
        }
        finally
        {
            if (generation == Volatile.Read(ref _validationGeneration)) SetTransferControls();
        }
    }

    private void RefreshSendAddresses()
    {
        var previous = (_sendAddressChoice.SelectedItem as LocalPeerAddress)?.Address;
        _sendAddressChoice.Items.Clear();
        foreach (var address in NetworkAddressCatalog.Discover()) _sendAddressChoice.Items.Add(address);
        if (_sendAddressChoice.Items.Count > 0)
        {
            var matchingIndex = Enumerable.Range(0, _sendAddressChoice.Items.Count)
                .FirstOrDefault(index => (_sendAddressChoice.Items[index] as LocalPeerAddress)?.Address.Equals(previous) == true, -1);
            _sendAddressChoice.SelectedIndex = matchingIndex >= 0 ? matchingIndex : 0;
        }
        SetTransferControls();
        if (_sendAddressChoice.Items.Count == 0)
        {
            _sendStatus.ForeColor = ErrorColor;
            _sendStatus.Text = "사용 가능한 사설 IPv4 또는 Tailscale 주소가 없습니다.";
        }
    }

    private async Task StartSendAsync()
    {
        if (_usbMode.Checked) { await RunUsbAsync(true); return; }
        if (IsTransferActive || _selectedFile is null ||
            _sendAddressChoice.SelectedItem is not LocalPeerAddress selectedAddress) return;

        try
        {
            var verified = await ChatFileValidator.ValidateAsync(_selectedFile.FullPath).ConfigureAwait(true);
            if (verified.Bytes != _selectedFile.Bytes)
            {
                _selectedFile = verified;
                throw new InvalidDataException("선택 후 파일 크기가 바뀌었습니다. 다시 전송 준비를 눌러주세요.");
            }

            _server = new OneShotChatServer(verified.FullPath, verified.TransferFileName, selectedAddress.Address);
            _sendAddress.Text = _server.DisplayAddress;
            _sendPin.Text = _server.Pin;
            _sendProgress.Value = 0;
            _lastSendBytes = 0;
            _sendClock.Reset();
            _sendStatus.ForeColor = TextColor;
            _sendStatus.Text = GetAndroidReceiveInstruction(verified.Kind);
            SetTransferControls();
            _sendTimer.Start();

            var result = await _server.ServeAsync(new Progress<TransferProgress>(UpdateSendProgress)).ConfigureAwait(true);
            if (!_closing && !IsDisposed) PresentSendResult(result);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SocketException or
            InvalidOperationException or InvalidDataException or ArgumentException)
        {
            _sendStatus.ForeColor = ErrorColor;
            _sendStatus.Text = $"전송을 시작하지 못했습니다: {error.Message}";
        }
        finally
        {
            _sendTimer.Stop();
            _server?.Dispose();
            _server = null;
            if (!_closing && !IsDisposed) SetTransferControls();
        }
    }

    private async Task StartReceiveAsync()
    {
        if (_usbMode.Checked) { await RunUsbAsync(false); return; }
        if (IsTransferActive) return;
        _receiveCancelRequested = false;
        try
        {
            var endpoint = PeerEndpointParser.Parse(_receiveAddress.Text);
            var pin = _receivePin.Text.Trim();
            if (!PeerTransferProtocol.IsValidPin(pin)) throw new ArgumentException("PIN은 숫자 10자리여야 합니다.");
            var destination = Path.GetFullPath(_receiveFolder.Text);
            if (!Directory.Exists(destination)) throw new DirectoryNotFoundException("선택한 저장 폴더를 찾을 수 없습니다.");

            _receiver = new PeerTransferClient(endpoint, pin);
            _receiveProgress.Value = 0;
            _receiveClock.Reset();
            _receiveStatus.ForeColor = TextColor;
            _receiveStatus.Text = "Android에 연결하고 PIN을 확인하는 중…";
            _receiveInfo.ForeColor = MutedColor;
            _receiveInfo.Text = "암호화 검증과 risuChat v2 또는 RisuAI 페르소나 PNG 형식 검사가 끝난 파일만 저장합니다.";
            SetTransferControls();

            using var received = await _receiver.ReceiveAndSaveAsync(
                destination, new Progress<TransferProgress>(UpdateReceiveProgress)).ConfigureAwait(true);
            var savedPath = received.SavedPath ?? throw new IOException("받은 파일의 최종 저장 경로를 확인하지 못했습니다.");
            _receiveProgress.Value = 100;
            _receiveStatus.ForeColor = SuccessColor;
            _receiveStatus.Text = $"저장 완료 · {savedPath}";
            _receiveInfo.ForeColor = SuccessColor;
            if (received.Info.Kind == TransferPayloadKind.Persona)
            {
                _receiveInfo.Text = $"페르소나 {received.Info.PersonaName} · 프롬프트 {received.Info.PersonaPromptCharacters:N0}자 · {FormatBytes(received.Info.Bytes)}\n" +
                    "PC 표준판 설정 → 페르소나에서 Import를 누르고 이 PNG를 선택하세요. 기존 페르소나를 덮어쓰지 않고 새 항목으로 추가됩니다.";
            }
            else
            {
                var character = string.IsNullOrWhiteSpace(received.Info.CharacterName) ? "" : $" · 캐릭터 {received.Info.CharacterName}";
                _receiveInfo.Text = $"{received.Info.ChatName}{character} · 메시지 {received.Info.MessageCount:N0}개 · {FormatBytes(received.Info.Bytes)}\n" +
                    "PC 표준판에서 대상 캐릭터를 열고 채팅 목록 맨 아래의 드라이브+↑ 아이콘으로 이 JSON을 선택하세요. " +
                    "맨 위에 새 채팅으로 추가되므로 그 대화를 이어서 플레이하세요.";
            }
            _receivePin.Clear();
        }
        catch (Exception error) when (_receiveCancelRequested && error is OperationCanceledException or IOException or SocketException or ObjectDisposedException)
        {
            _receiveStatus.ForeColor = MutedColor;
            _receiveStatus.Text = "파일 받기를 취소했습니다.";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SocketException or
            InvalidDataException or System.Security.Cryptography.CryptographicException or
            OperationCanceledException or ArgumentException or NotSupportedException)
        {
            _receiveStatus.ForeColor = ErrorColor;
            _receiveStatus.Text = $"받기 실패: {error.Message}";
        }
        finally
        {
            _receiver?.Dispose();
            _receiver = null;
            if (!_closing && !IsDisposed) SetTransferControls();
        }
    }

    private void ChooseReceiveFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Android에서 받은 RisuAI 대화 JSON 또는 페르소나 PNG를 저장할 폴더",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
            InitialDirectory = Directory.Exists(_receiveFolder.Text) ? _receiveFolder.Text : GetDefaultReceiveDirectory(),
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            _receiveFolder.Text = Path.GetFullPath(dialog.SelectedPath);
            SetTransferControls();
        }
    }

    private void UpdateSendProgress(TransferProgress progress)
    {
        if (_closing || IsDisposed) return;
        _lastSendBytes = progress.TransferredBytes;
        UpdateProgress(_sendProgress, _sendStatus, _sendClock, progress, "전송 중");
    }

    private void UpdateReceiveProgress(TransferProgress progress)
    {
        if (_closing || IsDisposed) return;
        UpdateProgress(_receiveProgress, _receiveStatus, _receiveClock, progress, "받는 중");
    }

    private static void UpdateProgress(
        ProgressBar bar, Label status, Stopwatch clock, TransferProgress progress, string action)
    {
        if (progress.TransferredBytes == 0) clock.Reset();
        if (!clock.IsRunning && progress.TransferredBytes > 0) clock.Start();
        var percent = progress.TotalBytes == 0
            ? 0
            : (int)Math.Clamp(progress.TransferredBytes * 100L / progress.TotalBytes, 0, 100);
        bar.Value = percent;

        var eta = string.Empty;
        if (progress.TransferredBytes > 0 && progress.TransferredBytes < progress.TotalBytes && clock.Elapsed.TotalSeconds > 0.2)
        {
            var bytesPerSecond = progress.TransferredBytes / clock.Elapsed.TotalSeconds;
            var remainingSeconds = (progress.TotalBytes - progress.TransferredBytes) / Math.Max(1, bytesPerSecond);
            eta = $" · 약 {FormatDuration(TimeSpan.FromSeconds(remainingSeconds))} 남음";
        }
        status.ForeColor = TextColor;
        status.Text = $"{action} {percent}% · {FormatBytes(progress.TransferredBytes)} / {FormatBytes(progress.TotalBytes)}{eta}";
    }

    private void UpdateSendCountdown()
    {
        if (_server is null) return;
        var remaining = _server.ExpiresAt - DateTimeOffset.UtcNow;
        if (remaining < TimeSpan.Zero) remaining = TimeSpan.Zero;
        _sendCountdown.Text = $"PIN 만료 {remaining.Minutes:00}:{remaining.Seconds:00}";
        if (_lastSendBytes == 0 && remaining > TimeSpan.Zero)
        {
            _sendStatus.Text = GetAndroidReceiveInstruction(_selectedFile?.Kind ?? TransferPayloadKind.Chat);
        }
    }

    private void PresentSendResult(TransferResult result)
    {
        _sendCountdown.Text = string.Empty;
        switch (result.Outcome)
        {
            case TransferOutcome.Sent:
                _sendProgress.Value = 100;
                _sendStatus.ForeColor = SuccessColor;
                _sendStatus.Text = "전송 완료 · Android에서 가져오기 확인 화면을 확인하세요.";
                break;
            case TransferOutcome.Expired:
                _sendStatus.ForeColor = WarningColor;
                _sendStatus.Text = "5분이 지나 주소와 PIN이 만료되었습니다. 전송 준비를 다시 누르세요.";
                break;
            case TransferOutcome.Cancelled:
                _sendStatus.ForeColor = MutedColor;
                _sendStatus.Text = "전송을 취소했습니다.";
                break;
            case TransferOutcome.TooManyAttempts:
                _sendStatus.ForeColor = ErrorColor;
                _sendStatus.Text = "잘못된 접속이 5회 발생해 전송을 종료했습니다. 새 PIN을 만드세요.";
                break;
            default:
                _sendStatus.ForeColor = ErrorColor;
                _sendStatus.Text = $"전송 실패: {result.ErrorMessage ?? "알 수 없는 오류"}";
                break;
        }
    }

    private void SetTransferControls()
    {
        var active = IsTransferActive;
        _sendBrowseButton.Enabled = !active;
        _sendRefreshButton.Enabled = !active;
        _sendAddressChoice.Enabled = !active;
        _sendStartButton.Enabled = !active && _selectedFile is not null && _sendAddressChoice.SelectedItem is LocalPeerAddress;
        _sendCancelButton.Enabled = _server is not null;
        _sendCopyAddressButton.Enabled = _server is not null && _sendAddress.TextLength > 0;
        _sendCopyPinButton.Enabled = _server is not null && _sendPin.TextLength > 0;

        _receiveAddress.Enabled = !active;
        _receivePin.Enabled = !active;
        _receiveFolderButton.Enabled = !active;
        _receiveStartButton.Enabled = !active && _receiveAddress.TextLength > 0 &&
            _receivePin.TextLength == 10 && Directory.Exists(_receiveFolder.Text);
        _receiveCancelButton.Enabled = _receiver is not null;
        SetUsbControls(active);
    }

    private bool IsTransferActive => _server is not null || _receiver is not null || _usbCancel is not null || _usbLoading;

    private static string GetAndroidReceiveInstruction(TransferPayloadKind kind) =>
        kind == TransferPayloadKind.Persona
            ? "Android: 계정 & 파일 → 주소·PIN으로 페르소나 받기"
            : "Android: 계정 & 파일 → 주소·PIN으로 현재 대화 받기";

    private void CopySendText(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        try
        {
            Clipboard.SetText(value);
            _sendStatus.ForeColor = TextColor;
            _sendStatus.Text = $"{label}를 복사했습니다.";
        }
        catch (Exception error)
        {
            _sendStatus.ForeColor = ErrorColor;
            _sendStatus.Text = $"{label}를 복사하지 못했습니다: {error.Message}";
        }
    }

    private static TabPage CreateTabPage(string title, Control content)
    {
        var page = new TabPage(title) { BackColor = WindowColor, ForeColor = TextColor, Padding = new Padding(4) };
        page.Controls.Add(content);
        return page;
    }

    private static TableLayoutPanel CreatePageLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            Padding = new Padding(10, 14, 10, 10),
            ColumnCount = 1,
            RowCount = 1,
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return root;
    }

    private static Panel CreateSection(string heading, int minimumHeight)
    {
        var panel = new Panel
        {
            BackColor = PanelColor,
            Dock = DockStyle.Top,
            AutoSize = true,
            MinimumSize = new Size(0, minimumHeight),
            Padding = new Padding(16),
            Margin = new Padding(0, 0, 0, 14),
        };
        var layout = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 1, RowCount = 1 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var label = CreateLabel(heading, TextColor);
        label.Font = new Font("Segoe UI", 11F, FontStyle.Bold);
        label.AutoSize = true;
        label.Margin = new Padding(0, 0, 0, 12);
        layout.Controls.Add(label);
        panel.Controls.Add(layout);
        return panel;
    }

    private static TableLayoutPanel CreateTwoColumnRow(Control value, Button button)
    {
        var row = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2 };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        value.Dock = DockStyle.Fill;
        button.Margin = new Padding(8, 0, 0, 0);
        row.Controls.Add(value, 0, 0);
        row.Controls.Add(button, 1, 0);
        return row;
    }

    private static Control CreateValueRow(string labelText, TextBox value, Button copyButton)
    {
        var row = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 3, Margin = new Padding(0, 10, 0, 0) };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 52));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var label = CreateLabel(labelText, MutedColor);
        label.Dock = DockStyle.Fill;
        label.TextAlign = ContentAlignment.MiddleLeft;
        value.Dock = DockStyle.Fill;
        copyButton.Width = 104;
        copyButton.Margin = new Padding(8, 0, 0, 0);
        row.Controls.Add(label, 0, 0);
        row.Controls.Add(value, 1, 0);
        row.Controls.Add(copyButton, 2, 0);
        return row;
    }

    private static Control CreateInputRow(string labelText, TextBox input)
    {
        var row = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Margin = new Padding(0, 5, 0, 5) };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 52));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var label = CreateLabel(labelText, MutedColor);
        label.Dock = DockStyle.Fill;
        label.TextAlign = ContentAlignment.MiddleLeft;
        input.Dock = DockStyle.Fill;
        row.Controls.Add(label, 0, 0);
        row.Controls.Add(input, 1, 0);
        return row;
    }

    private static void StylePrimaryButton(Button button)
    {
        button.BackColor = AccentColor;
        button.ForeColor = Color.White;
        button.Height = 42;
        button.Dock = DockStyle.Top;
    }

    private static Button CreateButton(string text) => new()
    {
        Text = text,
        AutoSize = false,
        Height = 34,
        BackColor = FieldColor,
        ForeColor = TextColor,
        FlatStyle = FlatStyle.Flat,
        UseVisualStyleBackColor = false,
    };

    private static TextBox CreateTextBox() => new()
    {
        BackColor = FieldColor,
        ForeColor = TextColor,
        BorderStyle = BorderStyle.FixedSingle,
        Height = 32,
    };

    private static ProgressBar CreateProgressBar() => new()
    {
        Dock = DockStyle.Top,
        Height = 18,
        Style = ProgressBarStyle.Continuous,
        Margin = new Padding(0, 12, 0, 6),
    };

    private static Label CreateWrappedLabel(string text)
    {
        var label = CreateLabel(text, MutedColor);
        label.AutoSize = true;
        label.MaximumSize = new Size(640, 0);
        return label;
    }

    private static Label CreateLabel(string text, Color color) => new()
    {
        Text = text,
        ForeColor = color,
        BackColor = Color.Transparent,
    };

    private static string GetDefaultReceiveDirectory()
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var downloads = string.IsNullOrWhiteSpace(profile) ? string.Empty : Path.Combine(profile, "Downloads");
        if (Directory.Exists(downloads)) return downloads;
        var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        return Directory.Exists(documents) ? documents : AppContext.BaseDirectory;
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KiB", "MiB", "GiB"];
        var value = (double)bytes;
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        return $"{value.ToString(unit == 0 ? "N0" : "N1", CultureInfo.CurrentCulture)} {units[unit]}";
    }

    private static string FormatDuration(TimeSpan duration)
    {
        if (duration.TotalSeconds < 1) return "1초 미만";
        if (duration.TotalMinutes < 1) return $"{Math.Ceiling(duration.TotalSeconds):N0}초";
        return $"{Math.Ceiling(duration.TotalMinutes):N0}분";
    }
}
