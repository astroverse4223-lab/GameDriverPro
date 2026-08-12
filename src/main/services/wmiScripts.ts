/**
 * PowerShell/CIM queries used by the hardware and driver services.
 *
 * These are constants — no value from the renderer is ever concatenated in.
 * Every section is individually wrapped in try/catch so one unsupported class
 * (a laptop-only WMI namespace, a denied elevation) degrades that section to
 * null instead of failing the whole snapshot.
 *
 * Deliberately free of backticks and ${ } so the strings survive being embedded
 * in JS template literals unchanged.
 */

const HELPERS = `
$errs = New-Object System.Collections.ArrayList
function Sect {
  param([string]$Name, [scriptblock]$Block)
  try { & $Block } catch { [void]$errs.Add("$Name : $($_.Exception.Message)"); $null }
}
function IsoDate($d) { if ($null -ne $d -and $d -is [datetime]) { $d.ToString('o') } else { $null } }
function CharArr($a) { if ($null -eq $a) { $null } else { (-join ([char[]]($a | Where-Object { $_ -gt 0 }))).Trim() } }
`

const EMIT = `
$out.errors = @($errs)
ConvertTo-Json -InputObject ([pscustomobject]$out) -Depth 7 -Compress
`

/** Fast, pure-CIM section: system, CPU, GPUs, memory, board, displays, battery. */
export const CORE_HARDWARE_SCRIPT = `${HELPERS}
$out = [ordered]@{}

$out.system = Sect 'system' {
  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
  $chassis = @()
  try { foreach ($e in @(Get-CimInstance Win32_SystemEnclosure)) { $chassis += @($e.ChassisTypes) } } catch {}
  [pscustomobject]@{
    hostname       = $env:COMPUTERNAME
    osCaption      = $os.Caption
    osVersion      = $os.Version
    osBuild        = [string]$os.BuildNumber
    osArchitecture = $os.OSArchitecture
    installDate    = IsoDate $os.InstallDate
    lastBootTime   = IsoDate $os.LastBootUpTime
    uptimeSeconds  = $(if ($os.LastBootUpTime) { [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds } else { $null })
    manufacturer   = $cs.Manufacturer
    model          = $cs.Model
    chassisTypes   = $chassis
    totalMemory    = [int64]$cs.TotalPhysicalMemory
    freeMemoryKb   = [int64]$os.FreePhysicalMemory
  }
}

$out.cpu = Sect 'cpu' {
  $c = @(Get-CimInstance Win32_Processor)[0]
  [pscustomobject]@{
    name           = $c.Name
    manufacturer   = $c.Manufacturer
    physicalCores  = $c.NumberOfCores
    logicalCores   = $c.NumberOfLogicalProcessors
    baseClockMhz   = $c.CurrentClockSpeed
    maxClockMhz    = $c.MaxClockSpeed
    socket         = $c.SocketDesignation
    l2CacheKb      = $c.L2CacheSize
    l3CacheKb      = $c.L3CacheSize
    virtualization = $c.VirtualizationFirmwareEnabled
  }
}

$out.gpus = Sect 'gpus' {
  $vram = @{}
  try {
    Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue |
      ForEach-Object {
        $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        if ($p -and $p.DriverDesc -and $p.'HardwareInformation.qwMemorySize') {
          $vram[([string]$p.DriverDesc).Trim().ToLowerInvariant()] = [int64]$p.'HardwareInformation.qwMemorySize'
        }
      }
  } catch {}

  @(Get-CimInstance Win32_VideoController) | ForEach-Object {
    $key = ([string]$_.Name).Trim().ToLowerInvariant()
    $mem = $null
    $fromReg = $false
    if ($vram.ContainsKey($key)) { $mem = $vram[$key]; $fromReg = $true }
    elseif ($_.AdapterRAM) { $mem = [int64]$_.AdapterRAM }
    [pscustomobject]@{
      name              = $_.Name
      driverVersion     = $_.DriverVersion
      driverDate        = IsoDate $_.DriverDate
      driverProvider    = $_.AdapterCompatibility
      vramBytes         = $mem
      vramFromRegistry  = $fromReg
      videoProcessor    = $_.VideoProcessor
      currentResolution = $(if ($_.CurrentHorizontalResolution) { "$($_.CurrentHorizontalResolution) x $($_.CurrentVerticalResolution)" } else { $null })
      refreshRateHz     = $_.CurrentRefreshRate
      statusCode        = $_.ConfigManagerErrorCode
      pnpDeviceId       = $_.PNPDeviceID
    }
  }
}

$out.memory = Sect 'memory' {
  $mods = @(Get-CimInstance Win32_PhysicalMemory) | ForEach-Object {
    [pscustomobject]@{
      bank               = $_.BankLabel
      slot               = $_.DeviceLocator
      capacityBytes      = [int64]$_.Capacity
      speedMhz           = $_.Speed
      configuredSpeedMhz = $_.ConfiguredClockSpeed
      manufacturer       = $_.Manufacturer
      partNumber         = $(if ($_.PartNumber) { $_.PartNumber.Trim() } else { $null })
      formFactor         = $_.FormFactor
      memoryType         = $_.SMBIOSMemoryType
    }
  }
  $slots = $null
  try { $slots = (@(Get-CimInstance Win32_PhysicalMemoryArray)[0]).MemoryDevices } catch {}
  [pscustomobject]@{ modules = @($mods); slotsTotal = $slots }
}

$out.motherboard = Sect 'motherboard' {
  $b = @(Get-CimInstance Win32_BaseBoard)[0]
  $bios = @(Get-CimInstance Win32_BIOS)[0]
  $sb = $null
  try { $sb = Confirm-SecureBootUEFI } catch { $sb = $null }
  [pscustomobject]@{
    manufacturer    = $b.Manufacturer
    product         = $b.Product
    version         = $b.Version
    biosVendor      = $bios.Manufacturer
    biosVersion     = $bios.SMBIOSBIOSVersion
    biosReleaseDate = IsoDate $bios.ReleaseDate
    secureBoot      = $sb
  }
}

$out.displays = Sect 'displays' {
  $params = @{}
  try {
    foreach ($p in @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction Stop)) {
      $params[[string]$p.InstanceName] = $p
    }
  } catch {}
  @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID -ErrorAction Stop) | ForEach-Object {
    $p = $null
    if ($params.ContainsKey([string]$_.InstanceName)) { $p = $params[[string]$_.InstanceName] }
    $diag = $null
    if ($p -and $p.MaxHorizontalImageSize -and $p.MaxVerticalImageSize) {
      $diag = [math]::Round([math]::Sqrt([math]::Pow($p.MaxHorizontalImageSize, 2) + [math]::Pow($p.MaxVerticalImageSize, 2)) / 2.54, 1)
    }
    [pscustomobject]@{
      instance       = [string]$_.InstanceName
      name           = CharArr $_.UserFriendlyName
      manufacturer   = CharArr $_.ManufacturerName
      productCode    = CharArr $_.ProductCodeID
      diagonalInches = $diag
      active         = $(if ($p) { [bool]$p.Active } else { $null })
    }
  }
}

$out.battery = Sect 'battery' {
  $b = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
  if ($b.Count -eq 0) { [pscustomobject]@{ present = $false } }
  else {
    $design = $null; $full = $null
    try { $design = (@(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStaticData -ErrorAction Stop)[0]).DesignedCapacity } catch {}
    try { $full = (@(Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity -ErrorAction Stop)[0]).FullChargedCapacity } catch {}
    [pscustomobject]@{
      present        = $true
      chargePercent  = $b[0].EstimatedChargeRemaining
      statusCode     = $b[0].BatteryStatus
      designCapacity = $design
      fullCapacity   = $full
    }
  }
}
${EMIT}`

/** Storage: physical disks, SMART-derived reliability counters, volumes. */
export const STORAGE_SCRIPT = `${HELPERS}
$out = [ordered]@{}

$out.storage = Sect 'storage' {
  $volsByDisk = @{}
  try {
    foreach ($part in @(Get-Partition -ErrorAction Stop)) {
      if (-not $part.DriveLetter -or $part.DriveLetter -eq [char]0) { continue }
      $vol = $null
      try { $vol = Get-Volume -DriveLetter $part.DriveLetter -ErrorAction Stop } catch {}
      $key = [string]$part.DiskNumber
      if (-not $volsByDisk.ContainsKey($key)) { $volsByDisk[$key] = @() }
      $volsByDisk[$key] += [pscustomobject]@{
        letter     = [string]$part.DriveLetter
        label      = $(if ($vol) { $vol.FileSystemLabel } else { $null })
        fileSystem = $(if ($vol) { $vol.FileSystem } else { $null })
        totalBytes = $(if ($vol) { [int64]$vol.Size } else { [int64]$part.Size })
        freeBytes  = $(if ($vol) { [int64]$vol.SizeRemaining } else { $null })
      }
    }
  } catch {}

  @(Get-PhysicalDisk) | ForEach-Object {
    $pd = $_
    $rc = $null
    try { $rc = $pd | Get-StorageReliabilityCounter -ErrorAction Stop } catch {}
    $key = [string]$pd.DeviceId
    [pscustomobject]@{
      deviceId     = $key
      model        = $pd.Model
      friendlyName = $pd.FriendlyName
      sizeBytes    = [int64]$pd.Size
      mediaType    = [string]$pd.MediaType
      busType      = [string]$pd.BusType
      healthStatus = [string]$pd.HealthStatus
      operational  = [string](@($pd.OperationalStatus) -join ', ')
      temperatureC = $(if ($rc) { $rc.Temperature } else { $null })
      powerOnHours = $(if ($rc) { $rc.PowerOnHours } else { $null })
      wearPercent  = $(if ($rc) { $rc.Wear } else { $null })
      readErrors   = $(if ($rc) { $rc.ReadErrorsTotal } else { $null })
      reliability  = ($null -ne $rc)
      volumes      = @($(if ($volsByDisk.ContainsKey($key)) { $volsByDisk[$key] } else { @() }))
    }
  }
}
${EMIT}`

/** Network adapters (Get-NetAdapter also carries driver version + provider). */
export const NETWORK_SCRIPT = `${HELPERS}
$out = [ordered]@{}

$out.network = Sect 'network' {
  $ips = @{}
  try {
    foreach ($ip in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)) {
      if (-not $ips.ContainsKey([string]$ip.InterfaceIndex)) { $ips[[string]$ip.InterfaceIndex] = $ip.IPAddress }
    }
  } catch {}
  @(Get-NetAdapter -ErrorAction Stop) | ForEach-Object {
    [pscustomobject]@{
      id             = [string]$_.InterfaceGuid
      name           = $_.Name
      description    = $_.InterfaceDescription
      interfaceType  = [string]$_.MediaType
      physicalMedia  = [string]$_.PhysicalMediaType
      status         = [string]$_.Status
      linkSpeedBps   = [int64]$_.Speed
      ipv4           = $(if ($ips.ContainsKey([string]$_.InterfaceIndex)) { $ips[[string]$_.InterfaceIndex] } else { $null })
      isVirtual      = [bool]$_.Virtual
      driverVersion  = $_.DriverVersion
      driverProvider = $_.DriverProvider
    }
  }
}
${EMIT}`

/**
 * Signed-driver inventory joined with PnP device status. One query serves both
 * the Driver Manager and the per-category device lists in My PC.
 */
export const DRIVER_INVENTORY_SCRIPT = `${HELPERS}
$out = [ordered]@{}

$status = @{}
try {
  foreach ($d in @(Get-PnpDevice -ErrorAction Stop)) {
    $status[([string]$d.InstanceId).ToUpperInvariant()] = [pscustomobject]@{
      status  = [string]$d.Status
      problem = $d.ProblemCode
      present = [bool]$d.Present
      class   = [string]$d.Class
    }
  }
} catch { [void]$errs.Add("pnp-status : $($_.Exception.Message)") }

$out.drivers = Sect 'drivers' {
  @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop) | ForEach-Object {
    $id = ([string]$_.DeviceID).ToUpperInvariant()
    $st = $null
    if ($status.ContainsKey($id)) { $st = $status[$id] }
    [pscustomobject]@{
      deviceId       = [string]$_.DeviceID
      deviceName     = $_.DeviceName
      friendlyName   = $_.FriendlyName
      deviceClass    = [string]$_.DeviceClass
      manufacturer   = $_.Manufacturer
      driverProvider = $_.DriverProviderName
      driverVersion  = $_.DriverVersion
      driverDate     = IsoDate $_.DriverDate
      infName        = $_.InfName
      isSigned       = $_.IsSigned
      hardwareId     = [string]$_.HardWareID
      location       = $_.Location
      status         = $(if ($st) { $st.status } else { $null })
      problemCode    = $(if ($st) { $st.problem } else { $null })
      present        = $(if ($st) { $st.present } else { $null })
    }
  }
}
${EMIT}`

/**
 * Running processes with genuinely measured CPU usage: two samples of
 * TotalProcessorTime 600ms apart, normalised by logical core count. Per-process
 * GPU utilisation comes from the GPU engine performance counters when the
 * platform exposes them.
 */
export const PROCESS_SCRIPT = `${HELPERS}
$out = [ordered]@{}
$out.processes = Sect 'processes' {
  $cores = [Environment]::ProcessorCount
  $first = @{}
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    try { $first[[string]$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {}
  }
  $spanMs = 600
  Start-Sleep -Milliseconds $spanMs

  $gpuByPid = @{}
  try {
    foreach ($e in @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop)) {
      if ([string]$e.Name -match 'pid_(\\d+)') {
        $key = $matches[1]
        $value = [double]$e.UtilizationPercentage
        if ($gpuByPid.ContainsKey($key)) { $gpuByPid[$key] = $gpuByPid[$key] + $value } else { $gpuByPid[$key] = $value }
      }
    }
  } catch {}

  @(Get-Process -ErrorAction SilentlyContinue) | Where-Object { $_.Id -gt 4 } | ForEach-Object {
    $id = [string]$_.Id
    $cpu = $null
    try {
      if ($first.ContainsKey($id)) {
        $delta = $_.TotalProcessorTime.TotalMilliseconds - $first[$id]
        if ($delta -ge 0) { $cpu = [math]::Round(($delta / ($spanMs * $cores)) * 100, 1) }
      }
    } catch {}
    $title = $null
    try { if ($_.MainWindowTitle) { $title = $_.MainWindowTitle } } catch {}
    $desc = $null
    try { $desc = $_.Description } catch {}
    $gpu = $null
    if ($gpuByPid.ContainsKey($id)) { $gpu = [math]::Round($gpuByPid[$id], 1) }
    [pscustomobject]@{
      pid         = $_.Id
      name        = $_.ProcessName
      description = $desc
      memoryBytes = [int64]$_.WorkingSet64
      cpuPercent  = $cpu
      gpuPercent  = $gpu
      windowTitle = $title
    }
  }
}
${EMIT}`

export const STARTUP_SCRIPT = `${HELPERS}
$out = [ordered]@{}
$out.startup = Sect 'startup' {
  $items = @()
  foreach ($cmd in @(Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue)) {
    $items += [pscustomobject]@{
      name      = $cmd.Name
      command   = $cmd.Command
      location  = $cmd.Location
      user      = $cmd.User
      enabled   = $true
      source    = 'startup-command'
    }
  }
  $approved = @(
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
  )
  $disabled = @{}
  foreach ($path in $approved) {
    try {
      $key = Get-Item $path -ErrorAction Stop
      foreach ($valueName in $key.GetValueNames()) {
        $bytes = $key.GetValue($valueName)
        if ($bytes -is [byte[]] -and $bytes.Length -gt 0 -and $bytes[0] -ne 2 -and $bytes[0] -ne 6) {
          $disabled[[string]$valueName] = $true
        }
      }
    } catch {}
  }
  foreach ($item in $items) {
    if ($disabled.ContainsKey([string]$item.name)) { $item.enabled = $false }
  }
  $items
}
${EMIT}`

export const POWER_PLAN_SCRIPT = `${HELPERS}
$out = [ordered]@{}
$out.plans = Sect 'power' {
  $text = & powercfg /list 2>$null
  $active = $null
  $result = @()
  foreach ($line in @($text)) {
    if ($line -match 'GUID:\\s*([0-9a-fA-F-]{36})\\s*\\(([^)]*)\\)') {
      $isActive = $line.Trim().EndsWith('*')
      $result += [pscustomobject]@{ guid = $matches[1]; name = $matches[2]; active = $isActive }
      if ($isActive) { $active = $matches[1] }
    }
  }
  [pscustomobject]@{ plans = @($result); active = $active }
}
${EMIT}`

export const CRASH_SCRIPT = `${HELPERS}
$out = [ordered]@{}
$days = [int]$env:GDP_ARG_DAYS
if ($days -le 0) { $days = 30 }
$since = (Get-Date).AddDays(-$days)

$out.events = Sect 'events' {
  $collected = @()

  # Display driver timeouts / TDRs and other display-stack faults.
  try {
    $collected += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Display'; StartTime = $since } -ErrorAction Stop)
  } catch {}
  # Kernel-level bugchecks and dirty shutdowns.
  try {
    $collected += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41; StartTime = $since } -ErrorAction Stop)
  } catch {}
  try {
    $collected += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'BugCheck'; StartTime = $since } -ErrorAction Stop)
  } catch {}
  # Application crashes and hangs.
  try {
    $collected += @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; StartTime = $since } -ErrorAction Stop)
  } catch {}
  try {
    $collected += @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Hang'; StartTime = $since } -ErrorAction Stop)
  } catch {}
  # Driver load / service failures.
  try {
    $collected += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; Level = 2; StartTime = $since } -ErrorAction Stop)
  } catch {}

  $collected | Sort-Object TimeCreated -Descending | Select-Object -First 400 | ForEach-Object {
    $msg = ''
    try { $msg = [string]$_.Message } catch {}
    if ($msg.Length -gt 600) { $msg = $msg.Substring(0, 600) }
    [pscustomobject]@{
      recordId  = [string]$_.RecordId
      timestamp = IsoDate $_.TimeCreated
      provider  = [string]$_.ProviderName
      eventId   = [int]$_.Id
      level     = [int]$_.Level
      logName   = [string]$_.LogName
      message   = $msg
    }
  }
}

$out.dumps = Sect 'dumps' {
  $paths = @()
  $mini = Join-Path $env:SystemRoot 'Minidump'
  if (Test-Path $mini) {
    $paths += @(Get-ChildItem -Path $mini -Filter '*.dmp' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 20 |
      ForEach-Object { [pscustomobject]@{ path = $_.FullName; size = [int64]$_.Length; modified = IsoDate $_.LastWriteTime; kind = 'minidump' } })
  }
  $kernel = Join-Path $env:SystemRoot 'MEMORY.DMP'
  if (Test-Path $kernel) {
    $f = Get-Item $kernel -ErrorAction SilentlyContinue
    if ($f) { $paths += [pscustomobject]@{ path = $f.FullName; size = [int64]$f.Length; modified = IsoDate $f.LastWriteTime; kind = 'kernel' } }
  }
  $paths
}
${EMIT}`

export const RESTORE_POINT_STATUS_SCRIPT = `${HELPERS}
$out = [ordered]@{}
$out.status = Sect 'restore' {
  $enabled = $null
  try {
    $drives = @(Get-CimInstance -Namespace root\\default -ClassName SystemRestore -ErrorAction Stop)
    $enabled = ($drives.Count -gt 0)
  } catch { $enabled = $null }
  $recent = $null
  try {
    $rp = @(Get-ComputerRestorePoint -ErrorAction Stop | Sort-Object CreationTime -Descending)
    if ($rp.Count -gt 0) { $recent = [string]$rp[0].Description }
  } catch {}
  [pscustomobject]@{ enabled = $enabled; mostRecent = $recent }
}
${EMIT}`
