import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotifyHubInbox } from './NotifyHubInbox.js';
import { mount } from './mount.js';
import type { InboxMessage } from './types.js';

const first: InboxMessage = {
  id: '10000000-0000-4000-8000-000000000001',
  notificationId: '20000000-0000-4000-8000-000000000001',
  title: 'First',
  body: 'A message',
  readAt: null,
  createdAt: '2026-07-12T10:00:00.000Z',
};
const second: InboxMessage = {
  ...first,
  id: '10000000-0000-4000-8000-000000000002',
  notificationId: '20000000-0000-4000-8000-000000000002',
  title: 'Second',
  createdAt: '2026-07-12T09:00:00.000Z',
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }
  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  disconnect(): void {
    this.onclose?.();
  }
}

function page(
  items: InboxMessage[],
  unreadCount = items.filter((item) => item.readAt === null).length,
  nextCursor: string | null = null,
): Response {
  return Response.json({ items, unreadCount, nextCursor });
}

describe('NotifyHubInbox', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => page([first], 1, 'next')),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads, opens accessibly, paginates, caps the badge, and restores focus on Escape', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(page([first], 120, 'next'))
      .mockResolvedValueOnce(page([second], 120));
    render(<NotifyHubInbox userToken="token" apiBaseUrl="https://api.example" />);
    const bell = await screen.findByRole('button', { name: 'Notifications, 120 unread' });
    expect(screen.getByText('99+')).toBeInTheDocument();
    fireEvent.click(bell);
    expect(await screen.findByRole('region', { name: 'Notifications' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bell).toHaveFocus();
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('renders empty, invalid-response failure, and retry states', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(page([]));
    const view = render(<NotifyHubInbox userToken="token" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('You’re all caught up.')).toBeInTheDocument();
    view.unmount();
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ items: [{}], unreadCount: -1, nextCursor: null }))
      .mockResolvedValueOnce(page([]));
    render(<NotifyHubInbox userToken="other" />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load notifications.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('You’re all caught up.')).toBeInTheDocument();
  });

  it('optimistically marks one and all read and reconciles failures', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(page([first, second], 2))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(page([first, second], 2))
      .mockResolvedValueOnce(Response.json({ updatedCount: 2, unreadCount: 0 }));
    render(<NotifyHubInbox userToken="token" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark First as read' }));
    expect(screen.getByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Notifications, 2 unread' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  });

  it('deduplicates and orders WebSocket messages, accepts unread truth, and polls while reconnecting', async () => {
    vi.useFakeTimers();
    render(<NotifyHubInbox userToken="token" pollIntervalMs={100} />);
    await act(async () => {
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => {
      socket.message({
        type: 'message',
        message: { ...second, createdAt: '2026-07-12T11:00:00.000Z' },
      });
      socket.message({
        type: 'message',
        message: { ...second, body: 'Updated', createdAt: '2026-07-12T11:00:00.000Z' },
      });
      socket.message({ type: 'unread', count: 7 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 7 unread' }));
    expect(screen.getAllByText('Second')).toHaveLength(1);
    expect(screen.getByText('Updated')).toBeInTheDocument();
    act(() => socket.disconnect());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('resets on identity changes, closes old resources, and vanilla unmount is idempotent', async () => {
    const view = render(<NotifyHubInbox userToken="one" apiBaseUrl="https://one.example" />);
    await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    const oldSocket = FakeWebSocket.instances[0]!;
    vi.mocked(fetch).mockResolvedValueOnce(page([], 0));
    view.rerender(<NotifyHubInbox userToken="two" apiBaseUrl="https://two.example" />);
    await screen.findByRole('button', { name: 'Notifications' });
    expect(oldSocket.closed).toBe(true);
    expect(FakeWebSocket.instances[1]!.url).toContain('token=two');
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer two' }),
    });

    view.unmount();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = mount(host, { userToken: 'vanilla' });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      handle.unmount();
      handle.unmount();
    });
    expect(host).toBeEmptyDOMElement();
    host.remove();
    expect(createElement(NotifyHubInbox, { userToken: 'x' })).toBeTruthy();
  });
});
