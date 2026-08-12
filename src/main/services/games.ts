import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { queryEmitted, runRaw } from './powershell'
import { log, describeError } from './logger'
import type { GameEntry, GameLauncher, GameLibrary } from '../../shared/types'

/**
 * Installed-game detection.
 *
 * Everything here reads launcher metadata that already exists on disk — Steam's
 * app manifests, Epic's manifest items, GOG's and Ubisoft's registry entries,
 * the Xbox app's install folders. No credentials are requested, no launcher API
 * is contacted, and nothing is sent anywhere.
 */

const CACHE_TTL_MS = 5 * 60_000
let cached: GameLibrary | null = null
let inFlight: Promise<GameLibrary> | null = null

const LAUNCHER_SCRIPT = `
$out = [ordered]@{}
function Reg($path) { try { Get-ItemProperty -Path $path -ErrorAction Stop } catch { $null } }

$out.steamPath = $(try { (Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop).SteamPath } catch { $null })

$out.gog = @()
foreach ($root in @('HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', 'HKLM:\\SOFTWARE\\GOG.com\\Games')) {
  try {
    foreach ($key in @(Get-ChildItem $root -ErrorAction Stop)) {
      $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($p -and $p.path) {
        $out.gog += [pscustomobject]@{
          id   = [string]$p.gameID
          name = [string]$p.gameName
          path = [string]$p.path
          exe  = [string]$p.exe
        }
      }
    }
  } catch {}
}

$out.ubisoft = @()
try {
  foreach ($key in @(Get-ChildItem 'HKLM:\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs' -ErrorAction Stop)) {
    $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
    if ($p -and $p.InstallDir) {
      $out.ubisoft += [pscustomobject]@{ id = $key.PSChildName; path = [string]$p.InstallDir }
    }
  }
} catch {}

$out.launcherPaths = [pscustomobject]@{
  epic     = $(try { (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher' -ErrorAction Stop).AppDataPath } catch { $null })
  ea       = $(try { (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop' -ErrorAction Stop).InstallLocation } catch { $null })
  ubisoft  = $(try { (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher' -ErrorAction Stop).InstallDir } catch { $null })
  battle   = $(try { (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\Battle.net\\Capabilities' -ErrorAction Stop).ApplicationIcon } catch { $null })
  gog      = $(try { (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths' -ErrorAction Stop).client } catch { $null })
}

# Registry uninstall entries let us find EA / Battle.net titles that do not
# publish a machine-readable manifest, without guessing at install paths.
$out.uninstall = @()
foreach ($root in @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)) {
  try {
    foreach ($key in @(Get-ChildItem $root -ErrorAction Stop)) {
      $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if (-not $p -or -not $p.DisplayName -or -not $p.InstallLocation) { continue }
      $publisher = [string]$p.Publisher
      $name = [string]$p.DisplayName
      $loc = [string]$p.InstallLocation
      $isGame = $false
      if ($publisher -match 'Electronic Arts|EA Games|Blizzard|Ubisoft|Rockstar|Bethesda|Riot Games|CD PROJEKT') { $isGame = $true }
      if ($loc -match 'EA Games|Origin Games|Battle.net|Ubisoft|Rockstar Games|SteamLibrary') { $isGame = $true }
      if (-not $isGame) { continue }
      $out.uninstall += [pscustomobject]@{
        name      = $name
        location  = $loc
        publisher = $publisher
        icon      = [string]$p.DisplayIcon
      }
    }
  } catch {}
}

ConvertTo-Json -InputObject ([pscustomobject]$out) -Depth 5 -Compress
`

interface RawLaunchers {
  steamPath: string | null
  gog: { id: string; name: string; path: string; exe: string }[] | null
  ubisoft: { id: string; path: string }[] | null
  launcherPaths: {
    epic: string | null
    ea: string | null
    ubisoft: string | null
    battle: string | null
    gog: string | null
  } | null
  uninstall: { name: string; location: string; publisher: string; icon: string }[] | null
}

function arr<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

// --- Valve KeyValues ("VDF") ------------------------------------------------

/**
 * Minimal reader for Steam's KeyValues text format. Only quoted scalars are
 * needed here, keyed by their nesting path, which keeps this immune to the
 * unusual blocks Steam occasionally adds.
 */
export function parseVdf(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  const stack: Record<string, unknown>[] = [root]
  const lines = text.split(/\r?\n/)
  let pendingKey: string | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//')) continue

    if (trimmed === '{') {
      const parent = stack[stack.length - 1]
      if (parent && pendingKey !== null) {
        const child: Record<string, unknown> = {}
        parent[pendingKey] = child
        stack.push(child)
        pendingKey = null
      }
      continue
    }
    if (trimmed === '}') {
      if (stack.length > 1) stack.pop()
      continue
    }

    const pair = /^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/.exec(trimmed)
    if (pair) {
      const target = stack[stack.length - 1]
      if (target) target[unescapeVdf(pair[1] ?? '')] = unescapeVdf(pair[2] ?? '')
      continue
    }

    const keyOnly = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed)
    if (keyOnly) pendingKey = unescapeVdf(keyOnly[1] ?? '')
  }
  return root
}

function unescapeVdf(text: string): string {
  return text.replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function int(value: unknown): number | null {
  const text = str(value)
  if (text === null) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

// --- Steam ------------------------------------------------------------------

function steamLibraries(steamPath: string): string[] {
  // libraryfolders.vdf lists the default library too, but with different casing
  // and escaping than the registry value — so key the set on a normalised form
  // or the same library gets walked twice and every game appears twice.
  const seen = new Map<string, string>()
  const add = (path: string) => {
    const key = path.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
    if (!seen.has(key)) seen.set(key, path)
  }

  add(steamPath)
  const vdfPath = join(steamPath, 'steamapps', 'libraryfolders.vdf')
  try {
    if (existsSync(vdfPath)) {
      const parsed = parseVdf(readFileSync(vdfPath, 'utf8'))
      const root = asRecord(parsed['libraryfolders']) ?? parsed
      for (const value of Object.values(root)) {
        const entry = asRecord(value)
        const path = entry ? str(entry['path']) : null
        if (path) add(path)
      }
    }
  } catch (error) {
    log.warn('games', `Could not read Steam libraries: ${describeError(error)}`)
  }
  return [...seen.values()]
}

/**
 * Steam caches library artwork on disk under appcache/librarycache/<appid>/,
 * with the useful images named library_600x900.jpg / library_hero.jpg. Using
 * those keeps artwork fully local — no CDN call and no app IDs leaving the PC.
 */
function steamArtwork(steamPath: string, appId: string): string | null {
  const base = join(steamPath, 'appcache', 'librarycache', appId)
  const preferred = ['library_600x900.jpg', 'library_capsule.jpg', 'library_header.jpg', 'header.jpg', 'library_hero.jpg']
  try {
    if (!existsSync(base)) return null
    const direct = preferred.map((name) => join(base, name)).find((path) => existsSync(path))
    if (direct) return direct
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const nested = join(base, entry.name)
      const hit = preferred.map((name) => join(nested, name)).find((path) => existsSync(path))
      if (hit) return hit
    }
  } catch {
    /* artwork is cosmetic — never let it break detection */
  }
  return null
}

function findExecutable(dir: string, hint: string | null): string | null {
  try {
    if (hint) {
      const direct = join(dir, hint)
      if (existsSync(direct)) return direct
    }
    const entries = readdirSync(dir, { withFileTypes: true })
    const exes = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe')).map((e) => e.name)
    const ignored = /unins|setup|crash|redist|vcredist|directx|launcher_?install|dxsetup|touchup/i
    const candidate = exes.find((name) => !ignored.test(name))
    return candidate ? join(dir, candidate) : null
  } catch {
    return null
  }
}

function readSteamGames(steamPath: string, warnings: string[]): GameEntry[] {
  const games: GameEntry[] = []
  for (const library of steamLibraries(steamPath)) {
    const appsDir = join(library, 'steamapps')
    let files: string[] = []
    try {
      if (!existsSync(appsDir)) continue
      files = readdirSync(appsDir).filter((name) => /^appmanifest_\d+\.acf$/i.test(name))
    } catch (error) {
      warnings.push(`Steam library “${library}” could not be read: ${describeError(error)}`)
      continue
    }

    for (const file of files) {
      try {
        const manifest = parseVdf(readFileSync(join(appsDir, file), 'utf8'))
        const state = asRecord(manifest['AppState'])
        if (!state) continue
        const appId = str(state['appid'])
        const name = str(state['name'])
        const installDir = str(state['installdir'])
        if (!appId || !name) continue

        // Steam's own tooling (Steamworks Redistributables, Proton, …) ships as
        // apps too; those are not games the user launches.
        if (/^(Steamworks|Proton|Steam Linux Runtime|SteamVR Performance)/i.test(name)) continue

        const path = installDir ? join(appsDir, 'common', installDir) : appsDir
        const lastPlayed = int(state['LastPlayed'])
        games.push({
          id: `steam:${appId}`,
          name,
          launcher: 'steam',
          installPath: path,
          sizeBytes: int(state['SizeOnDisk']),
          appId,
          lastPlayed: lastPlayed && lastPlayed > 0 ? lastPlayed * 1000 : null,
          executable: existsSync(path) ? findExecutable(path, null) : null,
          launchUrl: `steam://rungameid/${appId}`,
          storeUrl: `https://store.steampowered.com/app/${appId}`,
          heroImageUrl: steamArtwork(steamPath, appId)
        })
      } catch (error) {
        warnings.push(`Steam manifest ${file} could not be parsed: ${describeError(error)}`)
      }
    }
  }
  return games
}

// --- Epic -------------------------------------------------------------------

interface EpicManifest {
  DisplayName?: string
  InstallLocation?: string
  InstallSize?: number
  LaunchExecutable?: string
  AppName?: string
  CatalogNamespace?: string
  CatalogItemId?: string
  bIsIncompleteInstall?: boolean
  AppCategories?: string[]
}

function readEpicGames(warnings: string[]): GameEntry[] {
  const dir = join(process.env['PROGRAMDATA'] ?? 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  const games: GameEntry[] = []
  try {
    if (!existsSync(dir)) return games
    for (const file of readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.item'))) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8')) as EpicManifest
        const name = manifest.DisplayName
        const location = manifest.InstallLocation
        if (!name || !location) continue
        // Epic distributes Unreal Engine and plugins through the same manifests.
        const categories = manifest.AppCategories ?? []
        if (categories.length > 0 && !categories.includes('games')) continue
        if (/^Unreal Engine/i.test(name)) continue

        games.push({
          id: `epic:${manifest.AppName ?? name}`,
          name,
          launcher: 'epic',
          installPath: location,
          sizeBytes: typeof manifest.InstallSize === 'number' ? manifest.InstallSize : null,
          appId: manifest.AppName ?? null,
          lastPlayed: null,
          executable: manifest.LaunchExecutable ? join(location, manifest.LaunchExecutable.replace(/\//g, '\\')) : null,
          launchUrl:
            manifest.AppName && manifest.CatalogNamespace && manifest.CatalogItemId
              ? `com.epicgames.launcher://apps/${manifest.CatalogNamespace}%3A${manifest.CatalogItemId}%3A${manifest.AppName}?action=launch&silent=true`
              : null,
          storeUrl: null,
          heroImageUrl: null
        })
      } catch (error) {
        warnings.push(`Epic manifest ${file} could not be parsed: ${describeError(error)}`)
      }
    }
  } catch (error) {
    warnings.push(`Epic manifest folder could not be read: ${describeError(error)}`)
  }
  return games
}

// --- Xbox / Microsoft Store -------------------------------------------------

function readXboxGames(warnings: string[]): GameEntry[] {
  const games: GameEntry[] = []
  const roots = ['C:\\XboxGames', 'D:\\XboxGames', 'E:\\XboxGames']
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (entry.name === 'GameSave') continue
        const path = join(root, entry.name)
        const content = join(path, 'Content')
        games.push({
          id: `xbox:${entry.name}`,
          name: entry.name,
          launcher: 'xbox',
          installPath: path,
          sizeBytes: null,
          appId: null,
          lastPlayed: null,
          executable: existsSync(content) ? findExecutable(content, null) : null,
          // Store-packaged games must be started by the shell, not by exec.
          launchUrl: null,
          storeUrl: null,
          heroImageUrl: null
        })
      }
    } catch (error) {
      warnings.push(`Xbox games folder ${root} could not be read: ${describeError(error)}`)
    }
  }
  return games
}

// --- Registry-derived launchers --------------------------------------------

function launcherFromLocation(location: string, publisher: string): GameLauncher {
  const text = `${location} ${publisher}`.toLowerCase()
  if (/battle\.net|blizzard/.test(text)) return 'battlenet'
  if (/ubisoft/.test(text)) return 'ubisoft'
  if (/electronic arts|ea games|origin/.test(text)) return 'ea'
  if (/gog/.test(text)) return 'gog'
  return 'other'
}

function directorySize(path: string, budgetMs = 60): number | null {
  // A full recursive walk of a 100 GB install is not worth blocking on, so this
  // measures only the top level and reports null when that is not meaningful.
  const deadline = Date.now() + budgetMs
  let total = 0
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (Date.now() > deadline) return null
      if (!entry.isFile()) continue
      try {
        total += statSync(join(path, entry.name)).size
      } catch {
        /* skip unreadable file */
      }
    }
  } catch {
    return null
  }
  return total > 0 ? total : null
}

// --- Public API -------------------------------------------------------------

export async function getGameLibrary(force = false): Promise<GameLibrary> {
  if (!force && cached && Date.now() - cached.capturedAt < CACHE_TTL_MS) return cached
  // Startup fires this from the main process and from the renderer at once;
  // without in-flight coalescing the launcher folders get walked three times.
  if (inFlight) return inFlight
  inFlight = collectGames().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function collectGames(): Promise<GameLibrary> {
  const warnings: string[] = []
  const raw = await queryEmitted<RawLaunchers>(LAUNCHER_SCRIPT, { timeoutMs: 45_000 }).catch((error) => {
    warnings.push(`Launcher detection failed: ${describeError(error)}`)
    return null
  })

  const games: GameEntry[] = []
  const steamPath = raw?.steamPath ?? null

  if (steamPath && existsSync(steamPath)) {
    games.push(...readSteamGames(steamPath, warnings))
  }
  games.push(...readEpicGames(warnings))
  games.push(...readXboxGames(warnings))

  for (const gog of arr(raw?.gog)) {
    if (!gog.path) continue
    games.push({
      id: `gog:${gog.id || gog.name}`,
      name: gog.name || basename(gog.path),
      launcher: 'gog',
      installPath: gog.path,
      sizeBytes: directorySize(gog.path),
      appId: gog.id || null,
      lastPlayed: null,
      executable: gog.exe && existsSync(gog.exe) ? gog.exe : findExecutable(gog.path, null),
      launchUrl: null,
      storeUrl: null,
      heroImageUrl: null
    })
  }

  for (const ubi of arr(raw?.ubisoft)) {
    if (!ubi.path || !existsSync(ubi.path)) continue
    games.push({
      id: `ubisoft:${ubi.id}`,
      name: basename(ubi.path.replace(/[\\/]+$/, '')),
      launcher: 'ubisoft',
      installPath: ubi.path,
      sizeBytes: directorySize(ubi.path),
      appId: ubi.id,
      lastPlayed: null,
      executable: findExecutable(ubi.path, null),
      launchUrl: `uplay://launch/${ubi.id}`,
      storeUrl: null,
      heroImageUrl: null
    })
  }

  const known = new Set(games.map((g) => g.installPath.toLowerCase()))
  for (const entry of arr(raw?.uninstall)) {
    const location = entry.location?.replace(/[\\/]+$/, '')
    if (!location || known.has(location.toLowerCase()) || !existsSync(location)) continue
    known.add(location.toLowerCase())
    games.push({
      id: `reg:${entry.name}`,
      name: entry.name,
      launcher: launcherFromLocation(location, entry.publisher ?? ''),
      installPath: location,
      sizeBytes: directorySize(location),
      appId: null,
      lastPlayed: null,
      executable: findExecutable(location, null),
      launchUrl: null,
      storeUrl: null,
      heroImageUrl: null
    })
  }

  // Final belt-and-braces dedupe: a game reachable through two detectors (a
  // Steam manifest and an uninstall entry, say) must still appear once.
  const uniqueGames = [...new Map(games.map((game) => [game.id.toLowerCase(), game])).values()]

  const paths = raw?.launcherPaths ?? null
  const library: GameLibrary = {
    capturedAt: Date.now(),
    games: uniqueGames.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.name.localeCompare(b.name)),
    launchers: [
      {
        launcher: 'steam',
        detected: Boolean(steamPath && existsSync(steamPath)),
        path: steamPath,
        note: steamPath ? 'Detected from Steam’s own registry key.' : 'Steam was not found on this PC.'
      },
      {
        launcher: 'epic',
        detected: games.some((g) => g.launcher === 'epic'),
        path: paths?.epic ?? null,
        note: 'Read from the Epic Games Launcher manifest folder.'
      },
      {
        launcher: 'xbox',
        detected: games.some((g) => g.launcher === 'xbox'),
        path: existsSync('C:\\XboxGames') ? 'C:\\XboxGames' : null,
        note: 'Xbox / Microsoft Store games are detected by their install folder. Store-packaged titles are launched through Windows.'
      },
      {
        launcher: 'gog',
        detected: arr(raw?.gog).length > 0,
        path: paths?.gog ?? null,
        note: 'Read from GOG’s registry entries.'
      },
      {
        launcher: 'ubisoft',
        detected: arr(raw?.ubisoft).length > 0,
        path: paths?.ubisoft ?? null,
        note: 'Read from Ubisoft Connect’s registry entries.'
      },
      {
        launcher: 'ea',
        detected: games.some((g) => g.launcher === 'ea'),
        path: paths?.ea ?? null,
        note: 'EA titles are identified from Windows’ installed-programs entries; EA does not publish a local game manifest.'
      },
      {
        launcher: 'battlenet',
        detected: games.some((g) => g.launcher === 'battlenet'),
        path: null,
        note: 'Battle.net titles are identified from Windows’ installed-programs entries.'
      }
    ],
    warnings
  }

  cached = library
  log.info('games', `Detected ${library.games.length} game(s) across ${library.launchers.filter((l) => l.detected).length} launcher(s)`)
  return library
}

export function findGame(gameId: string): GameEntry | null {
  return cached?.games.find((game) => game.id === gameId) ?? null
}

/**
 * Launch through the launcher's own protocol when one exists, so play time and
 * cloud saves keep working. Falls back to the detected executable.
 */
export async function launchGame(gameId: string): Promise<{ ok: boolean; message: string }> {
  const game = findGame(gameId) ?? (await getGameLibrary(true).then(() => findGame(gameId)))
  if (!game) return { ok: false, message: 'That game is no longer in the library — it may have been uninstalled.' }

  const { shell } = await import('electron')

  if (game.launchUrl) {
    try {
      await shell.openExternal(game.launchUrl)
      return { ok: true, message: `Asked ${game.launcher} to launch ${game.name}.` }
    } catch (error) {
      log.warn('games', `Protocol launch failed: ${describeError(error)}`)
    }
  }

  if (game.executable && existsSync(game.executable)) {
    try {
      await runRaw('Start-Process -FilePath $env:GDP_ARG_EXE -WorkingDirectory $env:GDP_ARG_DIR', {
        args: { EXE: game.executable, DIR: game.installPath },
        timeoutMs: 15_000,
        tolerant: true
      })
      return { ok: true, message: `Launched ${game.name}.` }
    } catch (error) {
      return { ok: false, message: `Could not start ${game.name}: ${describeError(error)}` }
    }
  }

  return {
    ok: false,
    message:
      game.launcher === 'xbox'
        ? 'Xbox and Microsoft Store games must be started from the Xbox app — Windows does not allow launching packaged apps by path.'
        : 'No launch method was found for this game. Open its folder to start it manually.'
  }
}

export async function openGameFolder(gameId: string): Promise<{ ok: boolean; message: string }> {
  const game = findGame(gameId)
  if (!game) return { ok: false, message: 'That game is no longer in the library.' }
  if (!existsSync(game.installPath)) return { ok: false, message: 'The install folder no longer exists.' }
  const { shell } = await import('electron')
  const error = await shell.openPath(game.installPath)
  return error ? { ok: false, message: error } : { ok: true, message: 'Opened install folder.' }
}

/** Absolute artwork paths the art protocol is allowed to serve. */
export function allowedArtworkPaths(): Set<string> {
  const paths = new Set<string>()
  for (const game of cached?.games ?? []) {
    if (game.heroImageUrl) paths.add(game.heroImageUrl.toLowerCase())
  }
  return paths
}
