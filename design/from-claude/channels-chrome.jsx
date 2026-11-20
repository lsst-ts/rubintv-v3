/* global React, window */
// Shared chrome for the channels tab — top nav, brand pill, camera hero, tabs

const { useState, useEffect } = React;

function TopBar() {
  return (
    <div className="ch-topbar">
      <div>
        <div className="ch-topnav">
          <span><span className="dot" />LOCATION</span>
          <span className="sep">·</span>
          <span>SUMMIT</span>
          <span className="sep">·</span>
          <span className="cur">LSSTCAM</span>
        </div>
        <div className="ch-topnav br">
          <a>Home</a> <span className="slash">/</span>
          <a>Summit</a> <span className="slash">/</span>
          <span className="here">LSSTCam</span>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="ch-brand">
          <div className="sun" />
          <div className="meta">
            <div className="name">RubinTV</div>
            <div className="sub">VERA C. RUBIN OBSERVATORY</div>
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <span className="ch-memorial">
            <span className="flw">✿</span>
            In memory of <em>Simon Krughoff</em>
            <span style={{ color: 'var(--dim)' }}>·</span>
            1974–2023
            <span className="flw">✿</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function CameraHero() {
  const cam = window.RUBIN_CAMERA;
  return (
    <>
      <div className="ch-hero">
        <div>
          <h1>{cam.title}</h1>
          <div className="sub">
            <span className="pill tag-active">● {cam.status}</span>
            {cam.description}
            <span style={{ color: 'var(--hair-2)', margin: '0 10px' }}>·</span>
            <span style={{ color: 'var(--dim)' }}>{cam.pipeline}</span>
          </div>
        </div>
        <div className="clocks">
          <div className="clock">
            <div className="lbl">DAY OBS</div>
            <div className="val">{cam.dayObs}</div>
          </div>
          <div className="clock">
            <div className="lbl">UTC CLOCK</div>
            <div className="val">{cam.utcClock}<span className="u">UTC</span></div>
          </div>
          <div className="clock">
            <div className="lbl">SINCE LAST IMAGE</div>
            <div className="val" style={{ color: 'var(--sun)' }}>{cam.timeSinceLast}</div>
          </div>
        </div>
      </div>
      <div className="ch-tabs">
        <div className="ch-tab">Table <span className="count">786</span></div>
        <div className="ch-tab active">Channels <span className="count">8</span></div>
        <div className="ch-tab">Night report</div>
        <div className="ch-tab">Mosaic</div>
        <div className="ch-tab">Detectors</div>
        <div style={{ flex: 1 }} />
        <div style={{ padding: '0 0 12px' }}>
          <span className="tag tag-live" style={{ color: 'var(--grn)', fontSize: 10 }}>LIVE</span>
        </div>
      </div>
    </>
  );
}

window.CHTopBar = TopBar;
window.CHCameraHero = CameraHero;
