/**
 * The worker is intentionally a separately deployable process from the first
 * milestone. Durable delivery claiming and retry scheduling arrive with the
 * delivery schema in the next milestones.
 */
console.info(
  "HookForge worker foundation is ready for the delivery queue milestone.",
);
