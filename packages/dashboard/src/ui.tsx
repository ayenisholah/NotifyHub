import { useEffect, useRef, type FormEvent, type RefObject } from 'react';

import type {
  DashboardDlqItem,
  DashboardNotificationDetail,
  DashboardNotificationListItem,
  DashboardSummary,
  DeliveryStatus,
} from './types.js';

export interface PageView<T> {
  items: T[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export interface DetailView {
  data: DashboardNotificationDetail | null;
  loading: boolean;
  error: string | null;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatTimestamp(value: string): string {
  return dateFormatter.format(new Date(value));
}

function label(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function channelLabel(value: string): string {
  return value === 'IN_APP' ? 'in-app' : value.toLowerCase();
}

function statusClass(status: string): string {
  return `status-${status.toLowerCase().replaceAll('_', '-')}`;
}

export function StatusChip({
  status,
  channel,
  attempts,
}: {
  status: DeliveryStatus;
  channel?: string;
  attempts?: number;
}) {
  return (
    <span className={`status-chip ${statusClass(status)}`}>
      <span className="status-dot" aria-hidden="true" />
      {channel === undefined
        ? label(status)
        : `${channelLabel(channel)} · ${status === 'RETRYING' ? 'retrying' : label(status)}`}
      {status === 'RETRYING' && attempts !== undefined ? ` ${attempts}` : ''}
    </span>
  );
}

const summaryCards: Array<{
  key: keyof DashboardSummary;
  label: string;
  hint: string;
}> = [
  { key: 'sentToday', label: 'Sent today', hint: 'Since 00:00 UTC' },
  { key: 'inFlight', label: 'In flight', hint: 'Queued, scheduled, processing, or retrying' },
  { key: 'failed', label: 'Failed', hint: 'Awaiting resolution' },
  { key: 'dlq', label: 'DLQ', hint: 'Dead-lettered' },
];

export function SummaryGrid({
  summary,
  loading,
}: {
  summary: DashboardSummary | null;
  loading: boolean;
}) {
  return (
    <section className="summary-grid" aria-label="Delivery summary" aria-busy={loading}>
      {summaryCards.map((card) => (
        <article className={`summary-card summary-${card.key}`} key={card.key}>
          <div className="summary-label">
            <span>{card.label}</span>
            <span className="summary-pulse" aria-hidden="true" />
          </div>
          <strong>{summary === null ? '—' : summary[card.key].toLocaleString()}</strong>
          <small>{card.hint}</small>
        </article>
      ))}
    </section>
  );
}

export function NotificationTable({
  page,
  onOpen,
  onLoadMore,
}: {
  page: PageView<DashboardNotificationListItem>;
  onOpen: (item: DashboardNotificationListItem, trigger: HTMLButtonElement) => void;
  onLoadMore: () => void;
}) {
  if (page.loading && page.items.length === 0)
    return <LoadingState label="Loading recent notifications…" />;
  if (page.error !== null && page.items.length === 0) return <ErrorState message={page.error} />;
  if (page.items.length === 0)
    return (
      <EmptyState
        title="No notifications yet"
        detail="Activity for the configured demo account will appear here."
      />
    );

  return (
    <>
      {page.error !== null && <InlineError message={page.error} />}
      <div className="table-scroll">
        <table>
          <caption className="sr-only">Recent demo-account notifications</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col">Lifecycle</th>
              <th scope="col">Channels</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item) => (
              <tr key={item.notificationId}>
                <td data-label="Time">
                  <time dateTime={item.createdAt}>{formatTimestamp(item.createdAt)}</time>
                </td>
                <td data-label="Event">
                  <code className="event-chip">{item.event}</code>
                </td>
                <td data-label="Lifecycle">
                  <span className={`notification-status ${statusClass(item.status)}`}>
                    {label(item.status)}
                  </span>
                  {item.reason !== null && (
                    <small className="safe-detail">{label(item.reason)}</small>
                  )}
                </td>
                <td data-label="Channels">
                  <div className="chip-list">
                    {item.deliveries.length === 0 ? (
                      <span className="muted">No deliveries</span>
                    ) : (
                      item.deliveries.map((delivery) => (
                        <StatusChip
                          key={delivery.deliveryId}
                          status={delivery.status}
                          channel={delivery.channel}
                          attempts={delivery.attempts}
                        />
                      ))
                    )}
                  </div>
                </td>
                <td className="action-cell">
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`View details for ${item.event}`}
                    onClick={(event) => onOpen(item, event.currentTarget)}
                  >
                    <span aria-hidden="true">→</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.nextCursor !== null && (
        <div className="pagination-row">
          <button
            className="secondary-button"
            type="button"
            disabled={page.loadingMore}
            onClick={onLoadMore}
          >
            {page.loadingMore ? 'Loading…' : 'Load older notifications'}
          </button>
        </div>
      )}
    </>
  );
}

export function DlqTable({
  page,
  unlocked,
  retryingId,
  onRetry,
  onLoadMore,
}: {
  page: PageView<DashboardDlqItem>;
  unlocked: boolean;
  retryingId: string | null;
  onRetry: (item: DashboardDlqItem) => void;
  onLoadMore: () => void;
}) {
  if (page.loading && page.items.length === 0)
    return <LoadingState label="Loading dead-letter queue…" />;
  if (page.error !== null && page.items.length === 0) return <ErrorState message={page.error} />;
  if (page.items.length === 0)
    return (
      <EmptyState
        title="Dead-letter queue is clear"
        detail="Deliveries that need operator attention will appear here."
      />
    );

  return (
    <>
      {page.error !== null && <InlineError message={page.error} />}
      <div className="table-scroll">
        <table>
          <caption className="sr-only">Demo-account dead-lettered deliveries</caption>
          <thead>
            <tr>
              <th scope="col">Dead-lettered</th>
              <th scope="col">Event</th>
              <th scope="col">Channel</th>
              <th scope="col">Attempts</th>
              <th scope="col">Classification</th>
              <th scope="col">
                <span className="sr-only">Retry action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item) => (
              <tr key={item.deliveryId}>
                <td data-label="Dead-lettered">
                  <time dateTime={item.updatedAt}>{formatTimestamp(item.updatedAt)}</time>
                </td>
                <td data-label="Event">
                  <code className="event-chip">{item.event}</code>
                </td>
                <td data-label="Channel">
                  <StatusChip status="DLQ" channel={item.channel} />
                </td>
                <td data-label="Attempts">
                  <span className="data-value">{item.attempts}</span>
                </td>
                <td data-label="Classification">
                  {item.errorClassification !== null || item.reason !== null ? (
                    <span className="safe-detail">
                      {item.errorClassification === null
                        ? label(item.reason!)
                        : label(item.errorClassification)}
                    </span>
                  ) : (
                    <span className="muted">Unavailable</span>
                  )}
                </td>
                <td className="action-cell">
                  {unlocked ? (
                    <button
                      className="retry-button"
                      type="button"
                      disabled={retryingId !== null}
                      onClick={() => onRetry(item)}
                    >
                      {retryingId === item.deliveryId ? 'Retrying…' : 'Retry'}
                    </button>
                  ) : (
                    <span className="locked-label">Locked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.nextCursor !== null && (
        <div className="pagination-row">
          <button
            className="secondary-button"
            type="button"
            disabled={page.loadingMore}
            onClick={onLoadMore}
          >
            {page.loadingMore ? 'Loading…' : 'Load older DLQ entries'}
          </button>
        </div>
      )}
    </>
  );
}

export function OperatorLock({
  unlocked,
  draftKey,
  onDraftKey,
  onUnlock,
  onLock,
}: {
  unlocked: boolean;
  draftKey: string;
  onDraftKey: (value: string) => void;
  onUnlock: (event: FormEvent<HTMLFormElement>) => void;
  onLock: () => void;
}) {
  return (
    <div className={`operator-lock ${unlocked ? 'unlocked' : ''}`}>
      <div>
        <span className="lock-icon" aria-hidden="true">
          {unlocked ? '●' : '○'}
        </span>
        <strong>{unlocked ? 'Retry controls unlocked' : 'Retry controls locked'}</strong>
        <p>
          {unlocked
            ? 'The key is held only in this browser tab’s memory.'
            : 'Enter the operator key to retry dead-lettered deliveries.'}
        </p>
      </div>
      {unlocked ? (
        <button className="secondary-button" type="button" onClick={onLock}>
          Lock
        </button>
      ) : (
        <form className="unlock-form" onSubmit={onUnlock}>
          <label htmlFor="operator-key">Operator key</label>
          <input
            id="operator-key"
            name="operator-key"
            type="password"
            autoComplete="off"
            value={draftKey}
            onChange={(event) => onDraftKey(event.currentTarget.value)}
          />
          <button className="primary-button" type="submit">
            Unlock
          </button>
        </form>
      )}
    </div>
  );
}

export function DetailDrawer({
  notificationId,
  detail,
  returnFocus,
  onClose,
}: {
  notificationId: string;
  detail: DetailView;
  returnFocus: HTMLButtonElement | null;
  onClose: () => void;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const drawer = drawerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || drawer === null) return;
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      returnFocus?.focus();
    };
  }, [onClose, returnFocus]);

  return (
    <div
      className="drawer-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="detail-drawer"
        ref={drawerRef as RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        aria-describedby="detail-description"
        aria-busy={detail.loading}
      >
        <header className="drawer-header">
          <div>
            <p className="eyebrow">Notification detail</p>
            <h2 id="detail-title">{detail.data?.event ?? 'Delivery timeline'}</h2>
            <p id="detail-description">Ordered lifecycle events grouped by channel.</p>
          </div>
          <button className="close-button" type="button" ref={closeRef} onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span className="sr-only">Close details</span>
          </button>
        </header>
        <div className="drawer-body">
          {detail.loading && detail.data === null && <LoadingState label="Loading timeline…" />}
          {detail.error !== null && <ErrorState message={detail.error} />}
          {detail.data !== null && (
            <>
              <dl className="detail-meta">
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={detail.data.createdAt}>
                      {formatTimestamp(detail.data.createdAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Lifecycle</dt>
                  <dd>{label(detail.data.status)}</dd>
                </div>
                <div>
                  <dt>Notification ID</dt>
                  <dd>
                    <code>{notificationId}</code>
                  </dd>
                </div>
              </dl>
              {detail.data.reason !== null && (
                <p className="reason-callout">
                  <strong>Reason</strong> {label(detail.data.reason)}
                </p>
              )}
              {detail.data.deliveries.length === 0 ? (
                <EmptyState
                  title="No channel deliveries"
                  detail="This notification has no delivery timeline."
                />
              ) : (
                <div className="channel-timelines">
                  {[...detail.data.deliveries]
                    .sort((a, b) => a.channel.localeCompare(b.channel))
                    .map((delivery) => (
                      <section
                        className="channel-timeline"
                        key={delivery.deliveryId}
                        aria-labelledby={`channel-${delivery.deliveryId}`}
                      >
                        <div className="channel-heading">
                          <div>
                            <h3 id={`channel-${delivery.deliveryId}`}>
                              {channelLabel(delivery.channel)}
                            </h3>
                            <span>
                              {delivery.attempts} {delivery.attempts === 1 ? 'attempt' : 'attempts'}
                            </span>
                          </div>
                          <StatusChip status={delivery.status} />
                        </div>
                        <ol className="timeline">
                          {[...delivery.timeline]
                            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
                            .map((entry, index) => (
                              <li key={`${entry.createdAt}-${entry.status}-${index}`}>
                                <span
                                  className={`timeline-marker ${statusClass(entry.status)}`}
                                  aria-hidden="true"
                                />
                                <div>
                                  <div className="timeline-event">
                                    <strong>{label(entry.status)}</strong>
                                    <time dateTime={entry.createdAt}>
                                      {formatTimestamp(entry.createdAt)}
                                    </time>
                                  </div>
                                  {(entry.reason !== null ||
                                    entry.errorClassification !== null) && (
                                    <p>
                                      {entry.reason !== null && <span>{label(entry.reason)}</span>}
                                      {entry.reason !== null &&
                                        entry.errorClassification !== null &&
                                        ' · '}
                                      {entry.errorClassification !== null && (
                                        <span>{label(entry.errorClassification)}</span>
                                      )}
                                    </p>
                                  )}
                                </div>
                              </li>
                            ))}
                        </ol>
                      </section>
                    ))}
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

export function LoadingState({ label: text }: { label: string }) {
  return (
    <div className="state-card loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="state-card error-state" role="alert">
      <span aria-hidden="true">!</span>
      <div>
        <strong>Data unavailable</strong>
        <p>{message}</p>
      </div>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p className="inline-error" role="alert">
      {message} Existing results may be stale.
    </p>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="state-card empty-state">
      <span aria-hidden="true">◇</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}
