import { useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import { usePageTitle } from "../lib/usePageTitle";
import { AdminAccessNote } from "../components/AdminAccessNote";
import { ConfirmButton } from "../components/ConfirmButton";
import type { AdminActionOut, AdminMenuOut, ControlsOut } from "../lib/types";

// The analysis side acknowledges a control key K by writing K_READBACK, and
// the readback map is keyed by those full names.
const READBACK_SUFFIX = "_READBACK";

// The free-form box writes under the control namespace, as V2's did: the
// typed key is prefixed and uppercased (anything but letters, digits and _
// becomes _), and the value is uppercased with spaces and control characters
// collapsed to single underscores.
const CONTROL_PREFIX = "RUBINTV_CONTROL_";

function controlKey(typed: string): string {
  return CONTROL_PREFIX + typed.trim().replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
}

function controlValue(typed: string): string {
  return (
    typed
      .trim()
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F ]+/g, "_")
      .replace(/_+/g, "_")
      .toUpperCase()
  );
}

// Global admin/ops panel (one per deployment). Shows the app version, control
// boxes that send plain-SET values to Redis (with live readback), an arbitrary
// key/value sender, witness-detector and reset-head-node actions, and a danger
// zone (flush historical cache, flush redis). Control readback updates live via
// the admin WS topic.
//
// Every action reports its outcome in a shared status line so a 503 ("redis not
// configured") or a 403 (admin gate) is visible rather than silent.
export function Admin() {
  usePageTitle("Admin");
  const qc = useQueryClient();
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // Site-wide subscription (empty location keys the admin|| topic).
  useLiveTopic({ topic: "admin", location: "" });

  const { data: status } = useQuery({
    queryKey: ["adminStatus"],
    queryFn: api.adminStatus,
    staleTime: STALE.config,
  });

  // Every control action except "Flush historical cache" writes to Redis and
  // 503s when it isn't configured, so disable them all together (rather than
  // letting some fire into an error and others sit inert). The header's "Redis
  // not configured" warning says why they're greyed. Until /admin/status
  // resolves we optimistically leave them enabled.
  const redisDown = status ? !status.redis_enabled : false;
  // A non-admin's writes would only 403, so disable every action and say why
  // up front rather than after a click. Same optimism until status resolves.
  const locked = status ? !status.is_admin : false;

  const { data: menus } = useQuery({
    queryKey: ["adminMenus"],
    queryFn: api.adminMenus,
    staleTime: STALE.config,
  });

  // Readback: seed from REST, then live controlReadback messages keep the same
  // cache slot current.
  const readbackKey = queryKeys.controlReadback();
  const { data: controls } = useQuery<ControlsOut["values"]>({
    queryKey: readbackKey,
    queryFn: async () => {
      const cached = qc.getQueryData<ControlsOut["values"]>(readbackKey);
      if (cached) return cached;
      const res = await api.siteControls();
      return res.values;
    },
    staleTime: STALE.config,
  });
  const readback = controls ?? {};
  const readbackOf = (key: string) => readback[key + READBACK_SUFFIX];

  // Run an admin action and surface its result/error in the status line.
  const run = async (label: string, fn: () => Promise<AdminActionOut>) => {
    try {
      const res = await fn();
      setFeedback({ ok: res.ok, text: `${label}: ${res.detail || "done"}` });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      setFeedback({ ok: false, text: `${label} failed — ${msg}` });
    }
  };

  return (
    <section className="admin">
      <header className="admin-header">
        <h1>Admin</h1>
        <span className="admin-version">
          {/* Deployed images show the full setuptools-scm version; a local
              checkout drops the noisy `dev+g<sha>` string and shows just the
              sha and date. */}
          {status
            ? status.is_release
              ? `v${status.version} · ${status.git_sha} · ${status.commit_date}`
              : `${status.git_sha} · ${status.commit_date}`
            : ""}
          {status?.user && <span> · signed in as {status.user}</span>}
          {status && !status.redis_enabled && (
            <span className="admin-warn" role="alert">
              {" "}
              · Redis not configured — control writes are not possible
            </span>
          )}
        </span>
      </header>

      {status && locked && (
        <AdminAccessNote
          user={status.user ?? null}
          consequence="the controls below are disabled"
        />
      )}

      {feedback && (
        <p
          role="status"
          className={feedback.ok ? "admin-feedback ok" : "admin-feedback err"}
        >
          {feedback.text}
        </p>
      )}

      {/* Two rows, by kind: the configured menus, then the free-form
          writes and the head-node reset. Each row fills the width. */}
      <div
        className="admin-boxes"
        style={{ "--cols": Math.max(menus?.menus.length ?? 0, 1) } as CSSProperties}
      >
        {(menus?.menus ?? []).map((menu) => (
          <MenuBox
            key={menu.key}
            menu={menu}
            value={readbackOf(menu.key)}
            disabled={redisDown || locked}
            onSend={(value) =>
              run(menu.title, () => api.setControl(menu.key, value))
            }
          />
        ))}
      </div>

      <div className="admin-boxes admin-boxes-commands">
        <ArbitraryBox
          disabled={redisDown || locked}
          onSend={(key, value) =>
            run(`set ${key}`, () => api.setControl(key, value))
          }
        />

        <WitnessBox
          value={status ? readbackOf(status.witness_detector_key) : undefined}
          disabled={redisDown || locked}
          onSend={(value) =>
            run("Witness Detector", () => api.setWitnessDetector(value))
          }
        />

        <div className="admin-box">
          <h2>Reset Head Node</h2>
          <ConfirmButton
            label="Reset Head Node"
            confirmLabel="Reset — confirm?"
            danger
            disabled={redisDown || locked}
            onConfirm={() => run("Reset Head Node", api.resetHeadNode)}
          />
        </div>
      </div>

      <div className="admin-danger-zone">
        <h2>Danger zone</h2>
        <div className="admin-box">
          <h3>Flush historical cache</h3>
          <p className="admin-note">
            Clears the cached history and rescans from S3. The site reloads
            history in the background.
          </p>
          <ConfirmButton
            label="Flush historical cache"
            confirmLabel="Flush cache — confirm?"
            danger
            disabled={locked}
            onConfirm={() =>
              run("Flush historical cache", api.flushHistorical)
            }
          />
        </div>
        <div className="admin-box">
          <h3>Flush Redis</h3>
          <p className="admin-note">
            Wipes the entire Redis database. This cannot be undone.
          </p>
          <ConfirmButton
            label="Flush Redis"
            confirmLabel="Flush Redis — confirm?"
            danger
            disabled={redisDown || locked}
            onConfirm={() => run("Flush Redis", api.flushRedis)}
          />
        </div>
      </div>
    </section>
  );
}

// A configured control menu: shows the current readback (or a placeholder) and
// a dropdown of the menu's options that sends the chosen value on click.
function MenuBox({
  menu,
  value,
  onSend,
  disabled = false,
}: {
  menu: AdminMenuOut;
  value: string | undefined;
  onSend: (value: string) => void;
  disabled?: boolean;
}) {
  const [choice, setChoice] = useState(menu.items[0]?.label ?? "");
  return (
    <div className="admin-box">
      <h2>{menu.title}</h2>
      <p className="admin-readback">
        Current: <strong>{value ?? "—"}</strong>
      </p>
      <div className="admin-row">
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          {menu.items.map((item) => (
            <option key={item.label} value={item.label}>
              {item.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onSend(choice)}
          disabled={disabled || !choice}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// Send any key/value pair in the control namespace (see controlKey and
// controlValue); the key it will write is shown as it's typed.
function ArbitraryBox({
  onSend,
  disabled = false,
}: {
  onSend: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  return (
    <div className="admin-box admin-box-wide">
      <h2>Set key / value</h2>
      <div className="admin-row">
        <input
          aria-label="control key"
          placeholder="KEY"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <input
          aria-label="control value"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          onClick={() => onSend(controlKey(key), controlValue(value))}
          disabled={disabled || key.trim() === ""}
        >
          Send
        </button>
      </div>
      {/* Always present, so the box doesn't grow on the first keystroke;
          before a key is typed it shows the prefix that will be added. */}
      <p className="admin-note admin-sets">
        Sets {key.trim() === "" ? `${CONTROL_PREFIX}…` : controlKey(key)}
      </p>
    </div>
  );
}

// Send a value to the witness-detector control key.
function WitnessBox({
  value,
  onSend,
  disabled = false,
}: {
  value: string | undefined;
  onSend: (value: string) => void;
  disabled?: boolean;
}) {
  const [v, setV] = useState("");
  return (
    <div className="admin-box">
      <h2>Witness Detector</h2>
      <p className="admin-readback">
        Current: <strong>{value ?? "—"}</strong>
      </p>
      <div className="admin-row">
        <input
          aria-label="witness detector value"
          placeholder="value"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
        <button
          type="button"
          onClick={() => onSend(v)}
          disabled={disabled || v === ""}
        >
          Send
        </button>
      </div>
    </div>
  );
}
