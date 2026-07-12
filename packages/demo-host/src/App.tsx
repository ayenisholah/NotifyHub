import { useCallback, useEffect, useState } from 'react';
import { NotifyHubInbox } from '@notifyhub/widget';

type TokenState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; token: string };

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
          {token.status === 'ready' && <NotifyHubInbox userToken={token.token} />}
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
          <button type="button" className="primary">
            + New project
          </button>
        </section>
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
