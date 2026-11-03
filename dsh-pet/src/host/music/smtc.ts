/**
 * 系统媒体会话（SMTC）读取：一个常驻 PowerShell 子进程，每 ~700ms 打一行 JSON。
 *
 * 为什么常驻：每次 spawn PowerShell 冷启动 300–500ms，1s 级轮询会把 CPU 吃满。
 * 只读曲名/歌手/播放态——**网易云 Windows 客户端不上报时间轴**（实测），进度由 service 用时钟推算。
 * 控制（播放/暂停/切歌）是低频操作，单独一次性调用即可（见 control()）。
 * @module dsh-pet/src/host/music/smtc
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** 一次采样。 */
export interface SmtcSample {
  /** 客户端进程标识，如 cloudmusic.exe；无会话为 ''。 */
  app: string;
  title: string;
  artist: string;
  /** 'playing' | 'paused' | 'stopped' | '' */
  status: string;
}

const READER =
  String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$g = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` +
  '`1' +
  String.raw`' })[0]
function Aw($o,$t){ $x=$g.MakeGenericMethod($t).Invoke($null,@($o)); $x.Wait(4000)|Out-Null; $x.Result }
$m = Aw ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
while ($true) {
  $s = $m.GetSessions() | Where-Object { $_.SourceAppUserModelId -like '*cloudmusic*' } | Select-Object -First 1
  if ($s) {
    $p = Aw ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $o = [ordered]@{ app=$s.SourceAppUserModelId; title=$p.Title; artist=$p.Artist; status=[string]$s.GetPlaybackInfo().PlaybackStatus }
    [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  } else {
    [Console]::Out.WriteLine('{"app":"","title":"","artist":"","status":""}')
  }
  Start-Sleep -Milliseconds 700
}
`;

/** 控制命令 → 要调用的 SMTC 方法。 */
const CTRL_METHOD: Record<'playpause' | 'next' | 'prev', string> = {
  playpause: 'TryTogglePlayPauseAsync',
  next: 'TrySkipNextAsync',
  prev: 'TrySkipPreviousAsync',
};

const CONTROL = (method: string): string =>
  String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$g = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` +
  '`1' +
  String.raw`' })[0]
function Aw($o,$t){ $x=$g.MakeGenericMethod($t).Invoke($null,@($o)); $x.Wait(4000)|Out-Null; $x.Result }
$m = Aw ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $m.GetSessions() | Where-Object { $_.SourceAppUserModelId -like '*cloudmusic*' } | Select-Object -First 1
if ($s) { [void]$s.` +
  method +
  String.raw`() }
`;

/** 常驻读取器：把最新样本回调出去。 */
export class SmtcReader {
  private readonly onSample: (s: SmtcSample) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';

  constructor(onSample: (s: SmtcSample) => void) {
    this.onSample = onSample;
  }

  start(): void {
    if (this.child) return;
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', READER],
      {
        windowsHide: true,
      },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.on('error', () => this.stop());
    this.child.on('exit', () => {
      this.child = null;
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try {
        const o = JSON.parse(line) as SmtcSample;
        this.onSample({
          app: o.app ?? '',
          title: o.title ?? '',
          artist: o.artist ?? '',
          status: (o.status ?? '').toLowerCase(),
        });
      } catch {
        /* 半行/坏行忽略 */
      }
    }
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.buf = '';
  }
}

/** 一次性控制命令（低频，spawn 成本可接受）。 */
export function smtcControl(action: 'playpause' | 'next' | 'prev'): void {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CONTROL(CTRL_METHOD[action])],
    { windowsHide: true },
  );
  child.on('error', () => undefined);
}
