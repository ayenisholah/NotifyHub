import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

vi.mock('@notifyhub/widget', () => ({
  NotifyHubInbox: ({ userToken }: { userToken: string }) => <button>Inbox {userToken}</button>,
}));

describe('Acme Projects demo', () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
