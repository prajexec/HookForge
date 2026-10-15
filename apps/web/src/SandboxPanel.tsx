import { useEffect, useState } from "react";

import { errorMessage, projectPath, type ApiClient } from "./api.js";
import type { Endpoint, SandboxRequest } from "./types.js";

interface SandboxPanelProps {
  api: ApiClient;
  projectId: string;
  onChanged: () => void;
}

interface SandboxResponse {
  endpoint: Endpoint;
  signingSecret: string;
  sandbox: { publicUrl: string };
}

export function SandboxPanel({ api, projectId, onChanged }: SandboxPanelProps) {
  const [sandbox, setSandbox] = useState<SandboxResponse | null>(null);
  const [requests, setRequests] = useState<SandboxRequest[]>([]);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createSandbox() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await api.request<SandboxResponse>(
        `${projectPath(projectId)}/sandbox/endpoints`,
        { method: "POST", body: {} },
      );
      setSandbox(response);
      setRequests([]);
      onChanged();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  async function refresh() {
    if (!sandbox || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api.request<{ requests: SandboxRequest[] }>(
        `${projectPath(projectId)}/endpoints/${encodeURIComponent(sandbox.endpoint.id)}/sandbox/requests?limit=100`,
      );
      setRequests(response.requests);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }

  async function clear() {
    if (!sandbox || pending) return;
    setPending(true);
    setError(null);
    try {
      await api.request<undefined>(
        `${projectPath(projectId)}/endpoints/${encodeURIComponent(sandbox.endpoint.id)}/sandbox/requests`,
        { method: "DELETE" },
      );
      setRequests([]);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    setSandbox(null);
    setRequests([]);
    setError(null);
  }, [projectId]);

  return (
    <section className="panel" aria-labelledby="sandbox-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Developer sandbox</p>
          <h2 id="sandbox-heading">Inspect a local receiver</h2>
        </div>
        <button
          className="button ghost"
          type="button"
          onClick={() => void createSandbox()}
          disabled={pending}
        >
          {sandbox ? "Create another" : "Create sandbox"}
        </button>
      </div>
      <p className="muted">
        Captures are kept in memory by the local receiver and are safe to
        discard.
      </p>
      {sandbox ? (
        <>
          <div className="notice">
            <strong>Receiver URL</strong>
            <code>{sandbox.sandbox.publicUrl}</code>
            <small>Signing secret (shown once):</small>
            <code>{sandbox.signingSecret}</code>
          </div>
          <div className="actions">
            <button
              className="button ghost"
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh captures"}
            </button>
            <button
              className="button ghost"
              type="button"
              onClick={() => void clear()}
              disabled={pending}
            >
              Clear captures
            </button>
          </div>
          {requests.length === 0 ? (
            <p className="empty">
              No requests captured yet. Publish an event to see it here.
            </p>
          ) : (
            <div className="event-list">
              {requests.map((request) => (
                <details
                  className="event-row"
                  key={request.id ?? `${request.receivedAt}-${request.method}`}
                >
                  <summary>
                    <strong>{request.method}</strong>
                    <time dateTime={request.receivedAt}>
                      {new Date(request.receivedAt).toLocaleString()}
                    </time>
                  </summary>
                  <pre className="code-block">{request.rawBody}</pre>
                  <pre className="code-block">
                    {JSON.stringify(request.headers, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </>
      ) : null}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
