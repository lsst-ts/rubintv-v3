/* global React */
// Detector cluster status wireframes

function DetectorMosaic({ states, density = 1, dark = false }) {
  // 21x21 grid roughly resembling LSST focal plane (cross shape)
  const rows = 15;
  const cols = 15;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // cross / waffle shape
      const dx = Math.abs(c - (cols - 1) / 2);
      const dy = Math.abs(r - (rows - 1) / 2);
      const inside = dx + dy <= 9 && !(dx > 5.5 && dy > 5.5);
      if (!inside) { cells.push(null); continue; }
      const stateIdx = Math.floor(Math.random() * states.length);
      cells.push(states[stateIdx]);
    }
  }
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gap: 1.5,
      width: '100%',
      aspectRatio: '1 / 1',
      padding: 6
    }}>
      {cells.map((s, i) => (
        <div key={i} className={s ? `ccd ${s}` : ''} style={{ visibility: s ? 'visible' : 'hidden' }} />
      ))}
    </div>
  );
}

const STATES = ['s-free','s-busy','s-queue','s-restart','s-guest','s-missing'];
const STATE_LABELS = [['s-free','Free'],['s-busy','Busy'],['s-queue','Queued'],['s-restart','Restarting'],['s-guest','Guest payload'],['s-missing','Missing']];

function StateLegend({ inline }) {
  return (
    <div style={{ display: 'flex', gap: inline ? 14 : 10, flexWrap: 'wrap', alignItems: 'center' }}>
      {STATE_LABELS.map(([cls, label]) => (
        <div key={cls} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <div className={`chip ${cls}`} style={{ width: 14, height: 14, borderRadius: 2 }} />
          <span className="hand" style={{ fontSize: 12 }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

/* ============ Variation A: Big mosaics, current layout cleaned ============ */
function DetectorsA() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 1100 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">A — Big mosaics</div>
          <div className="vsub">closest to today • two imaging sets above • CWFS sets in row below</div>
        </div>
        <span className="tag live"><span className="hand">redis stream</span></span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <span className="hand-b" style={{ fontSize: 32 }}>Cluster Status</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>USDF · home › usdf › detectors</span>
      </div>

      <div style={{ marginBottom: 14 }}>
        <StateLegend />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 0.6fr', gap: 14, marginBottom: 14 }}>
        <div className="wf" style={{ padding: 10 }}>
          <div className="hand-b" style={{ fontSize: 16, marginBottom: 6 }}>Imaging Worker Set 1</div>
          <DetectorMosaic states={STATES} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <span className="btn" style={{ background: '#e8c490' }}>Restart Workers</span>
          </div>
        </div>
        <div className="wf" style={{ padding: 10 }}>
          <div className="hand-b" style={{ fontSize: 16, marginBottom: 6 }}>Imaging Worker Set 2</div>
          <DetectorMosaic states={STATES} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <span className="btn" style={{ background: '#e8c490' }}>Restart Workers</span>
          </div>
        </div>
        <div className="wf" style={{ padding: 10 }}>
          <div className="hand-b" style={{ fontSize: 16, marginBottom: 6 }}>SFM Step 1b</div>
          <div className="hatch" style={{ height: 220, border: '1px dashed var(--ink)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>narrow column</span>
          </div>
        </div>
      </div>

      {/* CWFS sets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 14 }}>
        {[1,2,3,4].map(n => (
          <div key={n} className="wf" style={{ padding: 8 }}>
            <div className="hand-b" style={{ fontSize: 13, marginBottom: 4 }}>CWFS Worker Set {n}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, height: 130 }}>
              {[...Array(9)].map((_,i) => <div key={i} className={`chip ${STATES[i % STATES.length]}`} style={{ aspectRatio: 'auto', height: '100%' }} />)}
            </div>
            <div className="hand" style={{ textAlign: 'right', fontSize: 11, marginTop: 4, color: 'var(--warn)' }}>↻ Restart</div>
          </div>
        ))}
        <div className="wf" style={{ padding: 8 }}>
          <div className="hand-b" style={{ fontSize: 13, marginBottom: 4 }}>AOS Step 1b</div>
          <div className="hatch" style={{ height: 130, border: '1px dashed var(--ink)' }} />
        </div>
      </div>

      {/* Backlog + Other queues */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14 }}>
        <div className="wf" style={{ padding: 10 }}>
          <div className="hand-b" style={{ fontSize: 14, marginBottom: 4 }}>Backlog Workers</div>
          <span className="btn" style={{ background: '#e8c490' }}>Restart Workers</span>
        </div>
        <div className="wf" style={{ padding: 10 }}>
          <div className="hand-b" style={{ fontSize: 14, marginBottom: 6 }}>Other Queues</div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', borderTop: '1px dashed var(--ink)' }}>
            <div className="hand" style={{ padding: 6, fontSize: 12, borderRight: '1px dashed var(--ink)' }}>Queue Name</div>
            <div className="hand" style={{ padding: 6, fontSize: 12 }}>Queue Length</div>
          </div>
          {['ats-queue','aos-queue','sfm-queue'].map((q,i) => (
            <div key={q} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', borderTop: '1px dashed var(--line-soft)' }}>
              <div className="mono" style={{ padding: 6, fontSize: 11, borderRight: '1px dashed var(--line-soft)' }}>{q}</div>
              <div className="mono" style={{ padding: 6, fontSize: 11 }}>{[12,3,0][i]}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="callout" style={{ marginTop: 14, maxWidth: 480 }}>
        ↑ keeps user's mental model intact — same shape as today,<br/>
        but with proper spacing, cleaner legend, and pulse-animation per cell update
      </div>
    </div>
  );
}

/* ============ Variation B: Health-summary first, drill-down ============ */
function DetectorsB() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 1100 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">B — Health summary on top</div>
          <div className="vsub">stat tiles → mosaics below • problems surface immediately</div>
        </div>
        <span className="tag" style={{ background: '#f5e6e0' }}><span className="hand">2 missing · 4 restart</span></span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <span className="hand-b" style={{ fontSize: 32 }}>Cluster</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>USDF · auto-refresh 1s</span>
        <span style={{ flex: 1 }} />
        <span className="btn">⟳ Restart all backlog</span>
      </div>

      {/* Stat tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 18 }}>
        {[
          ['Free', 187, 's-free'],
          ['Busy', 42, 's-busy'],
          ['Queued', 11, 's-queue'],
          ['Restarting', 4, 's-restart'],
          ['Guest', 0, 's-guest'],
          ['Missing', 2, 's-missing'],
        ].map(([label, n, cls]) => (
          <div key={label} className="wf" style={{ padding: 12, position: 'relative' }}>
            <div className={`chip ${cls}`} style={{ width: 24, height: 8, marginBottom: 8, borderRadius: 2 }} />
            <div className="hand-b" style={{ fontSize: 32, lineHeight: 1 }}>{n}</div>
            <div className="hand" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Worker sets list */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {['Imaging Set 1','Imaging Set 2','CWFS 1','CWFS 2','CWFS 3','CWFS 4'].map((name,i) => (
          <div key={name} className="wf" style={{ padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="hand-b" style={{ fontSize: 15 }}>{name}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>{32 - i*3} workers · {i % 2 ? '0 missing' : '1 missing'}</span>
            </div>
            {/* progress-bar style health */}
            <div style={{ display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', border: '1px solid var(--ink)', marginBottom: 8 }}>
              <div style={{ flex: 70, background: '#c8e0a8' }} />
              <div style={{ flex: 18, background: '#e8c490' }} />
              <div style={{ flex: 6, background: '#e0a8b8' }} />
              <div style={{ flex: 4, background: '#d4b8e0' }} />
              <div style={{ flex: 2, background: '#d8d8d4' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2 }}>
              {[...Array(32)].map((_,j) => <div key={j} className={`chip ${STATES[(i+j) % STATES.length]}`} style={{ aspectRatio: 'auto', height: 18 }} />)}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        <StateLegend />
      </div>

      <div className="callout" style={{ marginTop: 16, maxWidth: 460 }}>
        ↑ for ops, the question is "is anything broken?"<br/>
        stat tiles answer that in 1s; mosaic for the where
      </div>
    </div>
  );
}

/* ============ Variation C: Faithful focal plane shape ============ */
function FocalPlane({ size = 360 }) {
  // 5x5 raft grid, each raft 3x3 sensors, with corners removed
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
      gap: 4, width: size, aspectRatio: '1 / 1'
    }}>
      {[...Array(25)].map((_, i) => {
        const r = Math.floor(i / 5), c = i % 5;
        const isCorner = (r === 0 || r === 4) && (c === 0 || c === 4);
        if (isCorner) return <div key={i} />;
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 1, border: '1.25px solid var(--ink)' }}>
            {[...Array(9)].map((_,j) => <div key={j} className={`chip ${STATES[(i+j)%STATES.length]}`} style={{ aspectRatio: 'auto', height: '100%', border: 'none' }} />)}
          </div>
        );
      })}
    </div>
  );
}

function DetectorsC() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 1100 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">C — Anatomical focal plane</div>
          <div className="vsub">workers laid out as the actual focal plane • spatial pattern jumps out</div>
        </div>
        <span className="tag live"><span className="hand">live</span></span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24 }}>
        <div>
          <div className="hand-b" style={{ fontSize: 28, marginBottom: 6 }}>Imaging Set 1 — focal plane</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 12 }}>
            21 rafts · 189 sensors · click sensor for worker log
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24, background: 'var(--paper-2)', border: '1.5px solid var(--ink)', borderRadius: 6 }}>
            <FocalPlane size={520} />
          </div>
          <div style={{ marginTop: 14 }}>
            <StateLegend />
          </div>
          <div className="callout" style={{ marginTop: 12, maxWidth: 560 }}>
            ↑ if a whole raft is restarting, you see the cluster; same for missing.<br/>
            spatial layout = pattern recognition, not just counts.
          </div>
        </div>
        <div>
          <div className="wf" style={{ padding: 12, marginBottom: 10 }}>
            <div className="hand-b" style={{ fontSize: 14, marginBottom: 6 }}>Other sets</div>
            {['Imaging 2','CWFS 1','CWFS 2','CWFS 3','CWFS 4','SFM 1b','AOS 1b','Backlog'].map((s,i) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px dashed var(--line-soft)' }}>
                <div className="hand" style={{ fontSize: 13, flex: 1 }}>{s}</div>
                <div style={{ display: 'flex', height: 6, width: 90, borderRadius: 1, overflow: 'hidden', border: '1px solid var(--ink)' }}>
                  <div style={{ flex: 80 - i*2, background: '#c8e0a8' }} />
                  <div style={{ flex: 15, background: '#e8c490' }} />
                  <div style={{ flex: 5, background: '#e0a8b8' }} />
                </div>
                <div className="mono" style={{ fontSize: 10 }}>{i % 2 ? '✓' : '!'}</div>
              </div>
            ))}
          </div>
          <div className="wf" style={{ padding: 12 }}>
            <div className="hand-b" style={{ fontSize: 14, marginBottom: 6 }}>Selected sensor</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 8 }}>R22_S11 · busy 00:04</div>
            <div className="hand" style={{ fontSize: 13 }}>processing seq 786 · post-ISR</div>
            <div className="divider-soft" />
            <div className="mono" style={{ fontSize: 10, lineHeight: 1.6 }}>
              <div>worker_id: aos-w-43</div>
              <div>queue: imaging</div>
              <div>last update: 14:01:24</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ Variation D: Compact ops dashboard ============ */
function DetectorsD() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 1100 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">D — Ops dashboard</div>
          <div className="vsub">timeline + heatmap + actions • everything one screen, no scroll</div>
        </div>
        <span className="tag" style={{ background: '#f5e6e0' }}><span className="hand">⚠ 2 missing</span></span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
        {[['Active workers','229 / 234'],['Throughput','17 img/min'],['Queue depth','11'],['Last seq processed','786 · 04s ago']].map(([k,v]) => (
          <div key={k} className="wf" style={{ padding: 10 }}>
            <div className="hand" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{k}</div>
            <div className="hand-b" style={{ fontSize: 22 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Timeline of cluster state over last 30 min */}
      <div className="wf" style={{ padding: 12, marginBottom: 14 }}>
        <div className="hand-b" style={{ fontSize: 14, marginBottom: 8 }}>Last 30 min — workers by state</div>
        <div style={{ position: 'relative', height: 80, border: '1px dashed var(--ink)', background: 'var(--paper-2)', overflow: 'hidden' }}>
          {/* Stacked area mock */}
          <svg viewBox="0 0 600 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
            <path d="M0,90 L0,30 L60,40 L120,25 L180,28 L240,18 L300,22 L360,15 L420,20 L480,25 L540,18 L600,22 L600,90 Z" fill="#c8e0a8" />
            <path d="M0,90 L0,80 L60,75 L120,70 L180,72 L240,65 L300,68 L360,60 L420,65 L480,72 L540,68 L600,70 L600,90 Z" fill="#e8c490" opacity="0.85" />
            <path d="M0,95 L0,90 L600,88 L600,95 Z" fill="#e0a8b8" />
          </svg>
          <div className="mono" style={{ position: 'absolute', left: 8, top: 6, fontSize: 9, color: 'var(--ink-soft)' }}>234</div>
          <div className="mono" style={{ position: 'absolute', left: 8, bottom: 4, fontSize: 9, color: 'var(--ink-soft)' }}>0</div>
        </div>
        <div className="mono" style={{ fontSize: 9, color: 'var(--ink-soft)', display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span>13:31 UTC</span><span>14:01 UTC ←now</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
        {/* Heatmap of all sets */}
        <div className="wf" style={{ padding: 12 }}>
          <div className="hand-b" style={{ fontSize: 14, marginBottom: 8 }}>All sets · heatmap</div>
          {['Imaging 1','Imaging 2','CWFS 1','CWFS 2','CWFS 3','CWFS 4','SFM 1b','Backlog'].map((s,i) => (
            <div key={s} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 30px', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <div className="hand" style={{ fontSize: 12 }}>{s}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(36, 1fr)', gap: 1 }}>
                {[...Array(36)].map((_, j) => <div key={j} className={`chip ${STATES[(i*5+j) % STATES.length]}`} style={{ aspectRatio: 'auto', height: 14, borderWidth: 0.5 }} />)}
              </div>
              <div className="mono" style={{ fontSize: 10, textAlign: 'right' }}>{36 - i}</div>
            </div>
          ))}
          <div style={{ marginTop: 10 }}><StateLegend /></div>
        </div>
        <div>
          <div className="wf" style={{ padding: 12, marginBottom: 10 }}>
            <div className="hand-b" style={{ fontSize: 14, marginBottom: 6 }}>Recent restarts</div>
            {['CWFS 3 · 13:48','Imaging 1 · 13:31','Backlog · 12:57'].map(r => (
              <div key={r} className="mono" style={{ fontSize: 11, padding: '4px 0', borderBottom: '1px dashed var(--line-soft)' }}>{r}</div>
            ))}
          </div>
          <div className="wf" style={{ padding: 12 }}>
            <div className="hand-b" style={{ fontSize: 14, marginBottom: 6 }}>Quick actions</div>
            <span className="btn" style={{ marginBottom: 6, display: 'block', textAlign: 'center' }}>Restart missing only</span>
            <span className="btn" style={{ marginBottom: 6, display: 'block', textAlign: 'center' }}>Drain backlog</span>
            <span className="btn" style={{ display: 'block', textAlign: 'center' }}>Reset head node</span>
          </div>
        </div>
      </div>
    </div>
  );
}

window.DetectorsA = DetectorsA;
window.DetectorsB = DetectorsB;
window.DetectorsC = DetectorsC;
window.DetectorsD = DetectorsD;
