const DEFAULT_HFOV = 100;
const MIN_HFOV = 50;
const MAX_HFOV = 120;
const ZOOM_STEP = 10;

export class PanoViewer {
  constructor(containerId) {
    this.containerId = containerId;
    this.viewer = null;
    this.zoomLocked = false;
  }

  load(panoramaUrl, { vaov, modifier = 'free', onLoad } = {}) {
    this.destroy();
    this.zoomLocked = modifier === 'no-zoom';
    const config = {
      type: 'equirectangular',
      panorama: panoramaUrl,
      autoLoad: true,
      showControls: false,
      compass: false,
      hfov: DEFAULT_HFOV,
      minHfov: this.zoomLocked ? DEFAULT_HFOV : MIN_HFOV,
      maxHfov: this.zoomLocked ? DEFAULT_HFOV : MAX_HFOV,
      yaw: 0,
    };
    if (vaov) config.vaov = vaov;
    this.viewer = window.pannellum.viewer(this.containerId, config);
    if (onLoad) this.viewer.on('load', onLoad);
  }

  zoomIn() {
    if (!this.viewer || this.zoomLocked) return;
    const next = Math.max(MIN_HFOV, this.viewer.getHfov() - ZOOM_STEP);
    this.viewer.setHfov(next, true);
  }

  zoomOut() {
    if (!this.viewer || this.zoomLocked) return;
    const next = Math.min(MAX_HFOV, this.viewer.getHfov() + ZOOM_STEP);
    this.viewer.setHfov(next, true);
  }

  resetNorth() {
    if (!this.viewer) return;
    this.viewer.setYaw(0, true);
    this.viewer.setPitch(0, true);
  }

  toggleFullscreen() {
    if (!this.viewer) return;
    this.viewer.toggleFullscreen();
  }

  destroy() {
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
  }
}
