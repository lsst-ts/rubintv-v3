/* global window */
// LSSTCam channel data — straight from models_data.yaml

window.RUBIN_CAMERA = {
  name: 'lsstcam',
  title: 'LSSTCam',
  description: '3.2 GP science camera',
  status: 'ACTIVE',
  dayObs: '2026-04-30',
  lastSeq: '0786',
  seqCount: 786,
  timeSinceLast: '03:47:39',
  utcClock: '13:59:34',
  location: 'Summit',
  locationSub: 'Cerro Pachón',
  pipeline: 'Summit Quicklook Processing',
};

window.RUBIN_CHANNELS = [
  { name: 'witness_detector',   title: 'Witness Detector',  color: '#64CED9', seq: '0786', updated: '12s ago', desc: 'Single-CCD raw preview from R22_S11', kind: 'image' },
  { name: 'focal_plane_mosaic', title: 'Post-ISR mosaic',   color: '#85E986', seq: '0786', updated: '14s ago', desc: 'ISR-corrected full focal plane',     kind: 'image' },
  { name: 'calexp_mosaic',      title: 'Calexp mosaic',     color: '#E76FD8', seq: '0785', updated: '46s ago', desc: 'Calibrated exposure mosaic',          kind: 'image' },
  { name: 'psf_shape_azel',     title: 'PSF shape AzEl',    color: '#6F58E7', seq: '0785', updated: '52s ago', desc: 'Whisker plot of PSF in Az/El',        kind: 'plot'  },
  { name: 'fwhm_focal_plane',   title: 'FWHM Focal Plane',  color: '#6232A8', seq: '0784', updated: '1m ago',  desc: 'PSF FWHM per detector',               kind: 'plot'  },
  { name: 'mount',              title: 'Mount torques',     color: '#58B4E7', seq: '0786', updated: '11s ago', desc: 'Az/El torque trace over exposure',    kind: 'plot'  },
  { name: 'imexam',             title: 'Image Analysis',    color: '#E7587B', seq: '0785', updated: '47s ago', desc: 'Per-exposure quick statistics',       kind: 'plot'  },
  { name: 'event_timeline',     title: 'Event timeline',    color: '#E79459', seq: '0786', updated: '9s ago',  desc: 'Per-visit event chronology',          kind: 'timeline' },
  { name: 'day_movie',          title: 'Whole Day Movie',   color: '#83DAEE', seq: 'today', updated: 'rolling', desc: 'All exposures of the day, stitched', kind: 'movie', perDay: true },
];

// Group for layout C (sidebar/list)
window.RUBIN_CHANNEL_GROUPS = [
  { title: 'Per-exposure imaging',  names: ['witness_detector','focal_plane_mosaic','calexp_mosaic'] },
  { title: 'Per-exposure analysis', names: ['psf_shape_azel','fwhm_focal_plane','mount','imexam'] },
  { title: 'Per-night',             names: ['event_timeline','day_movie'] },
];
