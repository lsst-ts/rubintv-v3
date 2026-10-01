/* global React, window */
// Four hi-fi explorations of the Channels tab for a single camera (LSSTCam).
// All share the top chrome (CHTopBar + CHCameraHero) and differ only in how
// they present the channel list itself.

const TopBar = () => React.createElement(window.CHTopBar);
const Hero   = () => React.createElement(window.CHCameraHero);

// ─────────────────────────────────────────────────────────────────
//  Layout A — Latest-frame grid (matches the reference image.png card style)
//  Each channel is a portrait card: large striped placeholder for the
//  most recent frame, then title + status + description + seq/age line.
// ─────────────────────────────────────────────────────────────────

function ChannelCardA({ ch }) {
  return (
    <div style={{
      background: 'var(--surf)',
      border: '1px solid var(--hair)',
      borderRadius: 8,
      overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      <div className="placeholder" style={{ height: 168, borderRadius: 0, border: 'none', borderBottom: '1px solid var(--hair)' }}>
        <div className="ph-label" style={{ color: ch.color, letterSpacing: '0.18em' }}>{ch.title.toUpperCase()}</div>
        <div className="ph-sub">LATEST FRAME · SEQ {ch.seq}</div>
      </div>
      <div style={{ padding: '14px 18px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: ch.color, transform: 'translateY(-2px)' }} />
          <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 600, flex: 1, lineHeight: 1.1 }}>{ch.title}</div>
          <span className={'tag ' + (ch.perDay ? 'tag-standby' : 'tag-active')}>{ch.perDay ? 'PER DAY' : 'LIVE'}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--cream-2)', marginTop: 6 }}>{ch.desc}</div>
        <div style={{
          display: 'flex', gap: 14, marginTop: 12, paddingTop: 10,
          borderTop: '1px dashed var(--hair)',
          fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--dim)',
          letterSpacing: '0.05em', textTransform: 'uppercase',
        }}>
          <span><span style={{ color: 'var(--cream-2)', fontWeight: 600, marginRight: 6 }}>seq</span>{ch.seq}</span>
          <span style={{ color: 'var(--hair-2)' }}>·</span>
          <span>last {ch.updated}</span>
        </div>
      </div>
    </div>
  );
}

function ChannelsTabA() {
  const list = window.RUBIN_CHANNELS;
  return (
    <div className="ch-root">
      <TopBar />
      <Hero />
      <div className="section-h">
        <h2>Image channels</h2>
        <div className="rule" />
        <div className="meta">8 LIVE · 1 PER-DAY</div>
      </div>
      <div className="toolbar">
        <button className="tb-btn"><span className="ic">◀</span>{window.RUBIN_CAMERA.dayObs}<span className="ic">▶</span></button>
        <button className="tb-btn">Historical <span className="ic">↻</span></button>
        <button className="tb-btn">Open table view <span className="ic">↗</span></button>
        <div className="tb-grow" />
        <div className="tb-clock">{window.RUBIN_CAMERA.utcClock}<span className="u">UTC</span></div>
        <div className="tb-since">since last image · {window.RUBIN_CAMERA.timeSinceLast}</div>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 18,
        padding: '0 36px 40px',
      }}>
        {list.map(ch => <ChannelCardA key={ch.name} ch={ch} />)}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
//  Layout B — Featured hero + thumbnail rail
//  One channel takes a large display at the top; the rest sit in a
//  scrollable rail. Good for "watching the night unfold" when there's
//  a primary channel you keep an eye on.
// ─────────────────────────────────────────────────────────────────

function ChannelsTabB() {
  const list = window.RUBIN_CHANNELS;
  const [focused, setFocused] = useState('focal_plane_mosaic');
  const hero = list.find(c => c.name === focused) || list[1];

  return (
    <div className="ch-root">
      <TopBar />
      <Hero />
      <div className="section-h">
        <h2>Channel viewer</h2>
        <div className="rule" />
        <div className="meta">FOCUSED · {hero.title.toUpperCase()}</div>
      </div>

      <div style={{ padding: '0 36px 28px', display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24 }}>
        {/* Hero */}
        <div style={{ background: 'var(--surf)', border: '1px solid var(--hair)', borderRadius: 8, overflow: 'hidden' }}>
          <div className="placeholder" style={{ height: 460, borderRadius: 0, border: 'none' }}>
            <div className="ph-label" style={{ color: hero.color, fontSize: 13, letterSpacing: '0.2em' }}>{hero.title.toUpperCase()}</div>
            <div className="ph-sub">LATEST FRAME · SEQ {hero.seq} · {window.RUBIN_CAMERA.dayObs}</div>
          </div>
          <div style={{ padding: '16px 22px', display: 'flex', alignItems: 'center', gap: 14, borderTop: '1px solid var(--hair)' }}>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 600 }}>{hero.title}</div>
            <span className="tag tag-active">LIVE</span>
            <div style={{ color: 'var(--cream-2)', fontSize: 12, flex: 1 }}>{hero.desc}</div>
            <button className="tb-btn">↗ Open full</button>
            <button className="tb-btn">⤓ Download</button>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)',
            gap: 1, padding: 1, background: 'var(--hair)',
          }}>
            {[
              ['exp time', '15 s'],
              ['filter', 'z_20'],
              ['target', 'lowdust'],
              ['focus Z', '−2.65'],
              ['residual AOS', '0.38"'],
              ['RA', '8.11°'],
            ].map(([k,v]) => (
              <div key={k} style={{ background: 'var(--bg-2)', padding: '10px 12px' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dim)' }}>{k}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--cream)', marginTop: 3 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Right rail */}
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--dim)', textTransform: 'uppercase', marginBottom: 10 }}>
            All channels · click to focus
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.map(ch => (
              <div
                key={ch.name}
                onClick={() => setFocused(ch.name)}
                style={{
                  display: 'grid', gridTemplateColumns: '70px 1fr auto', gap: 12,
                  padding: 8, alignItems: 'center',
                  background: ch.name === hero.name ? 'var(--surf-2)' : 'var(--surf)',
                  border: '1px solid ' + (ch.name === hero.name ? ch.color : 'var(--hair)'),
                  borderRadius: 6, cursor: 'pointer',
                }}>
                <div className="placeholder" style={{ height: 50, borderRadius: 3 }}>
                  <div style={{ width: 14, height: 14, borderRadius: 2, background: ch.color, opacity: 0.95 }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: 14, fontWeight: 600, color: 'var(--cream)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.title}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>seq {ch.seq} · {ch.updated}</div>
                </div>
                <div style={{ width: 6, height: 28, background: ch.color, borderRadius: 2 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
//  Layout C — Grouped sidebar list + single viewer
//  Long, dense list of channels organised by group on the left,
//  a single large preview + metadata on the right. Built for a
//  dashboard / kiosk that stays on one channel at a time.
// ─────────────────────────────────────────────────────────────────

function ChannelsTabC() {
  const list = window.RUBIN_CHANNELS;
  const groups = window.RUBIN_CHANNEL_GROUPS;
  const byName = Object.fromEntries(list.map(c => [c.name, c]));
  const [focused, setFocused] = useState('calexp_mosaic');
  const hero = byName[focused];

  return (
    <div className="ch-root">
      <TopBar />
      <Hero />
      <div style={{
        display: 'grid', gridTemplateColumns: '300px 1fr',
        borderTop: '1px solid var(--hair)',
        minHeight: 600,
      }}>
        {/* Left: grouped list */}
        <div style={{ borderRight: '1px solid var(--hair)', padding: '22px 0' }}>
          <div style={{ padding: '0 22px 14px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 600 }}>Channels</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', letterSpacing: '0.1em' }}>{list.length} TOTAL</div>
          </div>
          {groups.map(g => (
            <div key={g.title} style={{ marginBottom: 14 }}>
              <div style={{
                padding: '6px 22px',
                fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.14em',
                color: 'var(--dim)', textTransform: 'uppercase',
              }}>{g.title}</div>
              {g.names.map(n => {
                const ch = byName[n];
                const active = n === focused;
                return (
                  <div key={n} onClick={() => setFocused(n)} style={{
                    display: 'grid', gridTemplateColumns: '4px 1fr auto', gap: 12,
                    padding: '9px 22px', alignItems: 'center',
                    background: active ? 'var(--surf)' : 'transparent',
                    borderLeft: '3px solid ' + (active ? ch.color : 'transparent'),
                    cursor: 'pointer',
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: ch.color }} />
                    <div>
                      <div style={{ fontFamily: 'var(--serif)', fontSize: 14, fontWeight: active ? 600 : 500, color: active ? 'var(--cream)' : 'var(--cream-2)' }}>{ch.title}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>seq {ch.seq} · {ch.updated}</div>
                    </div>
                    <span className={'tag ' + (ch.perDay ? 'tag-standby' : 'tag-active')} style={{ fontSize: 8.5, padding: '1px 5px' }}>{ch.perDay ? 'DAY' : 'LIVE'}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Right: viewer */}
        <div style={{ padding: '22px 36px 32px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 14 }}>
            <div style={{ width: 12, height: 12, borderRadius: 3, background: hero.color }} />
            <div style={{ fontFamily: 'var(--serif)', fontSize: 30, fontWeight: 600 }}>{hero.title}</div>
            <span className="tag tag-active">LIVE</span>
            <div style={{ flex: 1 }} />
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>seq {hero.seq} · updated {hero.updated}</div>
          </div>
          <div className="placeholder" style={{ height: 380 }}>
            <div className="ph-label" style={{ color: hero.color, fontSize: 13, letterSpacing: '0.2em' }}>{hero.title.toUpperCase()}</div>
            <div className="ph-sub">SEQ {hero.seq} · {window.RUBIN_CAMERA.dayObs}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 24, marginTop: 18 }}>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--dim)', textTransform: 'uppercase', marginBottom: 8 }}>Description</div>
              <div style={{ fontSize: 14, color: 'var(--cream-2)', lineHeight: 1.55, textWrap: 'pretty' }}>{hero.desc}. Generated per exposure by the Summit Quicklook pipeline and refreshed automatically as new seq numbers arrive.</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button className="tb-btn">↗ Open in viewer</button>
                <button className="tb-btn">⤓ FITS</button>
                <button className="tb-btn">⌖ Quicklook FOV</button>
              </div>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--dim)', textTransform: 'uppercase', marginBottom: 8 }}>Exposure metadata</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                {[
                  ['exp time', '15 s'],
                  ['image type', 'science'],
                  ['target', 'lowdust'],
                  ['filter', 'z_20'],
                  ['focus Z', '−2.65'],
                  ['witness', 'R22_S11'],
                  ['sky mean', '9 372.50'],
                  ['date begin', '10:12:16'],
                ].map(([k,v]) => (
                  <React.Fragment key={k}>
                    <div style={{ color: 'var(--dim)' }}>{k}</div>
                    <div style={{ color: 'var(--cream)' }}>{v}</div>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
//  Layout D — Contact sheet (wall of frames)
//  Every channel as a wide tile with its colour as a top accent bar.
//  Minimal chrome, optimised for glance-and-scan on a big screen.
// ─────────────────────────────────────────────────────────────────

function ChannelTileD({ ch, big }) {
  return (
    <div style={{
      background: 'var(--surf)',
      border: '1px solid var(--hair)',
      borderRadius: 6,
      overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ height: 4, background: ch.color }} />
      <div className="placeholder" style={{ flex: 1, borderRadius: 0, border: 'none', minHeight: big ? 200 : 130 }}>
        <div className="ph-label" style={{ color: ch.color, fontSize: 11, letterSpacing: '0.2em' }}>{ch.title.toUpperCase()}</div>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px',
        borderTop: '1px solid var(--hair)',
        background: 'var(--bg-2)',
      }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 14, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.title}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>{ch.seq}</div>
        <div style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--grn)', boxShadow: '0 0 0 3px rgba(95,165,108,0.15)' }} />
      </div>
    </div>
  );
}

function ChannelsTabD() {
  const list = window.RUBIN_CHANNELS;
  // Pull the per-day movie out — it deserves a wider tile.
  const movies = list.filter(c => c.perDay);
  const frames = list.filter(c => !c.perDay);
  return (
    <div className="ch-root">
      <TopBar />
      <Hero />
      <div className="section-h">
        <h2>Contact sheet</h2>
        <div className="rule" />
        <div className="meta">SEQ {window.RUBIN_CAMERA.lastSeq} · ALL CHANNELS</div>
      </div>
      <div className="toolbar">
        <button className="tb-btn"><span className="ic">◀</span>{window.RUBIN_CAMERA.dayObs}<span className="ic">▶</span></button>
        <button className="tb-btn">Auto-refresh <span style={{ color: 'var(--grn)' }}>● on</span></button>
        <button className="tb-btn">Density <span style={{ color: 'var(--cream)' }}>4×</span></button>
        <div className="tb-grow" />
        <div className="tb-clock">{window.RUBIN_CAMERA.utcClock}<span className="u">UTC</span></div>
        <div className="tb-since">since last · {window.RUBIN_CAMERA.timeSinceLast}</div>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12,
        padding: '0 36px 12px',
      }}>
        {frames.map(ch => <ChannelTileD key={ch.name} ch={ch} />)}
      </div>
      {movies.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr', gap: 12,
          padding: '4px 36px 32px',
        }}>
          {movies.map(ch => (
            <div key={ch.name} style={{
              background: 'var(--surf)', border: '1px solid var(--hair)', borderRadius: 6,
              display: 'grid', gridTemplateColumns: '4px 1fr',
            }}>
              <div style={{ background: ch.color }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', padding: '14px 20px', gap: 16 }}>
                <div>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 600 }}>{ch.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--cream-2)', marginTop: 4 }}>{ch.desc} · rolling stitch updated every minute</div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="tag tag-standby">PER DAY</span>
                  <button className="tb-btn">▶ Play</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, {
  ChannelsTabA, ChannelsTabB, ChannelsTabC, ChannelsTabD,
});
