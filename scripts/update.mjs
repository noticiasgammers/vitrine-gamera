// Busca jogos na RAWG + promocoes da Steam e salva em data/games.json
// Roda no GitHub Actions. A chave vem do Secret RAWG_KEY (nunca escreva a chave aqui).
import { writeFile, mkdir } from 'node:fs/promises';

const KEY = (process.env.RAWG_KEY || '').trim();
if (!KEY) { console.error('Falta a variavel RAWG_KEY'); process.exit(1); }

const BASE = 'https://api.rawg.io/api';
// Lojas: Steam, Xbox, PlayStation, Nintendo eShop, Google Play
const STORES = { 1: 'Steam', 2: 'Xbox', 3: 'PlayStation', 6: 'Nintendo eShop', 8: 'Google Play' };
const STORE_IDS = Object.keys(STORES).join(',');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, params = {}) {
  const url = new URL(BASE + path);
  url.searchParams.set('key', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      console.warn(`HTTP ${res.status} em ${path}`);
    } catch (e) { console.warn('Erro de rede', e.message); }
    await sleep(1000 * (i + 1));
  }
  return null;
}

// Data de hoje no fuso de Sao Paulo
const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const addDays = (s, n) => {
  const d = new Date(s + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// extra: filtros adicionais da RAWG. Por padrao limita as lojas conhecidas.
async function list(dates, ordering, size, extra = { stores: STORE_IDS }) {
  const data = await api('/games', { dates, ordering, page_size: size, ...extra });
  return data?.results ?? [];
}

const PLAT_MAP = { pc: 'pc', playstation: 'playstation', xbox: 'xbox', nintendo: 'nintendo', android: 'android' };

function base(g) {
  return {
    id: g.id,
    name: g.name,
    released: g.released,
    image: g.background_image,
    rating: g.rating || null,
    metacritic: g.metacritic || null,
    platforms: [...new Set((g.parent_platforms || []).map(p => PLAT_MAP[p.platform.slug]).filter(Boolean))],
    genres: (g.genres || []).slice(0, 2).map(x => x.name),
  };
}

async function enrich(g) {
  const stores = await api(`/games/${g.id}/stores`);
  g.stores = (stores?.results ?? [])
    .filter(s => STORES[s.store_id] && s.url)
    .map(s => ({ name: STORES[s.store_id], url: s.url }));
  await sleep(150);
  const movies = await api(`/games/${g.id}/movies`);
  const m = movies?.results?.[0];
  g.trailer = m ? (m.data?.max || m.data?.['480'] || null) : null;
  g.trailerSearch = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(g.name + ' trailer');
  await sleep(150);
  return g;
}

// ---------- PROMOCOES ----------
// Cada loja fica na sua propria funcao. Se uma falhar, devolve [] e as outras seguem.

// Steam: lista publica de ofertas, em reais.
async function steamDeals() {
  try {
    const res = await fetch('https://store.steampowered.com/api/featuredcategories?cc=br&l=portuguese', {
      headers: { 'Accept-Language': 'pt-BR' },
    });
    if (!res.ok) { console.warn('Steam promocoes: HTTP', res.status); return []; }
    const data = await res.json();
    const items = data?.specials?.items ?? [];
    return items
      .filter(i => i && i.id && i.discounted && i.discount_percent > 0 && (i.type === undefined || i.type === 0))
      .map(i => ({
        store: 'Steam',
        id: Number(i.id),
        name: i.name,
        image: i.header_image || i.large_capsule_image || i.small_capsule_image || null,
        discount: i.discount_percent,
        original: i.original_price,   // em centavos
        final: i.final_price,         // em centavos
        currency: i.currency || 'BRL',
        url: `https://store.steampowered.com/app/${Number(i.id)}`,
      }))
      .sort((a, b) => b.discount - a.discount);
  } catch (e) {
    console.warn('Steam promocoes falhou:', e.message);
    return [];
  }
}

console.log('Hoje:', todayStr);

const [destaquesRaw, recentesRaw, proximosRaw, androidRaw] = await Promise.all([
  list(`${addDays(todayStr, -30)},${todayStr}`, '-added', 15),   // mais populares do ultimo mes
  list(`${addDays(todayStr, -14)},${todayStr}`, '-released', 24), // lancamentos recentes
  list(`${addDays(todayStr, 1)},${addDays(todayStr, 120)}`, '-added', 30), // proximos
  // Android: sem filtro de loja (a RAWG cobre pouco a Google Play), so pela plataforma
  list(`${addDays(todayStr, -365)},${todayStr}`, '-added', 30, { parent_platforms: 8 }),
]);

const hojeRaw = await list(`${todayStr},${todayStr}`, '-added', 10);

const pool = new Map();
const pick = arr => arr.filter(g => g.name && g.background_image).map(g => {
  if (!pool.has(g.id)) pool.set(g.id, base(g));
  return g.id;
});

const sections = {
  hoje: pick(hojeRaw),
  destaques: pick(destaquesRaw),
  lancamentos: pick(recentesRaw),
  proximos: pick(proximosRaw),
  android: pick(androidRaw),
};
sections.proximos.sort((a, b) =>
  (pool.get(a).released || '9999').localeCompare(pool.get(b).released || '9999'));

for (const [nome, ids] of Object.entries(sections)) console.log(`Secao ${nome}: ${ids.length}`);
console.log('Jogos unicos:', pool.size);
for (const g of pool.values()) await enrich(g);

// Promocoes (cada loja isolada)
const deals = [...await steamDeals()];
console.log('Promocoes Steam:', deals.filter(d => d.store === 'Steam').length);

await mkdir('data', { recursive: true });
await writeFile('data/games.json', JSON.stringify({
  updated: new Date().toISOString(),
  today: todayStr,
  sections,
  games: Object.fromEntries(pool),
  deals,
}, null, 1));
console.log('data/games.json salvo');
