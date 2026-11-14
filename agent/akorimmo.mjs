// ---------------------------------------------------------------------------
// Agent de récupération des annonces publiées sur www.akorimmo.com
// (site motorisé par Apimo). Aucune dépendance : Node 18+ suffit.
//
//  1. ouvre la page « Acheter » pour obtenir une session et le formulaire,
//  2. lance la recherche « Vente » + type(s) de bien (comme un visiteur),
//  3. parcourt toutes les pages de résultats,
//  4. ouvre chaque fiche et lit ses données structurées (JSON-LD) :
//     prix, pièces, surface, ville, code postal, coordonnées GPS, photos…
// ---------------------------------------------------------------------------

export const BASE = 'https://akorimmo.com';
const UA = 'Mozilla/5.0 (compatible; AkorimmoSitesAgent/1.0; +https://www.akorimmo.com)';

// Valeurs du formulaire Apimo (relues sur la page à chaque passage ; ces
// valeurs ne servent que si la lecture échoue).
export const TYPES_PAR_DEFAUT = {
  'Appartement': 'Appartement|1',
  'Maison': 'Maison|2',
  'Terrain': 'Terrain|3',
  'Commerce': 'Commerce|4',
  'Garage / Parking': 'Garage / Parking|5',
  'Immeuble': 'Immeuble|6',
  'Bureau': 'Bureau|7',
  "Locaux d'activité / Entrepôts": "Locaux d'activité / Entrepôts|9",
};

// ---------------------------------------------------------------- utilitaires
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô', euro: '€', sup2: '²' };
export function decode(s = '') {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z0-9]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
}
export const stripTags = (s = '') => decode(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rythme « poli » vis-à-vis d'akorimmo.com : une seule requête à la fois,
// une pause entre deux requêtes, et une durée maximale pour finir avant la
// limite de temps de Netlify.
const PAUSE_MS = 700;                    // pause minimale entre deux requêtes (+ 0 à 300 ms)
const DELAI_MAX_MS = 20000;              // délai maximal d'attente d'une réponse
const ATTENTES_ESSAIS_MS = [3000, 10000, 30000]; // attentes avant chaque nouvel essai
const DUREE_MAX_MS = 11 * 60 * 1000;     // au-delà : abandon (Netlify coupe vers 15 min)

// ------------------------------------------------------------ analyse du HTML
/** Lit le préfixe du formulaire de recherche et les valeurs des types de biens. */
export function parseSearchForm(html) {
  const m = html.match(/name="(search-form-\d+)\[search\]\[category\]/);
  const prefix = m ? m[1] : 'search-form-222685';
  const types = { ...TYPES_PAR_DEFAUT };
  const sel = html.match(/name="[^"]*\[search\]\[type\]\[\]"[\s\S]*?<\/select>/);
  if (sel) {
    for (const o of sel[0].matchAll(/<option[^>]*value="([^"]+\|\d+)"/g)) {
      const v = decode(o[1]);
      types[v.split('|')[0].trim()] = v;
    }
  }
  let vente = 'Vente|1';
  const cat = html.match(/<option[^>]*value="(Vente\|\d+)"/);
  if (cat) vente = cat[1];
  return { prefix, types, vente };
}

/** Lit les vignettes d'une page de résultats. */
export function parseListPage(html) {
  const out = [];
  const re = /<li[^>]*class="[^"]*\bproperty\b[^"]*"[^>]*data-property-id="(\d+)"[\s\S]*?<\/a>/g;
  for (const m of html.matchAll(re)) {
    const block = m[0];
    const href = (block.match(/href="([^"]+\/propriete\/[^"]+)"/) || [])[1];
    if (!href) continue;
    out.push({
      id: m[1],
      url: new URL(decode(href), BASE).href,
      price: stripTags((block.match(/class="price"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || ''),
      city: stripTags((block.match(/class="city"[\s\S]*?<span>([\s\S]*?)<\/span>/) || [])[1] || ''),
    });
  }
  return out;
}

/** Lit une fiche détaillée et renvoie un objet propre. */
export function parseDetail(html, url) {
  let listing = null;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      const g = Array.isArray(j['@graph']) ? j['@graph'] : [j];
      listing = g.find((x) => x['@type'] === 'RealEstateListing') || listing;
    } catch { /* bloc ignoré */ }
  }
  if (!listing) return null;
  const about = listing.about || {};
  const addr = about.address || {};
  const geo = about.geo || {};
  const offers = listing.offers || {};

  // Segment d'URL : /propriete/vente+appartement+nice+slug+87124667
  const seg = decodeURIComponent(url.split('/propriete/')[1] || '').split('+');
  const typeUrl = (seg[1] || '').toLowerCase();
  const id = seg[seg.length - 1];

  // Bloc d'informations (pièces, chambres, surface…) et titre « Vente Appartement / Nice Wilson »
  const infoBlock = (html.match(/module-property-info[\s\S]*?<\/ul>/) || [''])[0];
  const h1 = stripTags((infoBlock.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || '');
  const facts = {};
  for (const f of infoBlock.matchAll(/<p>\s*<span>([^<]*)<\/span>\s*<br>\s*([^<(]*)/g)) {
    const val = stripTags(f[1]); const lab = stripTags(f[2]).toLowerCase();
    if (/chambre/.test(lab)) facts.bedrooms = parseFloat(val);
    else if (/salle/.test(lab)) facts.bathrooms = parseFloat(val);
    else if (/pi[eè]ce/.test(lab)) facts.rooms = parseFloat(val);
    else if (/m²|m2/.test(lab)) facts.area = parseFloat(val);
  }

  // Photos : JSON-LD + diaporama de la fiche
  const imgs = new Set(Array.isArray(listing.image) ? listing.image : listing.image ? [listing.image] : []);
  const slider = (html.match(/module-slider[\s\S]*?(?=class="module |$)/) || [''])[0];
  for (const m of slider.matchAll(/https:\/\/[a-z0-9.-]+\/prod\/[^"'\s)]+\.(?:jpe?g|png|webp)/gi)) imgs.add(m[0]);

  const name = String(listing.name || '').trim();
  let description = String(listing.description || '').trim();
  if (name && description.startsWith(name)) description = description.slice(name.length).trim();

  const r = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : null); // ~100 m : on ne publie pas l'adresse exacte
  return {
    id,
    url,
    reference: about.identifier || null,
    titre: name || h1,
    entete: h1, // ex. « Vente Appartement Nice Wilson »
    type: typeUrl, // appartement, maison, commerce, bureau…
    typeSchema: about['@type'] || null,
    prix: typeof offers.price === 'number' ? offers.price : parseFloat(offers.price) || null,
    pieces: about.numberOfRooms ?? facts.rooms ?? null,
    chambres: facts.bedrooms ?? null,
    sdb: facts.bathrooms ?? null,
    surface: about.floorSize?.value ?? facts.area ?? null,
    ville: addr.addressLocality || seg[2] || '',
    cp: addr.postalCode || '',
    lat: r(geo.latitude),
    lng: r(geo.longitude),
    photos: [...imgs],
    description,
    publie: listing.datePosted || null,
    modifie: listing.dateModified || null,
  };
}

// ------------------------------------------------------------- accès réseau
class Session {
  constructor() { this.cookies = new Map(); this.dernier = 0; this.debut = Date.now(); }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of list) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
  }
  async tour() {
    const attente = this.dernier + PAUSE_MS + Math.random() * 300 - Date.now();
    if (attente > 0) await sleep(attente);
    this.dernier = Date.now();
  }
  async fetch(url, opts = {}, tries = 1 + ATTENTES_ESSAIS_MS.length) {
    for (let t = 1; ; t++) {
      if (Date.now() - this.debut > DUREE_MAX_MS) throw new Error('durée maximale dépassée');
      await this.tour();
      try {
        const res = await fetch(new URL(url, BASE), {
          ...opts,
          redirect: 'manual',
          signal: AbortSignal.timeout(DELAI_MAX_MS),
          headers: { 'user-agent': UA, 'accept-language': 'fr-FR,fr;q=0.9', cookie: this.header(), ...(opts.headers || {}) },
        });
        this.store(res);
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          return this.fetch(new URL(res.headers.get('location'), BASE).href, {}, tries);
        }
        if (res.status === 404 || res.status === 410) {
          const e = new Error(`HTTP ${res.status} sur ${url}`); e.absent = true; throw e;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
        return await res.text();
      } catch (e) {
        if (e.absent || t >= tries) throw e;
        await sleep(ATTENTES_ESSAIS_MS[t - 1] ?? 30000);
      }
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/**
 * Lance une recherche « Vente » sur akorimmo pour les types indiqués et
 * renvoie les fiches détaillées.
 * @param {{types: string[], log?: Function, maxPages?: number, concurrence?: number}} opt
 */
export async function recupererAnnonces({ types, log = console.log, maxPages = 80, concurrence = 1 }) {
  const s = new Session();
  const home = await s.fetch('/fr/acheter');
  const form = parseSearchForm(home);
  const body = new URLSearchParams();
  body.append(`${form.prefix}[search][category][]`, form.vente);
  for (const t of types) {
    const v = form.types[t];
    if (!v) { log(`  ! type « ${t} » introuvable sur akorimmo, ignoré`); continue; }
    body.append(`${form.prefix}[search][type][]`, v);
  }
  body.append(`${form.prefix}[submit]`, '');
  const first = await s.fetch('/fr/acheter', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });

  const vus = new Map();
  let page = parseListPage(first);
  for (let p = 2; page.length && p <= maxPages + 1; p++) {
    let nouveaux = 0;
    for (const v of page) if (!vus.has(v.id)) { vus.set(v.id, v); nouveaux++; }
    if (!nouveaux) break; // page déjà vue : fin de la pagination
    page = parseListPage(await s.fetch(`/fr/recherche?page=${p}`));
  }
  log(`  ${vus.size} annonce(s) trouvée(s) pour : ${types.join(', ')}`);

  if (!vus.size) throw new Error('aucune annonce trouvée sur akorimmo.com (site modifié ?)');

  // Lecture des fiches. Si akorimmo cesse de répondre (5 échecs de suite) ou si
  // trop de fiches manquent, on abandonne : mieux vaut garder le site actuel
  // que publier une liste incomplète.
  const liste = [...vus.values()];
  let erreurs = 0, suite = 0, arret = null;
  const fiches = await pool(liste, concurrence, async (v) => {
    if (arret) return null;
    try {
      const d = parseDetail(await s.fetch(v.url), v.url);
      suite = 0;
      if (!d) log(`  ! fiche illisible : ${v.url}`);
      return d;
    } catch (e) {
      if (e.absent) { log(`  - fiche retirée entre-temps : ${v.url}`); return null; }
      erreurs++; suite++;
      log(`  ! ${e.message}`);
      if (suite >= 5 || /durée maximale/.test(e.message)) arret = e;
      return null;
    }
  });
  if (arret) throw new Error(`akorimmo.com ne répond plus (${arret.message})`);
  const tolerance = Math.max(2, Math.ceil(liste.length * 0.05));
  if (erreurs > tolerance) throw new Error(`${erreurs} fiche(s) sur ${liste.length} n'ont pas pu être lues`);
  return fiches.filter(Boolean);
}
