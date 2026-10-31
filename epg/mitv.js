// mi.tv: epg = "mi.tv/<país>/<canal>", el país y el id como en las URLs de
// mi.tv (la página mi.tv/cl/canales/chilevision es "mi.tv/cl/chilevision").
// La página de cada día trae los programas en orden con la hora de inicio en
// UTC; si la hora retrocede, ya es el día siguiente. Las páginas se solapan (lo
// de pasada la medianoche sale en dos días), así que puede repetir programas.
// Sin API oficial: si mi.tv cambia su HTML hay que ajustar estas expresiones
// (el grabber de iptv-org/epg para mi.tv sirve de referencia).
const PATTERN = /^mi\.tv\/([a-z]{2})\/([\w-]+)$/;

module.exports = {
  match: (epg) => PATTERN.test(epg),

  async fetch(epg, { days, fetchPage, decodeEntities }) {
    const [, country, id] = PATTERN.exec(epg);
    const pages = await Promise.all(days.map(async ({ day, date }) => {
      try {
        return { day, html: await fetchPage(`https://mi.tv/${country}/async/channel/${id}/${date}/0`) };
      } catch {
        return null;
      }
    }));
    const text = (html) => decodeEntities((html || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    let logo = null;
    const programs = [];
    for (const page of pages.filter(Boolean)) {
      logo ||= /<div class="channel-info">\s*<img src="([^"]+)"/.exec(page.html)?.[1] || null;
      let base = page.day;
      let prev = -Infinity;
      for (const [, item] of page.html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
        const time = /class="time">\s*(\d{1,2}):(\d{2})/.exec(item);
        if (!time) continue;
        let start = base + (Number(time[1]) * 60 + Number(time[2])) * 60000;
        if (start < prev) {
          base += 24 * 60 * 60 * 1000;
          start += 24 * 60 * 60 * 1000;
        }
        prev = start;
        programs.push({
          start,
          title: text(/<h2>([\s\S]*?)<\/h2>/.exec(item)?.[1]),
          category: text(/class="sub-title">([\s\S]*?)<\/span>/.exec(item)?.[1]),
          description: text(/class="synopsis">([\s\S]*?)<\/p>/.exec(item)?.[1]),
        });
      }
    }
    return { logo, programs };
  },
};
