/**
 * WorkBuddy credential storage.
 *
 * Every credential the plugin holds comes from {@link module:dsh-workbuddy-connect/login}'s
 * device-authorization flow, which is what makes this store's write paths the
 * whole story: a login writes one, and a refresh replaces one. Nothing here
 * reads a file the WorkBuddy desktop app wrote, so the plugin works whether or
 * not that app is installed and wherever it happens to keep its state.
 *
 * One file per variant under `$DSH_HOME`. The on-disk document keeps the
 * published cross-tool layout (`{"auth":{...},"account":{...}}`) so the same
 * file stays readable by the tooling built around this product; the plugin's own
 * `version` key rides alongside and is ignored by readers that do not know it.
 *
 * @module dsh-workbuddy-connect/auth
 */

import { readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { realmOf, regionOf } from './upstream.ts'
import type { WorkBuddyRegion, WorkBuddyRefreshOutcome } from './upstream.ts'
import type { WorkBuddyVariant } from './variants.ts'

/** The one provenance a stored credential can have: this plugin's own login. */
export const WORKBUDDY_CREDENTIAL_SOURCE = 'login'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  /**
   * The realm a supplied document declared, when it declared one.
   *
   * Absent for a credential this plugin obtained by logging in, whose realm the
   * domain already states. It exists for an imported document: the sibling
   * tooling writes an explicit `region`, and honouring it is what keeps a
   * credential that names its realm from being routed by a domain it disagrees
   * with.
   */
  region?: WorkBuddyRegion
  uid: string
  enterpriseId?: string
  nickname?: string
  /** Always {@link WORKBUDDY_CREDENTIAL_SOURCE}; carried so callers can display it. */
  source: typeof WORKBUDDY_CREDENTIAL_SOURCE
}

/** Read-only sign-in summary for status and doctor output. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  /** Which upstream region the stored credential belongs to. */
  region?: WorkBuddyRegion
  /**
   * Why no credential is usable, when the reason is diagnosable rather than
   * "nobody has signed in" — a credential stored for the other realm being the
   * case that matters.
   */
  reason?: string
}

/** Constructor options; only {@link WorkBuddyStoreOptions.refresh} is required. */
export interface WorkBuddyStoreOptions {
  variant?: WorkBuddyVariant
  /** Explicit plugin-owned credential path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
}

/** Basename of the plugin-owned credential file inside the plugin's data directory. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/**
 * Name of the folder this plugin keeps its own files in.
 *
 * Scoped per profile, so the two plugins' state and two profiles' sign-ins stay
 * apart: DSH already separates a profile's installed plugins, and a credential
 * belongs to the profile that is running rather than to the machine.
 */
export const WORKBUDDY_DATA_DIR_NAME = '.dsh-workbuddy-connect'

/** Env var overriding the plugin's data directory; used by tests and by a host that sets one. */
export const WORKBUDDY_DATA_DIR_ENV = 'DSH_WORKBUDDY_DATA_DIR'

/** Harness-home subdirectory holding every profile. */
const PROFILES_DIR_NAME = 'profiles'

/** This plugin's package name, as a profile's manifest spells it. */
const PLUGIN_PACKAGE_NAME = 'dsh-workbuddy-connect'

/** This package's own root directory, or undefined when it cannot be determined. */
function pluginPackageRoot(): string | undefined {
  try {
    // `<root>/lib/auth.js` in a build, `<root>/src/auth.ts` from source.
    return dirname(dirname(fileURLToPath(import.meta.url)))
  } catch {
    // Not loaded from a file URL (a bundled or synthetic module).
    return undefined
  }
}

/**
 * Whether a profile directory declares this plugin.
 *
 * Read from the profile's manifest rather than inferred from this module's own
 * location, because DSH installs a plugin into a profile by *link*: the manifest
 * carries `"dsh-workbuddy-connect": "link:/path/to/checkout"`, while Node
 * resolves the module to that real path, which lies outside `$DSH_HOME` entirely.
 * Walking up from the module would therefore miss the profile for exactly the
 * install shape a developer uses.
 */
function profileDeclaresPlugin(profileDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return typeof manifest.dependencies?.[PLUGIN_PACKAGE_NAME] === 'string'
      || typeof manifest.devDependencies?.[PLUGIN_PACKAGE_NAME] === 'string'
  } catch {
    // Not a profile, or unreadable: it simply is not a candidate.
    return false
  }
}

/**
 * Whether a profile's installed copy of this plugin resolves to this package.
 *
 * This is what separates two profiles that both declare the plugin — a `web` and
 * a `desktop` profile can each list it — so the data directory follows the
 * profile whose copy is actually running rather than the first one found.
 */
function profileLinksToThisPackage(profileDir: string): boolean {
  const own = pluginPackageRoot()
  if (own === undefined) return false
  try {
    return realpathSync(join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME)) === realpathSync(own)
  } catch {
    // No installed copy, or an unreadable link.
    return false
  }
}

/**
 * The profile directory this plugin belongs to, or undefined when none can be
 * determined.
 *
 * DSH does not export the active profile name to a plugin, so it is recovered
 * from the profiles themselves: the ones whose manifest declares this plugin,
 * narrowed to the one whose installed copy resolves to this package. A single
 * declaring profile is accepted without the second test, so a normal (non-linked)
 * install still resolves.
 */
function discoverProfileDir(): string | undefined {
  const profilesRoot = join(resolveDshHome(), PROFILES_DIR_NAME)
  let entries: Dirent[]
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    // No profiles directory at all: nothing to discover.
    return undefined
  }
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(profilesRoot, entry.name)
    if (profileDeclaresPlugin(dir)) candidates.push(dir)
  }
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  return candidates.find(candidate => profileLinksToThisPackage(candidate))
}

/**
 * The directory this plugin keeps its own files in: `<profile>/.dsh-workbuddy-connect`.
 *
 * Falls back to the Harness home when no profile can be discovered — a checkout
 * running its own tests, or a host that loads the plugin from outside a profile —
 * so the plugin always has somewhere to write, and `DSH_WORKBUDDY_DATA_DIR`
 * overrides either way.
 */
export function workbuddyPluginDataDir(): string {
  const override = process.env[WORKBUDDY_DATA_DIR_ENV]
  if (override !== undefined && override.trim() !== '') return override
  const base = discoverProfileDir() ?? resolveDshHome()
  return join(base, WORKBUDDY_DATA_DIR_NAME)
}

/** Current on-disk format written by this plugin; readers accept older ones. */
const OWN_FORMAT_VERSION = 1

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function isDocument(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Plugin-owned credential path used when no variant names its own file.
 *
 * @returns the path inside the plugin's data directory.
 */
export function workbuddyOwnAuthPath(): string {
  return join(workbuddyPluginDataDir(), WORKBUDDY_AUTH_FILENAME)
}

/**
 * Parse a WorkBuddy credential document in either on-disk layout: the nested
 * form `{"auth":{...},"account":{...}}` this plugin writes and the sibling
 * tooling publishes, and the flat form hand-written files use. Returns undefined
 * when the document carries no access token.
 *
 * Tolerance is deliberate: this is a published cross-tool format, and a file
 * written by a sibling tool must keep loading rather than silently signing the
 * user out. Two spellings of "which realm" are accepted — a top-level `region`
 * and a nested `auth.realm` — because both are in use.
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isDocument(parsed)) return undefined
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (isDocument(parsed['auth'])) {
    auth = parsed['auth'] as Record<string, unknown>
    identity = isDocument(parsed['account']) ? parsed['account'] as Record<string, unknown> : {}
  } else {
    auth = parsed
    identity = parsed
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const realm = optionalString(parsed['region']) ?? optionalString(auth['realm'])
  return {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs: typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    ...realm === undefined ? {} : { region: realm.trim().toLowerCase() === 'global' ? 'global' : 'cn' },
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: WORKBUDDY_CREDENTIAL_SOURCE,
  }
}

/**
 * Parse a document this plugin wrote.
 *
 * Two spellings exist. Current versions write the nested cross-tool layout with
 * a `version` marker; version 1 as originally shipped wrote the normalized
 * credential under `credential` (camelCase `expiresAtMs`, identity at the top
 * level). Both are read, because rejecting the older one would sign a working
 * user out on upgrade.
 */
function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isDocument(parsed)) return undefined
  const stored = parsed['credential']
  if (isDocument(stored) && typeof stored['accessToken'] === 'string' && stored['accessToken'] !== '') {
    const refreshExpiresAtMs = typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
    const enterpriseId = optionalString(stored['enterpriseId'])
    const nickname = optionalString(stored['nickname'])
    const realm = optionalString(stored['region'])
    return {
      accessToken: stored['accessToken'],
      refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
      expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
      ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
      domain: optionalString(stored['domain']) ?? '',
      ...realm === undefined ? {} : { region: realm.trim().toLowerCase() === 'global' ? 'global' : 'cn' },
      uid: optionalString(stored['uid']) ?? '',
      ...enterpriseId === undefined ? {} : { enterpriseId },
      ...nickname === undefined ? {} : { nickname },
      source: WORKBUDDY_CREDENTIAL_SOURCE,
    }
  }
  return parseWorkBuddyAuth(text)
}

/**
 * Serialize the plugin-owned document in the nested cross-tool layout.
 *
 * `expiresAt` is written in **seconds**, matching the sibling tooling this
 * format comes from: the two write the same file, so a value in the wrong unit
 * would be read as an expiry decades away rather than rejected. Readers here
 * accept either unit, which is what makes that safe.
 *
 * Identity fields are omitted rather than written empty, so a credential whose
 * account lookup failed does not claim a `uid` of `""`.
 */
function ownDocument(credential: WorkBuddyCredential): Record<string, unknown> {
  const region = realmOf(credential)
  return {
    version: OWN_FORMAT_VERSION,
    // Written explicitly rather than left to the domain: the sibling tooling
    // reads this key first, and backfills it for files that lack one.
    region,
    auth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: Math.floor(credential.expiresAtMs / 1000),
      ...credential.refreshExpiresAtMs === undefined
        ? {}
        : { refreshExpiresAt: Math.floor(credential.refreshExpiresAtMs / 1000) },
      domain: credential.domain,
      realm: region,
    },
    account: {
      uid: credential.uid,
      ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
      ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
    },
  }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin (or
 * already expired), and keep the refreshed credential in the plugin-owned file.
 * A failed refresh still returns a not-yet-expired token, so an unreachable
 * refresh endpoint does not take down a working session.
 */
export class WorkBuddyCredentialStore {
  private readonly variant: WorkBuddyVariant | undefined
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private inflight: Promise<WorkBuddyCredential> | undefined

  constructor(options: WorkBuddyStoreOptions) {
    this.variant = options.variant
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath ?? (options.variant
      ? join(workbuddyPluginDataDir(), options.variant.ownFilename)
      : workbuddyOwnAuthPath())
  }

  /** The plugin-owned credential path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /**
   * Read the stored credential without refreshing anything.
   *
   * A credential belonging to the other realm is refused rather than used: one
   * plugin serves both products, and sending one realm's token to the other's
   * endpoint would leak it across products. The error names the file and the
   * expected realm, which is what makes it fixable.
   */
  async current(): Promise<WorkBuddyCredential | undefined> {
    const credential = await this.readOwn()
    if (credential === undefined || this.variant === undefined) return credential
    const region = realmOf(credential)
    if (region !== this.variant.region) {
      throw new Error(
        `${this.variant.displayName} holds a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
        + ` (domain ${JSON.stringify(credential.domain)}) in ${this.ownPath};`
        + ` sign in again for ${this.variant.appName}, or remove that file`,
      )
    }
    return credential
  }

  /**
   * Adopt a credential document supplied by the user.
   *
   * The document is parsed with the tolerant cross-tool reader, so a
   * `workbuddy.json` written by the sibling tooling imports as-is. It is then
   * checked against this store's realm before anything is written: a document
   * for the other product is refused with a message naming that product, rather
   * than stored and refused on every later read.
   *
   * @param text - the document's text, exactly as read from the user's file.
   * @returns the adopted credential, for a secret-free summary.
   * @throws when the text carries no usable credential or belongs to the other realm.
   */
  async importDocument(text: string): Promise<WorkBuddyCredential> {
    const credential = parseOwnDocument(text)
    if (credential === undefined) {
      throw new Error('no usable credential in that document (expected an accessToken, as workbuddy.json has)')
    }
    const region = realmOf(credential)
    if (this.variant !== undefined && region !== this.variant.region) {
      throw new Error(
        `that document belongs to ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'},`
        + ` not ${this.variant.displayName};`
        + ` import it for --provider ${region === 'cn' ? 'workbuddy' : 'workbuddy-ai'}`,
      )
    }
    await this.saveOwn(credential)
    return credential
  }

  /**
   * Persist a credential a login just obtained. This is the store's only write
   * path besides refresh; the login route is its only caller.
   *
   * A credential for the wrong realm is refused here, at the boundary that knows
   * which product asked, rather than written and refused on every later read.
   */
  async save(credential: WorkBuddyCredential): Promise<void> {
    if (this.variant !== undefined) {
      const region = realmOf(credential)
      if (region !== this.variant.region) {
        throw new Error(
          `refusing to store a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
          + ` for ${this.variant.displayName}`,
        )
      }
    }
    await this.saveOwn(credential)
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      const app = this.variant?.appName ?? 'WorkBuddy'
      throw new Error(
        `workbuddy: not signed in to ${app}; sign in from the plugin's settings card`
        + ` (the credential is stored at ${this.ownPath})`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<WorkBuddyAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        region: realmOf(credential),
      }
    } catch (error: unknown) {
      // A realm mismatch (or an unreadable file) is a *diagnosable* signed-out
      // state, not a silent one: the user needs the path to the file that is
      // wrong, and which product it actually belongs to. Reported as a status
      // rather than thrown, because `status()` is documented never to throw and
      // the card renders `reason` verbatim.
      return { state: 'signed-out', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Remove the stored credential. */
  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again from the settings card')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: WORKBUDDY_CREDENTIAL_SOURCE,
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' sign in again from the plugin\'s settings card',
      )
    }
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    // The plugin's data directory is created here rather than assumed: the first
    // write of a fresh install is what brings it into being, and a lock or write
    // into a directory that does not exist yet fails outright.
    await mkdir(dirname(this.ownPath), { recursive: true, mode: 0o700 })
    // Written atomically — a temporary file renamed over the target — so no
    // reader ever observes a half-written credential, and no lock file is left
    // beside it. Concurrent writers are already serialized in-process by the
    // store's single-flight refresh; across processes the rename means the last
    // complete document wins rather than two interleaving.
    await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  private async readOwn(): Promise<WorkBuddyCredential | undefined> {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch (error: unknown) {
      // An absent file means "not signed in". Any other read failure is treated
      // the same way rather than thrown: the only recovery either way is to sign
      // in again, and a status read must never be the thing that breaks the card.
      if (isENOENT(error)) return undefined
      return undefined
    }
  }
}
