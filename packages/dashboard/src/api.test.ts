import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDashboardClient, DashboardApiError } from './api.js';

const delivery = {
  deliveryId: 'delivery-1',
  channel: 'EMAIL',
  status: 'SENT',
  attempts: 1,
  createdAt: '2026-07-13T10:00:00.000Z',
  updatedAt: '2026-07-13T10:00:02.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('dashboard API client', () => {
  it('allowlists and parses a complete notification detail response', async () => {
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
      void request;
      return Response.json({
        notificationId: 'notification-1',
        event: 'comment.created',
        status: 'ROUTED',
        reason: null,
        createdAt: '2026-07-13T10:00:00.000Z',
        userId: 'must-not-enter-browser-state',
        payload: { private: true },
        deliveries: [
          {
            ...delivery,
            provider: 'private-provider',
            lastError: 'private raw error',
            timeline: [
              {
                status: 'QUEUED',
                createdAt: '2026-07-13T10:00:00.000Z',
                reason: 'immediate',
                errorClassification: null,
                detail: { private: true },
              },
              {
                status: 'SENT',
                createdAt: '2026-07-13T10:00:02.000Z',
                reason: 'email_sent',
                errorClassification: null,
              },
            ],
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createDashboardClient('/api').notification('notification-1');

    expect(result).toEqual({
      notificationId: 'notification-1',
      event: 'comment.created',
      status: 'ROUTED',
      reason: null,
      createdAt: '2026-07-13T10:00:00.000Z',
      deliveries: [
        {
          ...delivery,
          timeline: [
            {
              status: 'QUEUED',
              createdAt: '2026-07-13T10:00:00.000Z',
              reason: 'immediate',
              errorClassification: null,
            },
            {
              status: 'SENT',
              createdAt: '2026-07-13T10:00:02.000Z',
              reason: 'email_sent',
              errorClassification: null,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/userId|payload|provider|lastError|private raw/);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/dashboard/notifications/notification-1',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('rejects malformed public responses with a generic client error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ sentToday: -1 })),
    );

    await expect(createDashboardClient().summary()).rejects.toEqual(
      expect.objectContaining<Partial<DashboardApiError>>({
        name: 'DashboardApiError',
        message: 'NotifyHub returned an invalid response.',
      }),
    );
  });

  it.each([
    [202, 'retried'],
    [200, 'retried'],
    [401, 'unauthorized'],
    [404, 'removed'],
    [409, 'ineligible'],
  ] as const)(
    'maps retry status %s and sends the key only in the bearer header',
    async (status, outcome) => {
      const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>) => {
        void request;
        return new Response(null, { status });
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        createDashboardClient('/api').retry('delivery/1', 'memory-only-key'),
      ).resolves.toBe(outcome);
      const [requestUrl, init] = fetchMock.mock.calls[0]!;
      expect(requestUrl).toBe('/api/v1/dlq/delivery%2F1/retry');
      expect(requestUrl).not.toContain('memory-only-key');
      expect(init).toEqual(
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer memory-only-key' },
        }),
      );
    },
  );
});
