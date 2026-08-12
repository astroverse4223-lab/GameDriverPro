import type { JSX, SVGProps } from 'react'

/**
 * Hand-drawn 24px icon set on a consistent 1.6px stroke grid. Bundled as
 * components rather than an icon font so nothing is fetched at runtime — the
 * app's CSP blocks external requests entirely.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V20h13V9.5" />
    <path d="M9.5 20v-5.5h5V20" />
  </Svg>
)

export const IconPc = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12.5" rx="2" />
    <path d="M8 20.5h8M12 16.5v4" />
    <path d="M7 8h4M7 11h2" />
  </Svg>
)

export const IconChip = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.6" />
    <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
  </Svg>
)

export const IconGamepad = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.5 8h9a4.5 4.5 0 0 1 4.4 3.6l.8 4A3 3 0 0 1 18.8 19c-.9 0-1.7-.4-2.2-1.1L15.3 16H8.7l-1.3 1.9C6.9 18.6 6.1 19 5.2 19a3 3 0 0 1-2.9-3.4l.8-4A4.5 4.5 0 0 1 7.5 8Z" />
    <path d="M7.2 12.5h2.4M8.4 11.3v2.4" />
    <circle cx="15.4" cy="11.8" r=".9" fill="currentColor" stroke="none" />
    <circle cx="17.4" cy="13.4" r=".9" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 3 5 13.5h5.5L10 21l8.5-10.5H13L13.5 3Z" />
  </Svg>
)

export const IconPulse = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12.5h4l2.2-6 3.6 12 2.6-8 1.8 2h4.8" />
  </Svg>
)

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
    <path d="M12 10v4.2" />
    <circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4v4.5h4.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Svg>
)

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
  </Svg>
)

export const IconWifi = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 9a15 15 0 0 1 19 0" />
    <path d="M5.8 12.6a10 10 0 0 1 12.4 0" />
    <path d="M9 16.2a5 5 0 0 1 6 0" />
    <circle cx="12" cy="19.5" r=".9" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="16" rx="2" />
    <path d="M6.5 9.5 9.5 12l-3 2.5M12.5 15h5" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
  </Svg>
)

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const IconMinus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
)

export const IconSquare = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="1.6" />
  </Svg>
)

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M21 3.5V9h-5.5" />
  </Svg>
)

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v11" />
    <path d="M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4 18.5h16" />
  </Svg>
)

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 4.5H19.5v6" />
    <path d="M19 5 11 13" />
    <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </Svg>
)

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v6c0 4.4 3.1 7.8 7.5 9 4.4-1.2 7.5-4.6 7.5-9V6L12 3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
)

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h6.5A1.5 1.5 0 0 1 19 9v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
  </Svg>
)

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.5 4.8 19 12 7.5 19.2V4.8Z" />
  </Svg>
)

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5.5 16 12l-7 6.5" />
  </Svg>
)

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconDrive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="7" width="19" height="10" rx="2" />
    <path d="M6 12h.01M9.5 12h6" />
  </Svg>
)

export const IconMemory = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="7.5" width="19" height="9" rx="1.5" />
    <path d="M6 16.5v3M10 16.5v3M14 16.5v3M18 16.5v3M6.5 10.5h3v3h-3zM11 10.5h3v3h-3z" />
  </Svg>
)

export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M8.5 20.5h7M12 17v3.5" />
  </Svg>
)

export const IconSpeaker = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4v-5Z" />
    <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.8a7.5 7.5 0 0 1 0 10.4" />
  </Svg>
)

export const IconBluetooth = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 7.5 17 16.5 12 20.5V3.5l5 4L7 16.5" />
  </Svg>
)

export const IconUsb = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="19.5" r="1.8" />
    <path d="M12 17.7V5" />
    <path d="M9.5 7.5 12 3.5l2.5 4" />
    <path d="M12 12.5 16 10V7.5M12 14.5 8 12V9.5" />
  </Svg>
)

export const IconCamera = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="6.5" width="19" height="12" rx="2" />
    <circle cx="12" cy="12.5" r="3.2" />
    <path d="M8.5 6.5 9.8 4h4.4l1.3 2.5" />
  </Svg>
)

export const IconPrinter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 9V4h10v5" />
    <rect x="3.5" y="9" width="17" height="7" rx="1.6" />
    <path d="M7 14h10v6H7z" />
  </Svg>
)

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5 7.5 20h9l1-13.5" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="m15.6 15.6 4.4 4.4" />
  </Svg>
)

export const IconPause = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5v14M15 5v14" />
  </Svg>
)

export const CATEGORY_ICONS: Record<string, (p: IconProps) => JSX.Element> = {
  graphics: IconMonitor,
  chipset: IconChip,
  audio: IconSpeaker,
  network: IconWifi,
  wifi: IconWifi,
  bluetooth: IconBluetooth,
  storage: IconDrive,
  usb: IconUsb,
  motherboard: IconChip,
  controller: IconGamepad,
  input: IconChip,
  display: IconMonitor,
  camera: IconCamera,
  printer: IconPrinter,
  system: IconChip,
  other: IconChip
}
