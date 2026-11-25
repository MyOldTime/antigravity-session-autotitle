/**
 * antigravity-session-autotitle / ConversationService HTTP+JSON client.
 *
 * Talks to the local Antigravity Language Server using the standard
 * ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN environment variables.
 */

export class ConversationsClient {
  constructor({ address = process.env.ANTIGRAVITY_LS_ADDRESS, csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN, fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
    this.address = typeof address === 'string' ? address.trim() : '';
    this.csrfToken = typeof csrfToken === 'string' ? csrfToken.trim() : '';
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  isConfigured() {
    return Boolean(this.address && this.csrfToken && typeof this.fetchImpl === 'function');
  }

  async call(method, body) {
    if (!this.isConfigured()) {
      return { ok: false, errorCode: 'ls_not_configured', data: null };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const url = `http://${this.address}/product.v1.ConversationService/${method}`;
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-antigravity-csrf-token': this.csrfToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, errorCode: `http_${response.status}`, data: null };
      }
      const data = await response.json();
      return { ok: true, errorCode: null, data };
    } catch (error) {
      const code = error?.name === 'AbortError' ? 'ls_timeout' : 'ls_unreachable';
      return { ok: false, errorCode: code, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async getConversation(conversationId) {
    return this.call('GetConversation', { conversationId });
  }

  async updateTitle(conversationId, title) {
    return this.call('UpdateConversation', {
      conversationId,
      annotations: { title },
    });
  }
}

export function extractConversationInfo(conv) {
  if (!conv || typeof conv !== 'object') return null;
  const annotations = conv.annotations ?? {};
  const metadata = conv.metadata ?? {};
  const state = conv.state ?? {};
  return {
    id: conv.id ?? '',
    title: typeof annotations.title === 'string' ? annotations.title : '',
    summary: typeof state.summary === 'string' ? state.summary : '',
    archived: annotations.archived === true,
    parentConversationId: typeof metadata.parentConversationId === 'string' ? metadata.parentConversationId : '',
    runState: typeof state.runState === 'string' ? state.runState : '',
  };
}
