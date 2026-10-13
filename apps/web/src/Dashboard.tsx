import { useEffect, useState, type FormEvent } from "react";

import { errorMessage, projectPath, type ApiClient } from "./api.js";
import { EndpointsPanel } from "./EndpointsPanel.js";
import type {
  Delivery,
  DeliveryDetail,
  EventSummary,
  Overview,
  Project,
  Session,
} from "./types.js";

interface DashboardProps {
  api: ApiClient;
  session: Session;
  onLogout: () => void;
}

interface ProjectsResponse {
  projects: Project[];
}

interface OverviewResponse {
  overview: Overview;
}

interface EventsResponse {
  events: EventSummary[];
  pagination: { limit: number; nextCursor: string | null };
}

interface DeliveriesResponse {
  deliveries: Delivery[];
  pagination: { limit: number; nextCursor: string | null };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(value: string): string {
  return value.replace("_", " ");
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{statusLabel(status)}</span>;
}

export function Dashboard({ api, session, onLogout }: DashboardProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [reloadProjects, setReloadProjects] = useState(0);
  const selectedProject =
    projects.find((project) => project.id === projectId) ?? null;

  useEffect(() => {
    const controller = new AbortController();
    setProjectsLoading(true);
    setProjectsError(null);
    void api
      .request<ProjectsResponse>("/api/v1/projects?limit=100", {
        signal: controller.signal,
      })
      .then((response) => {
        setProjects(response.projects);
        setProjectId((current) =>
          current && response.projects.some((project) => project.id === current)
            ? current
            : (response.projects[0]?.id ?? null),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProjectsError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setProjectsLoading(false);
      });

    return () => controller.abort();
  }, [api, reloadProjects]);

  function handleProjectCreated(project: Project) {
    setProjects((current) => [project, ...current]);
    setProjectId(project.id);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          <div>
            <p className="eyebrow">HookForge</p>
            <p className="brand-subtitle">Webhook control plane</p>
          </div>
        </div>
        <div className="account-actions">
          <span className="account-email">{session.user.email}</span>
          <button className="button ghost" type="button" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>

      {projectsLoading ? (
        <div className="loading-block" role="status">
          Loading projects…
        </div>
      ) : projectsError ? (
        <section className="panel error-panel" role="alert">
          <h1>Could not load projects</h1>
          <p>{projectsError}</p>
          <button
            className="button"
            type="button"
            onClick={() => setReloadProjects((value) => value + 1)}
          >
            Retry
          </button>
        </section>
      ) : projects.length === 0 ? (
        <ProjectEmptyState api={api} onCreated={handleProjectCreated} />
      ) : (
        <>
          <section className="workspace-heading">
            <div>
              <p className="eyebrow">Project workspace</p>
              <h1>{selectedProject?.name ?? "Select a project"}</h1>
              <p className="lede compact">
                Publish events, watch delivery health, and manage receivers from
                one place.
              </p>
            </div>
            <label className="project-select-label">
              <span>Project</span>
              <select
                value={projectId ?? ""}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </section>
          {selectedProject ? (
            <ProjectWorkspace
              key={selectedProject.id}
              api={api}
              project={selectedProject}
            />
          ) : null}
        </>
      )}
    </main>
  );
}

function ProjectEmptyState({
  api,
  onCreated,
}: {
  api: ApiClient;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await api.request<{ project: Project }>(
        "/api/v1/projects",
        {
          method: "POST",
          body: { name: name.trim() },
        },
      );
      onCreated(response.project);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="empty-hero panel">
      <span className="hero-orbit" aria-hidden="true" />
      <p className="eyebrow">First deployment</p>
      <h1>Create your first project.</h1>
      <p className="lede">
        Projects keep events, receivers, signing secrets, and delivery history
        isolated.
      </p>
      <form className="inline-form narrow-form" onSubmit={createProject}>
        <label>
          Project name
          <input
            autoFocus
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder="Payments platform"
            required
          />
        </label>
        <button className="button" type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create project"}
        </button>
      </form>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ProjectWorkspace({
  api,
  project,
}: {
  api: ApiClient;
  project: Project;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewReload, setOverviewReload] = useState(0);
  const [eventReload, setEventReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setOverview(null);
    setOverviewError(null);
    void api
      .request<OverviewResponse>(`${projectPath(project.id)}/overview`, {
        signal: controller.signal,
      })
      .then((response) => setOverview(response.overview))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setOverviewError(errorMessage(error));
      });
    return () => controller.abort();
  }, [api, project.id, overviewReload]);

  function changed() {
    setOverviewReload((value) => value + 1);
    setEventReload((value) => value + 1);
  }

  return (
    <div className="workspace-grid">
      <section className="main-column">
        <OverviewCards
          overview={overview}
          error={overviewError}
          onRetry={() => setOverviewReload((value) => value + 1)}
        />
        <EventComposer api={api} projectId={project.id} onPublished={changed} />
        <EventList
          api={api}
          projectId={project.id}
          reloadVersion={eventReload}
        />
        <DeliveriesPanel
          api={api}
          projectId={project.id}
          reloadVersion={eventReload}
        />
      </section>
      <aside className="side-column">
        <EndpointsPanel api={api} projectId={project.id} onChanged={changed} />
        <ReceiverNote />
      </aside>
    </div>
  );
}

function OverviewCards({
  overview,
  error,
  onRetry,
}: {
  overview: Overview | null;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="error" role="alert">
        {error}{" "}
        <button className="button link-button" type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (!overview)
    return (
      <div className="skeleton-grid" aria-label="Loading project overview">
        <span />
        <span />
        <span />
        <span />
      </div>
    );
  const totalDeliveries = Object.values(overview.deliveries).reduce(
    (sum, count) => sum + count,
    0,
  );
  return (
    <section aria-label="Project overview" className="overview-grid">
      <MetricCard
        label="Events"
        value={overview.events}
        detail="accepted by this project"
        tone="blue"
      />
      <MetricCard
        label="Endpoints"
        value={overview.endpoints.active}
        detail={`${overview.endpoints.paused} paused · ${overview.endpoints.disabled} disabled`}
        tone="violet"
      />
      <MetricCard
        label="Delivered"
        value={overview.deliveries.delivered}
        detail={`${totalDeliveries} total delivery records`}
        tone="green"
      />
      <MetricCard
        label="Needs attention"
        value={overview.deliveries.failed}
        detail={`${overview.deliveries.pending} pending · ${overview.deliveries.in_flight} in flight`}
        tone="orange"
      />
    </section>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  tone: string;
}) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
      <small>{detail}</small>
    </article>
  );
}

function EventComposer({
  api,
  projectId,
  onPublished,
}: {
  api: ApiClient;
  projectId: string;
  onPublished: () => void;
}) {
  const [eventType, setEventType] = useState("payment.created");
  const [payload, setPayload] = useState('{\n  "id": "example"\n}');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      setError("Payload must be valid JSON.");
      return;
    }
    if (pending) return;
    setPending(true);
    try {
      const result = await api.request<{
        event: EventSummary;
        deliveriesScheduled: number;
        deduplicated: boolean;
      }>(`${projectPath(projectId)}/events`, {
        method: "POST",
        body: { eventType: eventType.trim(), payload: parsedPayload },
        idempotencyKey: crypto.randomUUID(),
      });
      setMessage(
        `${result.event.id} accepted; ${result.deliveriesScheduled} delivery${result.deliveriesScheduled === 1 ? "" : "ies"} scheduled.`,
      );
      onPublished();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel composer" aria-labelledby="publish-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Ingestion</p>
          <h2 id="publish-heading">Publish an event</h2>
        </div>
        <span className="live-pill">
          <span />
          async
        </span>
      </div>
      <form onSubmit={publish} className="composer-form">
        <label>
          Event type
          <input
            value={eventType}
            onChange={(event) => setEventType(event.target.value)}
            maxLength={100}
            required
            disabled={pending}
          />
        </label>
        <label>
          JSON payload
          <textarea
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            rows={7}
            spellCheck={false}
            required
            disabled={pending}
          />
        </label>
        <div className="composer-footer">
          <span className="muted">
            Persisted before downstream delivery begins.
          </span>
          <button className="button" type="submit" disabled={pending}>
            {pending ? "Publishing…" : "Publish event"}
          </button>
        </div>
      </form>
      {message ? (
        <div className="success" role="status">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

function EventList({
  api,
  projectId,
  reloadVersion,
}: {
  api: ApiClient;
  projectId: string;
  reloadVersion: number;
}) {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [eventType, setEventType] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setEvents([]);
    setCursor(null);
    void api
      .request<EventsResponse>(
        `${projectPath(projectId)}/events?limit=5${eventType ? `&eventType=${encodeURIComponent(eventType)}` : ""}`,
        { signal: controller.signal },
      )
      .then((response) => {
        setEvents(response.events);
        setCursor(response.pagination.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, projectId, reloadVersion, eventType]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await api.request<EventsResponse>(
        `${projectPath(projectId)}/events?limit=5&cursor=${encodeURIComponent(cursor)}${eventType ? `&eventType=${encodeURIComponent(eventType)}` : ""}`,
      );
      setEvents((current) => [...current, ...response.events]);
      setCursor(response.pagination.nextCursor);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="events-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Event stream</p>
          <h2 id="events-heading">Recent events</h2>
        </div>
        <label className="compact-label">
          Filter type
          <input
            value={eventType}
            onChange={(event) => setEventType(event.target.value)}
            placeholder="All event types"
          />
        </label>
      </div>
      {loading ? (
        <p className="muted" role="status">
          Loading events…
        </p>
      ) : error && events.length === 0 ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : events.length === 0 ? (
        <p className="empty">No events match this filter.</p>
      ) : (
        <>
          <div className="event-list">
            {events.map((event) => (
              <div className="event-row" key={event.id}>
                <span className="event-icon" aria-hidden="true">
                  ↗
                </span>
                <div>
                  <strong>{event.eventType}</strong>
                  <small>{event.id}</small>
                </div>
                <time dateTime={event.createdAt}>
                  {formatDate(event.createdAt)}
                </time>
              </div>
            ))}
          </div>
          {error ? (
            <div className="error" role="alert">
              {error}
            </div>
          ) : null}
          {cursor ? (
            <button
              className="button ghost full-button"
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more events"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function DeliveriesPanel({
  api,
  projectId,
  reloadVersion,
}: {
  api: ApiClient;
  projectId: string;
  reloadVersion: number;
}) {
  const [status, setStatus] = useState("");
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DeliveryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSelected(null);
    setCursor(null);
    setDeliveries([]);
    const query = status ? `&status=${status}` : "";
    void api
      .request<DeliveriesResponse>(
        `${projectPath(projectId)}/deliveries?limit=10${query}`,
        { signal: controller.signal },
      )
      .then((response) => {
        setDeliveries(response.deliveries);
        setCursor(response.pagination.nextCursor);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, projectId, reloadVersion, status]);

  async function showDetail(delivery: Delivery) {
    setDetailLoading(true);
    setError(null);
    try {
      setSelected(
        await api.request<DeliveryDetail>(
          `${projectPath(projectId)}/deliveries/${encodeURIComponent(delivery.id)}`,
        ),
      );
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setDetailLoading(false);
    }
  }

  async function replay() {
    if (!selected || actionPending) return;
    setActionPending(true);
    setError(null);
    try {
      const result = await api.request<{ delivery: Delivery }>(
        `${projectPath(projectId)}/deliveries/${encodeURIComponent(selected.delivery.id)}/replay`,
        { method: "POST" },
      );
      setDeliveries((current) => [result.delivery, ...current]);
      setSelected(null);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setActionPending(false);
    }
  }

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api.request<DeliveriesResponse>(
        `${projectPath(projectId)}/deliveries?limit=10&cursor=${encodeURIComponent(cursor)}${status ? `&status=${status}` : ""}`,
      );
      setDeliveries((current) => [...current, ...response.deliveries]);
      setCursor(response.pagination.nextCursor);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="deliveries-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Reliability</p>
          <h2 id="deliveries-heading">Delivery activity</h2>
        </div>
        <label className="compact-label">
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
            <option value="in_flight">In flight</option>
          </select>
        </label>
      </div>
      {error && !selected ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {loading && deliveries.length === 0 ? (
        <p className="muted" role="status">
          Loading deliveries…
        </p>
      ) : !loading && deliveries.length === 0 ? (
        <p className="empty">No deliveries match this filter.</p>
      ) : (
        <>
          <div className="delivery-list">
            {deliveries.map((delivery) => (
              <button
                className="delivery-row"
                key={delivery.id}
                type="button"
                onClick={() => void showDetail(delivery)}
              >
                <span>
                  <strong>{delivery.eventType}</strong>
                  <small>
                    {delivery.endpoint.name} · attempt {delivery.attemptCount}
                  </small>
                </span>
                <span className="delivery-meta">
                  <StatusBadge status={delivery.status} />
                  <time>{formatDate(delivery.createdAt)}</time>
                </span>
              </button>
            ))}
          </div>
          {cursor ? (
            <button
              className="button ghost full-button"
              type="button"
              onClick={() => void loadMore()}
              disabled={loading}
            >
              {loading ? "Loading…" : "Load more deliveries"}
            </button>
          ) : null}
        </>
      )}
      {selected ? (
        <DeliveryDetailView
          detail={selected}
          loading={detailLoading}
          actionPending={actionPending}
          error={error}
          onReplay={() => void replay()}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}

function DeliveryDetailView({
  detail,
  loading,
  actionPending,
  error,
  onReplay,
  onClose,
}: {
  detail: DeliveryDetail;
  loading: boolean;
  actionPending: boolean;
  error: string | null;
  onReplay: () => void;
  onClose: () => void;
}) {
  return (
    <div className="detail-drawer" role="dialog" aria-label="Delivery detail">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Delivery detail</p>
          <h3>{detail.delivery.eventType}</h3>
        </div>
        <button className="button ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="detail-grid">
        <span>
          Status
          <strong>
            <StatusBadge status={detail.delivery.status} />
          </strong>
        </span>
        <span>
          Endpoint<strong>{detail.delivery.endpoint.name}</strong>
        </span>
        <span>
          HTTP status
          <strong>{detail.delivery.lastHttpStatusCode ?? "—"}</strong>
        </span>
        <span>
          Attempts<strong>{detail.delivery.attemptCount}</strong>
        </span>
      </div>
      <div className="detail-actions">
        {detail.delivery.status === "failed" ? (
          <button
            className="button"
            type="button"
            onClick={onReplay}
            disabled={actionPending}
          >
            {actionPending ? "Replaying…" : "Replay failed delivery"}
          </button>
        ) : null}
        {loading ? <span className="muted">Refreshing detail…</span> : null}
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      <h4>Payload</h4>
      <pre className="code-block">
        {JSON.stringify(detail.eventPayload, null, 2)}
      </pre>
      <h4>Attempt timeline</h4>
      {detail.attempts.length === 0 ? (
        <p className="muted">No attempts recorded yet.</p>
      ) : (
        <ol className="timeline">
          {detail.attempts.map((attempt) => (
            <li key={attempt.id}>
              <div>
                <strong>Attempt {attempt.attemptNumber}</strong>
                <StatusBadge status={attempt.outcome} />
              </div>
              <small>
                {formatDate(attempt.requestAt)} ·{" "}
                {attempt.httpStatusCode ?? "network error"} ·{" "}
                {attempt.responseDurationMs ?? "—"} ms
              </small>
              {attempt.responseExcerpt ? (
                <p>{attempt.responseExcerpt}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ReceiverNote() {
  return (
    <section className="note-card">
      <span className="note-icon" aria-hidden="true">
        ✦
      </span>
      <div>
        <strong>Build for retries</strong>
        <p>
          Receivers should verify the timestamped signature and deduplicate by
          event ID before applying side effects.
        </p>
      </div>
    </section>
  );
}
