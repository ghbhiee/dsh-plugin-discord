/**
 * Late-bound access to the harness packages this bridge drives.
 *
 * These live in the profile's own tree, not in this plugin's. A plugin
 * installed normally finds them by Node's parent walk, but one installed with
 * `link:` (the usual dev loop) sits outside the profile directory and never
 * reaches it. Resolving through `ctx.baseUrl` — the profile directory the
 * loader booted from — covers both, and importing the resolved path keeps a
 * single module instance shared with the host rather than a second copy.
 *
 * @module dsh-plugin-discord/host-modules
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The harness entry points the bridge calls into. */
export interface HostModules {
  installModelSelection: typeof installModelSelection
  createUserMessage: typeof createUserMessage
  SessionId: typeof SessionId
  resolveSessionPreset: typeof resolveSessionPreset
}

/**
 * Resolve one specifier against this module, then against the profile.
 * @param specifier - bare package specifier.
 * @param baseUrl - the loader's base URL, when the entry has one.
 * @returns an absolute file URL for the module.
 * @throws when no anchor resolves it, naming every path tried.
 */
function resolveHostModule(specifier: string, baseUrl: string | undefined): string {
  const failures: string[] = []
  for (const anchor of [import.meta.url, ...(baseUrl === undefined ? [] : [baseUrl])]) {
    try {
      return pathToFileURL(createRequire(anchor).resolve(specifier)).href
    } catch (error) {
      failures.push(`${anchor}: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`)
    }
  }
  throw new Error(
    `dsh-plugin-discord: cannot resolve "${specifier}" from the profile. Tried:\n`
    + failures.map(line => `  - ${line}`).join('\n'),
  )
}

/**
 * Load the harness modules the bridge needs.
 * @param baseUrl - `ctx.baseUrl` of the plugin entry.
 * @returns the resolved harness entry points.
 */
export async function loadHostModules(baseUrl: string | undefined): Promise<HostModules> {
  const [agent, llm, session, presets] = await Promise.all([
    import(resolveHostModule('@deepseek-ai/dsh-agent', baseUrl)) as Promise<{ installModelSelection: typeof installModelSelection }>,
    import(resolveHostModule('@deepseek-ai/dsh-llm', baseUrl)) as Promise<{ createUserMessage: typeof createUserMessage }>,
    import(resolveHostModule('@deepseek-ai/dsh-session', baseUrl)) as Promise<{ SessionId: typeof SessionId }>,
    import(resolveHostModule('@deepseek-ai/dsh-agent-presets', baseUrl)) as Promise<{ resolveSessionPreset: typeof resolveSessionPreset }>,
  ])
  return {
    installModelSelection: agent.installModelSelection,
    createUserMessage: llm.createUserMessage,
    SessionId: session.SessionId,
    resolveSessionPreset: presets.resolveSessionPreset,
  }
}
