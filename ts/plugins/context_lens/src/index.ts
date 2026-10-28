import { definePlugin, type BundledPlugin } from '@xueness/kernel';
import type { AgentExtension } from '@xueness/agent';
import { isDict } from '@xueness/contracts';
import { captureRequest } from './context.ts';
import manifest from '../manifest.json' with { type: 'json' };

export { createContextLensHttp } from './http.ts';
export { projectContextLens, sessionSummary, ownersFromManifests } from './projection.ts';
export { contextItems, captureRequest } from './context.ts';
export const contextLens: BundledPlugin = { manifest, plugin: definePlugin({ name: 'context_lens', apply() {} }) };

export function contextLensExtension(config: () => Record<string, unknown> = () => ({})): AgentExtension {
  return { id: 'context_lens', capabilities: ['context_lens.capture'],
    prepareRequest(context, request) {
      const settings = config(), prefix = typeof settings.promptPrefix === 'string' ? settings.promptPrefix : '', suffix = typeof settings.promptSuffix === 'string' ? settings.promptSuffix : '';
      let messages = request.messages;
      if (prefix || suffix) {
        const first = messages[0];
        if (first?.role === 'system' && typeof first.content === 'string') messages = [{ ...first, content: [prefix, first.content, suffix].filter(Boolean).join('\n') }, ...messages.slice(1)];
        else messages = [{ role: 'system', content: [prefix, suffix].filter(Boolean).join('\n') }, ...messages];
      }
      if (settings.captureRequests !== false) {
        const selection = isDict(context.session.model_selection) ? context.session.model_selection : {};
        captureRequest(context.session, messages, request.tools, String(selection.model ?? ''));
      }
      return { ...request, messages };
    } };
}
