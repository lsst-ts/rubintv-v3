/* global React */
// All Sky wireframe variations

function SkyDisk({ size = 280, label = '14:00:00', date = '2026-05-01' }) {
  return (
    <div style={{
      width: size, height: size, position: 'relative',
      background: 'radial-gradient(circle at 35% 30%, #b9c8da 0%, #6f8aa6 60%, #20303f 100%)',
      borderRadius: '50%', border: '1.5px solid var(--ink)', overflow: 'hidden'
    }}>
      <div className="mono" style={{ position: 'absolute', top: 6, left: 8, color: '#fff', fontSize: 10, fontWeight: 600 }}>{date}<br/>{label}</div>
      <div className="hand-b" style={{ position: 'absolute', top: 4, right: 18, color: '#fff', fontSize: 12 }}>E</div>
      <div className="hand-b" style={{ position: 'absolute', right: 4, top: '45%', color: '#fff', fontSize: 12 }}>N</div>
      <div className="hand-b" style={{ position: 'absolute', bottom: 6, right: 18, color: '#fff', fontSize: 12 }}>W</div>
      <div className="hand-b" style={{ position: 'absolute', left: 4, top: '45%', color: '#fff', fontSize: 12 }}>S</div>
      {/* Sun glare */}
      <div style={{ position: 'absolute', left: '32%', top: '24%', width: 36, height: 36, background: 'radial-gradient(circle, #fff 0%, transparent 70%)', borderRadius: '50%' }} />
      {/* Ground / horizon dot */}
      <div style={{ position: 'absolute', left: '52%', top: '60%', width: 14, height: 14, background: '#3a3a44', borderRadius: '50%', opacity: 0.6 }} />
    </div>
  );
}

/* ========= A: Cleanup of current ========= */
function AllSkyA() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 900 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">A — Refined current</div>
          <div className="vsub">latest still + latest movie · keep two-up · cleaner header</div>
        </div>
        <span className="tag live"><span className="hand">live · new image 12:00 ago</span></span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <span className="hand-b" style={{ fontSize: 32 }}>All Sky</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>summit · latest 2026-05-01</span>
        <span style={{ flex: 1 }} />
        <span className="btn">◐ Historical</span>
      </div>

      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 14 }}>home / summit / all sky</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <div>
          <div className="hand-b" style={{ fontSize: 18, marginBottom: 4 }}>Image 25 · 14:00:00</div>
          <SkyDisk size={420} label="14:00:00" />
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 6 }}>allsky_stills_2026-05-01_000025.jpg</div>
        </div>
        <div>
          <div className="hand-b" style={{ fontSize: 18, marginBottom: 4 }}>Movie · images 1 → 23</div>
          <div style={{ position: 'relative' }}>
            <SkyDisk size={420} label="12:30:00" />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="wf hand-b" style={{ width: 60, height: 60, borderRadius: '50%', background: 'rgba(245,241,232,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>▶</div>
            </div>
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 6 }}>allsky_movies_2026-05-01_000023.mp4</div>
        </div>
      </div>

      <div className="callout" style={{ marginTop: 18, maxWidth: 520 }}>
        ↑ minimal change, fixes alignment + adds clear "last update" pill.<br/>
        memorial card moved to footer.
      </div>
    </div>
  );
}

/* ========= B: Single hero with timeline ========= */
function AllSkyB() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 900 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">B — Single hero + timeline</div>
          <div className="vsub">one big disk · scrubbable timeline of the night below</div>
        </div>
        <span className="tag live"><span className="hand">recording</span></span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <span className="hand-b" style={{ fontSize: 32 }}>All Sky</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>2026-05-01 · 25 stills · 23 movies</span>
        <span style={{ flex: 1 }} />
        <span className="btn">jump to: <span className="mono">↓</span> latest</span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <SkyDisk size={520} label="14:00:00" />
      </div>

      {/* Timeline */}
      <div className="wf" style={{ padding: 12 }}>
        <div className="hand" style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 8 }}>tonight · scrub to view any moment</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(25, 1fr)', gap: 3 }}>
          {[...Array(25)].map((_, i) => (
            <div key={i} className="wf" style={{
              aspectRatio: '1 / 1', borderRadius: '50%',
              background: `radial-gradient(circle, hsl(${210 + i*2} 30% ${50 - i}%) 0%, #20303f 100%)`,
              border: i === 24 ? '2.5px solid var(--accent)' : '1px solid var(--ink)',
              padding: 0
            }} />
          ))}
        </div>
        <div className="mono" style={{ fontSize: 9, color: 'var(--ink-soft)', display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span>00:00 UTC</span><span>14:00 UTC · now</span>
        </div>
      </div>

      <div className="callout" style={{ marginTop: 14, maxWidth: 520 }}>
        ↑ each thumbnail is a real frame — scrubbing instantly previews
      </div>
    </div>
  );
}

/* ========= C: Calendar + viewer (historical-first) ========= */
function AllSkyC() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 900 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">C — Calendar grid</div>
          <div className="vsub">years inline, selected day on the right · matches today's historical view but tighter</div>
        </div>
      </div>

      <div className="hand-b" style={{ fontSize: 28, marginBottom: 4 }}>All Sky · Historical</div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 16 }}>2026-04-30 selected</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            {['2026','2025','2024','2023','2022','2021'].map((y,i) => (
              <span key={y} className="hand" style={{
                fontSize: 14,
                padding: '2px 8px',
                borderBottom: i === 0 ? '2px solid var(--accent)' : 'none',
                fontWeight: i === 0 ? 700 : 400
              }}>{y}</span>
            ))}
          </div>

          {['May','April','March'].map((m, mi) => (
            <div key={m} style={{ marginBottom: 14 }}>
              <div className="hand-b" style={{ fontSize: 14, marginBottom: 6 }}>{m}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3, fontSize: 10 }} className="mono">
                {['M','T','W','T','F','S','S'].map(d => <div key={Math.random()} style={{ color: 'var(--ink-soft)', textAlign: 'center' }}>{d}</div>)}
                {[...Array(31)].map((_, i) => {
                  const has = (i + mi) % 3 !== 0;
                  const isSel = mi === 0 && i === 0;
                  return (
                    <div key={i} style={{
                      aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: has ? '1px solid var(--ink)' : '1px dashed var(--line-soft)',
                      background: isSel ? '#c8e0a8' : has ? 'var(--paper)' : 'transparent',
                      color: has ? 'var(--ink)' : 'var(--ink-soft)',
                      borderRadius: 2
                    }}>{i+1}</div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div>
          <div className="hand-b" style={{ fontSize: 18, marginBottom: 8 }}>Images 1 → 511</div>
          <SkyDisk size={420} label="12:00:00" date="2026-04-30" />
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 6 }}>allsky_movies_2026-04-30_000351.mp4</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <span className="btn">⏮</span><span className="btn">▶</span><span className="btn">⏭</span>
            <span className="btn">↓ download</span>
          </div>
        </div>
      </div>

      <div className="callout" style={{ marginTop: 18, maxWidth: 520 }}>
        ↑ calendar dots = "data exists" cue · selected day in green
      </div>
    </div>
  );
}

/* ========= D: Dashboard with sky + conditions ========= */
function AllSkyD() {
  return (
    <div style={{ padding: 24, background: 'var(--paper)', minHeight: 900 }}>
      <div className="vhead">
        <div>
          <div className="vlabel">D — Sky + conditions panel</div>
          <div className="vsub">disk + observing-condition strip · context for what you're seeing</div>
        </div>
        <span className="tag live"><span className="hand">14:01 UTC</span></span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
            <span className="hand-b" style={{ fontSize: 28 }}>Sky · now</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>auto-advance every 60s</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <SkyDisk size={460} />
          </div>
          {/* Filmstrip below */}
          <div style={{ display: 'flex', gap: 4, marginTop: 12, overflow: 'hidden' }}>
            {[...Array(10)].map((_, i) => (
              <div key={i} style={{
                width: 60, height: 60, borderRadius: '50%',
                background: `radial-gradient(circle, hsl(${210 + i*5} 30% ${50 - i*2}%) 0%, #20303f 100%)`,
                border: i === 9 ? '2.5px solid var(--accent)' : '1px solid var(--ink)',
                flexShrink: 0
              }} />
            ))}
            <div className="hand" style={{ fontSize: 11, color: 'var(--ink-soft)', alignSelf: 'flex-end', marginLeft: 6 }}>last 10 frames</div>
          </div>
        </div>

        <div>
          <div className="wf" style={{ padding: 12, marginBottom: 10 }}>
            <div className="hand-b" style={{ fontSize: 14, marginBottom: 8 }}>Conditions</div>
            {[['Sun alt','+12°'],['Moon phase','▣ 78%'],['Seeing (DIMM)','0.84″'],['Cloud cover','45%'],['Wind','5.2 m/s NW'],['Humidity','62%']].map(([k,v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px dashed var(--line-soft)' }}>
                <span className="hand" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{k}</span>
                <span className="mono" style={{ fontSize: 11 }}>{v}</span>
              </div>
            ))}
          </div>
          <div className="wf" style={{ padding: 12, marginBottom: 10 }}>
            <div className="hand-b" style={{ fontSize: 14, marginBottom: 6 }}>Tonight</div>
            <div className="mono" style={{ fontSize: 11, lineHeight: 1.5 }}>
              <div>sunset 23:42</div>
              <div>twilight end 00:54</div>
              <div>twilight start 09:18</div>
              <div>sunrise 10:30</div>
            </div>
          </div>
          <div className="wf" style={{ padding: 12 }}>
            <div className="hand-b" style={{ fontSize: 14, marginBottom: 6 }}>Compare</div>
            <span className="btn" style={{ display: 'block', textAlign: 'center' }}>same time yesterday</span>
          </div>
        </div>
      </div>

      <div className="callout" style={{ marginTop: 14, maxWidth: 460 }}>
        ↑ context turns "is the sky clear?" from a guess into a glance
      </div>
    </div>
  );
}

window.AllSkyA = AllSkyA;
window.AllSkyB = AllSkyB;
window.AllSkyC = AllSkyC;
window.AllSkyD = AllSkyD;
