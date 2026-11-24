import { useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useNow } from "../lib/lastPoll";
import { queryKeys } from "../lib/liveQuery";
import { STALE } from "../lib/queryClient";
import { useLiveTopic } from "../lib/LiveContext";
import {
  unansweredFor,
  unansweredSince,
  useRedisLink,
  type RedisLink,
} from "../lib/redisLink";
import { usePageTitle } from "../lib/usePageTitle";
import { useDismiss } from "../lib/useDismiss";
import { AdminAccessNote } from "../components/AdminAccessNote";
import { ConfirmButton } from "../components/ConfirmButton";
import type { AdminActionOut, AdminMenuOut, ControlsOut } from "../lib/types";

// The analysis side acknowledges a control key K by writing K_READBACK, and
// the readback map is keyed by those full names.
const READBACK_SUFFIX = "_READBACK";

// The free-form box writes under the control namespace, as V2's did: the
// typed key is prefixed and uppercased (anything but letters, digits and _
// becomes _), and the value is uppercased with spaces and control characters
// collapsed to single underscores. Unlike V2, a key typed in full doesn't get
// the prefix twice.
const CONTROL_PREFIX = "RUBINTV_CONTROL_";

function controlKey(typed: string): string {
  const key = typed.trim().replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
  return key.startsWith(CONTROL_PREFIX) ? key : CONTROL_PREFIX + key;
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

type Outcome = { state: "pending" | "ok" | "err"; text: string };

// The time an outcome is shown at, so sending the same value twice still
// visibly changes the box.
const now = () => new Date().toTimeString().slice(0, 8);

// One box's action and its outcome. Each box reports in itself, next to the
// control that was used, so a send (or a 503 "redis not configured", or a 403
// from the admin gate) can't go unnoticed at the other end of the page.
function useAction() {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const run = async (fn: () => Promise<AdminActionOut>, okText?: string) => {
    setOutcome({ state: "pending", text: "Sending…" });
    try {
      const res = await fn();
      const text = okText ?? (res.detail || "Done");
      setOutcome({ state: res.ok ? "ok" : "err", text: `${text} · ${now()}` });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      setOutcome({ state: "err", text: `Failed — ${msg} · ${now()}` });
    }
  };
  return { outcome, run };
}

function ActionStatus({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  return (
    <p role="status" className={`admin-status ${outcome.state}`}>
      {outcome.text}
    </p>
  );
}

// Global admin/ops panel (one per deployment). Shows the app version, control
// boxes that send plain-SET values to Redis (with live readback), an arbitrary
// key/value sender, witness-detector and reset-head-node actions, and a danger
// zone (flush historical cache, flush redis). Control readback updates live via
// the admin WS topic.
export function Admin() {
  usePageTitle("Admin");
  const qc = useQueryClient();
  // Site-wide subscription (empty location keys the admin|| topic).
  useLiveTopic({ topic: "admin", location: "" });

  const { data: status } = useQuery({
    queryKey: ["adminStatus"],
    queryFn: api.adminStatus,
    staleTime: STALE.config,
  });

  // Whether Redis can be written to and read back: "off" (none configured)
  // or "down" (configured, but not answering the server). The live link says
  // so as it changes; until its first message the status fetched with the
  // page does, and until that resolves we optimistically assume it is up.
  const link = useRedisLink();
  const redis: "up" | "off" | "down" = link
    ? !link.configured
      ? "off"
      : link.connected
        ? "up"
        : "down"
    : !status || (status.redis_enabled && status.redis_connected)
      ? "up"
      : status.redis_enabled
        ? "down"
        : "off";
  // Every control action except "Flush historical cache" writes to Redis and
  // 503s when it can't, so disable them all together (rather than letting
  // some fire into an error and others sit inert). The header's warning says
  // why they're greyed.
  const redisDown = redis !== "up";
  // The values shown were read before Redis stopped answering.
  const stale = redis === "down";
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

  return (
    <section className="admin">
      <header className="admin-header">
        <h1>Admin</h1>
        <span className="admin-version">
          {/* Deployed images show the setuptools-scm version without its
              local part (`+g<sha>`, plus `.d<date>` if dirty), which only
              repeats the sha beside it: `0.1.dev400+g9dff062da` reads
              `v0.1.dev400 · 9dff062`. A local checkout shows just the sha
              and date. */}
          {status
            ? status.is_release
              ? `v${status.version.split("+")[0]} · ${status.git_sha} · ${status.commit_date}`
              : `${status.git_sha} · ${status.commit_date}`
            : ""}
          {status?.user && <span> · signed in as {status.user}</span>}
          {redis === "off" && (
            <span className="admin-warn" role="alert">
              {" "}
              · Redis not configured — control writes are not possible
            </span>
          )}
          {redis === "down" && <RedisDown link={link} />}
        </span>
      </header>

      {status && locked && (
        <AdminAccessNote
          user={status.user ?? null}
          consequence="the controls below are disabled"
        />
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
            stale={stale}
            disabled={redisDown || locked}
            send={(value) => api.setControl(menu.key, value)}
          />
        ))}
      </div>

      <div className="admin-boxes admin-boxes-commands">
        <ArbitraryBox
          disabled={redisDown || locked}
          send={(key, value) => api.setControl(key, value)}
        />

        <WitnessBox
          value={status ? readbackOf(status.witness_detector_key) : undefined}
          stale={stale}
          disabled={redisDown || locked}
          send={(value) => api.setWitnessDetector(value)}
        />

        <ConfirmBox
          title="Reset Head Node"
          confirmLabel="Reset — confirm?"
          okText="Reset requested"
          disabled={redisDown || locked}
          action={api.resetHeadNode}
        />
      </div>

      <div className="admin-danger-zone">
        <h2>Danger zone</h2>
        <ConfirmBox
          title="Flush historical cache"
          note="Clears the cached history and rescans from S3. The site reloads history in the background."
          confirmLabel="Flush cache — confirm?"
          disabled={locked}
          action={api.flushHistorical}
          minor
        />
        <ConfirmBox
          title="Flush Redis"
          note="Wipes the entire Redis database. This cannot be undone."
          confirmLabel="Flush Redis — confirm?"
          disabled={redisDown || locked}
          action={api.flushRedis}
          minor
        />
      </div>
    </section>
  );
}

// The header's warning while a configured Redis isn't answering the server:
// writes can't be made, and the "Current" values are what was last read.
// The sentence in the live region holds still while that lasts; the age
// that grows is beside it, outside. Without the live link (the status
// fetched with the page said so) there is no time to give.
function RedisDown({ link }: { link: RedisLink | undefined }) {
  const now = useNow();
  const age = link ? unansweredFor(link, now) : null;
  return (
    <span className="admin-warn">
      {" "}
      ·{" "}
      <span role="alert">
        Redis unreachable{link ? ` ${unansweredSince(link, now)}` : ""} —
        control writes are not possible, and the current values are as last
        read
      </span>
      {age !== null && ` (${age})`}
    </span>
  );
}

// A control's value as the analysis side last acknowledged it. `stale`: it
// was read before Redis stopped answering, so it may no longer be so.
function Readback({ value, stale }: { value: string | undefined; stale: boolean }) {
  return (
    <p className={"admin-readback" + (stale ? " is-stale" : "")}>
      {stale ? "Last read" : "Current"}: <strong>{value ?? "—"}</strong>
    </p>
  );
}

// A configured control menu: the current readback (or a placeholder), and a
// list of the menu's values that sends one as soon as it's picked, as V2's
// did. Not a <select>: on Windows and Linux arrowing through a closed select
// fires a change per step, which would send every value passed over.
function MenuBox({
  menu,
  value,
  stale,
  send,
  disabled = false,
}: {
  menu: AdminMenuOut;
  value: string | undefined;
  stale: boolean;
  send: (value: string) => Promise<AdminActionOut>;
  disabled?: boolean;
}) {
  const { outcome, run } = useAction();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const pick = (item: string) => {
    setOpen(false);
    void run(() => send(item), `Sent ${item}`);
  };
  // The analysis side's readback may differ in case from the menu's value
  // (it has written "Danish" for DANISH).
  const isCurrent = (item: string) =>
    value !== undefined && item.toUpperCase() === value.toUpperCase();
  return (
    <div className="admin-box">
      <h2>{menu.title}</h2>
      <Readback value={value} stale={stale} />
      <div className="admin-picker" ref={ref}>
        <button
          type="button"
          className="admin-picker-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          Send a value <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div className="admin-picker-pop" role="menu" aria-label={menu.title}>
            {menu.items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={
                  isCurrent(item.label)
                    ? "admin-picker-item current"
                    : "admin-picker-item"
                }
                onClick={() => pick(item.label)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <ActionStatus outcome={outcome} />
    </div>
  );
}

// Send any key/value pair in the control namespace (see controlKey and
// controlValue); the key it will write is shown as it's typed.
function ArbitraryBox({
  send,
  disabled = false,
}: {
  send: (key: string, value: string) => Promise<AdminActionOut>;
  disabled?: boolean;
}) {
  const { outcome, run } = useAction();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  // Nothing typed (or only the prefix itself) names no key.
  const full = controlKey(key);
  const noKey = full === CONTROL_PREFIX;
  const onSend = () => {
    const v = controlValue(value);
    void run(() => send(full, v), `Sent ${v} to ${full}`);
  };
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
        <button type="button" onClick={onSend} disabled={disabled || noKey}>
          Send
        </button>
      </div>
      {/* Always present, so the box doesn't grow on the first keystroke;
          before a key is typed it shows the prefix that will be added. */}
      <p className="admin-note admin-sets">
        Sets {noKey ? `${CONTROL_PREFIX}…` : full}
      </p>
      <ActionStatus outcome={outcome} />
    </div>
  );
}

// Send a value to the witness-detector control key.
function WitnessBox({
  value,
  stale,
  send,
  disabled = false,
}: {
  value: string | undefined;
  stale: boolean;
  send: (value: string) => Promise<AdminActionOut>;
  disabled?: boolean;
}) {
  const { outcome, run } = useAction();
  const [v, setV] = useState("");
  return (
    <div className="admin-box">
      <h2>Witness Detector</h2>
      <Readback value={value} stale={stale} />
      <div className="admin-row">
        <input
          aria-label="witness detector value"
          placeholder="value"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
        <button
          type="button"
          onClick={() => void run(() => send(v), `Sent ${v}`)}
          disabled={disabled || v === ""}
        >
          Send
        </button>
      </div>
      <ActionStatus outcome={outcome} />
    </div>
  );
}

// A one-button action behind a confirm click (head-node reset, the danger
// zone's flushes). `minor` boxes sit inside a section with its own heading.
function ConfirmBox({
  title,
  note,
  confirmLabel,
  okText,
  disabled = false,
  action,
  minor = false,
}: {
  title: string;
  note?: string;
  confirmLabel: string;
  okText?: string;
  disabled?: boolean;
  action: () => Promise<AdminActionOut>;
  minor?: boolean;
}) {
  const { outcome, run } = useAction();
  const Heading = minor ? "h3" : "h2";
  return (
    <div className="admin-box">
      <Heading>{title}</Heading>
      {note && <p className="admin-note">{note}</p>}
      <ConfirmButton
        label={title}
        confirmLabel={confirmLabel}
        danger
        disabled={disabled}
        onConfirm={() => run(action, okText)}
      />
      <ActionStatus outcome={outcome} />
    </div>
  );
}
