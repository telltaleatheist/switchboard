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
  /** ISO-8601 of the newest message, or null when nothing has been said. */
  last_message_at: string | null;
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

/** An uploaded attachment. `id` is the sha256 of the bytes. */
export interface BlobRef {
  id: string;
  media_type: string;
  bytes: number;
  name: string | null;
  created_at: string;
}

export interface Message {
  seq: number;
  ts: string;
  sender: string;
  to: string[] | null;
  /** Null when the operator sent without one; agent messages always carry a subject. */
  subject: string | null;
  body: string;
  /** Scalar when one seq is cited, array when several. */
  in_reply_to: number | number[] | null;
  /**
   * true = woke its addressees; false = record-only, pushed to nobody;
   * "digest" = held, delivered with the addressee's next wake-up.
   */
  wake: boolean | 'digest';
  /** Evidence that travelled with the message; null when there was none. */
  attachments: BlobRef[] | null;
  signal: string | null;
  /** 'superseded' = this crossed with another message and defers to it. */
  state: 'settled' | 'withdrawn' | 'superseded' | null;
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
  /** Null on archives written before schema 7 — transcript only, no cards. */
  channel_id: number | null;
  channel_name: string;
  closed_at: string;
  reason: string;
  message_count: number;
}

export interface ArchiveDetail extends ArchiveSummary {
  transcript: string;
  /** The same Message objects the live feed renders; empty for pre-v7 archives. */
  messages: Message[];
}

export interface PurgeResponse {
  deleted: number;
}

export interface ApiErrorBody {
  error: string;
}
