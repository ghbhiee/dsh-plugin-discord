/**
 * Late-bound, version-tolerant access to the harness packages this bridge uses.
 *
 * Two hazards this module exists to handle:
 *
 *  1. **Which copy.** A plugin installed with `link:` (the usual dev loop) has
 *     its own `node_modules` holding the harness packages it was BUILT against.
 *     Resolving from this file first would load those stale copies beside the
 *     host's live ones — two module instances of the same package, silently
 *     diverging after a host upgrade. So the running host's entry point is the
 *     first anchor, and this plugin's own tree only the last resort.
 *  2. **Which symbols.** The harness moves between releases: symbols get
 *     renamed, relocated, or dropped. Every import here is therefore OPTIONAL —
 *     an absent symbol degrades one feature with a warning instead of failing
 *     the whole bridge. Anything the bridge cannot do without is implemented
 *     locally rather than imported (see `bridge.ts`).
 *
 * @module dsh-plugin-discord/host-modules
 */

import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Harness entry points, each absent when this host no longer exports it. */
export interface HostModules {
  /** Builds the identified user message the agent inbox accepts. */
  createUserMessage?: typeof createUserMessage
  /** Couples a mutable model selection to agent-scoped prompt assembly. */
  installModelSelection?: typeof installModelSelection
}

/**
 * Anchors to resolve harness packages from, host-first.
 * @param baseUrl - `ctx.baseUrl` of the plugin entry, when the loader has one.
 * @returns candidate anchors in resolution order.
 */
function anchors(baseUrl: string | undefined): string[] {
  const list: string[] = []
  const entry = process.argv[1]
  if (entry !== undefined && entry !== '') {
    list.push(pathToFileURL(entry).href)
    try {
      // The launcher is usually a symlink on PATH; its own directory has no
      // node_modules, so the real file is what reaches the host's tree.
      list.push(pathToFileURL(realpathSync(entry)).href)
    } catch {
      // Unreadable launcher path: the raw entry above still gets a try.
    }
  }
  if (baseUrl !== undefined) list.push(baseUrl)
  list.push(import.meta.url)
  return list
}

/**
 * Import one harness module from the first anchor that resolves it.
 * @param specifier - bare package specifier.
 * @param baseUrl - the loader's base URL, when the entry has one.
 * @returns the module namespace, or undefined when no anchor resolves it.
 */
async function loadOptional(specifier: string, baseUrl: string | undefined): Promise<Record<string, unknown> | undefined> {
  for (const anchor of anchors(baseUrl)) {
    let resolved: string
    try {
      resolved = pathToFileURL(createRequire(anchor).resolve(specifier)).href
    } catch {
      continue
    }
    try {
      return await import(resolved) as Record<string, unknown>
    } catch {
      // Resolvable but unloadable (a half-installed tree): try the next anchor.
    }
  }
  return undefined
}

/**
 * Load what this host still offers.
 * @param baseUrl - `ctx.baseUrl` of the plugin entry.
 * @param warn - reports each degraded capability once, at boot.
 * @returns the entry points that resolved.
 */
export async function loadHostModules(
  baseUrl: string | undefined,
  warn: (text: string) => void = () => {},
): Promise<HostModules> {
  const [llm, agent] = await Promise.all([
    loadOptional('@deepseek-ai/dsh-llm', baseUrl),
    loadOptional('@deepseek-ai/dsh-agent', baseUrl),
  ])
  const modules: HostModules = {}
  const createUser = llm?.createUserMessage
  if (typeof createUser === 'function') {
    modules.createUserMessage = createUser as typeof createUserMessage
  } else {
    warn('@deepseek-ai/dsh-llm createUserMessage is unavailable; using the built-in message builder')
  }
  const install = agent?.installModelSelection
  if (typeof install === 'function') {
    modules.installModelSelection = install as typeof installModelSelection
  } else {
    warn('@deepseek-ai/dsh-agent installModelSelection is unavailable; sessions keep their creation-time model')
  }
  return modules
}
