import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';

import {
  apiUrl,
  mergeMessages,
  parseClientEvent,
  parseInboxPage,
  parseMessage,
  parseReadAllResult,
  webSocketUrl,
} from './transport.js';
import type { InboxConnectionState, InboxMessage, NotifyHubInboxProps } from './types.js';
import { NotifyHubWidgetError } from './types.js';

const MAX_RECONNECT_MS = 30_000;

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

export function NotifyHubInbox({
  userToken,
  apiBaseUrl = '',
  pageSize = 20,
  pollIntervalMs = 30_000,
}: NotifyHubInboxProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [connection, setConnection] = useState<InboxConnectionState>('connecting');
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = `nh-inbox-${useId().replaceAll(':', '')}`;
  const scope = `${apiBaseUrl}\u0000${userToken}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const request = useCallback(
    async <T,>(
      path: string,
      parse: (value: unknown) => T | undefined,
      init?: RequestInit,
    ): Promise<T> => {
      const response = await fetch(apiUrl(apiBaseUrl, path), {
        ...init,
        headers: { Authorization: `Bearer ${userToken}`, ...init?.headers },
      });
      if (!response.ok)
        throw new NotifyHubWidgetError(
          'fetch_failed',
          `NotifyHub request failed (${response.status})`,
        );
      const result = parse(await response.json());
      if (result === undefined)
        throw new NotifyHubWidgetError(
          'invalid_response',
          'NotifyHub returned an invalid response',
        );
      return result;
    },
    [apiBaseUrl, userToken],
  );

  const fetchPage = useCallback(
    async (cursor?: string, polling = false): Promise<void> => {
      const requestScope = scope;
      const query = new URLSearchParams({ limit: String(pageSize) });
      if (cursor !== undefined) query.set('cursor', cursor);
      if (cursor !== undefined) setLoadingMore(true);
      try {
        const page = await request(`/v1/inbox?${query}`, parseInboxPage);
        if (scopeRef.current !== requestScope) return;
        setMessages((current) =>
          mergeMessages(
            cursor === undefined && polling ? current : cursor === undefined ? [] : current,
            page.items,
            cursor === undefined && polling,
          ),
        );
        setUnreadCount(page.unreadCount);
        if (!polling || cursor !== undefined) setNextCursor(page.nextCursor);
        setError(undefined);
      } catch {
        if (scopeRef.current !== requestScope) return;
        setError('Unable to load notifications.');
      } finally {
        if (scopeRef.current === requestScope) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [pageSize, request, scope],
  );

  useEffect(() => {
    setMessages([]);
    setUnreadCount(0);
    setNextCursor(null);
    setLoading(true);
    setError(undefined);
    setOpen(false);
    setConnection('connecting');
    void fetchPage();
  }, [fetchPage]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;

    const stopPolling = (): void => {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      pollTimer = undefined;
    };
    const startPolling = (): void => {
      if (pollTimer === undefined && pollIntervalMs > 0)
        pollTimer = setInterval(() => void fetchPage(undefined, true), pollIntervalMs);
    };
    const connect = (): void => {
      if (stopped) return;
      setConnection('connecting');
      try {
        socket = new WebSocket(webSocketUrl(apiBaseUrl, userToken));
      } catch {
        setConnection('disconnected');
        startPolling();
        const delay = Math.min(1000 * 2 ** attempts++, MAX_RECONNECT_MS);
        reconnectTimer = setTimeout(connect, delay);
        return;
      }
      socket.onopen = () => {
        attempts = 0;
        setConnection('connected');
      };
      socket.onmessage = ({ data }) => {
        try {
          const event = parseClientEvent(JSON.parse(String(data)));
          if (event?.type === 'message')
            setMessages((current) => mergeMessages(current, [event.message], true));
          if (event?.type === 'unread') setUnreadCount(event.count);
        } catch {
          /* Ignore malformed server frames. */
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnection('disconnected');
        startPolling();
        const delay = Math.min(1000 * 2 ** attempts++, MAX_RECONNECT_MS);
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };
    startPolling();
    connect();
    return () => {
      stopped = true;
      stopPolling();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [apiBaseUrl, fetchPage, pollIntervalMs, userToken]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        bellRef.current?.focus();
      }
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [open]);

  const markRead = async (id: string): Promise<void> => {
    const operationScope = scope;
    const before = messages;
    const beforeCount = unreadCount;
    const readAt = new Date().toISOString();
    setMessages((current) => current.map((item) => (item.id === id ? { ...item, readAt } : item)));
    setUnreadCount((count) => Math.max(0, count - 1));
    try {
      const updated = await request(`/v1/inbox/${encodeURIComponent(id)}/read`, parseMessage, {
        method: 'POST',
      });
      if (scopeRef.current !== operationScope) return;
      setMessages((current) => current.map((item) => (item.id === id ? updated : item)));
    } catch {
      if (scopeRef.current !== operationScope) return;
      setMessages(before);
      setUnreadCount(beforeCount);
      await fetchPage(undefined, true);
      setError('Unable to mark notification as read.');
    }
  };

  const markAllRead = async (): Promise<void> => {
    const operationScope = scope;
    const before = messages;
    const beforeCount = unreadCount;
    const readAt = new Date().toISOString();
    setMessages((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? readAt })));
    setUnreadCount(0);
    try {
      const result = await request('/v1/inbox/read-all', parseReadAllResult, { method: 'POST' });
      if (scopeRef.current !== operationScope) return;
      setUnreadCount(result.unreadCount);
    } catch {
      if (scopeRef.current !== operationScope) return;
      setMessages(before);
      setUnreadCount(beforeCount);
      await fetchPage(undefined, true);
      setError('Unable to mark notifications as read.');
    }
  };

  return (
    <div className="nh-widget">
      <button
        ref={bellRef}
        className="nh-bell"
        type="button"
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">&#128276;</span>
        {unreadCount > 0 && (
          <span className="nh-badge" aria-hidden="true">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      <span className="nh-sr-only" role="status" aria-live="polite">
        {unreadCount} unread notifications. Connection {connection}.
      </span>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className="nh-panel"
          role="region"
          aria-label="Notifications"
          tabIndex={-1}
        >
          <header className="nh-header">
            <h2>Notifications</h2>
            <button type="button" disabled={unreadCount === 0} onClick={() => void markAllRead()}>
              Mark all read
            </button>
          </header>
          {loading && (
            <p className="nh-state" role="status">
              Loading notifications…
            </p>
          )}
          {!loading && error && (
            <p className="nh-state nh-error" role="alert">
              {error}{' '}
              <button type="button" onClick={() => void fetchPage()}>
                Try again
              </button>
            </p>
          )}
          {!loading && messages.length === 0 && !error && (
            <p className="nh-state">You’re all caught up.</p>
          )}
          {messages.length > 0 && (
            <ul className="nh-list">
              {messages.map((message) => (
                <li key={message.id} className={message.readAt === null ? 'nh-unread' : undefined}>
                  <button
                    type="button"
                    disabled={message.readAt !== null}
                    onClick={() => void markRead(message.id)}
                    aria-label={
                      message.readAt === null
                        ? `Mark ${message.title} as read`
                        : `${message.title}, read`
                    }
                  >
                    <span className="nh-dot" aria-hidden="true" />
                    <span className="nh-content">
                      <strong>{message.title}</strong>
                      <span className="nh-body">{message.body}</span>
                      <time dateTime={message.createdAt}>{relativeTime(message.createdAt)}</time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {nextCursor !== null && (
            <button
              className="nh-more"
              type="button"
              disabled={loadingMore}
              onClick={() => void fetchPage(nextCursor)}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
