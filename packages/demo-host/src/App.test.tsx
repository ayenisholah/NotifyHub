import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

vi.mock('@notifyhub/widget', () => ({
  NotifyHubInbox: ({ userToken }: { userToken: string }) => <button>Inbox {userToken}</button>,
}));

describe('Acme Projects demo', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders accessible navigation, main content, summaries and the real widget position', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'demo-token' }) }),
    );
    render(<App />);
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Project summary' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Inbox demo-token' })).toBeInTheDocument();
    expect(screen.getByText('Recent activity')).toBeInTheDocument();
  });

  it('shows a retry action when token loading fails', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'retry-token' }) });
    vi.stubGlobal('fetch', fetch);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Inbox retry-token' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sends a demo notification and announces success', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      input === '/demo/token'
        ? { ok: true, status: 200, json: async () => ({ token: 'demo-token' }) }
        : { ok: true, status: 202, json: async () => ({ notificationId: 'notification-1' }) },
    );
    vi.stubGlobal('fetch', fetch);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send demo notification' }));
    expect(
      await screen.findByText('Update sent. Open the inbox to see it arrive.'),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/demo/notify', { method: 'POST' });
  });

  it('announces the public demo rate limit', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      input === '/demo/token'
        ? { ok: true, status: 200, json: async () => ({ token: 'demo-token' }) }
        : { ok: false, status: 429 },
    );
    vi.stubGlobal('fetch', fetch);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send demo notification' }));
    expect(
      await screen.findByText('Demo limit reached. Please wait before trying again.'),
    ).toBeInTheDocument();
  });
});
