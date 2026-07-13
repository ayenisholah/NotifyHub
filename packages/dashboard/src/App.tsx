import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { createDashboardClient, DashboardApiError, type DashboardClient } from './api.js';
import type {
  DashboardDlqItem,
  DashboardDlqListResult,
  DashboardNotificationDetail,
  DashboardNotificationListItem,
  DashboardNotificationListResult,
  DashboardSummary,
} from './types.js';
import {
  DetailDrawer,
  DlqTable,
  NotificationTable,
  OperatorLock,
  SummaryGrid,
  type DetailView,
  type PageView,
} from './ui.js';

const POLL_INTERVAL_MS = 5_000;

type DashboardTab = 'notifications' | 'dlq';

const initialNotificationPage: PageView<DashboardNotificationListItem> = {
  items: [],
  nextCursor: null,
  loading: true,
  loadingMore: false,
  error: null,
};

const initialDlqPage: PageView<DashboardDlqItem> = {
  items: [],
  nextCursor: null,
  loading: true,
  loadingMore: false,
  error: null,
};

const initialDetail: DetailView = { data: null, loading: false, error: null };

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function mergeById<T>(current: T[], incoming: T[], id: (value: T) => string): T[] {
  const merged = new Map(current.map((item) => [id(item), item]));
  for (const item of incoming) merged.set(id(item), item);
  return [...merged.values()];
}

async function collectPages<T>(
  load: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
  pageCount: number,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const items: T[] = [];
  let cursor: string | undefined;
  let nextCursor: string | null = null;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = await load(cursor);
    items.push(...page.items);
    nextCursor = page.nextCursor;
    if (nextCursor === null) break;
    cursor = nextCursor;
  }
  return { items, nextCursor };
}

function timeLabel(value: Date | null): string {
  if (value === null) return 'Connecting';
  return `Updated ${value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

export interface DashboardAppProps {
  apiBaseUrl?: string;
  client?: DashboardClient;
}

export function App({ apiBaseUrl = '', client: injectedClient }: DashboardAppProps) {
  const client = useMemo(
    () => injectedClient ?? createDashboardClient(apiBaseUrl),
    [apiBaseUrl, injectedClient],
  );
  const [activeTab, setActiveTab] = useState<DashboardTab>('notifications');
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [notifications, setNotifications] =
    useState<PageView<DashboardNotificationListItem>>(initialNotificationPage);
  const [dlq, setDlq] = useState<PageView<DashboardDlqItem>>(initialDlqPage);
  const [notificationPageCount, setNotificationPageCount] = useState(1);
  const [dlqPageCount, setDlqPageCount] = useState(1);
  const [selectedNotificationId, setSelectedNotificationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailView>(initialDetail);
  const [operatorKey, setOperatorKey] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState('');
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [liveState, setLiveState] = useState<'live' | 'paused'>('live');
  const [refreshing, setRefreshing] = useState(false);
  const [announcement, setAnnouncement] = useState('Loading dashboard.');
  const selectedIdRef = useRef<string | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const notificationTabRef = useRef<HTMLButtonElement | null>(null);
  const dlqTabRef = useRef<HTMLButtonElement | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const summaryRequestRef = useRef(0);
  const notificationRequestRef = useRef(0);
  const dlqRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const loadSummary = useCallback(
    async (silent = false, signal?: AbortSignal): Promise<boolean> => {
      const requestId = ++summaryRequestRef.current;
      if (!silent) setSummaryLoading(true);
      try {
        const nextSummary = await client.summary(signal);
        if (summaryRequestRef.current !== requestId) return false;
        setSummary(nextSummary);
        setSummaryError(null);
        return true;
      } catch (error) {
        if (isAbort(error) || summaryRequestRef.current !== requestId) return false;
        setSummaryError('Unable to load delivery counters.');
        return false;
      } finally {
        if (summaryRequestRef.current === requestId) setSummaryLoading(false);
      }
    },
    [client],
  );

  const loadNotificationPages = useCallback(
    async (pages: number, silent = false, signal?: AbortSignal): Promise<boolean> => {
      const requestId = ++notificationRequestRef.current;
      if (!silent) setNotifications((current) => ({ ...current, loading: true, error: null }));
      try {
        const page = await collectPages((cursor) => client.notifications(cursor, signal), pages);
        if (notificationRequestRef.current !== requestId) return false;
        setNotifications({
          ...page,
          loading: false,
          loadingMore: false,
          error: null,
        });
        return true;
      } catch (error) {
        if (isAbort(error) || notificationRequestRef.current !== requestId) return false;
        setNotifications((current) => ({
          ...current,
          loading: false,
          loadingMore: false,
          error: 'Unable to load recent notifications.',
        }));
        return false;
      }
    },
    [client],
  );

  const loadDlqPages = useCallback(
    async (pages: number, silent = false, signal?: AbortSignal): Promise<boolean> => {
      const requestId = ++dlqRequestRef.current;
      if (!silent) setDlq((current) => ({ ...current, loading: true, error: null }));
      try {
        const page = await collectPages((cursor) => client.dlq(cursor, signal), pages);
        if (dlqRequestRef.current !== requestId) return false;
        setDlq({ ...page, loading: false, loadingMore: false, error: null });
        return true;
      } catch (error) {
        if (isAbort(error) || dlqRequestRef.current !== requestId) return false;
        setDlq((current) => ({
          ...current,
          loading: false,
          loadingMore: false,
          error: 'Unable to load the dead-letter queue.',
        }));
        return false;
      }
    },
    [client],
  );

  const loadDetail = useCallback(
    async (notificationId: string, silent = false, signal?: AbortSignal): Promise<boolean> => {
      const requestId = ++detailRequestRef.current;
      if (!silent) setDetail({ data: null, loading: true, error: null });
      try {
        const nextDetail: DashboardNotificationDetail = await client.notification(
          notificationId,
          signal,
        );
        if (selectedIdRef.current !== notificationId || detailRequestRef.current !== requestId)
          return false;
        setDetail({ data: nextDetail, loading: false, error: null });
        return true;
      } catch (error) {
        if (
          isAbort(error) ||
          selectedIdRef.current !== notificationId ||
          detailRequestRef.current !== requestId
        )
          return false;
        const missing = error instanceof DashboardApiError && error.status === 404;
        setDetail({
          data: null,
          loading: false,
          error: missing
            ? 'This notification is no longer available.'
            : 'Unable to load the delivery timeline.',
        });
        return false;
      }
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    refreshInFlightRef.current = true;
    refreshControllerRef.current = controller;
    void Promise.all([
      loadSummary(false, controller.signal),
      loadNotificationPages(1, false, controller.signal),
      loadDlqPages(1, false, controller.signal),
    ])
      .then(() => {
        if (!controller.signal.aborted) {
          setLastUpdated(new Date());
          setAnnouncement('Dashboard loaded.');
        }
      })
      .finally(() => {
        if (refreshControllerRef.current === controller) {
          refreshControllerRef.current = null;
          refreshInFlightRef.current = false;
        }
      });
    return () => controller.abort();
  }, [loadDlqPages, loadNotificationPages, loadSummary]);

  const poll = useCallback(async (): Promise<boolean> => {
    if (refreshInFlightRef.current) return false;
    const controller = new AbortController();
    refreshInFlightRef.current = true;
    refreshControllerRef.current = controller;
    const tasks: Array<Promise<boolean>> = [
      loadSummary(true, controller.signal),
      loadNotificationPages(notificationPageCount, true, controller.signal),
      loadDlqPages(dlqPageCount, true, controller.signal),
    ];
    const selectedId = selectedIdRef.current;
    if (selectedId !== null) tasks.push(loadDetail(selectedId, true, controller.signal));
    try {
      await Promise.all(tasks);
      if (!controller.signal.aborted) setLastUpdated(new Date());
      return !controller.signal.aborted;
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        refreshInFlightRef.current = false;
      }
    }
  }, [
    dlqPageCount,
    loadDetail,
    loadDlqPages,
    loadNotificationPages,
    loadSummary,
    notificationPageCount,
  ]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const start = (): void => {
      if (timer === undefined) timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    };
    const visibilityChanged = (): void => {
      if (document.hidden) {
        stop();
        refreshControllerRef.current?.abort();
        setLiveState('paused');
        setAnnouncement('Live updates paused while this page is hidden.');
      } else {
        setLiveState('live');
        setAnnouncement('Page visible. Refreshing dashboard.');
        void poll();
        start();
      }
    };

    if (document.hidden) setLiveState('paused');
    else start();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      stop();
      refreshControllerRef.current?.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [poll]);

  const refreshNow = async (): Promise<void> => {
    setRefreshing(true);
    setAnnouncement('Refreshing dashboard.');
    const refreshed = await poll();
    setRefreshing(false);
    setAnnouncement(
      refreshed ? 'Dashboard refreshed.' : 'A dashboard refresh is already in progress.',
    );
  };

  const loadMoreNotifications = async (): Promise<void> => {
    const cursor = notifications.nextCursor;
    if (cursor === null || notifications.loadingMore) return;
    const requestId = ++notificationRequestRef.current;
    setNotifications((current) => ({ ...current, loadingMore: true, error: null }));
    try {
      const page: DashboardNotificationListResult = await client.notifications(cursor);
      if (notificationRequestRef.current !== requestId) return;
      setNotifications((current) => ({
        items: mergeById(current.items, page.items, (item) => item.notificationId),
        nextCursor: page.nextCursor,
        loading: false,
        loadingMore: false,
        error: null,
      }));
      setNotificationPageCount((count) => count + 1);
      setAnnouncement(`${page.items.length} older notifications loaded.`);
    } catch {
      if (notificationRequestRef.current !== requestId) return;
      setNotifications((current) => ({
        ...current,
        loadingMore: false,
        error: 'Unable to load older notifications.',
      }));
    }
  };

  const loadMoreDlq = async (): Promise<void> => {
    const cursor = dlq.nextCursor;
    if (cursor === null || dlq.loadingMore) return;
    const requestId = ++dlqRequestRef.current;
    setDlq((current) => ({ ...current, loadingMore: true, error: null }));
    try {
      const page: DashboardDlqListResult = await client.dlq(cursor);
      if (dlqRequestRef.current !== requestId) return;
      setDlq((current) => ({
        items: mergeById(current.items, page.items, (item) => item.deliveryId),
        nextCursor: page.nextCursor,
        loading: false,
        loadingMore: false,
        error: null,
      }));
      setDlqPageCount((count) => count + 1);
      setAnnouncement(`${page.items.length} older dead-lettered deliveries loaded.`);
    } catch {
      if (dlqRequestRef.current !== requestId) return;
      setDlq((current) => ({
        ...current,
        loadingMore: false,
        error: 'Unable to load older dead-lettered deliveries.',
      }));
    }
  };

  const openDetail = (item: DashboardNotificationListItem, trigger: HTMLButtonElement): void => {
    detailTriggerRef.current = trigger;
    selectedIdRef.current = item.notificationId;
    setSelectedNotificationId(item.notificationId);
    void loadDetail(item.notificationId);
  };

  const closeDetail = useCallback((): void => {
    detailRequestRef.current += 1;
    selectedIdRef.current = null;
    setSelectedNotificationId(null);
    setDetail(initialDetail);
  }, []);

  const unlock = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draftKey.length === 0) {
      setAnnouncement('Enter an operator key to unlock retry controls.');
      return;
    }
    setOperatorKey(draftKey);
    setDraftKey('');
    setRetryNotice(null);
    setAnnouncement('Retry controls unlocked. The key is held in memory only.');
  };

  const lock = (): void => {
    setOperatorKey(null);
    setDraftKey('');
    setRetryNotice(null);
    setAnnouncement('Retry controls locked and the operator key was cleared.');
  };

  const retry = async (item: DashboardDlqItem): Promise<void> => {
    if (operatorKey === null || retryingId !== null) return;
    setRetryingId(item.deliveryId);
    setRetryNotice(null);
    try {
      const outcome = await client.retry(item.deliveryId, operatorKey);
      if (outcome === 'unauthorized') {
        setOperatorKey(null);
        setDraftKey('');
        setRetryNotice('Operator key rejected. Retry controls were locked.');
      } else if (outcome === 'removed') {
        setRetryNotice('Delivery was removed from the queue.');
      } else if (outcome === 'ineligible') {
        setRetryNotice('Delivery is no longer eligible for retry.');
      } else {
        setRetryNotice('Delivery accepted for retry.');
      }
      setAnnouncement(
        outcome === 'retried'
          ? 'Delivery accepted for retry.'
          : outcome === 'unauthorized'
            ? 'Operator key rejected. Retry controls locked.'
            : outcome === 'removed'
              ? 'Delivery was removed from the queue.'
              : 'Delivery is no longer eligible for retry.',
      );
      refreshControllerRef.current?.abort();
      const selectedId = selectedIdRef.current;
      const refreshes: Array<Promise<boolean>> = [
        loadSummary(true),
        loadNotificationPages(notificationPageCount, true),
        loadDlqPages(dlqPageCount, true),
      ];
      if (selectedId !== null) refreshes.push(loadDetail(selectedId, true));
      await Promise.all(refreshes);
      setLastUpdated(new Date());
    } catch {
      setRetryNotice('Retry could not be completed. Try again.');
      setAnnouncement('Retry could not be completed.');
    } finally {
      setRetryingId(null);
    }
  };

  const moveTabFocus = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: DashboardTab,
  ): void => {
    let next: DashboardTab | null = null;
    if (event.key === 'ArrowRight') next = current === 'notifications' ? 'dlq' : 'notifications';
    if (event.key === 'ArrowLeft') next = current === 'notifications' ? 'dlq' : 'notifications';
    if (event.key === 'Home') next = 'notifications';
    if (event.key === 'End') next = 'dlq';
    if (next === null) return;
    event.preventDefault();
    setActiveTab(next);
    (next === 'notifications' ? notificationTabRef.current : dlqTabRef.current)?.focus();
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#dashboard-content">
        Skip to dashboard content
      </a>
      <header className="topbar">
        <a className="brand" href="/dashboard" aria-label="NotifyHub dashboard home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            NotifyHub <small>Operator</small>
          </span>
        </a>
        <div className="live-controls">
          <span className={`live-indicator ${liveState}`}>
            <span aria-hidden="true" />
            {liveState === 'live' ? 'Live · 5s' : 'Paused'}
          </span>
          <span className="updated-at">{timeLabel(lastUpdated)}</span>
          <button
            className="refresh-button"
            type="button"
            disabled={refreshing}
            aria-label="Refresh dashboard now"
            onClick={() => void refreshNow()}
          >
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </header>

      <main id="dashboard-content">
        <section className="page-heading" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">Synthetic demo account</p>
            <h1 id="page-title">Delivery operations</h1>
            <p>Sanitized notification lifecycle activity across every configured channel.</p>
          </div>
          <span className="read-only-badge">
            <span aria-hidden="true">●</span> Public read-only view
          </span>
        </section>

        {summaryError !== null && (
          <div className="summary-error" role="alert">
            <span>{summaryError}</span>
            <button type="button" onClick={() => void refreshNow()}>
              Try again
            </button>
          </div>
        )}
        <SummaryGrid summary={summary} loading={summaryLoading} />

        <section className="activity-panel" aria-labelledby="activity-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Pipeline activity</p>
              <h2 id="activity-title">
                {activeTab === 'notifications' ? 'Recent notifications' : 'Dead-letter queue'}
              </h2>
            </div>
            <div className="tabs" role="tablist" aria-label="Dashboard views">
              <button
                id="notifications-tab"
                ref={notificationTabRef}
                role="tab"
                type="button"
                aria-selected={activeTab === 'notifications'}
                aria-controls="notifications-panel"
                tabIndex={activeTab === 'notifications' ? 0 : -1}
                onClick={() => setActiveTab('notifications')}
                onKeyDown={(event) => moveTabFocus(event, 'notifications')}
              >
                Recent
              </button>
              <button
                id="dlq-tab"
                ref={dlqTabRef}
                role="tab"
                type="button"
                aria-selected={activeTab === 'dlq'}
                aria-controls="dlq-panel"
                tabIndex={activeTab === 'dlq' ? 0 : -1}
                onClick={() => setActiveTab('dlq')}
                onKeyDown={(event) => moveTabFocus(event, 'dlq')}
              >
                Dead letter <span>{summary?.dlq ?? '—'}</span>
              </button>
            </div>
          </div>

          <div
            id="notifications-panel"
            role="tabpanel"
            aria-labelledby="notifications-tab"
            hidden={activeTab !== 'notifications'}
          >
            <NotificationTable
              page={notifications}
              onOpen={openDetail}
              onLoadMore={() => void loadMoreNotifications()}
            />
          </div>
          <div
            id="dlq-panel"
            role="tabpanel"
            aria-labelledby="dlq-tab"
            hidden={activeTab !== 'dlq'}
          >
            <OperatorLock
              unlocked={operatorKey !== null}
              draftKey={draftKey}
              onDraftKey={setDraftKey}
              onUnlock={unlock}
              onLock={lock}
            />
            {retryNotice !== null && <p className="retry-notice">{retryNotice}</p>}
            <DlqTable
              page={dlq}
              unlocked={operatorKey !== null}
              retryingId={retryingId}
              onRetry={(item) => void retry(item)}
              onLoadMore={() => void loadMoreDlq()}
            />
          </div>
        </section>
      </main>

      <footer>
        <span>NotifyHub pipeline observability</span>
        <span>Times shown in your local timezone · counters use UTC day boundaries</span>
      </footer>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {selectedNotificationId !== null && (
        <DetailDrawer
          notificationId={selectedNotificationId}
          detail={detail}
          returnFocus={detailTriggerRef.current}
          onClose={closeDetail}
        />
      )}
    </div>
  );
}
