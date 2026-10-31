// 3ABN: epg = "3abn/<canal>", con el canal como lo usa r.3abn.org/sched-app:
// main (3ABN), proc (Proclaim), dare (Dare to Dream), int (International),
// canada, praise (Praise Him), kids, lat (Latino) o radio. Es la API JSON que
// consulta esa página: un día por pedido, con el desfase en minutos al final
// (0: fechas en UTC). El episodio va como categoría, junto a la descripción.
const PATTERN = /^3abn\/([a-z]+)$/;

module.exports = {
  match: (epg) => PATTERN.test(epg),

  async fetch(epg, { days, fetchPage }) {
    const [, channel] = PATTERN.exec(epg);
    const pages = await Promise.all(days.map(async ({ date }) => {
      try {
        return JSON.parse(await fetchPage(`https://api2-test.3abn.org/sched/daily/${channel}/${date}/0`)).schedule;
      } catch {
        return null;
      }
    }));
    const programs = pages.filter(Boolean).flat().map((p) => {
      const start = Date.parse(p.date);
      // "duartion" (sic): HH:MM:SS:cuadros. Solo cuenta para el último programa.
      const [h, m, s] = (p.duartion || '').split(':').map(Number);
      const length = ((h || 0) * 3600 + (m || 0) * 60 + (s || 0)) * 1000;
      return {
        start,
        stop: length ? start + length : undefined,
        title: p.series_title || p.program_title || '',
        category: p.program_title && p.program_title !== p.series_title ? p.program_title : '',
        description: p.description || '',
      };
    });
    return { logo: null, programs: programs.filter((p) => !Number.isNaN(p.start)) };
  },
};
