// Helpers for the Cluster Status (detector) view. Ported from the original
// rubintv detectorUtils — status colours/classes, the reset-key prefix, and
// placeholder generation for sets that report a worker count but no per-worker
// detail yet.

export const RESET_PREFIX = "RUBINTV_CONTROL_RESET_";

export interface WorkerStatus {
  status: string;
  queue_length?: number;
}

// One detector set's live payload (as shipped by the backend, keyed by set
// name): per-worker statuses, an optional worker count, and optional free-text
// queue entries (the Other Queues table).
export interface SetPayload {
  workers?: Record<string, WorkerStatus>;
  numWorkers?: number;
  text?: Record<string, string>;
}

export function getStatusClass(status: string): string {
  switch (status) {
    case "free":
      return "status-free";
    case "busy":
      return "status-busy";
    case "queued":
      return "status-queued";
    case "restarting":
      return "status-restarting";
    case "guest":
      return "status-guest";
    default:
      return "status-missing";
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case "free":
      return "#22c55e";
    case "busy":
      return "#eab308";
    case "queued":
      return "#ef4444";
    case "restarting":
      return "#a163ac";
    case "guest":
      return "#3b82f6";
    default:
      return "#d1d5db";
  }
}

// Missing-status placeholders for `count` workers (ids "0".."count-1"). Used
// when a set advertises numWorkers but hasn't reported per-worker detail, so
// the grid shows the right number of cells immediately.
export function createPlaceholders(count: number): Record<string, WorkerStatus> {
  const placeholders: Record<string, WorkerStatus> = {};
  for (let i = 0; i < count; i++) {
    placeholders[i.toString()] = { status: "missing" };
  }
  return placeholders;
}
