export class PanoViewer {
  constructor(containerId) {
    this.containerId = containerId;
    this.viewer = null;
  }

  load(panoramaUrl) {
    this.destroy();
    this.viewer = window.pannellum.viewer(this.containerId, {
      type: 'equirectangular',
      panorama: panoramaUrl,
      autoLoad: true,
      showControls: false,
      compass: false,
      hfov: 100,
      minHfov: 50,
      maxHfov: 120,
    });
  }

  destroy() {
    if (this.viewer) {
      this.viewer.destroy();
      this.viewer = null;
    }
  }
}
