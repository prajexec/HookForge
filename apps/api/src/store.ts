import type { Pool, PoolClient, QueryResultRow } from "pg";

import { conflict, notFound } from "./errors.js";

export type EndpointStatus = "active" | "paused" | "disabled";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
  user: UserRecord;
}

export interface ProjectRecord {
  id: string;
  ownerId: string;
  name: string;
  publicIdentifier: string;
  createdAt: string;
  updatedAt: string;
}

export interface EndpointRecord {
  id: string;
  projectId: string;
  name: string;
  url: string;
  status: EndpointStatus;
  currentSecretVersion: number;
  lastSuccessfulDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedSecretRecord {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface HookForgeStore {
  createUser(input: {
    email: string;
    emailNormalized: string;
    passwordHash: string;
  }): Promise<UserRecord>;
  findUserByEmail(emailNormalized: string): Promise<UserRecord | null>;
  createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<{ id: string; expiresAt: string }>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeSession(sessionId: string): Promise<void>;
  createProject(input: {
    ownerId: string;
    name: string;
    nameNormalized: string;
    publicIdentifier: string;
  }): Promise<ProjectRecord>;
  listProjects(ownerId: string, limit: number): Promise<ProjectRecord[]>;
  getProject(ownerId: string, projectId: string): Promise<ProjectRecord | null>;
  createEndpoint(input: {
    ownerId: string;
    projectId: string;
    name: string;
    nameNormalized: string;
    url: string;
    secret: EncryptedSecretRecord;
  }): Promise<EndpointRecord>;
  listEndpoints(
    ownerId: string,
    projectId: string,
    limit: number,
  ): Promise<EndpointRecord[]>;
  getEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
  ): Promise<EndpointRecord | null>;
  updateEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
    input: { name?: string; nameNormalized?: string; url?: string },
  ): Promise<EndpointRecord | null>;
  setEndpointStatus(
    ownerId: string,
    projectId: string,
    endpointId: string,
    status: EndpointStatus,
  ): Promise<EndpointRecord | null>;
  rotateEndpointSecret(
    ownerId: string,
    projectId: string,
    endpointId: string,
    secret: EncryptedSecretRecord,
  ): Promise<EndpointRecord | null>;
}

type DatabaseRow = QueryResultRow & Record<string, unknown>;

function mapUser(row: DatabaseRow): UserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapProject(row: DatabaseRow): ProjectRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    publicIdentifier: String(row.public_identifier),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function mapEndpoint(row: DatabaseRow): EndpointRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    url: String(row.url),
    status: row.status as EndpointStatus,
    currentSecretVersion: Number(row.current_secret_version),
    lastSuccessfulDeliveryAt: row.last_successful_delivery_at
      ? new Date(String(row.last_successful_delivery_at)).toISOString()
      : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

export class PgStore implements HookForgeStore {
  public constructor(private readonly pool: Pool) {}

  public async createUser(input: {
    email: string;
    emailNormalized: string;
    passwordHash: string;
  }): Promise<UserRecord> {
    try {
      const result = await this.pool.query<DatabaseRow>(
        `INSERT INTO users (email, email_normalized, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, password_hash, created_at, updated_at`,
        [input.email, input.emailNormalized, input.passwordHash],
      );
      return mapUser(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          "EMAIL_TAKEN",
          "An account with this email already exists",
        );
      }
      throw error;
    }
  }

  public async findUserByEmail(
    emailNormalized: string,
  ): Promise<UserRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT id, email, password_hash, created_at, updated_at
       FROM users WHERE email_normalized = $1`,
      [emailNormalized],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  public async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<{ id: string; expiresAt: string }> {
    const result = await this.pool.query<DatabaseRow>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, expires_at`,
      [input.userId, input.tokenHash, input.expiresAt],
    );
    const row = result.rows[0]!;
    return {
      id: String(row.id),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
    };
  }

  public async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<SessionRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT
         s.id AS session_id,
         s.user_id,
         s.expires_at,
         s.revoked_at,
         u.id,
         u.email,
         u.password_hash,
         u.created_at,
         u.updated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    await this.pool.query(
      "UPDATE sessions SET last_seen_at = now() WHERE id = $1",
      [row.session_id],
    );

    return {
      id: String(row.session_id),
      userId: String(row.user_id),
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      revokedAt: row.revoked_at
        ? new Date(String(row.revoked_at)).toISOString()
        : null,
      user: mapUser(row),
    };
  }

  public async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query(
      "UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1",
      [sessionId],
    );
  }

  public async createProject(input: {
    ownerId: string;
    name: string;
    nameNormalized: string;
    publicIdentifier: string;
  }): Promise<ProjectRecord> {
    try {
      const result = await this.pool.query<DatabaseRow>(
        `INSERT INTO projects (owner_id, name, name_normalized, public_identifier)
         VALUES ($1, $2, $3, $4)
         RETURNING id, owner_id, name, public_identifier, created_at, updated_at`,
        [
          input.ownerId,
          input.name,
          input.nameNormalized,
          input.publicIdentifier,
        ],
      );
      return mapProject(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          "PROJECT_NAME_TAKEN",
          "You already have a project with this name",
        );
      }
      throw error;
    }
  }

  public async listProjects(
    ownerId: string,
    limit: number,
  ): Promise<ProjectRecord[]> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT id, owner_id, name, public_identifier, created_at, updated_at
       FROM projects
       WHERE owner_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [ownerId, limit],
    );
    return result.rows.map(mapProject);
  }

  public async getProject(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT id, owner_id, name, public_identifier, created_at, updated_at
       FROM projects WHERE id = $1 AND owner_id = $2`,
      [projectId, ownerId],
    );
    return result.rows[0] ? mapProject(result.rows[0]) : null;
  }

  public async createEndpoint(input: {
    ownerId: string;
    projectId: string;
    name: string;
    nameNormalized: string;
    url: string;
    secret: EncryptedSecretRecord;
  }): Promise<EndpointRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<DatabaseRow>(
        "SELECT id FROM projects WHERE id = $1 AND owner_id = $2 FOR SHARE",
        [input.projectId, input.ownerId],
      );
      if (project.rowCount === 0) {
        throw notFound();
      }

      const endpoint = await client.query<DatabaseRow>(
        `INSERT INTO endpoints (project_id, name, name_normalized, url)
         VALUES ($1, $2, $3, $4)
         RETURNING id, project_id, name, url, status, current_secret_version,
                   last_successful_delivery_at, created_at, updated_at`,
        [input.projectId, input.name, input.nameNormalized, input.url],
      );
      const row = endpoint.rows[0]!;
      await client.query(
        `INSERT INTO endpoint_secrets (endpoint_id, version, ciphertext, iv, auth_tag)
         VALUES ($1, 1, $2, $3, $4)`,
        [
          row.id,
          input.secret.ciphertext,
          input.secret.iv,
          input.secret.authTag,
        ],
      );
      await client.query("COMMIT");
      return mapEndpoint(row);
    } catch (error) {
      await rollback(client);
      if (isUniqueViolation(error)) {
        throw conflict(
          "ENDPOINT_NAME_TAKEN",
          "This project already has an endpoint with this name",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async listEndpoints(
    ownerId: string,
    projectId: string,
    limit: number,
  ): Promise<EndpointRecord[]> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT e.id, e.project_id, e.name, e.url, e.status,
              e.current_secret_version, e.last_successful_delivery_at,
              e.created_at, e.updated_at
       FROM endpoints e
       JOIN projects p ON p.id = e.project_id
       WHERE e.project_id = $1 AND p.owner_id = $2
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $3`,
      [projectId, ownerId, limit],
    );
    return result.rows.map(mapEndpoint);
  }

  public async getEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
  ): Promise<EndpointRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT e.id, e.project_id, e.name, e.url, e.status,
              e.current_secret_version, e.last_successful_delivery_at,
              e.created_at, e.updated_at
       FROM endpoints e
       JOIN projects p ON p.id = e.project_id
       WHERE e.id = $1 AND e.project_id = $2 AND p.owner_id = $3`,
      [endpointId, projectId, ownerId],
    );
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null;
  }

  public async updateEndpoint(
    ownerId: string,
    projectId: string,
    endpointId: string,
    input: { name?: string; nameNormalized?: string; url?: string },
  ): Promise<EndpointRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `UPDATE endpoints e
       SET name = COALESCE($4, e.name),
           name_normalized = COALESCE($5, e.name_normalized),
           url = COALESCE($6, e.url),
           updated_at = now()
       FROM projects p
       WHERE e.id = $1 AND e.project_id = $2 AND p.id = e.project_id
         AND p.owner_id = $3
       RETURNING e.id, e.project_id, e.name, e.url, e.status,
                 e.current_secret_version, e.last_successful_delivery_at,
                 e.created_at, e.updated_at`,
      [
        endpointId,
        projectId,
        ownerId,
        input.name ?? null,
        input.nameNormalized ?? null,
        input.url ?? null,
      ],
    );
    if (!result.rows[0]) {
      return null;
    }
    return mapEndpoint(result.rows[0]);
  }

  public async setEndpointStatus(
    ownerId: string,
    projectId: string,
    endpointId: string,
    status: EndpointStatus,
  ): Promise<EndpointRecord | null> {
    const result = await this.pool.query<DatabaseRow>(
      `UPDATE endpoints e
       SET status = $4, updated_at = now()
       FROM projects p
       WHERE e.id = $1 AND e.project_id = $2 AND p.id = e.project_id
         AND p.owner_id = $3
       RETURNING e.id, e.project_id, e.name, e.url, e.status,
                 e.current_secret_version, e.last_successful_delivery_at,
                 e.created_at, e.updated_at`,
      [endpointId, projectId, ownerId, status],
    );
    return result.rows[0] ? mapEndpoint(result.rows[0]) : null;
  }

  public async rotateEndpointSecret(
    ownerId: string,
    projectId: string,
    endpointId: string,
    secret: EncryptedSecretRecord,
  ): Promise<EndpointRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const endpoint = await client.query<DatabaseRow>(
        `SELECT e.id, e.project_id, e.name, e.url, e.status,
                e.current_secret_version, e.last_successful_delivery_at,
                e.created_at, e.updated_at
         FROM endpoints e
         JOIN projects p ON p.id = e.project_id
         WHERE e.id = $1 AND e.project_id = $2 AND p.owner_id = $3
         FOR UPDATE`,
        [endpointId, projectId, ownerId],
      );
      const row = endpoint.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      if (row.status === "disabled") {
        throw conflict(
          "ENDPOINT_DISABLED",
          "Disabled endpoints cannot rotate signing secrets",
        );
      }

      const nextVersion = Number(row.current_secret_version) + 1;
      await client.query(
        `UPDATE endpoint_secrets
         SET retired_at = COALESCE(retired_at, now())
         WHERE endpoint_id = $1 AND retired_at IS NULL`,
        [endpointId],
      );
      await client.query(
        `INSERT INTO endpoint_secrets (endpoint_id, version, ciphertext, iv, auth_tag)
         VALUES ($1, $2, $3, $4, $5)`,
        [endpointId, nextVersion, secret.ciphertext, secret.iv, secret.authTag],
      );
      const updated = await client.query<DatabaseRow>(
        `UPDATE endpoints
         SET current_secret_version = $2, updated_at = now()
         WHERE id = $1
         RETURNING id, project_id, name, url, status, current_secret_version,
                   last_successful_delivery_at, created_at, updated_at`,
        [endpointId, nextVersion],
      );
      await client.query("COMMIT");
      return mapEndpoint(updated.rows[0]!);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
