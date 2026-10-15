import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";

describe("mock receiver", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("captures raw bodies and removes sensitive headers", async () => {
    app = buildApp({
      config: {
        maxBodyBytes: 1_024,
        maxRequestsPerToken: 10,
        maxTokens: 10,
      },
      logger: false,
    });

    const post = await app.inject({
      method: "POST",
      url: "/hooks/test-token",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-hookforge-event-id": "event-1",
      },
      payload: '{"value":1}',
    });

    expect(post.statusCode).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/hooks/test-token/requests",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      expect.objectContaining({
        rawBody: '{"value":1}',
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-hookforge-event-id": "event-1",
        }),
      }),
    ]);
    expect(list.json()[0].receivedAt).toEqual(expect.any(String));
    expect(list.json()[0].headers.authorization).toBeUndefined();
    expect(list.json()[0].headers.cookie).toBeUndefined();
  });

  it("bounds requests and clears a token", async () => {
    app = buildApp({
      config: {
        maxBodyBytes: 1_024,
        maxRequestsPerToken: 2,
        maxTokens: 10,
      },
      logger: false,
    });

    for (const payload of ["one", "two", "three"]) {
      await app.inject({
        method: "POST",
        url: "/hooks/bounded",
        payload,
      });
    }

    const list = await app.inject({
      method: "GET",
      url: "/hooks/bounded/requests",
    });
    expect(
      list.json().map((request: { rawBody: string }) => request.rawBody),
    ).toEqual(["two", "three"]);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/hooks/bounded/requests",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: 2 });
  });
});
