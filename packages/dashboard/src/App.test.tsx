import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import type { DashboardClient } from './api.js';
import type {
  DashboardDlqItem,
  DashboardNotificationDetail,
  DashboardNotificationListItem,
} from './types.js';

const notification: DashboardNotificationListItem = {
  notificationId: 'notification-1',
  event: 'comment.created',
  status: 'ROUTED',
  reason: null,
  createdAt: '2026-07-13T10:00:00.000Z',
  deliveries: [
    {
      deliveryId: 'delivery-1',
      channel: 'EMAIL',
      status: 'SENT',
      attempts: 1,
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: '2026-07-13T10:00:03.000Z',
    },
    {
      deliveryId: 'delivery-2',
      channel: 'SMS',
      status: 'RETRYING',
      attempts: 2,
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: '2026-07-13T10:00:02.000Z',
    },
  ],
};

const detail: DashboardNotificationDetail = {
  ...notification,
  deliveries: [
    {
      ...notification.deliveries[0]!,
      timeline: [
        {
          status: 'SENT',
          createdAt: '2026-07-13T10:00:03.000Z',
          reason: 'email_sent',
          errorClassification: null,
        },
        {
          status: 'QUEUED',
          createdAt: '2026-07-13T10:00:00.000Z',
          reason: 'immediate',
          errorClassification: null,
        },
        {
          status: 'PROCESSING',
          createdAt: '2026-07-13T10:00:01.000Z',
          reason: 'email_processing',
          errorClassification: null,
        },
      ],
    },
    { ...notification.deliveries[1]!, timeline: [] },
  ],
};

const dlqItem: DashboardDlqItem = {
  deliveryId: 'delivery-dlq',
  notificationId: 'notification-dlq',
  event: 'invoice.overdue',
  channel: 'SMS',
  status: 'DLQ',
  attempts: 5,
  createdAt: '2026-07-13T09:00:00.000Z',
  updatedAt: '2026-07-13T09:05:00.000Z',
  reason: 'delivery_dead_lettered',
  errorClassification: 'SmsDeliveryError',
};

function createClient(overrides: Partial<DashboardClient> = {}): DashboardClient {
  return {
    summary: vi.fn(async () => ({ sentToday: 12, inFlight: 3, failed: 2, dlq: 1 })),
    notifications: vi.fn(async () => ({ items: [notification], nextCursor: null })),
    notification: vi.fn(async () => detail),
    dlq: vi.fn(async () => ({ items: [dlqItem], nextCursor: null })),
    retry: vi.fn<DashboardClient['retry']>().mockResolvedValue('retried'),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('operator dashboard', () => {
  it('renders counters, textual channel statuses, and cursor pagination', async () => {
    const older = { ...notification, notificationId: 'notification-older', event: 'task.assigned' };
    const notifications = vi.fn(async (cursor?: string) =>
      cursor === undefined
        ? { items: [notification], nextCursor: 'older-cursor' }
        : { items: [older], nextCursor: null },
    );
    render(<App client={createClient({ notifications })} />);

    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('email · sent')).toBeInTheDocument();
    expect(screen.getByText('sms · retrying 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older notifications' }));

    expect(await screen.findByText('task.assigned')).toBeInTheDocument();
    expect(notifications).toHaveBeenCalledWith('older-cursor');
  });

  it('opens a focus-contained drawer, orders timeline entries, and restores focus on Escape', async () => {
    render(<App client={createClient()} />);
    const trigger = await screen.findByRole('button', { name: 'View details for comment.created' });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'comment.created' });
    const closeButton = screen.getByRole('button', { name: 'Close details' });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeButton).toHaveFocus();
    const emailTimeline = within(dialog)
      .getByRole('heading', { name: 'email' })
      .closest('section')!;
    expect(
      [...emailTimeline.querySelectorAll('.timeline-event strong')].map((node) => node.textContent),
    ).toEqual(['queued', 'processing', 'sent']);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('supports keyboard tab navigation to the DLQ view', async () => {
    render(<App client={createClient()} />);
    const recentTab = await screen.findByRole('tab', { name: 'Recent' });
    recentTab.focus();

    fireEvent.keyDown(recentTab, { key: 'ArrowRight' });

    const dlqTab = screen.getByRole('tab', { name: /Dead letter/ });
    expect(dlqTab).toHaveFocus();
    expect(dlqTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Retry controls locked')).toBeInTheDocument();
  });

  it('pauses polling while hidden, refreshes on visibility, and never overlaps slow polls', async () => {
    vi.useFakeTimers();
    let resolveSlow:
      | ((value: { sentToday: number; inFlight: number; failed: number; dlq: number }) => void)
      | undefined;
    const slow = new Promise<{ sentToday: number; inFlight: number; failed: number; dlq: number }>(
      (resolve) => {
        resolveSlow = resolve;
      },
    );
    const summary = vi
      .fn<DashboardClient['summary']>()
      .mockResolvedValueOnce({ sentToday: 12, inFlight: 3, failed: 2, dlq: 1 })
      .mockReturnValueOnce(slow)
      .mockResolvedValue({ sentToday: 13, inFlight: 2, failed: 1, dlq: 1 });
    const notifications = vi.fn<DashboardClient['notifications']>().mockResolvedValue({
      items: [notification],
      nextCursor: null,
    });
    const dlq = vi.fn<DashboardClient['dlq']>().mockResolvedValue({
      items: [dlqItem],
      nextCursor: null,
    });
    let hidden = false;
    const originalHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

    await act(async () => {
      render(<App client={createClient({ summary, notifications, dlq })} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(summary).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveBeenCalledTimes(1);
    expect(dlq).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(summary).toHaveBeenCalledTimes(2);
    expect(notifications).toHaveBeenCalledTimes(2);
    expect(dlq).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(summary).toHaveBeenCalledTimes(2);
    expect(notifications).toHaveBeenCalledTimes(2);
    expect(dlq).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSlow?.({ sentToday: 12, inFlight: 3, failed: 2, dlq: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    hidden = true;
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(summary).toHaveBeenCalledTimes(2);

    hidden = false;
    await act(async () => {
      fireEvent(document, new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(summary).toHaveBeenCalledTimes(3);
    expect(notifications).toHaveBeenCalledTimes(3);
    expect(dlq).toHaveBeenCalledTimes(3);

    if (originalHidden === undefined) delete (document as { hidden?: boolean }).hidden;
    else Object.defineProperty(document, 'hidden', originalHidden);
  });

  it('polls an open notification detail every five seconds', async () => {
    vi.useFakeTimers();
    const notificationDetail = vi.fn<DashboardClient['notification']>().mockResolvedValue(detail);
    await act(async () => {
      render(<App client={createClient({ notification: notificationDetail })} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'View details for comment.created' }));
      await Promise.resolve();
    });
    expect(notificationDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(notificationDetail).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale pre-retry poll after the post-retry refresh completes', async () => {
    vi.useFakeTimers();
    let resolveStaleDlq:
      ((value: { items: DashboardDlqItem[]; nextCursor: string | null }) => void) | undefined;
    const staleDlq = new Promise<{ items: DashboardDlqItem[]; nextCursor: string | null }>(
      (resolve) => {
        resolveStaleDlq = resolve;
      },
    );
    const dlq = vi
      .fn<DashboardClient['dlq']>()
      .mockResolvedValueOnce({ items: [dlqItem], nextCursor: null })
      .mockReturnValueOnce(staleDlq)
      .mockResolvedValue({ items: [], nextCursor: null });
    const client = createClient({ dlq });
    await act(async () => {
      render(<App client={client} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('tab', { name: /Dead letter/ }));
    const keyInput = screen.getByLabelText('Operator key');
    fireEvent.change(keyInput, { target: { value: 'memory-only-key' } });
    fireEvent.submit(keyInput.closest('form')!);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(dlq).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Dead-letter queue is clear')).toBeInTheDocument();

    await act(async () => {
      resolveStaleDlq?.({ items: [dlqItem], nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Dead-letter queue is clear')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows empty and error states without exposing request details', async () => {
    const emptyClient = createClient({
      notifications: vi.fn(async () => ({ items: [], nextCursor: null })),
    });
    const { unmount } = render(<App client={emptyClient} />);
    expect(await screen.findByText('No notifications yet')).toBeInTheDocument();
    unmount();

    render(
      <App
        client={createClient({
          notifications: vi.fn(async () => {
            throw new Error('private recipient and raw error');
          }),
        })}
      />,
    );
    expect(await screen.findByText('Unable to load recent notifications.')).toBeInTheDocument();
    expect(screen.queryByText(/private recipient/)).not.toBeInTheDocument();
  });

  it.each([
    ['retried', 'Delivery accepted for retry.'],
    ['removed', 'Delivery was removed from the queue.'],
    ['ineligible', 'Delivery is no longer eligible for retry.'],
    ['unauthorized', 'Operator key rejected. Retry controls were locked.'],
  ] as const)(
    'handles the %s retry outcome and keeps the key in component memory',
    async (outcome, message) => {
      const retry = vi.fn<DashboardClient['retry']>().mockResolvedValue(outcome);
      const client = createClient({ retry });
      render(<App client={client} />);
      fireEvent.click(await screen.findByRole('tab', { name: /Dead letter/ }));
      const summaryCalls = vi.mocked(client.summary).mock.calls.length;
      const notificationCalls = vi.mocked(client.notifications).mock.calls.length;
      const dlqCalls = vi.mocked(client.dlq).mock.calls.length;
      const keyInput = screen.getByLabelText('Operator key');
      fireEvent.change(keyInput, { target: { value: 'memory-only-key' } });
      fireEvent.submit(keyInput.closest('form')!);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      await waitFor(() =>
        expect(screen.getByText(message, { selector: '.retry-notice' })).toBeInTheDocument(),
      );
      expect(retry).toHaveBeenCalledWith('delivery-dlq', 'memory-only-key');
      await waitFor(() => {
        expect(client.summary).toHaveBeenCalledTimes(summaryCalls + 1);
        expect(client.notifications).toHaveBeenCalledTimes(notificationCalls + 1);
        expect(client.dlq).toHaveBeenCalledTimes(dlqCalls + 1);
      });
      if (outcome === 'unauthorized') {
        expect(screen.getByLabelText('Operator key')).toHaveValue('');
        expect(screen.getByText('Retry controls locked')).toBeInTheDocument();
      }
    },
  );

  it('clears the in-memory key when the operator locks controls', async () => {
    render(<App client={createClient()} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Dead letter/ }));
    const input = screen.getByLabelText('Operator key');
    fireEvent.change(input, { target: { value: 'temporary-key' } });
    fireEvent.submit(input.closest('form')!);
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));

    expect(screen.getByLabelText('Operator key')).toHaveValue('');
    expect(screen.getByText('Retry controls locked')).toBeInTheDocument();
  });

  it('starts locked with an empty key after a remount', async () => {
    const client = createClient();
    const first = render(<App client={client} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Dead letter/ }));
    const input = screen.getByLabelText('Operator key');
    fireEvent.change(input, { target: { value: 'temporary-key' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByText('Retry controls unlocked')).toBeInTheDocument();
    first.unmount();

    render(<App client={createClient()} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Dead letter/ }));
    expect(screen.getByText('Retry controls locked')).toBeInTheDocument();
    expect(screen.getByLabelText('Operator key')).toHaveValue('');
  });
});
