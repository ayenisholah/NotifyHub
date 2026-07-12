export interface InboxMessage {
  id: string;
  notificationId: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotifyHubInboxProps {
  userToken: string;
  apiBaseUrl?: string;
  pageSize?: number;
  pollIntervalMs?: number;
}

export interface MountHandle {
  unmount(): void;
}

export type InboxConnectionState = 'connecting' | 'connected' | 'disconnected';
export type InboxClientEvent =
  { type: 'message'; message: InboxMessage } | { type: 'unread'; count: number };

export type InboxErrorCode = 'fetch_failed' | 'mutation_failed' | 'invalid_response';

export class NotifyHubWidgetError extends Error {
  public constructor(
    public readonly code: InboxErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'NotifyHubWidgetError';
  }
}
