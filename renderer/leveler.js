// Nivelador de volumen: pasa el audio de cada <video> por un compresor de Web
// Audio para que los canales fuertes y los suaves suenen parecido. Se carga en
// el renderer (videos HLS) y main.js lo inyecta en cada iframe de YouTube, que
// es de otro origen y no se puede tocar desde la página.
// window.livetvLeveler(on) lo enciende o apaga. window.livetvAnalyser(video)
// devuelve un AnalyserNode que escucha el audio del video (para las barras de
// las radios), conectado en paralelo: no cambia lo que suena.
(() => {
  if (window.livetvLeveler) return;
  let ctx = null;
  let enabled = false;
  // Un video se conecta al grafo una sola vez (createMediaElementSource no se
  // puede repetir) y desde entonces solo suena a través de él. Los nodos
  // quedan en video.livetvLeveler (también sirve para inspeccionar por CDP).
  function wire(video) {
    if (video.livetvLeveler) return video.livetvLeveler;
    ctx ||= new AudioContext();
    const source = ctx.createMediaElementSource(video);
    const compressor = ctx.createDynamicsCompressor();
    // Umbral bajo y razón alta: baja los canales fuertes. Chromium suma
    // ganancia de compensación automática, que sube los suaves. Medido en
    // los canales de Chile: la diferencia entre el más fuerte (T13, -16 dB)
    // y el más suave (Cooperativa, -34 dB) baja de 18 dB a menos de 3.
    compressor.threshold.value = -50;
    compressor.knee.value = 10;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.3;
    video.livetvLeveler = { source, compressor };
    return video.livetvLeveler;
  }

  function route({ source, compressor, analyser }) {
    source.disconnect();
    compressor.disconnect();
    if (analyser) source.connect(analyser);
    if (enabled) {
      source.connect(compressor);
      compressor.connect(ctx.destination);
    } else {
      source.connect(ctx.destination);
    }
  }

  function apply(video) {
    // Apagado, un video que nunca pasó por el grafo sigue tal cual.
    if (!enabled && !video.livetvLeveler) return;
    route(wire(video));
    ctx.resume();
  }

  // play no burbujea, pero se ve en la captura: así se toman los videos que
  // el reproductor crea después.
  document.addEventListener('play', (e) => {
    if (e.target instanceof HTMLVideoElement) apply(e.target);
  }, true);

  window.livetvAnalyser = (video) => {
    const nodes = wire(video);
    if (!nodes.analyser) {
      nodes.analyser = ctx.createAnalyser();
      nodes.analyser.fftSize = 256;
      nodes.analyser.smoothingTimeConstant = 0.75;
      route(nodes);
      ctx.resume();
    }
    return nodes.analyser;
  };

  window.livetvLeveler = (on) => {
    enabled = on;
    document.querySelectorAll('video').forEach(apply);
  };
})();
