param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('previous', 'playpause', 'next')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'

# WinRT-команды ниже адресованы конкретно сессии Spotify. Они не затрагивают
# браузерные медиасессии и не зависят от того, какое приложение было активным.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]

function Wait-WinRtOperation {
  param(
    [Parameter(Mandatory = $true)] $Operation,
    [Parameter(Mandatory = $true)] [Type] $ResultType
  )

  $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethod -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1

  $task = $asTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

$managerOperation = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
$manager = Wait-WinRtOperation $managerOperation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$spotifySessions = @($manager.GetSessions() | Where-Object {
  $_.SourceAppUserModelId -match 'spotify'
})

if (-not $spotifySessions.Count) {
  Write-Error 'Spotify media session was not found.'
  exit 2
}

$spotifySession = $spotifySessions |
  Where-Object {
    $_.GetPlaybackInfo().PlaybackStatus -eq
      [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
  } |
  Select-Object -First 1

if (-not $spotifySession) {
  $spotifySession = $spotifySessions[0]
}

$controlOperation = switch ($Action) {
  'previous'  { $spotifySession.TrySkipPreviousAsync() }
  'playpause' { $spotifySession.TryTogglePlayPauseAsync() }
  'next'      { $spotifySession.TrySkipNextAsync() }
}

$succeeded = Wait-WinRtOperation $controlOperation ([Boolean])
if (-not $succeeded) {
  Write-Error "Spotify rejected media action '$Action'."
  exit 3
}
