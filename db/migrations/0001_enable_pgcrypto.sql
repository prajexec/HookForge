-- pgcrypto provides cryptographically secure database-side identifiers for
-- migrations and future schema objects. Application secrets are generated in
-- Node.js and are never stored as plaintext by the application.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
