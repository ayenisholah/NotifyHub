import { useCallback, useEffect, useState } from 'react';
import { NotifyHubInbox } from '@notifyhub/widget';

type TokenState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; token: string };
type DemoState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent' }
  | { status: 'limited' }
  | { status: 'error' };

const projects = [
  { name: 'Website refresh', detail: '12 of 18 tasks', progress: 67, color: 'violet' },
  { name: 'Mobile application', detail: '8 of 14 tasks', progress: 57, color: 'blue' },
  { name: 'Customer research', detail: '21 of 24 tasks', progress: 88, color: 'green' },
];

async function fetchToken(signal?: AbortSignal): Promise<string> {
  const response = await fetch('/demo/token', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('Token bootstrap failed');
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('token' in body) ||
    typeof body.token !== 'string'
  )
    throw new Error('Invalid token response');
  return body.token;
}

export function App() {
  const [token, setToken] = useState<TokenState>({ status: 'loading' });
  const [demo, setDemo] = useState<DemoState>({ status: 'idle' });
  const loadToken = useCallback((signal?: AbortSignal) => {
    setToken({ status: 'loading' });
    void fetchToken(signal).then(
      (value) => setToken({ status: 'ready', token: value }),
      (error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          setToken({ status: 'error' });
      },
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadToken(controller.signal);
    return () => controller.abort();
  }, [loadToken]);

  const sendDemoNotification = async (): Promise<void> => {
    setDemo({ status: 'sending' });
    try {
      const response = await fetch('/demo/notify', { method: 'POST' });
      if (response.status === 429) {
        setDemo({ status: 'limited' });
        return;
      }
      if (!response.ok) throw new Error('Demo notification failed');
      setDemo({ status: 'sent' });
    } catch {
      setDemo({ status: 'error' });
    }
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="topbar">
        <a className="brand" href="#main" aria-label="Acme Projects home">
          <span aria-hidden="true">A</span> Acme Projects
        </a>
        <nav aria-label="Primary navigation">
          <a className="active" href="#overview">
            Overview
          </a>
          <a href="#projects">Projects</a>
          <a href="#activity">Activity</a>
        </nav>
        <div className="header-actions">
          {token.status === 'ready' && (
            <NotifyHubInbox userToken={token.token} pollIntervalMs={1_000} />
          )}
          {token.status === 'loading' && (
            <span className="token-state" role="status">
              Loading notifications…
            </span>
          )}
          {token.status === 'error' && (
            <span className="token-state" role="alert">
              Notifications unavailable.{' '}
              <button type="button" onClick={() => loadToken()}>
                Retry
              </button>
            </span>
          )}
          <span className="avatar" aria-label="Signed in as Alex Morgan">
            AM
          </span>
        </div>
      </header>
      <main id="main">
        <section className="welcome" id="overview" aria-labelledby="welcome-title">
          <div>
            <p className="eyebrow">Sunday, July 12</p>
            <h1 id="welcome-title">Good morning, Alex.</h1>
            <p>Here’s what’s happening across your projects today.</p>
          </div>
          <button
            type="button"
            className="primary"
            disabled={demo.status === 'sending'}
            onClick={() => void sendDemoNotification()}
          >
            {demo.status === 'sending' ? 'Sending update…' : 'Send demo notification'}
          </button>
        </section>
        <div className="demo-feedback" aria-live="polite">
          {demo.status === 'sent' && 'Update sent. Open the inbox to see it arrive.'}
          {demo.status === 'limited' && 'Demo limit reached. Please wait before trying again.'}
          {demo.status === 'error' && 'The demo update could not be sent. Please try again.'}
        </div>
        <section aria-labelledby="summary-title">
          <h2 id="summary-title">Project summary</h2>
          <div className="project-grid" id="projects">
            {projects.map((project) => (
              <article className="project-card" key={project.name}>
                <span className={`project-icon ${project.color}`} aria-hidden="true">
                  ◆
                </span>
                <h3>{project.name}</h3>
                <p>{project.detail}</p>
                <div
                  className="progress"
                  role="progressbar"
                  aria-label={`${project.name} progress`}
                  aria-valuenow={project.progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${project.progress}%` }} />
                </div>
                <strong>{project.progress}%</strong>
              </article>
            ))}
          </div>
        </section>
        <section className="activity" id="activity" aria-labelledby="activity-title">
          <div className="section-heading">
            <div>
              <h2 id="activity-title">Recent activity</h2>
              <p>Updates from your team</p>
            </div>
            <a href="#activity">View all</a>
          </div>
          <ol>
            <li>
              <span className="activity-avatar blue">NK</span>
              <p>
                <strong>Nina Kim</strong> completed “Finalize homepage copy”
                <time dateTime="2026-07-12T08:15:00+01:00">24 minutes ago</time>
              </p>
            </li>
            <li>
              <span className="activity-avatar green">OS</span>
              <p>
                <strong>Omar Smith</strong> uploaded research-notes.pdf
                <time dateTime="2026-07-12T07:12:00+01:00">1 hour ago</time>
              </p>
            </li>
            <li>
              <span className="activity-avatar violet">JL</span>
              <p>
                <strong>Jamie Lee</strong> commented on “Mobile navigation”
                <time dateTime="2026-07-11T16:30:00+01:00">Yesterday</time>
              </p>
            </li>
          </ol>
        </section>
      </main>
    </div>
  );
}
