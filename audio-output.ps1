param([ValidateSet('get','toggle')][string]$Action = 'get')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

if (-not ('AudioOutput.PolicyConfig' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace AudioOutput {
  enum EDataFlow { Render, Capture, All }
  enum ERole { Console, Multimedia, Communications }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow flow, uint stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow flow, ERole role, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid id, uint context, IntPtr activationParams, out IntPtr instance);
    int OpenPropertyStore(uint access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator {}

  [ComImport, Guid("568B9108-44BF-40B4-9006-86AFE5B5A620"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfigVista {
    int GetMixFormat(string id, out IntPtr format);
    int GetDeviceFormat(string id, int defaultFormat, out IntPtr format);
    int SetDeviceFormat(string id, IntPtr endpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod(string id, int defaultPeriod, out long defaultValue, out long minimumValue);
    int SetProcessingPeriod(string id, ref long period);
    int GetShareMode(string id, out IntPtr mode);
    int SetShareMode(string id, IntPtr mode);
    int GetPropertyValue(string id, IntPtr key, out IntPtr value);
    int SetPropertyValue(string id, IntPtr key, IntPtr value);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, ERole role);
  }

  [ComImport, Guid("294935CE-F637-4E7C-A41B-AB255460B862")]
  class PolicyConfigVistaClient {}

  public static class PolicyConfig {
    public static string GetDefaultId() {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out device));
      string id;
      Marshal.ThrowExceptionForHR(device.GetId(out id));
      return id;
    }

    public static void SetDefault(string id) {
      var policy = (IPolicyConfigVista)new PolicyConfigVistaClient();
      for (var role = ERole.Console; role <= ERole.Communications; role++)
        Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(id, role));
    }
  }
}
'@
}

$renderRoot = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
$friendlyNameKey = '{a45c254e-df1c-4efd-8020-67d146a850e0},2'
$devices = @(Get-ChildItem $renderRoot | ForEach-Object {
  $state = (Get-ItemProperty $_.PSPath -Name DeviceState -ErrorAction SilentlyContinue).DeviceState
  $properties = Get-ItemProperty (Join-Path $_.PSPath 'Properties') -ErrorAction SilentlyContinue
  $name = $properties.$friendlyNameKey
  $driverName = $properties.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
  if ($state -eq 1 -and $name -and "$name $driverName" -notmatch '(?i)steam|streaming|virtual') {
    [pscustomobject]@{ Id = "{0.0.0.00000000}.$($_.PSChildName)"; Name = $name }
  }
})

$currentId = [AudioOutput.PolicyConfig]::GetDefaultId()
$current = $devices | Where-Object Id -eq $currentId | Select-Object -First 1

if ($Action -eq 'toggle') {
  $headphones = $devices | Where-Object Name -match '(?i)headphone|headset|\u043d\u0430\u0443\u0448|\u0433\u0430\u0440\u043d\u0438\u0442\u0443\u0440|2nd output' | Select-Object -First 1
  $speakers = $devices | Where-Object Name -match '(?i)speaker|\u0434\u0438\u043d\u0430\u043c\u0438\u043a' | Select-Object -First 1
  if (-not $headphones -or -not $speakers) { throw 'Headphones and speakers outputs must both be connected' }
  $target = if ($currentId -eq $headphones.Id) { $speakers } else { $headphones }
  [AudioOutput.PolicyConfig]::SetDefault($target.Id)
  if ([AudioOutput.PolicyConfig]::GetDefaultId() -ne $target.Id) { throw 'Windows did not change the default audio output' }
  $current = $target
}

$kind = if ($current.Name -match '(?i)headphone|headset|\u043d\u0430\u0443\u0448|\u0433\u0430\u0440\u043d\u0438\u0442\u0443\u0440|2nd output') { 'headphones' } else { 'speakers' }
[pscustomobject]@{ kind = $kind; name = $current.Name } | ConvertTo-Json -Compress
