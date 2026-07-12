import { describe, expect, it, vi } from 'vitest';

import { renderInAppTemplate } from '../packages/workers/src/index.js';

describe('in-app template rendering', () => {
  it('renders nested user and payload values as plain text', () => {
    expect(
      renderInAppTemplate({
        event: 'comment.created',
        subject: '{{user.email}} commented',
        body: '{{payload.author.name}} wrote {{payload.text}}',
        context: {
          user: { email: 'reader@example.test' },
          payload: { author: { name: 'Ada' }, text: '<hello>' },
        },
      }),
    ).toEqual({ title: 'reader@example.test commented', body: 'Ada wrote <hello>' });
  });

  it('falls back to the event name when subject is absent', () => {
    expect(
      renderInAppTemplate({
        event: 'mention.created',
        subject: null,
        body: 'Mention',
        context: {},
      }),
    ).toEqual({ title: 'mention.created', body: 'Mention' });
  });

  it('renders missing values empty and reports their field and path once', () => {
    const onWarning = vi.fn();
    expect(
      renderInAppTemplate({
        event: 'comment.created',
        subject: '{{payload.missing}} {{payload.missing}}',
        body: '{{user.name}}',
        context: { payload: {}, user: {} },
        onWarning,
      }),
    ).toEqual({ title: ' ', body: '' });
    expect(onWarning.mock.calls.map(([warning]) => warning)).toEqual([
      { field: 'title', path: 'payload.missing' },
      { field: 'body', path: 'user.name' },
    ]);
  });
});
