import type { DeviceStatus, DriverCategory, GpuVendor, ProcessInfo } from '../../shared/types'

/** Map a Windows setup class to one of the app's driver categories. */
export function categoryFromClass(deviceClass: string | null, name: string | null): DriverCategory {
  const cls = (deviceClass ?? '').toUpperCase()
  const text = (name ?? '').toLowerCase()

  switch (cls) {
    case 'DISPLAY':
      return 'graphics'
    case 'MEDIA':
    case 'AUDIOENDPOINT':
    case 'AUDIOPROCESSINGOBJECT':
      return 'audio'
    case 'BLUETOOTH':
      return 'bluetooth'
    case 'NET':
      // Wi-Fi adapters live in the same class as wired NICs; split on the name.
      if (/wi-?fi|wireless|802\.11|wlan|dual band|ax\d{3}|ac \d{4}/.test(text)) return 'wifi'
      return 'network'
    case 'USB':
      return 'usb'
    case 'DISKDRIVE':
    case 'SCSIADAPTER':
    case 'HDC':
    case 'VOLUME':
    case 'VOLUMESNAPSHOT':
    case 'STORAGE':
      return 'storage'
    case 'MONITOR':
      return 'display'
    case 'KEYBOARD':
    case 'MOUSE':
      return 'input'
    case 'HIDCLASS':
      if (/controller|gamepad|xbox|dualshock|dualsense|joystick|wheel|xinput/.test(text)) return 'controller'
      return 'input'
    case 'XNACOMPOSITE':
    case 'XBOXCOMPOSITE':
      return 'controller'
    case 'IMAGE':
    case 'CAMERA':
      return 'camera'
    case 'PRINTQUEUE':
    case 'PRINTER':
      return 'printer'
    case 'PROCESSOR':
    case 'COMPUTER':
    case 'FIRMWARE':
      return 'motherboard'
    case 'SYSTEM':
      // The SYSTEM class is where chipset packages land.
      if (/chipset|pci express root|host bridge|smbus|lpc|management engine|platform|serial io|thermal|amd psp|pcie/.test(text)) {
        return 'chipset'
      }
      return 'system'
    case 'SOFTWARECOMPONENT':
    case 'SOFTWAREDEVICE':
      return 'system'
    default:
      if (/audio|realtek|sound/.test(text)) return 'audio'
      if (/graphics|geforce|radeon|nvidia/.test(text)) return 'graphics'
      return 'other'
  }
}

export const CATEGORY_LABELS: Record<DriverCategory, string> = {
  graphics: 'Graphics',
  chipset: 'Chipset',
  audio: 'Audio',
  network: 'Network',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  storage: 'Storage',
  usb: 'USB',
  motherboard: 'Motherboard',
  controller: 'Controllers',
  input: 'Input devices',
  display: 'Displays',
  camera: 'Cameras',
  printer: 'Printers',
  system: 'System devices',
  other: 'Other hardware'
}

/** Categories that matter for gaming, in the order the UI presents them. */
export const GAMING_CATEGORIES: DriverCategory[] = [
  'graphics',
  'chipset',
  'audio',
  'network',
  'wifi',
  'bluetooth',
  'storage',
  'usb',
  'controller'
]

export function gpuVendorOf(name: string | null, provider: string | null): GpuVendor {
  const text = `${name ?? ''} ${provider ?? ''}`.toLowerCase()
  if (/nvidia|geforce|quadro|rtx|gtx/.test(text)) return 'nvidia'
  if (/amd|radeon|ati |ryzen/.test(text)) return 'amd'
  if (/intel|arc |iris|uhd graphics|hd graphics/.test(text)) return 'intel'
  if (/microsoft|basic display|remote/.test(text)) return 'microsoft'
  return 'unknown'
}

/**
 * Configuration-manager error code → status. Code 0 (and no code) is working;
 * anything else is a real problem Windows is reporting.
 */
export function statusFromProblem(problemCode: number | null, statusText: string | null): DeviceStatus {
  const text = (statusText ?? '').toLowerCase()
  if (text === 'error') return 'error'
  if (text === 'degraded') return 'warning'
  if (text === 'unknown') return 'unknown'
  if (problemCode === null || problemCode === undefined) return text === 'ok' ? 'ok' : 'unknown'
  if (problemCode === 0) return 'ok'
  if (problemCode === 22) return 'disabled'
  return 'error'
}

/** Plain-language explanation of the Windows problem codes users actually hit. */
export function problemText(code: number | null): string | null {
  if (code === null || code === 0) return null
  const map: Record<number, string> = {
    1: 'Device is not configured correctly (no driver installed).',
    3: 'The driver may be corrupted, or the system is low on memory.',
    9: 'Windows cannot identify this hardware.',
    10: 'The device cannot start.',
    12: 'The device cannot find enough free resources to use.',
    14: 'The device needs a restart to work properly.',
    18: 'The drivers for this device need to be reinstalled.',
    19: 'Windows cannot start this device because its configuration information is incomplete or damaged.',
    21: 'Windows is removing this device.',
    22: 'This device is disabled.',
    24: 'This device is not present, not working properly, or does not have all its drivers installed.',
    28: 'The drivers for this device are not installed.',
    31: 'Windows cannot load the drivers required for this device.',
    32: 'A driver for this device has been disabled.',
    35: 'The firmware does not include enough information to configure and use this device.',
    38: 'Windows cannot load the device driver because a previous instance is still in memory.',
    39: 'Windows cannot load the driver — it may be corrupt or missing.',
    43: 'Windows has stopped this device because it reported problems.',
    45: 'This device is not currently connected to the computer.',
    48: 'The software for this device has been blocked because of known compatibility problems.',
    52: 'Windows cannot verify the digital signature for the drivers required for this device.'
  }
  return map[code] ?? `Windows reported device problem code ${code}.`
}

const PROTECTED_PROCESSES = new Set(
  [
    'system',
    'registry',
    'smss',
    'csrss',
    'wininit',
    'winlogon',
    'services',
    'lsass',
    'lsaiso',
    'svchost',
    'fontdrvhost',
    'dwm',
    'explorer',
    'sihost',
    'taskhostw',
    'ctfmon',
    'audiodg',
    'conhost',
    'runtimebroker',
    'searchhost',
    'searchindexer',
    'shellexperiencehost',
    'startmenuexperiencehost',
    'textinputhost',
    'dashost',
    'wudfhost',
    'spoolsv',
    'msmpeng',
    'nissrv',
    'securityhealthservice',
    'securityhealthsystray',
    'wmiprvse',
    'trustedinstaller',
    'memcompression',
    'lockapp',
    'applicationframehost',
    'systemsettings',
    'gamedriver pro',
    'electron'
  ].map((n) => n.toLowerCase())
)

const CATEGORY_PATTERNS: { category: ProcessInfo['category']; pattern: RegExp }[] = [
  { category: 'browser', pattern: /^(chrome|msedge|firefox|opera|brave|vivaldi|iexplore)$/i },
  { category: 'launcher', pattern: /^(steam|steamwebhelper|epicgameslauncher|epicwebhelper|galaxyclient|origin|eadesktop|eabackgroundservice|upc|ubisoftconnect|battle\.net|agent|riotclientservices|xboxapp|gamingservices)$/i },
  { category: 'updater', pattern: /update|installer|setup|patch|nvcontainer|nvidia web helper|amdow|igfxem/i },
  { category: 'overlay', pattern: /overlay|geforce ?experience|nvidia share|rtss|msiafterburner|riva|discordoverlay|gameoverlay/i },
  { category: 'recording', pattern: /^(obs64|obs32|obs|streamlabs|xsplit|bdcam|action|nvcontainer|shadowplay|medal|outplayed)$/i },
  { category: 'communication', pattern: /^(discord|slack|teams|ms-teams|zoom|skype|telegram|whatsapp)$/i }
]

export function classifyProcess(name: string): { category: ProcessInfo['category']; isProtected: boolean } {
  const lower = name.toLowerCase()
  if (PROTECTED_PROCESSES.has(lower)) return { category: 'system', isProtected: true }
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(name)) return { category, isProtected: false }
  }
  return { category: 'other', isProtected: false }
}

/** Startup entries the app refuses to touch. */
const PROTECTED_STARTUP = /securityhealth|windows ?defender|onedrive setup|msedgeautolaunch|realtekaudio|rtkaudio|igfxtray|delltech|synaptics|touchpad|hotkey|nvbackend/i

export function isProtectedStartup(name: string, command: string | null): boolean {
  return PROTECTED_STARTUP.test(name) || PROTECTED_STARTUP.test(command ?? '')
}

/**
 * Startup impact. Windows' own "Startup impact" rating is not exposed through a
 * documented API, so this is derived from what the entry actually is and is
 * labelled in the UI as GameDriver's own estimate.
 */
export function startupImpact(name: string, command: string | null): 'high' | 'medium' | 'low' | 'unknown' {
  const text = `${name} ${command ?? ''}`.toLowerCase()
  if (!command) return 'unknown'
  if (/adobe|creative cloud|dropbox|onedrive|teams|epicgameslauncher|origin|eadesktop|galaxyclient|itunes|spotify/.test(text)) {
    return 'high'
  }
  if (/discord|steam|nvidia|geforce|amd|razer|logitech|corsair|msi|asus|icue|synapse|java|skype|zoom/.test(text)) {
    return 'medium'
  }
  return 'low'
}
