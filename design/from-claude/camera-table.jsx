/* global React */
// Camera Table wireframe variations

const seqRows = [780, 779, 778, 777, 776, 775, 774, 773, 772, 771, 770];
const colorChips = ['c-cyan','c-mint','c-pink','c-violet','c-purp','c-blue','c-rose','c-orng'];
const channelLabels = ['Witness Detector','Post-ISR mosaic','Calexp mosaic','PSF shape AzEl','FWHM Focal Plane','Mount torques','Image Analysis','Event timeline'];
const metaCols = ['Exp.t','Img type','Witness Detector','Residual AOS FWHM','Sky mean','Target','Date begin','Focus Z','Filter','Group name','RA'];

function ChannelChip({ label, idx, dark }) {
  return (
    <div className={`chip ${colorChips[idx % colorChips.length]} ${dark ? 'dark':''}`}
      style={{ aspectRatio: 'auto', height: 70, width: 100, borderRadius: 4, position: 'relative' }}>
      <div className="hand" style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', padding: 4, fontSize: 12, color: '#1d1d22'
      }}>{label}</div>
    </div>
  );
}

function MiniCell({ idx, empty }) {
  if (empty) return <div className="chip" style={{ background: 'transparent', borderColor: '#b7b7bd' }} />;
  return <div className={`chip ${colorChips[idx % colorChips.length]}`} />;
}

/* ========= Variation A: Refined current layout ========= */
function CameraTableA() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 1100 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">A — Refined current layout</div>
          <div className="vsub">top header • channel chip rail • dense table • subtle accent</div>
        </div>
        <span className="tag live"><span className="hand">live</span></span>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div className="hand-b" style={{ fontSize: 36, lineHeight: 1 }}>LSSTCam</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 4 }}>
            summit-usdf · latest 2026-04-30 · <span className="squiggle">summit quicklook processing</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="btn btn-tab">◐ Historical</span>
          <span className="btn">◇ Night Report</span>
        </div>
      </div>

      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 16 }}>
        home / summit / lsstcam
      </div>

      {/* Channel rail */}
      <div className="hand" style={{ fontSize: 13, marginBottom: 6, color: 'var(--ink-soft)' }}>current image channels</div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {channelLabels.map((c,i)=> <ChannelChip key={c} label={c} idx={i} />)}
      </div>

      {/* Date + controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span className="btn">◀ 2026-04-30</span>
        <span className="btn">+ Add/Remove Columns</span>
        <span className="btn">↓ Download Metadata</span>
        <span className="mono" style={{ fontSize: 12, padding: '4px 8px', border: '1.25px solid var(--ink)', borderRadius: 4 }}>14:01:25 UTC</span>
        <span className="tag" style={{ background: 'var(--accent-soft)' }}>
          <span className="hand">since last image: 03:48:07</span>
        </span>
      </div>

      {/* Table */}
      <div className="scroller" style={{ padding: 0 }}>
        {/* Column headers (rotated) */}
        <div style={{ display: 'grid', gridTemplateColumns: '60px repeat(8, 36px) repeat(11, 1fr)', borderBottom: '1.5px solid var(--ink)', background: 'var(--paper)' }}>
          <div className="hand" style={{ padding: 8, fontSize: 11, borderRight: '1px dashed var(--ink)', textAlign: 'center' }}>Seq.No</div>
          {channelLabels.map((c,i) => (
            <div key={i} className="mono" style={{
              fontSize: 9, padding: '24px 2px 6px', borderRight: '1px dashed #b7b7bd',
              writingMode: 'vertical-rl', transform: 'rotate(180deg)',
              color: 'var(--ink-soft)', whiteSpace: 'nowrap'
            }}>{c}</div>
          ))}
          {metaCols.map((m,i) => (
            <div key={m} className="mono" style={{
              fontSize: 9, padding: '24px 4px 6px', borderRight: '1px dashed #b7b7bd',
              transform: 'rotate(-15deg)', transformOrigin: 'left bottom',
              color: 'var(--ink-soft)', whiteSpace: 'nowrap'
            }}>{m}</div>
          ))}
        </div>

        {seqRows.map((s, ri) => (
          <div key={s} style={{
            display: 'grid', gridTemplateColumns: '60px repeat(8, 36px) repeat(11, 1fr)',
            borderBottom: '1px dashed #b7b7bd',
            background: ri === 0 ? 'rgba(107,91,214,0.08)' : 'transparent',
            position: 'relative'
          }}>
            <div className="mono" style={{ padding: 6, fontSize: 11, borderRight: '1px dashed var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{s}</div>
            {channelLabels.map((_, i) => (
              <div key={i} style={{ padding: 4, borderRight: '1px dashed #b7b7bd' }}>
                <MiniCell idx={i} empty={Math.random() > 0.85} />
              </div>
            ))}
            {metaCols.map((m,i) => (
              <div key={m} className="mono" style={{ padding: 6, fontSize: 10, borderRight: '1px dashed #b7b7bd', color: 'var(--ink-2)' }}>
                {i === 0 ? '15' : i === 1 ? 'science' : i === 2 ? 'R22_S11' : i === 3 ? '0.36' : i === 4 ? '9372.50' : i === 5 ? 'lowdst' : i === 6 ? '...12:20.281' : i === 7 ? '-2.65' : i === 8 ? 'z_20' : i === 9 ? 'BT664...' : '8.11'}
              </div>
            ))}
            {ri === 0 && (
              <div className="callout" style={{ position: 'absolute', right: -160, top: 4, width: 150 }}>
                ↰ newest row<br/>highlighted for 3s
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="callout" style={{ marginTop: 18, maxWidth: 520 }}>
        ↑ keep the current "channel chip rail" but make labels readable, drop the
        rotated headers below into 15° angle, and pin the latest seq-num row.
      </div>
    </div>
  );
}

/* ========= Variation B: Sidebar nav + cleaner table ========= */
function CameraTableB() {
  return (
    <div style={{ padding: 0, background: 'var(--paper)', minHeight: 1100, display: 'grid', gridTemplateColumns: '220px 1fr' }}>
      {/* Sidebar */}
      <div style={{ borderRight: '1.5px solid var(--ink)', padding: 18, background: 'var(--paper-2)' }}>
        <div className="hand-b" style={{ fontSize: 22 }}>RubinTV</div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>summit-usdf</div>

        <div className="divider" />
        <div className="hand" style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 6 }}>cameras</div>
        {['LSSTCam','LSSTCamAOS','AuxTel','TMA','AllSky','ComCam'].map((c,i) => (
          <div key={c} className="hand" style={{
            padding: '6px 10px', marginBottom: 4, fontSize: 14,
            background: i === 0 ? 'var(--ink)' : 'transparent',
            color: i === 0 ? 'var(--paper)' : 'var(--ink)',
            border: '1.25px solid var(--ink)', borderRadius: 4
          }}>{c}</div>
        ))}

        <div className="divider" />
        <div className="hand" style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 6 }}>views</div>
        {['Table','Channel','Mosaic','Night Report','Detectors','Admin'].map((v,i) => (
          <div key={v} className="hand" style={{
            padding: '4px 8px', marginBottom: 2, fontSize: 13,
            background: i === 0 ? 'var(--accent-soft)' : 'transparent',
            borderRadius: 4
          }}>{v}</div>
        ))}

        <div className="divider" />
        <div className="callout" style={{ fontSize: 12 }}>
          ← persistent left nav<br/>kills full-page reloads
        </div>
      </div>

      {/* Main */}
      <div style={{ padding: 20 }}>
        <div className="vhead">
          <div>
            <div className="vlabel">B — Sidebar shell</div>
            <div className="vsub">camera & view in sidebar • tabs above table • everything one click away</div>
          </div>
          <span className="tag live"><span className="hand">live · 14:01 UTC</span></span>
        </div>

        <div className="hand-b" style={{ fontSize: 32 }}>LSSTCam</div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 16 }}>
          2026-04-30 · 786 seq · time since last: 03:48
        </div>

        {/* sub tabs */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 14, borderBottom: '1.5px solid var(--ink)' }}>
          {['Table','Channels','Mosaic','Night report','Detectors'].map((t,i) => (
            <div key={t} className="hand" style={{
              padding: '8px 14px', fontSize: 14,
              background: i === 0 ? 'var(--paper)' : 'transparent',
              border: i === 0 ? '1.5px solid var(--ink)' : 'none',
              borderBottom: i === 0 ? '1.5px solid var(--paper)' : 'none',
              borderRadius: '5px 5px 0 0',
              marginBottom: -1.5
            }}>{t}</div>
          ))}
        </div>

        {/* date strip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span className="btn">◀</span>
          <span className="btn btn-tab">📅 2026-04-30</span>
          <span className="btn">▶</span>
          <span style={{ flex: 1 }} />
          <span className="btn">⚙ columns (14)</span>
          <span className="btn">↓ csv</span>
        </div>

        {/* simplified column-first table */}
        <div className="scroller" style={{ padding: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '50px 1.2fr 0.6fr 0.8fr 0.8fr 0.6fr 1.4fr 0.6fr', borderBottom: '1.5px solid var(--ink)', background: 'var(--paper)' }}>
            {['#','channels','exp','img type','witness','filter','group','RA'].map(h => (
              <div key={h} className="hand" style={{ padding: '8px 10px', fontSize: 12, color: 'var(--ink-soft)', borderRight: '1px dashed var(--line-soft)' }}>{h}</div>
            ))}
          </div>
          {seqRows.map((s, ri) => (
            <div key={s} style={{
              display: 'grid', gridTemplateColumns: '50px 1.2fr 0.6fr 0.8fr 0.8fr 0.6fr 1.4fr 0.6fr',
              borderBottom: '1px dashed #b7b7bd',
              background: ri === 0 ? 'rgba(107,91,214,0.10)' : ri % 2 ? 'var(--paper-2)' : 'transparent'
            }}>
              <div className="mono" style={{ padding: '8px 10px', fontSize: 11 }}>{s}</div>
              <div style={{ padding: 6, display: 'flex', gap: 3 }}>
                {channelLabels.map((_,i) => (
                  <div key={i} className={`chip ${colorChips[i]}`} style={{ width: 22, height: 22, borderRadius: 3 }} />
                ))}
              </div>
              <div className="mono" style={{ padding: '8px 10px', fontSize: 11 }}>15</div>
              <div className="mono" style={{ padding: '8px 10px', fontSize: 11 }}>science</div>
              <div className="mono" style={{ padding: '8px 10px', fontSize: 11 }}>R22_S11</div>
              <div className="mono" style={{ padding: '8px 10px', fontSize: 11, background: ri % 3 === 0 ? '#e6c5cb' : 'transparent' }}>z_20</div>
              <div className="mono" style={{ padding: '8px 10px', fontSize: 10, color: 'var(--ink-soft)' }}>BT664_O_20260429...</div>
              <div className="mono" style={{ padding: '8px 10px', fontSize: 11 }}>{(8 + ri * 0.3).toFixed(2)}</div>
            </div>
          ))}
        </div>

        <div className="callout" style={{ marginTop: 14, maxWidth: 480 }}>
          ↑ channel chips collapse into a row preview cell;
          click row → opens drawer with full channel images
        </div>
      </div>
    </div>
  );
}

/* ========= Variation C: Stream / feed view (bold rethink) ========= */
function CameraTableC() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 1100 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">C — Stream view</div>
          <div className="vsub">latest seq fills the frame • prior seqs scroll below • metadata as inline cards</div>
        </div>
        <span className="tag live"><span className="hand">live</span></span>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <span className="hand-b" style={{ fontSize: 28 }}>LSSTCam · 2026-04-30</span>
        <span style={{ flex: 1 }} />
        <span className="btn btn-active hand">▣ feed</span>
        <span className="btn hand">≡ table</span>
        <span className="btn hand">📅 calendar</span>
      </div>

      {/* Hero current seq */}
      <div className="wf wf-thick" style={{ padding: 16, background: 'var(--paper-2)', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 12 }}>
          <span className="hand-b" style={{ fontSize: 22 }}>seq 786</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>just now · 14:01:25 UTC</span>
          <span style={{ flex: 1 }} />
          <span className="tag">filter z_20</span>
          <span className="tag">science</span>
          <span className="tag">R22_S11</span>
          <span className="tag">15s</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {channelLabels.slice(0,8).map((c,i) => (
            <div key={c}>
              <div className="ph" style={{ height: 110, borderRadius: 4 }}>{c.toLowerCase()}.png</div>
              <div className="hand" style={{ fontSize: 12, marginTop: 4 }}>{c}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="hand" style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 6 }}>previous seqs ↓</div>

      {seqRows.slice(1, 6).map(s => (
        <div key={s} className="wf" style={{ padding: 10, marginBottom: 8, display: 'grid', gridTemplateColumns: '70px 1fr auto', alignItems: 'center', gap: 12 }}>
          <div>
            <div className="hand-b" style={{ fontSize: 16 }}>seq {s}</div>
            <div className="mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>14:0{s%9}:00</div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {channelLabels.map((_, i) => (
              <div key={i} className={`chip ${colorChips[i]}`} style={{ width: 36, height: 36, borderRadius: 3 }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <span className="tag">z_20</span>
            <span className="tag mono">{(8+s*0.01).toFixed(2)}</span>
            <span className="tag">science</span>
          </div>
        </div>
      ))}

      <div className="callout" style={{ marginTop: 8, maxWidth: 440 }}>
        ↑ optimised for "watching the night unfold"<br/>
        flips the metaphor: timeline-first, table on demand
      </div>
    </div>
  );
}

/* ========= Variation D: Hybrid — split panel (table + preview) ========= */
function CameraTableD() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 1100 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">D — Split panel</div>
          <div className="vsub">compact left table • selected row's images on the right • prev/next keys</div>
        </div>
        <span className="tag"><span className="hand">cell flash on update</span></span>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <span className="hand-b" style={{ fontSize: 22 }}>LSSTCam</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>2026-04-30 · 786 events</span>
        <span style={{ flex: 1 }} />
        <span className="btn">⚙ columns</span>
        <span className="btn">filter</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '44% 56%', gap: 14 }}>
        {/* Left: compact table */}
        <div className="scroller">
          <div style={{ display: 'grid', gridTemplateColumns: '46px 1fr 50px 60px 50px', borderBottom: '1.5px solid var(--ink)', background: 'var(--paper)' }}>
            {['seq','channels','exp','witness','filter'].map(h => (
              <div key={h} className="hand" style={{ padding: '6px 8px', fontSize: 11, color: 'var(--ink-soft)', borderRight: '1px dashed var(--line-soft)' }}>{h}</div>
            ))}
          </div>
          {seqRows.map((s, ri) => (
            <div key={s} style={{
              display: 'grid', gridTemplateColumns: '46px 1fr 50px 60px 50px',
              borderBottom: '1px dashed #b7b7bd',
              background: ri === 1 ? 'var(--accent-soft)' : ri === 0 ? 'rgba(217,119,66,0.15)' : 'transparent',
              position: 'relative',
              animation: ri === 0 ? 'pulse 2s infinite' : 'none'
            }}>
              <div className="mono" style={{ padding: '6px 8px', fontSize: 11 }}>{s}</div>
              <div style={{ padding: 4, display: 'flex', gap: 2 }}>
                {channelLabels.map((_,i) => (
                  <div key={i} className={`chip ${colorChips[i]}`} style={{ width: 14, height: 14, borderRadius: 2 }} />
                ))}
              </div>
              <div className="mono" style={{ padding: '6px 8px', fontSize: 10 }}>15</div>
              <div className="mono" style={{ padding: '6px 8px', fontSize: 10 }}>R22_S11</div>
              <div className="mono" style={{ padding: '6px 8px', fontSize: 10 }}>z_20</div>
              {ri === 1 && (
                <div style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }} className="hand">▸</div>
              )}
            </div>
          ))}
        </div>

        {/* Right: preview */}
        <div>
          <div className="wf" style={{ padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span className="hand-b" style={{ fontSize: 26 }}>seq 779</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>← → to navigate</span>
              <span style={{ flex: 1 }} />
              <span className="btn">↗ open</span>
            </div>
            <div className="divider-soft" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {channelLabels.slice(0,4).map(c => (
                <div key={c}>
                  <div className="ph" style={{ height: 130, borderRadius: 3 }}>{c}</div>
                </div>
              ))}
            </div>
            <div className="divider-soft" />
            <div className="hand" style={{ fontSize: 13, marginBottom: 4, color: 'var(--ink-soft)' }}>metadata</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }} className="mono">
              {[['exp time','15s'],['img type','science'],['target','lowdst'],['filter','z_20'],['focus Z','-2.63'],['RA','4.51'],['date begin','2026-05-01T10:11:51.738']].map(([k,v]) => (
                <React.Fragment key={k}>
                  <div style={{ fontSize: 10, color: 'var(--ink-soft)' }}>{k}</div>
                  <div style={{ fontSize: 11 }}>{v}</div>
                </React.Fragment>
              ))}
            </div>
          </div>

          <div className="callout" style={{ marginTop: 10 }}>
            cells in the table flash for 1.5s when their underlying<br/>
            channel updates — subtle live signal without chrome
          </div>
        </div>
      </div>
    </div>
  );
}

window.CameraTableA = CameraTableA;
window.CameraTableB = CameraTableB;
window.CameraTableC = CameraTableC;
window.CameraTableD = CameraTableD;
