import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as WorkBuddy from '../src/index.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
let root: string | undefined

/** A credential document for one upstream region, as a login would store it. */
function credentialDocument(domain: string): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid: 'uid-1', nickname: 'nick', enterpriseId: 'ent-1' },
  })
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('WorkBuddy Host settings integration', () => {
  it('restores the saved maximum-window preference after restarting and can disable it', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-context-restart-'))
    const settingsFile = join(root, 'settings.json')
    const aiAuthPath = join(root, AI_VARIANT.ownFilename)
    await writeFile(settingsFile, '{}')
    await writeFile(aiAuthPath, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('DSH_HOME', root)
    // The plugin keeps its files in a per-profile folder; point that at the same
    // temporary root so the credential path is the one this spec writes.
    vi.stubEnv(WorkBuddy.WORKBUDDY_DATA_DIR_ENV, root)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    class FileSettings extends SettingsProvider {
      readonly writable = true
      protected async load(): Promise<Record<string, unknown>> {
        return JSON.parse(await readFile(settingsFile, 'utf8'))
      }
      protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
        const document = await this.load()
        document[ns] = section
        await writeFile(settingsFile, JSON.stringify(document))
      }
    }
    const boot = async (): Promise<Context> => {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(FileSettings)
      await ctx.plugin(WorkBuddy, {})
      await vi.waitFor(async () => {
        expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
      })
      return ctx
    }
    let ctx = await boot()
    // Fresh profile, setting never touched: the default is on, so the model
    // resolves at its largest declared window before any update is written.
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(1_000_000)
    await ctx.fiber.dispose()
    ctx = await boot()
    // Still on across a restart with nothing stored (schema default, not state).
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(1_000_000)
    // An explicit opt-out must survive restarts: the flipped default may not
    // resurrect the preference the user turned off.
    await ctx.settings.update('workbuddy-ai', { useMaximumContextWindow: false })
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(300_000)
    })
    await ctx.fiber.dispose()
    ctx = await boot()
    expect(ctx.settings.get('workbuddy-ai')).toMatchObject({ useMaximumContextWindow: false })
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(300_000)
  })

  it('exposes the provider directory entry, the settings section, and the fallback model list', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-settings-'))
    vi.stubEnv('DSH_HOME', root)
    // The plugin keeps its files in a per-profile folder; point that at the same
    // temporary root so the credential path is the one this spec writes.
    vi.stubEnv(WorkBuddy.WORKBUDDY_DATA_DIR_ENV, root)
    // This case asserts the CN fallback roster, which is served only to a
    // signed-in variant. Pinning a credential of its own keeps that independent
    // of anything else on this machine: the store reads the plugin's own file
    // under `$DSH_HOME`, and without one the group stays hidden (empty model
    // list) rather than serving the roster.
    const cnAuthPath = join(root, CN_VARIANT.ownFilename)
    await writeFile(cnAuthPath, credentialDocument('copilot.tencent.com'))
    // Signing in would otherwise make this case perform a real request to the CN
    // catalog endpoint. These tests must not touch the network, and the roster
    // asserted below is the compiled-in fallback, so the fetch is stubbed to
    // fail exactly as the sibling case does rather than depending on the remote.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    // Registration rides on the loopback shim's listening event.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy',
      displayName: 'WorkBuddy',
      settingsNs: 'workbuddy',
      settingsPath: [],
      declared: false,
    })

    // The section is what the Models settings page joins on to render a card.
    const descriptor = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(descriptor).toBeDefined()

    const models = await ctx.llm.listModels('workbuddy')
    expect(models.map(model => model.id)).toContain('auto')
    expect(models.map(model => model.id)).toContain('deepseek-v4-pro')
    // The fallback catalog tracks the live `cli` roster, including the newer
    // models the desktop app offers that older builds lacked.
    expect(models.map(model => model.id)).toContain('hy4-preview')
    expect(models.map(model => model.id)).toContain('glm-5.3')

    // The billing rate rides the display name (and the advisory description)
    // so both the /model popup and the composer seat show it; the id and the
    // request path are untouched by this display-only decoration.
    const byId = new Map(models.map(model => [model.id, model]))
    // Since DSH 0.1.2 the composer seat renders the model name only, so both
    // the billing rate and the declared promo badges ride the name itself;
    // description stays untouched everywhere.
    expect(byId.get('glm-5.2')?.name).toBe('GLM-5.2 · x0.79 · 夜间折扣')
    expect(byId.get('glm-5.1')?.name).toBe('GLM-5.1 · x0.79')
    expect(byId.get('auto')?.name).toBe('Auto')
    expect(byId.get('glm-5.2')?.description).toBeUndefined()
    expect(byId.get('glm-5.3')?.description).toBeUndefined()

    // Thinking controls are declared-set-only: models whose upstream row
    // carries `supportedEfforts` expose exactly those efforts; rows without a
    // list (the older `{effort, summary}` shape) expose no control at all, so
    // requests never carry `reasoning_effort` for them and the upstream
    // default applies — matching the desktop app's own per-model gating.
    const autoResolved = await ctx.llm.resolveModelInfo('workbuddy', 'auto')
    expect(autoResolved.reasoning).toBeUndefined()
    const flashResolved = await ctx.llm.resolveModelInfo('workbuddy', 'glm-5.3-flash')
    expect(flashResolved.reasoning?.efforts.map(effort => effort.id).sort()).toEqual(['high', 'low', 'max', 'off'])

    // Image modalities follow the per-model catalog flag (fallback list here):
    // image-capable entries expose `image`, glm-5.1 stays text-only.
    const modalities = new Map(models.map(model => [model.id, model.inputModalities]))
    expect(modalities.get('auto')).toContain('image')
    expect(modalities.get('glm-5.1')).toEqual(['text'])

    // A settings write validates against the schema and persists. The CN
    // section owns one field — `probeConsent` — so that is the write to make,
    // and the stored value is read back both through the live descriptor and
    // through the section's own document.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { probeConsent: true })
    const updated = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect((updated?.value as Record<string, unknown>)['probeConsent']).toBe(true)
    expect(ctx.settings.get(WorkBuddy.WORKBUDDY_SETTINGS_NS)).toMatchObject({ probeConsent: true })
  })

  /**
   * Both providers register from one plugin, unconditionally, and the four
   * credential combinations are expressed through catalog visibility rather
   * than through registration. That is what lets a sign-in that happens while
   * DSH is already running surface without a restart.
   */
  it('registers both variants and keeps each variant identity separate', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-dual-'))
    vi.stubEnv('DSH_HOME', root)
    // The plugin keeps its files in a per-profile folder; point that at the same
    // temporary root so the credential path is the one this spec writes.
    vi.stubEnv(WorkBuddy.WORKBUDDY_DATA_DIR_ENV, root)
    // Shorten the credential sweep: a group appears only once the sweep has
    // adopted the credential it finds in the temporary home.
    vi.stubEnv('DSH_WORKBUDDY_POLL_MS', '100')
    // One real-shaped credential per product, each in the file its own variant
    // owns under the Harness home. The upstream fetch is stubbed to fail so the
    // assertion covers the per-variant fallback rosters rather than depending on
    // the network.
    await writeFile(join(root, CN_VARIANT.ownFilename), credentialDocument('copilot.tencent.com'))
    await writeFile(join(root, AI_VARIANT.ownFilename), credentialDocument('www.workbuddy.ai'))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(
        expect.arrayContaining(['workbuddy', 'workbuddy-ai']),
      )
    })

    // Each provider carries its own display name, which is the model group
    // heading the picker renders — and its OWN settings namespace: the Models
    // page resolves `settingsNs` against served sections, so a shared ns would
    // render both providers onto one card.
    expect(ctx.llm.listConfigurableProviders()).toEqual(expect.arrayContaining([
      { provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'workbuddy', settingsPath: [], declared: false },
      { provider: 'workbuddy-ai', displayName: 'WorkBuddy AI', settingsNs: 'workbuddy-ai', settingsPath: [], declared: false },
    ]))

    // THE DISPATCH CONTRACT. The Plugins tab renders a card by
    // `renderSlot('settings.plugin.item', {}, { entryKey: ns })` for each
    // namespace the Host serves, and skips an entry whose key names no served
    // namespace — the tab builds its list from sections, never from the slot's
    // registrations. A card whose variant id is not a served ns therefore
    // registers but never renders, which is exactly the bug this pins: every
    // variant id must be an installed section's namespace.
    const served = new Set(ctx.settings.describe().map(entry => entry.ns))
    for (const variant of WorkBuddy.WORKBUDDY_VARIANTS) {
      expect(served, `card key "${variant.id}" must be a served settings namespace`).toContain(variant.id)
    }
    expect(served).toContain(WorkBuddy.WORKBUDDY_AI_SETTINGS_NS)

    // Each section owns only its own fields, so one card's form cannot edit the
    // other's preference. `describe()` reports the schema as schemastery's ref
    // graph; the root object's `dict` is the field map.
    const fieldsOf = (ns: string): string[] => {
      const descriptor = ctx.settings.describe().find(entry => entry.ns === ns)
      const root = (descriptor?.schema as { refs?: Record<string, { dict?: Record<string, unknown> }>, uid?: string } | undefined)?.refs?.[String((descriptor?.schema as { uid?: number } | undefined)?.uid)]
      return Object.keys(root?.dict ?? {})
    }
    // No credential-path field survives on either card: a credential is obtained
    // by signing in and stored by the plugin, so there is nothing left to point
    // at a file.
    expect(fieldsOf('workbuddy')).toEqual(['probeConsent'])
    expect(fieldsOf('workbuddy-ai')).toEqual(['useMaximumContextWindow'])

    // A write through one section must reach only THAT variant. The schema
    // assertions above prove the two forms are split; this proves the wiring
    // behind them is too. Without it, a section could carry the right field
    // while `onChange` handed it to the wrong variant and nothing above would
    // notice.
    //
    // Observable chosen deliberately: `useMaximumContextWindow` is the only
    // setting that changes a served model. It selects a larger declared window,
    // and only the international variant exposes it, so the AI provider's
    // window must move while the CN provider's — a model that declares no
    // alternatives at all — stays exactly where it was. A mis-routed switch
    // would move the CN provider instead.
    await ctx.settings.update('workbuddy-ai', { useMaximumContextWindow: false })
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(300_000)
    })
    expect((await ctx.llm.resolveModelInfo('workbuddy', 'deepseek-v4.1-flash')).context?.contextWindow).toBe(1_000_000)

    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })

    // The two variants must not share a roster: the international models are
    // not reachable through the CN provider, and vice versa. A shared fallback
    // list would misdescribe one of them (different rates, windows, and
    // declared efforts).
    const cn = (await ctx.llm.listModels('workbuddy')).map(model => model.id)
    const ai = (await ctx.llm.listModels('workbuddy-ai')).map(model => model.id)
    expect(cn).toContain('minimax-m3')
    expect(ai).not.toContain('minimax-m3')
    expect(ai).toContain('gpt-5.6-luna')
    expect(cn).not.toContain('gpt-5.6-luna')
  })

  /**
   * With no credential present, a variant exposes nothing. This is the
   * deliberate behaviour change the plan calls out: the CN provider used to
   * publish 15 fallback models to a signed-out user, which offered models that
   * could only fail on the first message.
   */
  it('hides a variant with no usable credential while still registering it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-empty-'))
    // The temporary home is empty: neither variant's own credential file exists,
    // which is what "nobody has signed in" now means.
    vi.stubEnv('DSH_HOME', root)
    // The plugin keeps its files in a per-profile folder; point that at the same
    // temporary root so the credential path is the one this spec writes.
    vi.stubEnv(WorkBuddy.WORKBUDDY_DATA_DIR_ENV, root)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    })
    expect(await ctx.llm.listModels('workbuddy-ai')).toEqual([])

    // The provider directory entry survives: the group is hidden by having no
    // models, not by unregistering, so a later sign-in needs no restart.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .toEqual(expect.arrayContaining(['workbuddy', 'workbuddy-ai']))
    // And the settings card is still there to explain how to sign in.
    expect(ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)).toBeDefined()
  })

  /**
   * A credential for the other product is refused, and the refusal is what the
   * card shows. Silently treating it as "signed out" would send the user to
   * re-authenticate when the actual fix is a file path.
   */
  it('refuses a cross-product credential instead of using it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-cross-'))
    vi.stubEnv('DSH_HOME', root)
    // The plugin keeps its files in a per-profile folder; point that at the same
    // temporary root so the credential path is the one this spec writes.
    vi.stubEnv(WorkBuddy.WORKBUDDY_DATA_DIR_ENV, root)
    // A WorkBuddy (CN) credential written into the international variant's own
    // credential file. There is no path setting left to point somewhere else, so
    // this — one product's credential in the other's file — is the mistyped or
    // copied state the region check still has to refuse.
    await writeFile(join(root, AI_VARIANT.ownFilename), credentialDocument('copilot.tencent.com'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    const models = await (async () => {
      await vi.waitFor(() => {
        expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-ai')
      })
      return ctx.llm.listModels('workbuddy-ai')
    })()
    // Refused, so the group stays hidden rather than serving a roster the token
    // cannot actually reach.
    expect(models).toEqual([])
  })
})
