// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EndpointsPanel } from "../src/EndpointsPanel.js";
import type { ApiClient, ApiOptions } from "../src/api.js";
import type { Endpoint } from "../src/types.js";

const projectId = "project-1";
const basePath = `/api/v1/projects/${projectId}`;

function makeEndpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: "endpoint-1",
    projectId,
    name: "Primary receiver",
    url: "https://receiver.example/hooks",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSuccessfulDeliveryAt: null,
    ...overrides,
  };
}

function makeApi(endpoints: Endpoint[] = [makeEndpoint()]) {
  const request =
    vi.fn<(path: string, options?: ApiOptions) => Promise<unknown>>();

  request.mockImplementation(async (path, options) => {
    if (
      path === `${basePath}/endpoints?limit=100` &&
      (options?.method ?? "GET") === "GET"
    ) {
      return { endpoints };
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  const api: ApiClient = {
    request<T>(path: string, options?: ApiOptions) {
      return request(path, options) as Promise<T>;
    },
  };

  return { api, request };
}

function renderPanel(api: ApiClient, onChanged = vi.fn()) {
  return render(
    <EndpointsPanel api={api} projectId={projectId} onChanged={onChanged} />,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(cleanup);

describe("EndpointsPanel", () => {
  it("loads the first 100 endpoints and filters names locally", async () => {
    const first = makeEndpoint();
    const second = makeEndpoint({
      id: "endpoint-2",
      name: "Backup receiver",
      url: "https://backup.example/hooks",
    });
    const { api, request } = makeApi([first, second]);
    const { container } = renderPanel(api);

    expect(screen.getByRole("status").textContent).toContain(
      "Loading endpoints",
    );
    await screen.findByText("Primary receiver");
    expect(screen.getByText("Backup receiver")).toBeTruthy();
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `${basePath}/endpoints?limit=100`,
      { signal: expect.any(AbortSignal) },
    );
    expect(
      screen.getByText(/first 100 endpoints.*loaded list locally/i),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search loaded endpoints by name"), {
      target: { value: " BACKUP " },
    });

    expect(screen.queryByText("Primary receiver")).toBeNull();
    expect(screen.getByText("Backup receiver")).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search loaded endpoints by name"), {
      target: { value: "https://backup.example" },
    });
    expect(
      screen.getByText("No loaded endpoints match that name."),
    ).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("waits for creation, prevents duplicate submits, and shows a dismissible secret", async () => {
    const { api, request } = makeApi([]);
    const onChanged = vi.fn();
    renderPanel(api, onChanged);
    await screen.findByText("No endpoints have been configured yet.");
    const pending = deferred<{ endpoint: Endpoint; signingSecret: string }>();
    const created = makeEndpoint({ name: "Created receiver" });
    request.mockReturnValueOnce(pending.promise);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: " Created receiver " },
    });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://created.example/hooks" },
    });
    const add = screen.getByRole("button", { name: "Add endpoint" });
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.submit(add.closest("form")!);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(`${basePath}/endpoints`, {
      method: "POST",
      body: {
        name: "Created receiver",
        url: "https://created.example/hooks",
      },
      signal: expect.any(AbortSignal),
    });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("whsec_created")).toBeNull();
    expect(
      screen.getByText("No endpoints have been configured yet."),
    ).toBeTruthy();

    await act(async () => {
      pending.resolve({ endpoint: created, signingSecret: "whsec_created" });
    });
    await screen.findByText("Created receiver");
    const setup = screen.getByRole("region", {
      name: "Save this signing secret",
    });
    expect(within(setup).getByText("whsec_created")).toBeTruthy();
    expect(setup.textContent).toMatch(
      /queued deliveries retain the old secret/,
    );
    expect(setup.textContent).toMatch(/keep prior verification secrets/);
    expect(setup.textContent).toMatch(/until those deliveries have drained/);
    expect(onChanged).toHaveBeenCalledTimes(1);
    fireEvent.click(within(setup).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("whsec_created")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Save this signing secret" }),
    ).toBeNull();
  });

  it("PATCHes the edited name and URL and refreshes the persisted endpoint", async () => {
    const { api, request } = makeApi();
    const onChanged = vi.fn();
    renderPanel(api, onChanged);
    await screen.findByText("Primary receiver");

    const edited = makeEndpoint({
      name: "Edited receiver",
      url: "https://edited.example/hooks",
    });
    request.mockResolvedValueOnce({ endpoint: edited });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit name"), {
      target: { value: "Edited receiver" },
    });
    fireEvent.change(screen.getByLabelText("Edit URL"), {
      target: { value: "https://edited.example/hooks" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Edited receiver");
    expect(request).toHaveBeenNthCalledWith(
      2,
      `${basePath}/endpoints/endpoint-1`,
      {
        method: "PATCH",
        body: {
          name: "Edited receiver",
          url: "https://edited.example/hooks",
        },
        signal: expect.any(AbortSignal),
      },
    );
    expect(screen.getByText("https://edited.example/hooks")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("pauses and resumes using backend status responses", async () => {
    const { api, request } = makeApi();
    const onChanged = vi.fn();
    renderPanel(api, onChanged);
    await screen.findByText("Primary receiver");
    const pause = deferred<{ endpoint: Endpoint }>();
    const paused = makeEndpoint({ status: "paused" });
    request.mockReturnValueOnce(pause.promise);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByText("active")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => pause.resolve({ endpoint: paused }));
    await screen.findByText("paused");
    expect(request).toHaveBeenNthCalledWith(
      2,
      `${basePath}/endpoints/endpoint-1/pause`,
      { method: "POST", signal: expect.any(AbortSignal) },
    );

    request.mockResolvedValueOnce({ endpoint: makeEndpoint() });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await screen.findByText("active");
    expect(request).toHaveBeenNthCalledWith(
      3,
      `${basePath}/endpoints/endpoint-1/resume`,
      { method: "POST", signal: expect.any(AbortSignal) },
    );
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("confirms rotation, displays the returned secret, and clears it before a later mutation", async () => {
    const { api, request } = makeApi();
    const onChanged = vi.fn();
    renderPanel(api, onChanged);
    await screen.findByText("Primary receiver");
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    const confirmation = screen.getByRole("group", {
      name: /rotate signing secret/i,
    });
    expect(confirmation.textContent).toContain(
      "Existing queued deliveries retain the old secret",
    );
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(
      screen.queryByRole("group", { name: /rotate signing secret/i }),
    ).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);

    request.mockResolvedValueOnce({
      endpoint: makeEndpoint(),
      signingSecret: "whsec_rotated",
    });
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm rotate" }));
    await screen.findByText("whsec_rotated");
    await screen.findByText("Primary receiver");
    expect(request).toHaveBeenNthCalledWith(
      2,
      `${basePath}/endpoints/endpoint-1/rotate-secret`,
      { method: "POST", signal: expect.any(AbortSignal) },
    );
    expect(onChanged).toHaveBeenCalledTimes(1);

    const pause = deferred<never>();
    request.mockReturnValueOnce(pause.promise);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.queryByText("whsec_rotated")).toBeNull();
    await act(async () => pause.reject(new Error("Pause failed")));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Pause failed",
    );
    expect(screen.queryByText("whsec_rotated")).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("requires inline disable confirmation and accepts the API's empty 204 response", async () => {
    const { api, request } = makeApi();
    const onChanged = vi.fn();
    renderPanel(api, onChanged);
    await screen.findByText("Primary receiver");
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    const confirmation = screen.getByRole("group", {
      name: /disable endpoint/i,
    });
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(
      screen.queryByRole("group", { name: /disable endpoint/i }),
    ).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);

    const disable = deferred<undefined>();
    request.mockReturnValueOnce(disable.promise);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByText("active")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => disable.resolve(undefined));
    await screen.findByText("disabled");
    expect(request).toHaveBeenNthCalledWith(
      2,
      `${basePath}/endpoints/endpoint-1`,
      { method: "DELETE", signal: expect.any(AbortSignal) },
    );
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows an API error without claiming a disable succeeded", async () => {
    const { api, request } = makeApi();
    request.mockImplementation(async (path, options) => {
      if (path === `${basePath}/endpoints?limit=100`) {
        return { endpoints: [makeEndpoint()] };
      }
      if (options?.method === "DELETE") {
        throw new Error("Disable failed");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const onChanged = vi.fn();
    renderPanel(api, onChanged);
    await screen.findByText("Primary receiver");

    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Disable failed",
    );
    expect(screen.getByText("active")).toBeTruthy();
    expect(
      screen.getByRole("group", { name: /disable endpoint/i }),
    ).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("renders an empty state and retries a failed load", async () => {
    const { api, request } = makeApi([]);
    request.mockRejectedValueOnce(new Error("List failed"));
    renderPanel(api);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "List failed",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    request.mockResolvedValueOnce({ endpoints: [] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByText("No endpoints have been configured yet."),
    ).toBeTruthy();
  });
});
