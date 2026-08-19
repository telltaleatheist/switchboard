import { Injectable, inject } from '@angular/core';
import { ConfigService } from './config.service';
import type {
  AgentRegisterResponse,
  AgentSummary,
  ArchiveDetail,
  ArchiveSummary,
  ChannelDetail,
  ChannelSummary,
  CloseChannelResponse,
  CreateChannelRequest,
  CreateChannelResponse,
  JoinKeyResponse,
  MessagesPage,
  PatchRequest,
  PurgeResponse,
  RenameAgentResponse,
  VersionInfo,
} from './api.models';

/** Thrown for any non-2xx response; carries the server's status + error text. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Typed client for the Switchboard /v1 REST API, coded exactly against
 * ARCHITECTURE.md's "server/" REST surface table. Always sends the operator
 * bearer token; the server grants it full access.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly configService = inject(ConfigService);

  // ---- version (no auth) -------------------------------------------------

  getVersion(): Promise<VersionInfo> {
    return this.request<VersionInfo>('GET', '/v1/version');
  }

  // ---- agents --------------------------------------------------------------

  listAgents(): Promise<{ agents: AgentSummary[] }> {
    return this.request('GET', '/v1/agents');
  }

  registerAgent(name: string): Promise<AgentRegisterResponse> {
    return this.request('POST', '/v1/agents', { name });
  }

  reissueAgentToken(name: string): Promise<AgentRegisterResponse> {
    return this.request('POST', `/v1/agents/${encodeURIComponent(name)}/reissue`);
  }

  renameAgent(currentName: string, newName: string): Promise<RenameAgentResponse> {
    return this.request('POST', `/v1/agents/${encodeURIComponent(currentName)}/rename`, {
      name: newName,
    });
  }

  /** The re-displayable universal enrollment credential (ARCHITECTURE.md "Tokens"). */
  getJoinKey(): Promise<JoinKeyResponse> {
    return this.request('GET', '/v1/join-key');
  }

  /** Mints a fresh join key; the old one stops working immediately, joined agents are unaffected. */
  rotateJoinKey(): Promise<JoinKeyResponse> {
    return this.request('POST', '/v1/join-key/rotate', {});
  }

  /** The operator-configured DNS name the join block leads with; null = use the primary IP. */
  getAdvertisedHost(): Promise<{ host: string | null }> {
    return this.request('GET', '/v1/advertised-host');
  }

  /** Set (bare host, no scheme/port) or clear (null) the advertised DNS name. */
  setAdvertisedHost(host: string | null): Promise<{ host: string | null }> {
    return this.request('POST', '/v1/advertised-host', { host });
  }

  /** `deleted` is 'hard' (row gone) or 'soft' (mangled FK tombstone). Either way the name is freed immediately. */
  deleteAgent(name: string): Promise<{ name: string; deleted: 'hard' | 'soft' }> {
    return this.request('DELETE', `/v1/agents/${encodeURIComponent(name)}`);
  }

  // ---- channels --------------------------------------------------------

  listChannels(status?: 'open' | 'closed'): Promise<{ channels: ChannelSummary[] }> {
    const qs = status ? `?status=${status}` : '';
    return this.request('GET', `/v1/channels${qs}`);
  }

  getChannel(name: string): Promise<ChannelDetail> {
    return this.request('GET', `/v1/channels/${encodeURIComponent(name)}`);
  }

  createChannel(body: CreateChannelRequest): Promise<CreateChannelResponse> {
    return this.request('POST', '/v1/channels', body);
  }

  closeChannel(name: string): Promise<CloseChannelResponse> {
    return this.request('POST', `/v1/channels/${encodeURIComponent(name)}/close`, {});
  }

  /** Patch more agents into an open channel; already-members come back in `already`, not as an error. */
  addChannelMembers(name: string, members: string[]): Promise<{ name: string; added: string[]; already: string[] }> {
    return this.request('POST', `/v1/channels/${encodeURIComponent(name)}/members`, { members });
  }

  /** Unpatch one agent from an open channel; only the removed agent is notified. */
  removeChannelMember(name: string, agent: string): Promise<{ name: string; removed: string }> {
    return this.request(
      'DELETE',
      `/v1/channels/${encodeURIComponent(name)}/members/${encodeURIComponent(agent)}`,
    );
  }

  /** Speak in a channel as the reserved 'operator' sender (to: omitted = everyone). */
  /**
   * Operator send. `subject` is optional here and nowhere else: the server
   * lets the operator omit it (agents must always carry one), so an empty
   * subject is left off the body rather than echoing the message text.
   */
  sendChannelMessage(
    name: string,
    subject: string | null,
    body: string,
    to?: string[],
  ): Promise<{ seq: number; ts: string }> {
    return this.request('POST', `/v1/channels/${encodeURIComponent(name)}/messages`, {
      ...(subject && subject.trim().length > 0 ? { subject: subject.trim() } : {}),
      body,
      ...(to && to.length > 0 ? { to } : {}),
    });
  }

  getChannelMessages(name: string, since: number): Promise<MessagesPage> {
    return this.request('GET', `/v1/channels/${encodeURIComponent(name)}/messages?since=${since}`);
  }

  // ---- patch requests ----------------------------------------------------

  listPendingPatchRequests(): Promise<{ requests: PatchRequest[] }> {
    return this.request('GET', '/v1/patch-requests?status=pending');
  }

  approvePatchRequest(id: number, name?: string): Promise<unknown> {
    return this.request('POST', `/v1/patch-requests/${id}/approve`, name ? { name } : {});
  }

  denyPatchRequest(id: number): Promise<unknown> {
    return this.request('POST', `/v1/patch-requests/${id}/deny`);
  }

  // ---- archives ------------------------------------------------------------

  listArchives(): Promise<{ archives: ArchiveSummary[] }> {
    return this.request('GET', '/v1/archives');
  }

  getArchive(id: number): Promise<ArchiveDetail> {
    return this.request('GET', `/v1/archives/${id}`);
  }

  purge(olderThanDays: number): Promise<PurgeResponse> {
    return this.request('POST', '/v1/maintenance/purge', { older_than_days: olderThanDays });
  }

  // ---- WebSocket URL builder -----------------------------------------------

  /** Channel live-view WS URL: ws://…/v1/channels/{name}/ws?token=…&since=N */
  channelWsUrl(name: string, since: number): string {
    return this.wsUrl(`/v1/channels/${encodeURIComponent(name)}/ws`, { since });
  }

  private wsUrl(path: string, params: Record<string, string | number>): string {
    const httpBase = this.baseUrl();
    const wsBase = httpBase.replace(/^http/, 'ws');
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      qs.set(key, String(value));
    }
    qs.set('token', this.operatorToken());
    return `${wsBase}${path}?${qs.toString()}`;
  }

  // ---- plumbing --------------------------------------------------------

  private baseUrl(): string {
    const state = this.configService.state();
    if (state.status !== 'ready') {
      throw new Error('Switchboard config is not ready yet.');
    }
    return state.config.baseUrl.replace(/\/+$/, '');
  }

  private operatorToken(): string {
    const state = this.configService.state();
    if (state.status !== 'ready') {
      throw new Error('Switchboard config is not ready yet.');
    }
    return state.config.operatorToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.operatorToken()}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiError(
        `Could not reach the switchboard server at ${this.baseUrl()} (${err instanceof Error ? err.message : err}).`,
        0,
      );
    }

    if (!res.ok) {
      let message = `${method} ${path} failed with HTTP ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: string };
        if (errBody?.error) message = errBody.error;
      } catch {
        // response body wasn't JSON; keep the generic message
      }
      throw new ApiError(message, res.status);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
}
