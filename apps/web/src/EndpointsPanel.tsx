import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { errorMessage, projectPath, type ApiClient } from "./api.js";
import type { Endpoint } from "./types.js";

interface EndpointsResponse {
  endpoints: Endpoint[];
}

interface EndpointResponse {
  endpoint: Endpoint;
}

interface EndpointSecretResponse extends EndpointResponse {
  signingSecret: string;
}

interface EndpointsPanelProps {
  api: ApiClient;
  projectId: string;
  onChanged: () => void;
}

export function EndpointsPanel({
  api,
  projectId,
  onChanged,
}: EndpointsPanelProps) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [search, setSearch] = useState("");
  const [createName, setCreateName] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [createHeaders, setCreateHeaders] = useState("{}");
  const [createPatterns, setCreatePatterns] = useState("*");
  const [editingEndpointId, setEditingEndpointId] = useState<string | null>(
    null,
  );
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editHeaders, setEditHeaders] = useState("{}");
  const [editPatterns, setEditPatterns] = useState("*");
  const [confirmation, setConfirmation] = useState<{
    endpointId: string;
    action: "disable" | "rotate";
  } | null>(null);
  const [signingSecret, setSigningSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const projectIdRef = useRef(projectId);
  const viewScopeRef = useRef(0);

  projectIdRef.current = projectId;

  useEffect(() => {
    mountedRef.current = true;
    setMutationPending(false);
    setMutationError(null);
    setSigningSecret(null);
    setCreateName("");
    setCreateUrl("");
    setCreateHeaders("{}");
    setCreatePatterns("*");
    setEditName("");
    setEditUrl("");
    setEditHeaders("{}");
    setEditPatterns("*");
    setSearch("");

    return () => {
      mountedRef.current = false;
      mutationControllerRef.current?.abort();
      mutationControllerRef.current = null;
    };
  }, [api, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    const scope = ++viewScopeRef.current;
    let active = true;

    setLoading(true);
    setLoadError(null);
    setEndpoints([]);
    setEditingEndpointId(null);
    setConfirmation(null);

    void api
      .request<EndpointsResponse>(
        `${projectPath(projectId)}/endpoints?limit=100`,
        { signal: controller.signal },
      )
      .then((response) => {
        if (!active || scope !== viewScopeRef.current) return;
        setEndpoints(response.endpoints);
      })
      .catch((error: unknown) => {
        if (
          !active ||
          controller.signal.aborted ||
          scope !== viewScopeRef.current
        ) {
          return;
        }
        setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (!active || scope !== viewScopeRef.current) return;
        setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [api, projectId, reloadVersion]);

  const visibleEndpoints = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    if (!normalizedSearch) return endpoints;
    return endpoints.filter((endpoint) =>
      endpoint.name.toLocaleLowerCase().includes(normalizedSearch),
    );
  }, [endpoints, search]);

  const canCommit = (scope: number) =>
    mountedRef.current &&
    scope === viewScopeRef.current &&
    projectIdRef.current === projectId;

  async function runMutation<T>(
    request: (signal: AbortSignal) => Promise<T>,
    onSuccess: (response: T) => void,
  ): Promise<void> {
    if (mutationControllerRef.current || !mountedRef.current) return;

    const controller = new AbortController();
    const scope = viewScopeRef.current;
    mutationControllerRef.current = controller;
    setMutationPending(true);
    setMutationError(null);
    setSigningSecret(null);

    try {
      const response = await request(controller.signal);
      if (!canCommit(scope) || controller.signal.aborted) return;

      onSuccess(response);
      onChanged();
    } catch (error: unknown) {
      if (canCommit(scope) && !controller.signal.aborted) {
        setMutationError(errorMessage(error));
      }
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
      }
      if (canCommit(scope)) setMutationPending(false);
    }
  }

  function beginEdit(endpoint: Endpoint) {
    setMutationError(null);
    setConfirmation(null);
    setEditingEndpointId(endpoint.id);
    setEditName(endpoint.name);
    setEditUrl(endpoint.url);
    setEditHeaders("{}");
    setEditPatterns((endpoint.eventPatterns ?? ["*"]).join(", "));
  }

  function parseHeaders(value: string): Record<string, string> | null {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((item) => typeof item !== "string")
      ) {
        return null;
      }
      return parsed as Record<string, string>;
    } catch {
      return null;
    }
  }

  function parsePatterns(value: string): string[] {
    return value
      .split(",")
      .map((pattern) => pattern.trim())
      .filter(Boolean);
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createName.trim();
    const url = createUrl.trim();
    if (!name || !url) {
      setMutationError("Name and URL are required.");
      return;
    }
    const headers = parseHeaders(createHeaders);
    const eventPatterns = parsePatterns(createPatterns);
    if (!headers || eventPatterns.length === 0) {
      setMutationError(
        "Headers must be a JSON object and at least one event pattern is required.",
      );
      return;
    }

    const body = {
      name,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(eventPatterns.length !== 1 || eventPatterns[0] !== "*"
        ? { eventPatterns }
        : {}),
    };

    void runMutation(
      (signal) =>
        api.request<EndpointSecretResponse>(
          `${projectPath(projectId)}/endpoints`,
          {
            method: "POST",
            body,
            signal,
          },
        ),
      (response) => {
        setEndpoints((current) =>
          [response.endpoint, ...current].slice(0, 100),
        );
        setCreateName("");
        setCreateUrl("");
        setCreateHeaders("{}");
        setCreatePatterns("*");
        setSigningSecret(response.signingSecret);
      },
    );
  }

  function handleEdit(event: FormEvent<HTMLFormElement>, endpointId: string) {
    event.preventDefault();
    const name = editName.trim();
    const url = editUrl.trim();
    if (!name || !url) {
      setMutationError("Name and URL are required.");
      return;
    }
    const headers = parseHeaders(editHeaders);
    const eventPatterns = parsePatterns(editPatterns);
    if (!headers || eventPatterns.length === 0) {
      setMutationError(
        "Headers must be a JSON object and at least one event pattern is required.",
      );
      return;
    }

    const patternsChanged = editPatterns.trim() !== "*";
    const headersChanged = editHeaders.trim() !== "{}";
    void runMutation(
      (signal) =>
        (async () => {
          const endpoint = await api.request<EndpointResponse>(
            `${projectPath(projectId)}/endpoints/${encodeURIComponent(endpointId)}`,
            {
              method: "PATCH",
              body: {
                name,
                url,
                ...(headersChanged ? { headers } : {}),
              },
              signal,
            },
          );
          if (patternsChanged) {
            const subscriptions = await api.request<{ patterns: string[] }>(
              `${projectPath(projectId)}/endpoints/${encodeURIComponent(endpointId)}/subscriptions`,
              { method: "PUT", body: { patterns: eventPatterns }, signal },
            );
            return { ...endpoint, patterns: subscriptions.patterns };
          }
          return endpoint;
        })(),
      (response) => {
        setEndpoints((current) =>
          current.map((endpoint) =>
            endpoint.id === endpointId
              ? {
                  ...response.endpoint,
                  eventPatterns: ("patterns" in response
                    ? response.patterns
                    : undefined) ??
                    endpoint.eventPatterns ?? ["*"],
                }
              : endpoint,
          ),
        );
        setEditingEndpointId(null);
      },
    );
  }

  function changeStatus(endpoint: Endpoint, action: "pause" | "resume") {
    void runMutation(
      (signal) =>
        api.request<EndpointResponse>(
          `${projectPath(projectId)}/endpoints/${encodeURIComponent(endpoint.id)}/${action}`,
          { method: "POST", signal },
        ),
      (response) => {
        setEndpoints((current) =>
          current.map((currentEndpoint) =>
            currentEndpoint.id === response.endpoint.id
              ? response.endpoint
              : currentEndpoint,
          ),
        );
      },
    );
  }

  function disableEndpoint(endpointId: string) {
    void runMutation(
      (signal) =>
        api.request<undefined>(
          `${projectPath(projectId)}/endpoints/${encodeURIComponent(endpointId)}`,
          { method: "DELETE", signal },
        ),
      () => {
        setEndpoints((current) =>
          current.map((endpoint) =>
            endpoint.id === endpointId
              ? { ...endpoint, status: "disabled" }
              : endpoint,
          ),
        );
        setConfirmation(null);
      },
    );
  }

  function rotateSecret(endpointId: string) {
    void runMutation(
      (signal) =>
        api.request<EndpointSecretResponse>(
          `${projectPath(projectId)}/endpoints/${encodeURIComponent(endpointId)}/rotate-secret`,
          { method: "POST", signal },
        ),
      (response) => {
        setEndpoints((current) =>
          current.map((currentEndpoint) =>
            currentEndpoint.id === response.endpoint.id
              ? response.endpoint
              : currentEndpoint,
          ),
        );
        setConfirmation(null);
        setSigningSecret(response.signingSecret);
      },
    );
  }

  return (
    <section className="panel" aria-labelledby="endpoints-heading">
      <div className="section-heading">
        <div>
          <h2 id="endpoints-heading">Endpoints</h2>
          <p className="muted">
            Showing at most the first 100 endpoints. Search filters this loaded
            list locally.
          </p>
        </div>
      </div>

      {signingSecret ? (
        <section
          className="secret"
          aria-labelledby="signing-secret-heading"
          role="region"
        >
          <div className="section-heading">
            <div>
              <h3 id="signing-secret-heading">Save this signing secret</h3>
              <p className="muted">
                This secret is shown once. Existing queued deliveries retain the
                old secret, so keep prior verification secrets at your receiver
                until those deliveries have drained.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSigningSecret(null)}
              disabled={mutationPending}
            >
              Dismiss
            </button>
          </div>
          <code>{signingSecret}</code>
        </section>
      ) : null}

      <section aria-labelledby="create-endpoint-heading">
        <div className="section-heading">
          <h3 id="create-endpoint-heading">Add endpoint</h3>
        </div>
        <form className="form-grid" onSubmit={handleCreate}>
          <label>
            Name
            <input
              value={createName}
              maxLength={120}
              onChange={(event) => setCreateName(event.target.value)}
              required
              disabled={mutationPending}
            />
          </label>
          <label>
            URL
            <input
              type="url"
              maxLength={2048}
              value={createUrl}
              onChange={(event) => setCreateUrl(event.target.value)}
              required
              disabled={mutationPending}
            />
          </label>
          <label>
            Custom headers <span className="muted">JSON</span>
            <textarea
              value={createHeaders}
              onChange={(event) => setCreateHeaders(event.target.value)}
              rows={3}
              spellCheck={false}
              placeholder={'{"Authorization":"Bearer …"}'}
              disabled={mutationPending}
            />
          </label>
          <label>
            Event patterns <span className="muted">comma-separated</span>
            <input
              value={createPatterns}
              onChange={(event) => setCreatePatterns(event.target.value)}
              placeholder="payment.*, user.created"
              disabled={mutationPending}
            />
          </label>
          <div className="actions">
            <button type="submit" disabled={mutationPending}>
              Add endpoint
            </button>
          </div>
        </form>
      </section>

      {mutationPending ? (
        <p className="muted" role="status">
          Saving endpoint changes…
        </p>
      ) : null}

      {mutationError ? (
        <div className="error" role="alert">
          {mutationError}
        </div>
      ) : null}

      <section aria-labelledby="loaded-endpoints-heading">
        <div className="section-heading">
          <div>
            <h3 id="loaded-endpoints-heading">Loaded endpoints</h3>
            <label>
              <span className="muted">Search loaded endpoints by name</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name"
                disabled={loading || mutationPending}
              />
            </label>
          </div>
        </div>

        {loading ? (
          <p className="muted" role="status" aria-live="polite">
            Loading endpoints…
          </p>
        ) : loadError ? (
          <div className="error" role="alert">
            <p>{loadError}</p>
            <button
              type="button"
              onClick={() => setReloadVersion((version) => version + 1)}
              disabled={mutationPending}
            >
              Retry
            </button>
          </div>
        ) : endpoints.length === 0 ? (
          <p className="empty">No endpoints have been configured yet.</p>
        ) : visibleEndpoints.length === 0 ? (
          <p className="empty">No loaded endpoints match that name.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">URL</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleEndpoints.map((endpoint) => (
                  <tr key={endpoint.id}>
                    <td>
                      {editingEndpointId === endpoint.id ? (
                        <form
                          id={`edit-endpoint-${endpoint.id}`}
                          onSubmit={(event) => handleEdit(event, endpoint.id)}
                        >
                          <label>
                            <span className="muted">Edit name</span>
                            <input
                              value={editName}
                              maxLength={120}
                              onChange={(event) =>
                                setEditName(event.target.value)
                              }
                              required
                              disabled={mutationPending}
                            />
                          </label>
                        </form>
                      ) : (
                        endpoint.name
                      )}
                    </td>
                    <td>
                      {editingEndpointId === endpoint.id ? (
                        <>
                          <label>
                            <span className="muted">Edit URL</span>
                            <input
                              type="url"
                              maxLength={2048}
                              form={`edit-endpoint-${endpoint.id}`}
                              value={editUrl}
                              onChange={(event) =>
                                setEditUrl(event.target.value)
                              }
                              required
                              disabled={mutationPending}
                            />
                          </label>
                          <label>
                            <span className="muted">Custom headers JSON</span>
                            <textarea
                              rows={3}
                              value={editHeaders}
                              onChange={(event) =>
                                setEditHeaders(event.target.value)
                              }
                              spellCheck={false}
                              disabled={mutationPending}
                            />
                          </label>
                          <label>
                            <span className="muted">Event patterns</span>
                            <input
                              value={editPatterns}
                              onChange={(event) =>
                                setEditPatterns(event.target.value)
                              }
                              disabled={mutationPending}
                            />
                          </label>
                        </>
                      ) : (
                        <span>{endpoint.url}</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${endpoint.status}`}>
                        {endpoint.status}
                      </span>
                    </td>
                    <td>
                      <div className="actions">
                        {editingEndpointId === endpoint.id ? (
                          <>
                            <button
                              type="submit"
                              form={`edit-endpoint-${endpoint.id}`}
                              disabled={mutationPending}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingEndpointId(null)}
                              disabled={mutationPending}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => beginEdit(endpoint)}
                            disabled={mutationPending}
                          >
                            Edit
                          </button>
                        )}
                        {endpoint.status === "active" ? (
                          <button
                            type="button"
                            onClick={() => changeStatus(endpoint, "pause")}
                            disabled={mutationPending}
                          >
                            Pause
                          </button>
                        ) : endpoint.status === "paused" ? (
                          <button
                            type="button"
                            onClick={() => changeStatus(endpoint, "resume")}
                            disabled={mutationPending}
                          >
                            Resume
                          </button>
                        ) : null}
                        {endpoint.status !== "disabled" ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setMutationError(null);
                                setEditingEndpointId(null);
                                setConfirmation({
                                  endpointId: endpoint.id,
                                  action: "disable",
                                });
                              }}
                              disabled={mutationPending}
                            >
                              Disable
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setMutationError(null);
                                setEditingEndpointId(null);
                                setConfirmation({
                                  endpointId: endpoint.id,
                                  action: "rotate",
                                });
                              }}
                              disabled={mutationPending}
                            >
                              Rotate secret
                            </button>
                          </>
                        ) : null}
                      </div>
                      {confirmation?.endpointId === endpoint.id ? (
                        <div
                          className="notice"
                          role="group"
                          aria-label={
                            confirmation.action === "disable"
                              ? "Disable endpoint confirmation"
                              : "Rotate signing secret confirmation"
                          }
                        >
                          <p>
                            {confirmation.action === "disable"
                              ? `Disable ${endpoint.name}? Disabled endpoints cannot be resumed.`
                              : `Rotate the signing secret for ${endpoint.name}? Existing queued deliveries retain the old secret. Keep prior verification secrets at your receiver until those deliveries have drained.`}
                          </p>
                          <div className="actions">
                            <button
                              type="button"
                              onClick={() => {
                                if (confirmation.action === "disable") {
                                  disableEndpoint(endpoint.id);
                                } else {
                                  rotateSecret(endpoint.id);
                                }
                              }}
                              disabled={mutationPending}
                            >
                              {confirmation.action === "disable"
                                ? "Confirm disable"
                                : "Confirm rotate"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmation(null)}
                              disabled={mutationPending}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
