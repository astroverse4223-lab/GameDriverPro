# GameDriver Pro

**Your PC. Your Games. Always Ready.**

A gaming-focused driver manager, hardware monitor and optimisation centre for Windows, built with Electron + TypeScript + React + Vite.

It is a driver manager first, a gaming optimisation centre second, and a diagnostic analyst third.

---

## The rule this app is built around

Every number on screen is measured, or it is not shown.

Driver utilities have a bad reputation because they invent urgency — flagging every device as out of date, inventing FPS gains, animating fake progress bars. This app takes the opposite position, everywhere:

| Claim | How it is handled |
| --- | --- |
| "Your driver is out of date" | Only after an official source (NVIDIA's own lookup service, or Windows Update) actually said so. Before a scan, the UI says *not checked yet*. |
| "This update will improve performance" | Never stated. Updates are classified Critical / Recommended / Optional / Experimental / Unknown, each with its reasoning shown. Same-branch driver bumps are explicitly labelled *"no significant gaming benefit detected — keeping your current driver is reasonable"*. |
| Windows Update offering an **older** driver | Detected by version comparison and labelled *"Installing it would move you backwards. Not recommended."* This happens on real machines and most tools present it as an upgrade. |
| Driver age | Windows stamps every in-box driver `2006-06-21`, and some firmware reports impossible dates. Both are treated as *unknown*, not as "20 years old". |
| Frame rate | **Not measured, anywhere.** Reading a game's frame timing needs a presentation-layer hook, which this app does not install. Every FPS field reads `—`. |
| Drive health | If SMART/reliability counters are not returned, the app says so instead of claiming the drive is healthy. |
| Progress bars | The Windows Update Agent exposes no download percentage, so install progress shows the real *stage* with an indeterminate bar rather than a fabricated percentage. |
| "Free up RAM" | Not offered. Closing an app releases what that app held — that is the only honest claim, and it is the one made. |
| Crash diagnosis | Findings are correlations from Windows' own event log, worded as *possible* / *likely*, never as proof. |
| Features Windows does not expose | Listed as unavailable **with the reason** (e.g. Focus Assist has no supported API; driver rollback exists only in Device Manager). |

If a capability is missing, the app names it. It never quietly substitutes a guess.

---

## What it does

**Drivers**
- Full installed-driver inventory from `Win32_PnPSignedDriver`, joined with live PnP device status and plain-language explanations of Windows problem codes.
- Update scanning against official sources only:
  - **NVIDIA** — the same driver-lookup service nvidia.com's own Drivers page uses. Product and OS identifiers are resolved from NVIDIA's published lookup tables, never hard-coded.
  - **Windows Update** — via the Windows Update Agent COM API, the same mechanism Settings › Windows Update uses.
  - **Manufacturer pages** — a registry of official download pages for AMD, Intel, Realtek, ASUS, MSI, Gigabyte, ASRock, Dell, HP, Lenovo, Acer, Qualcomm, MediaTek and Microsoft, used to link out honestly where no machine-readable source exists.
- **In-app installation**, by two routes:
  - *Windows Update packages* — installed through the Windows Update Agent, the same component Settings uses.
  - *NVIDIA display drivers* — the app downloads the package from the URL NVIDIA's own API returned (host-checked, and re-checked across every redirect so it cannot leave NVIDIA's distribution domain), verifies the file's Authenticode signature names **NVIDIA Corporation**, and only then runs it. A file that fails the signature check is deleted without being executed. Silent and clean-install are both offered, using NVIDIA's documented switches.

  No third-party driver repository is involved at any point — that is the mechanism behind most "driver updater" tools and the reason they install mismatched drivers. AMD, Intel and board vendors publish no stable machine-readable source, so those stay hand-offs to the official page rather than being faked.
- Every install requires an explicit confirmation the renderer must echo back, takes an optional restore point first, and records its result.
- Driver backup via `pnputil /export-driver`, and rollback that hands off to Device Manager's own button (with an explanation of why nothing else is safe).
- Local history of every install, rollback, restore point, backup, scan and boost.

**Hardware**
- CPU, GPU, motherboard, BIOS, memory modules, storage (with SMART where available), network adapters, displays (EDID), audio, Bluetooth, USB, controllers, cameras, printers, battery.
- Discrete GPU is sorted first, so a machine with integrated graphics never pairs the iGPU's name with the discrete card's telemetry.
- NVIDIA drivers are shown with the vendor-facing version (`610.88`) alongside the Windows version (`32.0.16.1088`).

**Performance**
- Live CPU (per-core jiffy deltas), GPU load/temperature/clocks/power/VRAM (nvidia-smi, or language-neutral GPU performance counters as a fallback), memory, disk and network throughput.
- Charts break where a sensor stops reporting rather than interpolating across the gap.
- One long-lived PowerShell helper rather than a process per sample, to keep idle cost low.

**Games**
- Steam (app manifests + local artwork cache), Epic, GOG, Ubisoft Connect, Xbox/Microsoft Store, and EA/Battle.net via installed-programs entries. No launcher credentials, no launcher API calls.

**Diagnostics**
- Crash analysis from the System and Application event logs, grouped by what actually failed, plus stop codes read directly from crash-dump headers.
- Game Doctor: a local rule engine over measured telemetry that identifies GPU-bound / CPU-bound / VRAM-pressure / thermal situations and explains each recommendation. It never quotes an expected FPS figure.
- Network check: latency, jitter, packet loss, DNS. Throughput is deliberately not measured (it would require a third-party speed-test server).
- Gaming Health score where checks that could not be evaluated are excluded from the denominator rather than counted as passes.

**Boost**
- An opt-in optimisation plan shown before anything runs. Windows-critical processes are never offered for closing; the previous power plan is remembered for one-click undo; shader-cache clearing touches only regenerable vendor cache folders.

---

## Security model

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- The renderer reaches Windows only through a preload bridge bound to a compile-time allow-list of IPC channels — a channel name never comes from the caller.
- Every IPC handler validates its own payload before touching the system.
- Strict CSP; the renderer has **no network access at all** (outbound requests from the UI are cancelled outright).
- Outbound HTTP exists only in the main process, restricted to an allow-list of official vendor hosts over HTTPS.
- Game artwork is served from launcher caches through a custom protocol that only serves paths the game scanner itself discovered, and verifies image magic bytes.
- PowerShell scripts are compile-time constants; parameters are passed through the child process environment, so there is no string interpolation into a shell.
- Navigation away from the app's own document, `window.open`, webviews and all permission requests are refused.

## Privacy

Operates locally. Hardware identifiers, crash dumps, event logs, game data and personal files are never uploaded. The only outbound traffic is the driver lookups described above — the GPU model and OS version to the manufacturer, and hardware IDs handled entirely inside the Windows Update Agent. Both are individually switchable in Settings, which also states plainly what each one sends. There is no analytics code.

---

## Requirements

- Windows 10 or 11
- Node.js 22+ (development only)
- Administrator rights for: driver installation, restore points, `pnputil` driver export, and SMART reliability counters. The app checks up front and says so rather than failing halfway through; it never silently elevates itself.

## Development

```bash
npm install
npm run dev        # Vite dev server + Electron with main/preload watch-rebuild
npm run typecheck  # main/preload and renderer projects
npm run selftest   # run every service against this machine (read-only)
npm run build      # bundle main, preload and renderer
npm run package    # installer + portable exe via electron-builder
npm run icons      # regenerate app/tray icons procedurally
```

### Installing

`npm run package` writes three things to `release/`:

| Artifact | What it is |
| --- | --- |
| `GameDriver-Pro-Setup-<version>.exe` | NSIS installer. Per-user by default, lets you choose the install directory, creates Start Menu and desktop shortcuts, and registers an uninstaller. |
| `GameDriver-Pro-Portable-<version>.exe` | Single self-contained executable. Run it from anywhere — nothing is installed. |
| `win-unpacked/GameDriver Pro.exe` | The raw unpacked build, useful for debugging a packaged issue. |

The binaries are unsigned, so Windows SmartScreen will warn on first run
(*More info → Run anyway*). Signing needs a code-signing certificate, which this
project does not ship.

To use driver installation, restore points or driver export, right-click the
installed shortcut and choose **Run as administrator** — the app never elevates
itself.

### `npm run selftest`

Runs the whole main-process service layer against the real machine with Electron stubbed out — hardware detection, driver inventory, a live driver scan, health, crashes, games, boost planning, processes, startup, power plans, network and telemetry — plus unit checks on the pure logic (version comparison, the NVIDIA version mapping, Windows Update downgrade detection, VDF parsing, jitter, event-log module extraction).

It is read-only: it installs nothing, changes no setting and closes no process. Useful because most of this code can only be verified against a real Windows install.

## Architecture

```
src/
  main/                     Privileged process
    index.ts                Lifecycle, CSP, artwork protocol, single instance
    windows.ts              Frameless window, tray, navigation
    ipc.ts                  Validated handlers for the shared channel allow-list
    services/
      powershell.ts         Hardened CIM/PowerShell bridge (-EncodedCommand, env args)
      wmiScripts.ts         The CIM queries, as constants
      hardware.ts           Hardware snapshot
      drivers.ts            Driver inventory, version comparison
      driverSources/        Official source adapters + scanner
      driverActions.ts      Install, restore point, backup, rollback
      monitor.ts            Live telemetry
      games.ts crashes.ts boost.ts network.ts health.ts
      db.ts                 node:sqlite, with an atomic JSON fallback
  preload/index.ts          contextBridge surface
  renderer/                 Sandboxed UI (React)
  shared/                   Types + IPC contract
```

## Development phases

Phases 1–8 of the original plan are implemented, with the platform's real limits reported rather than papered over. Notable honest gaps, each surfaced in the UI: no FPS/frame-time measurement, no Focus Assist toggle, no programmatic driver rollback, no throughput speed test, and no in-game settings parsing.

## Licence

Unlicensed / private.
