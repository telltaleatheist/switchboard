// Wire types for the Switchboard /v1 REST + WS API.
// Source of truth: ARCHITECTURE.md ("server/" REST surface, WebSocket surface).
// Kept intentionally close to the JSON shapes on the wire — no client-side
// renaming beyond what's necessary for TS ergonomics.

export interface VersionInfo {
  api: number;
  server: string;
}

// ---- Agents ----------------------------------------------------------

export interface AgentSummary {
  name: string;
  created_at: string;
  connected: boolean;
  /** ISO-8601 of the last sign of life (WS or long-poll), null = never armed anything. */
  last_seen_at: string | null;
  channels: string[];
}

export interface AgentRegisterResponse {
  name: string;
  /** Plaintext token — only ever returned once (register / reissue). */
  token: string;
}

/** `GET /v1/join-key` and `POST /v1/join-key/rotate` share this shape. */
export interface JoinKeyResponse {
  join_key: string;
}

export interface RenameAgentResponse {
  old: string;
  name: string;
}

// ---- Channels ----------------------------------------------------------

export interface MemberPresence {
  name: string;
  connected: boolean;
  last_seen_at: string | null;
}

export interface ChannelSummary {
  name: string;
  status: 'open' | 'closed';
  members: string[];
  presence: MemberPresence[];
  last_seq: number;
  created_at: string;
  note: string | null;
}

export type ChannelDetail = ChannelSummary;

export interface CreateChannelRequest {
  name: string;
  members: string[];
  note?: string;
}

export interface CreateChannelResponse {
  name: string;
  invited: string[];
}

export interface CloseChannelResponse {
  transcript: string;
}

// ---- Messages ----------------------------------------------------------

export interface Message {
  seq: number;
  ts: string;
  sender: string;
  to: string[] | null;
  subject: string;
  body: string;
  /** Scalar when one seq is cited, array when several. */
  in_reply_to: number | number[] | null;
  /** False = record-only: never pushed to any agent; the console still shows it. */
  wake: boolean;
  signal: string | null;
  state: 'settled' | 'withdrawn' | null;
}

export interface MessagesPage {
  messages: Message[];
  last_seq: number;
}

/** One JSON frame over a channel WS (operator connections see everything unfiltered). */
export type ChannelWsFrame =
  | { type: 'message'; channel: string; message: Message }
  | { type: 'shutdown' };

// ---- Patch requests ----------------------------------------------------

export interface PatchRequest {
  id: number;
  requester: string;
  with: string[];
  purpose: string;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
}

// ---- Archives ------------------------------------------------------------

export interface ArchiveSummary {
  id: number;
  channel_name: string;
  closed_at: string;
  reason: string;
}

export interface ArchiveDetail extends ArchiveSummary {
  transcript: string;
}

export interface PurgeResponse {
  deleted: number;
}

export interface ApiErrorBody {
  error: string;
}
