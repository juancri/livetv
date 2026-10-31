// Programación de un canal para la guía. stream.epg dice de dónde sacarla: cada
// fuente es un módulo de este directorio con match(epg) y fetch(epg, ctx), que
// devuelve { logo, programs: [{ start, stop?, title, category, description }] }
// con tiempos en ms. Para agregar una fuente, crear su módulo y sumarlo a
// SOURCES. Se piden ayer, hoy y mañana (UTC) para tener lo que está al aire y
// lo que viene; aquí se ordenan, se deduplican por inicio y cada programa dura
// hasta que empieza el siguiente (el último, lo que diga su fuente o una hora).
//
// Caché en disco como la de los logos (cache/schedules/, un JSON por epg con
// { time, data }): vale SCHEDULE_TTL_MS y, si al renovarla falla, se usa la
// vieja. Los pedidos simultáneos del mismo epg comparten la búsqueda.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCES = [require('./mitv'), require('./3abn')];
const SCHEDULE_TTL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

module.exports = function scheduleFinder({ cacheDir, fetchPage, decodeEntities }) {
  const pending = new Map();
  const cacheFile = (epg) => path.join(cacheDir, `${crypto.createHash('sha1').update(epg).digest('hex').slice(0, 16)}.json`);

  function readCache(epg) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile(epg), 'utf8'));
    } catch {
      return null;
    }
  }

  function writeCache(epg, data) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = cacheFile(epg);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ epg, time: Date.now(), data }));
    fs.renameSync(`${file}.tmp`, file);
  }

  async function fetchSchedule(epg) {
    const source = SOURCES.find((s) => s.match(epg));
    if (!source) throw new Error(`epg no reconocido: ${epg}`);
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    const days = [-1, 0, 1].map((k) => {
      const day = today + k * DAY_MS;
      return { day, date: new Date(day).toISOString().slice(0, 10) };
    });
    const { logo = null, programs: found } = await source.fetch(epg, { days, fetchPage, decodeEntities });
    const byStart = new Map(found.map((p) => [p.start, p]));
    const programs = [...byStart.values()].sort((a, b) => a.start - b.start);
    programs.forEach((p, k) => { p.stop = programs[k + 1]?.start ?? p.stop ?? p.start + HOUR_MS; });
    if (!programs.length) throw new Error(`No llegó programación para ${epg}`);
    return { logo, programs };
  }

  return function findSchedule(epg) {
    const cached = readCache(epg);
    if (cached && Date.now() - cached.time < SCHEDULE_TTL_MS) return Promise.resolve(cached.data);
    if (!pending.has(epg)) {
      pending.set(epg, fetchSchedule(epg)
        .then((data) => {
          writeCache(epg, data);
          return data;
        }, (err) => {
          if (cached) return cached.data;
          throw err;
        })
        .finally(() => pending.delete(epg)));
    }
    return pending.get(epg);
  };
};
