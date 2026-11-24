import type { Db } from '../db.js';
import { artistsMatch, buildTokenRegex, fold, normalizeArtistForMatch } from '../lib/artistMatch.js';
import type { Track, TrackSource } from '../types.js';
import type { FetchFn, SpotifyService } from './spotify.js';
import type { TrackRepository } from './tracks.js';

export { artistsMatch };

export const CANONICAL_CATEGORIES = [
  'Samba & Pagode',
  'Sertanejo',
  'Funk',
  'Gospel',
  'Rock',
  'MPB',
  'Pop',
  'Forró & Piseiro',
  'Rap & Trap',
  'Eletrônica',
  'Reggae',
  'Flashback',
] as const;

export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

const CANONICAL_CATEGORY_SET = new Set<string>(CANONICAL_CATEGORIES);

export function isCanonicalCategory(value: string | null | undefined): value is CanonicalCategory {
  return Boolean(value && CANONICAL_CATEGORY_SET.has(value.trim()));
}

export const SUBGENRES_BY_CATEGORY: Record<CanonicalCategory, readonly string[]> = {
  Funk: [
    'Funk Anos 2000',
    'Funk Mandelão',
    'Funk Bruxaria',
    'Funk MTG',
    'Funk Automotivo',
    'Funk Melody',
    'Funk Ostentação',
    'Funk Pop',
  ],
  'Samba & Pagode': ['Pagode 90', 'Pagode Atual', 'Samba Raiz'],
  Sertanejo: ['Sertanejo Raiz', 'Sertanejo Universitário', 'Feminejo', 'Agronejo'],
  Gospel: ['Louvor & Adoração', 'Gospel Pentecostal', 'Gospel Jovem'],
  Rock: ['Rock Nacional', 'Rock Clássico', 'Pop Rock', 'Metal & Hard Rock'],
  MPB: ['MPB Clássica', 'Bossa Nova', 'Nova MPB'],
  Pop: ['Pop Nacional', 'Pop Internacional'],
  'Forró & Piseiro': ['Piseiro', 'Forró Eletrônico', 'Forró Tradicional'],
  'Rap & Trap': ['Rap Nacional', 'Trap BR', 'Hip Hop Internacional'],
  Eletrônica: ['EDM & House', 'Brazilian Bass', 'Psytrance & Techno'],
  Reggae: ['Reggae Nacional', 'Reggae Roots'],
  Flashback: ['Flashback 70s/80s', 'Flashback 90s/2000s'],
};

export interface ClassificationContext {
  title: string;
  artist: string;
  album?: string | null;
  year?: number | null;
  hints?: readonly string[];
}

export interface ClassificationOutcome {
  genre: CanonicalCategory;
  subgenre: string | null;
}

export interface AutocategorizeSummary {
  processed: number;
  updated: number;
  skippedManual: number;
  failed: number;
  updatedTrackIds: string[];
}

export type ClassificationSource = 'spotify' | 'deezer' | 'itunes' | 'musicbrainz' | 'heuristic' | 'cache';

export interface TrackClassificationResult {
  updated: boolean;
  genre: string | null;
  subgenre: string | null;
  source: ClassificationSource | null;
  skippedManual?: boolean;
}

export interface CleanedTrackMetadata {
  title: string;
  artist: string;
  searchTitle: string;
  artistCandidates: string[];
  signals: string[];
  extractedArtistFromTitle: boolean;
}

interface ArtistGenreRow {
  artist_key: string;
  artist_name: string;
  genre: string | null;
  subgenre: string | null;
  source: string;
  raw_genres: string | null;
  fetched_at: number;
}

interface ItunesSearchItem {
  artistName?: string;
  trackName?: string;
  primaryGenreName?: string;
  releaseDate?: string;
}

interface DeezerSearchItem {
  id?: number;
  title?: string;
  artist?: { id?: number; name?: string };
  album?: {
    id?: number;
    title?: string;
    genre_id?: number;
    genres?: { data?: Array<{ id?: number; name?: string }> };
  };
}

interface DeezerAlbumResponse {
  id?: number;
  genre_id?: number;
  release_date?: string;
  genres?: { data?: Array<{ id?: number; name?: string }> };
}

interface MusicBrainzTag {
  count?: number;
  name?: string;
}

interface MusicBrainzArtistItem {
  id?: string;
  name?: string;
  score?: number;
  tags?: MusicBrainzTag[];
  genres?: MusicBrainzTag[];
}

const ARTIST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXTERNAL_TIMEOUT_MS = 5000;
const MUSICBRAINZ_MIN_INTERVAL_MS = 1100;
const MUSICBRAINZ_USER_AGENT = 'jkbox-studio/0.1.0 (https://github.com/ApenasGabs/jkbox-studio)';
const VALID_CACHE_SOURCES = new Set(['spotify', 'deezer', 'itunes', 'musicbrainz']);

const BRACKET_NOISE_BODY =
  '(?:(?:feat\\.?|ft\\.?|featuring)\\b[^)\\]}]*|official(?:\\s+(?:music\\s+)?(?:video|audio|lyric\\s+video|lyrics?|visualizer|hd|4k|uhd))?|oficial(?:\\s+(?:clipe|áudio|audio|v[ií]deo|visualizer|lyric\\s+video))?|(?:clipe|v[ií]deo|video|áudio|audio|lyric)\\s+oficial|(?:official\\s+|oficial\\s+)?visualizer|music\\s+video|lyric\\s+video|lyrics?|audio|áudio|videoclipe(?:\\s+oficial)?|clipe\\s+oficial|hd|4k|uhd|hq|1080p|720p|explicit|clean|legendado|tradu[cç][aã]o(?:\\s+pt(?:-?br)?)?|full\\s+album|(?:\\d{4}\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?|mtg)';
const BRACKETED_CLASSIFICATION_NOISE_RE = new RegExp(
  `\\s*(?:\\(${BRACKET_NOISE_BODY}\\)|\\[${BRACKET_NOISE_BODY}\\]|\\{${BRACKET_NOISE_BODY}\\})`,
  'gi',
);
const PIPE_CLASSIFICATION_NOISE_RE =
  /\s*\|\s*(?:official|oficial|music\s+video|lyric\s+video|lyrics?|audio|áudio|visualizer|hd|4k|full\s+album).*$/i;
const TRAILING_DASH_CLASSIFICATION_NOISE_RE =
  /\s+[-–—]\s+(?:official(?:\s+(?:music\s+)?(?:video|audio|lyric\s+video|lyrics?|visualizer))?|oficial(?:\s+(?:clipe|áudio|audio|v[ií]deo))?|lyric\s+video|lyrics?|audio|áudio|clipe\s+oficial|visualizer)\s*$/i;
const TRAILING_FEAT_RE = /\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
const BRACKETED_FEAT_RE = /(?:\(|\[|\{)\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]}]+)(?:\)|\]|\})/gi;
const LEADING_NUMERIC_PREFIX_RE = /^\d{1,3}(?:_\s*|\.\s+)/;
const UNSAFE_SPLIT_RIGHT_RE =
  /^(?:part\.?\s*\d+|pt\.?\s*\d+|ao\s+vivo|live|remix|ac[uú]stico|acoustic|instrumental|karaoke|karaok[eê]|playback|vers[aã]o\b.*|remaster(?:ed)?(?:\s+\d{4})?|intro|outro)$/i;

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normCompact(value: string): string {
  return fold(value).replace(/[^a-z0-9]/g, '');
}

function extractBracketedFeats(value: string): string[] {
  if (!value) return [];
  return [...value.matchAll(BRACKETED_FEAT_RE)].map((m) => m[1].trim()).filter(Boolean);
}

function cleanClassificationArtist(raw: string): string {
  return normalizeSpaces(
    raw
      .replace(BRACKETED_CLASSIFICATION_NOISE_RE, ' ')
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/\s*VEVO$/i, '')
      .replace(/\s*[-–—]\s*(?:Official|Oficial)(?:\s+(?:Channel|Music|Artist))?$/i, '')
      .replace(/\s+(?:Official|Oficial)(?:\s+(?:Channel|Music|Artist))?$/i, '')
      .replace(/\s+Canal\s+Oficial$/i, ''),
  );
}

function cleanClassificationTitle(raw: string): string {
  return normalizeSpaces(
    raw
      .replace(BRACKETED_CLASSIFICATION_NOISE_RE, ' ')
      .replace(PIPE_CLASSIFICATION_NOISE_RE, '')
      .replace(TRAILING_DASH_CLASSIFICATION_NOISE_RE, ''),
  ).replace(LEADING_NUMERIC_PREFIX_RE, '').trim();
}

function isSafeArtistTitleSplit(left: string, right: string): boolean {
  if (left.length < 2 || right.length < 2) return false;
  if (/^\d+$/.test(left)) return false;
  if (UNSAFE_SPLIT_RIGHT_RE.test(fold(right))) return false;
  return true;
}

/** Splits multi-artist strings (`,` except `, The`, `feat.`, `ft.`, `&`, `x`) while preserving duos as first choice. */
export function extractArtistCandidates(
  rawArtist: string,
  rawTitle = '',
  extraFeats: readonly string[] = [],
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (name: string) => {
    const cleaned = cleanClassificationArtist(name).replace(TRAILING_FEAT_RE, '').trim();
    if (!cleaned) return;
    const key = normalizeArtistForMatch(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(cleaned);
  };

  const splitSecondary = (segment: string) =>
    segment
      .split(/\s*(?:,(?!\s*the\b)\s*|;\s*|\s+(?:feat\.?|ft\.?|featuring|vs\.?)\s+)\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);

  const pushWithDuoSplit = (segment: string) => {
    for (const unit of splitSecondary(segment)) {
      pushCandidate(unit);
      if (/\s+(?:&|x)\s+/i.test(unit)) {
        for (const duoPart of unit.split(/\s+(?:&|x)\s+/i)) {
          pushCandidate(duoPart);
        }
      }
    }
  };

  const artistBracketedFeats = extractBracketedFeats(rawArtist);
  const titleBracketedFeats = extractBracketedFeats(rawTitle);
  const artistCleaned = cleanClassificationArtist(rawArtist);
  const featMatch = artistCleaned.match(TRAILING_FEAT_RE);
  const primaryBase = artistCleaned.replace(TRAILING_FEAT_RE, '').trim();
  const titleFeatMatch = cleanClassificationTitle(rawTitle).match(TRAILING_FEAT_RE);

  pushWithDuoSplit(primaryBase);

  for (const extra of [featMatch?.[1], ...artistBracketedFeats, titleFeatMatch?.[1], ...titleBracketedFeats, ...extraFeats]) {
    if (!extra) continue;
    pushWithDuoSplit(extra);
  }

  return candidates;
}

/**
 * Strips YouTube/Spotify noise (`- Topic`, `VEVO`, `Oficial`, `(Visualizer)`, `[2023 Remaster]`,
 * `{Full Album}`, `4_`, `(MTG)`), preserves genre tokens like `MTG`, and safely extracts
 * `"Artist - Title"` when `artist` is empty.
 */
export function cleanTrackMetadataForClassification(rawTitle: string, rawArtist: string): CleanedTrackMetadata {
  const signals: string[] = [];
  const rawCombinedFolded = fold(`${rawTitle} ${rawArtist}`);
  if (tokenRegex('mtg').test(rawCombinedFolded)) {
    signals.push('mtg');
  }

  const bracketedFeats = [...extractBracketedFeats(rawArtist), ...extractBracketedFeats(rawTitle)];
  const initialArtist = cleanClassificationArtist(rawArtist);
  const initialTitle = cleanClassificationTitle(rawTitle);
  let artist = initialArtist;
  let title = initialTitle;
  let extractedArtistFromTitle = false;

  const dash = initialTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    const left = cleanClassificationArtist(dash[1]);
    const right = dash[2].trim().replace(LEADING_NUMERIC_PREFIX_RE, '').trim();
    if (!artist) {
      if (isSafeArtistTitleSplit(left, right)) {
        artist = left;
        title = right;
        extractedArtistFromTitle = true;
      }
    } else {
      const compactLeft = normCompact(left.replace(TRAILING_FEAT_RE, ''));
      const compactArtist = normCompact(artist.replace(TRAILING_FEAT_RE, ''));
      const sameArtist =
        compactLeft.length >= 2 &&
        compactArtist.length >= 2 &&
        (compactLeft === compactArtist || compactLeft.includes(compactArtist) || compactArtist.includes(compactLeft));
      if (sameArtist && right) {
        artist = left;
        title = right;
      }
    }
  }

  if (!title) title = rawTitle.trim();

  const searchTitle = title.replace(TRAILING_FEAT_RE, '').trim() || title;
  const artistCandidates = extractArtistCandidates(artist, title, bracketedFeats);

  return {
    title,
    artist,
    searchTitle,
    artistCandidates,
    signals,
    extractedArtistFromTitle,
  };
}

const TOKEN_REGEX_CACHE = new Map<string, RegExp>();

function tokenRegex(needle: string): RegExp {
  let cached = TOKEN_REGEX_CACHE.get(needle);
  if (!cached) {
    cached = buildTokenRegex(needle);
    TOKEN_REGEX_CACHE.set(needle, cached);
  }
  return cached;
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  if (!haystack) return false;
  return needles.some((needle) => tokenRegex(needle).test(haystack));
}

function matchesArtist(artistFolded: string, candidates: readonly string[]): boolean {
  if (!artistFolded) return false;
  return candidates.some((c) => artistFolded === c || tokenRegex(c).test(artistFolded));
}

// --- Curated BR & international artist / keyword rules -----------------------

const GOSPEL_RAW_KEYWORDS = [
  'gospel',
  'louvor',
  'adoracao',
  'harpa crista',
  'hino evangelico',
  'musica crista',
  'musica evangelica',
  'worship',
  'christian',
  'christian music',
  'ccm',
  'evangelico',
  'evangelica',
  'evangelical',
  'musica gospel',
];
const GOSPEL_TEXT_KEYWORDS = [
  'gospel',
  'harpa crista',
  'hino evangelico',
  'musica crista',
  'musica evangelica',
  'cancao evangelica',
  'louvor e adoracao',
  'louvor & adoracao',
  'adoracao e louvor',
  'casa worship',
  'hillsong worship',
  'elevation worship',
  'corinho de fogo',
];
const GOSPEL_ARTISTS_ADORACAO = [
  'aline barros',
  'fernandinho',
  'gabriela rocha',
  'diante do trono',
  'morada',
  'isadora pompeo',
  'casa worship',
  'ministerio zoe',
  'nivea soares',
  'juliano son',
  'kemuel',
  'eyshila',
  'ana nobrega',
];
const GOSPEL_ARTISTS_PENTECOSTAL = [
  'cassiane',
  'damares',
  'anderson freire',
  'bruna karla',
  'shirley carvalhaes',
  'lauriete',
  'elaine martins',
  'rose nascimento',
  'midian lima',
  'jotta a',
  'regis danese',
  'padre marcelo rossi',
  'padre fabio de melo',
];
const GOSPEL_ARTISTS_JOVEM = ['thalles roberto', 'preto no branco', 'rodolfo abrantes', 'oficina g3', 'rosa de saron'];

const FUNK_ARTISTS_2000 = [
  'claudinho & buchecha',
  'claudinho e buchecha',
  'mc marcinho',
  'bonde do tigrao',
  'mc serginho',
  'lacraia',
  'cidinho e doca',
  'furacao 2000',
  'mc leozinho',
  'perlla',
  'mc andinho',
  'mc bob rum',
];
const FUNK_ARTISTS_MELODY = ['mc sapao', 'mc koringa', 'naldo benny', 'latino', 'mc jean paul', 'biel', 'mc livinho'];
const FUNK_ARTISTS_OSTENTACAO = ['mc guime', 'mc daleste', 'mc lon', 'mc pocahontas', 'mc pikachu', 'mc gui', 'mc rodolfinho'];
const FUNK_ARTISTS_BRUXARIA = ['dj arana', 'tropa do bruxo', 'dj ramon 011', 'dj guuga', 'dj ws da igrejinha'];
const FUNK_ARTISTS_MANDELAO = ['mc paiva', 'mc ryan sp', 'mc ig', 'mc hariel', 'mc kevin', 'mc pedrinho', 'mc don juan', 'mc rick'];
const FUNK_ARTISTS_POP = ['anitta', 'ludmilla', 'pedro sampaio', 'kevinho', 'dennis dj', 'pocah', 'lexa', 'mc kekel'];

function hasDjAndMcCombo(textFolded: string): boolean {
  if (!textFolded) return false;
  return /(?:^|[^a-z0-9])dj\s+[a-z0-9]/.test(textFolded) && /(?:^|[^a-z0-9])mc\s+[a-z0-9]/.test(textFolded);
}

const PAGODE_90_ARTISTS = [
  'raca negra',
  'so pra contrariar',
  'exaltasamba',
  'katinguele',
  'soweto',
  'molejo',
  'karametade',
  'art popular',
  'pixote',
  'negritude junior',
  'os travessos',
  'kiloucura',
];
const PAGODE_ATUAL_ARTISTS = [
  'pericles',
  'thiaguinho',
  'ferrugem',
  'dilsinho',
  'menos e mais',
  'sorriso maroto',
  'turma do pagode',
  'belo',
  'alexandre pires',
  'rodriguinho',
  'mumuzzinho',
  'mumuzinho',
  'grupo revelacao',
  'revelacao',
  'bom gosto',
  'jeito moleque',
];
const SAMBA_RAIZ_ARTISTS = [
  'zeca pagodinho',
  'cartola',
  'beth carvalho',
  'jorge aragao',
  'fundo de quintal',
  'martinho da vila',
  'alcione',
  'clara nunes',
  'adoniran barbosa',
  'bezerra da silva',
  'diogo nogueira',
  'arlindo cruz',
  'paulinho da viola',
];

const SERTANEJO_RAIZ_ARTISTS = [
  'tiao carreiro',
  'milionario e jose rico',
  'milionario & jose rico',
  'chitaozinho e xororo',
  'chitaozinho & xororo',
  'zeze di camargo',
  'leandro e leonardo',
  'leandro & leonardo',
  'joao mineiro',
  'tonico e tinoco',
  'sergio reis',
  'daniel',
  'rio negro e solimoes',
  'rionegro & solimoes',
  'bruno e marrone',
  'bruno & marrone',
  'chrystian e ralf',
  'chrystian & ralf',
  'christian e ralf',
  'christian & ralf',
];
const SERTANEJO_FEMINEJO_ARTISTS = [
  'marilia mendonca',
  'maiara e maraisa',
  'maiara & maraisa',
  'simone e simaria',
  'simone & simaria',
  'simone mendes',
  'naiara azevedo',
  'lauana prado',
  'paula fernandes',
];
const SERTANEJO_AGRONEJO_ARTISTS = ['ana castela', 'luan pereira', 'us agroboy', 'leo e raphael', 'dj kevin'];
const SERTANEJO_UNIV_ARTISTS = [
  'jorge e mateus',
  'jorge & mateus',
  'gusttavo lima',
  'henrique e juliano',
  'henrique & juliano',
  'luan santana',
  'ze neto e cristiano',
  'ze neto & cristiano',
  'matheus e kauan',
  'matheus & kauan',
  'wesley safadao',
  'hugo e guilherme',
  'hugo & guilherme',
  'murilo huff',
  'michel telo',
  'cesar menotti',
  'gustavo mioto',
  'felipe araujo',
  'israel e rodolffo',
  'israel & rodolffo',
  'fernando e sorocaba',
];

const FORRO_PISEIRO_ARTISTS = ['joao gomes', 'ze vaqueiro', 'os baroes da pisadinha', 'baroes da pisadinha', 'tarcisio do acordeon', 'nattan', 'mari fernandez', 'eric land', 'xand aviao'];
const FORRO_ELETRONICO_ARTISTS = ['calcinha preta', 'avioes do forro', 'mastruz com leite', 'limao com mel', 'desejo de menina', 'magníficos', 'magnificos', 'saia rodada', 'cavaleiros do forro'];
const FORRO_TRADICIONAL_ARTISTS = ['luiz gonzaga', 'falamansa', 'dominguinhos', 'alceu valenca', 'rastape', 'elba ramalho', 'jackson do pandeiro'];

const MPB_BOSSA_ARTISTS = ['tom jobim', 'antonio carlos jobim', 'joao gilberto', 'vinicius de moraes', 'toquinho', 'elis regina'];
const MPB_NOVA_ARTISTS = ['anavitoria', 'rubel', 'lagum', 'melim', 'tiago iorc', 'silva', 'gilsons', 'liniker', 'bala desejo'];
const MPB_CLASSICA_ARTISTS = ['djavan', 'caetano veloso', 'gilberto gil', 'chico buarque', 'tim maia', 'milton nascimento', 'marisa monte', 'gal costa', 'maria bethania', 'seu jorge', 'ney matogrosso', 'adriana calcanhotto', 'cazuza', 'tribalistas', 'nando reis', 'cassia eller', 'jorge ben jor'];

const ROCK_NACIONAL_ARTISTS = [
  'legiao urbana',
  'charlie brown jr',
  'titas',
  'paralamas do sucesso',
  'os paralamas do sucesso',
  'capital inicial',
  'skank',
  'barao vermelho',
  'raimundos',
  'pitty',
  'engenheiros do hawaii',
  'cpm 22',
  'detonautas',
  'jota quest',
  'o rappa',
  'los hermanos',
  'raul seixas',
  'rita lee',
  'ultraje a rigor',
  'ira!',
  'nx zero',
  'fresno',
  'sepultura',
];
const ROCK_METAL_ARTISTS = ['metallica', 'iron maiden', 'system of a down', 'slipknot', 'linkin park', 'megadeth', 'black sabbath', 'avenged sevenfold', 'evanescence', 'rammstein'];
const ROCK_CLASSICO_ARTISTS = ['queen', 'the beatles', 'beatles', 'led zeppelin', 'pink floyd', 'ac/dc', 'acdc', 'rolling stones', 'the rolling stones', 'guns n roses', "guns n' roses", 'aerosmith', 'bon jovi', 'nirvana', 'pearl jam', 'u2', 'the doors', 'creedence', 'dire straits', 'deep purple'];

const RAP_NACIONAL_ARTISTS = ['racionais', 'sabotage', 'criolo', 'emicida', 'marcelo d2', 'djonga', 'hungria', 'gabriel o pensador', 'mv bill', 'rashid', 'projota', 'bk', 'black alien'];
const TRAP_BR_ARTISTS = ['matue', 'teto', 'wiu', 'orochi', 'filipe ret', 'l7nnon', 'veigh', 'kayblack', 'mc cabelinho', 'baco exu do blues', 'sidoka', 'recayd mob'];
const HIPHOP_INTL_ARTISTS = [
  'eminem',
  '2pac',
  'tupac',
  'snoop dogg',
  'kendrick lamar',
  'drake',
  'travis scott',
  'kanye west',
  'jay-z',
  '50 cent',
  'post malone',
  'lil wayne',
  'nicki minaj',
  'cardi b',
  'tyler, the creator',
  'tyler the creator',
  'j. cole',
  'j cole',
  'asap rocky',
  'a$ap rocky',
  'playboi carti',
  '21 savage',
  'future',
  'metro boomin',
];

const ELETRONICA_BRAZILIAN_BASS = [
  'alok',
  'vintage culture',
  'bhaskar',
  'kvsh',
  'cat dealers',
  'dubdogz',
  'liu',
  'gabriel boni',
  'afterclapp',
  'illusionize',
  'mochakk',
  'victor lou',
  'chemical surf',
  'bruno be',
];
const ELETRONICA_PSY_TECHNO = ['vini vici', 'astrix', 'charlotte de witte', 'amelie lens', 'infected mushroom', 'carl cox'];
const ELETRONICA_EDM = ['david guetta', 'calvin harris', 'tiesto', 'avicii', 'martin garrix', 'skrillex', 'daft punk', 'marshmello', 'deadmau5', 'kygo', 'armin van buuren'];

const REGGAE_NACIONAL_ARTISTS = ['natiruts', 'maneva', 'planta e raiz', 'armandinho', 'cidade negra', 'chimarruts', 'mato seco', 'tribo de jah'];
const REGGAE_ROOTS_ARTISTS = ['bob marley', 'peter tosh', 'jimmy cliff', 'soja', 'ub40', 'inner circle', 'groundation'];

const FLASHBACK_70_80_ARTISTS = ['bee gees', 'abba', 'michael jackson', 'madonna', 'cyndi lauper', 'a-ha', 'tears for fears', 'duran duran', 'pet shop boys', 'earth wind & fire', 'kool & the gang', 'gloria gaynor', 'donna summer', 'modern talking', 'rick astley', 'roxette', 'elvis presley', 'whitney houston', 'lionel richie'];
const FLASHBACK_90_2000_ARTISTS = ['backstreet boys', 'spice girls', 'ace of base', 'aqua', 'corona', 'la bouche', 'snap!', 'haddaway', 'vengaboys', 'scorpions', 'nsync', 'westlife', 'robbie williams', 'cher'];

const POP_NACIONAL_ARTISTS = ['iza', 'pabllo vittar', 'jao', 'gloria groove', 'luisa sonza', 'luan', 'sandy', 'sandy e junior', 'kelly key', 'rouge', 'melim', 'duda beat', 'marina sena'];
const POP_INTL_ARTISTS = ['taylor swift', 'dua lipa', 'bruno mars', 'beyonce', 'rihanna', 'katy perry', 'lady gaga', 'the weeknd', 'ed sheeran', 'justin bieber', 'ariana grande', 'adele', 'billie eilish', 'coldplay', 'maroon 5', 'shawn mendes', 'harry styles', 'miley cyrus', 'shakira', 'sia'];

function detectSubgenreForCategory(
  category: CanonicalCategory,
  rawFolded: string,
  titleFolded: string,
  artistFolded: string,
  year: number | null,
): string | null {
  const combined = `${rawFolded} ${titleFolded}`;
  switch (category) {
    case 'Funk': {
      if (containsAny(combined, ['mtg']) || containsAny(artistFolded, ['mtg'])) {
        return 'Funk MTG';
      }
      if (containsAny(combined, ['automotivo', 'funk automotivo'])) {
        return 'Funk Automotivo';
      }
      if (
        containsAny(combined, ['bruxaria', 'bruxo', 'ritmada']) ||
        matchesArtist(artistFolded, FUNK_ARTISTS_BRUXARIA)
      ) {
        return 'Funk Bruxaria';
      }
      if (
        containsAny(combined, ['mandelao', 'mandela', 'dz7', 'fluxo', 'bololo']) ||
        matchesArtist(artistFolded, FUNK_ARTISTS_MANDELAO)
      ) {
        return 'Funk Mandelão';
      }
      if (containsAny(combined, ['melody', 'romantico']) || matchesArtist(artistFolded, FUNK_ARTISTS_MELODY)) {
        return 'Funk Melody';
      }
      if (containsAny(combined, ['ostentacao']) || matchesArtist(artistFolded, FUNK_ARTISTS_OSTENTACAO)) {
        return 'Funk Ostentação';
      }
      if (
        containsAny(combined, ['anos 2000', '2000', 'furacao 2000', 'old school', 'das antigas', 'das antiga']) ||
        matchesArtist(artistFolded, FUNK_ARTISTS_2000) ||
        (year !== null && year >= 1995 && year <= 2010)
      ) {
        return 'Funk Anos 2000';
      }
      if (containsAny(combined, ['funk pop', 'pop']) || matchesArtist(artistFolded, FUNK_ARTISTS_POP)) {
        return 'Funk Pop';
      }
      return null;
    }
    case 'Samba & Pagode': {
      if (
        containsAny(combined, ['pagode 90', 'anos 90', 'pagode retro']) ||
        matchesArtist(artistFolded, PAGODE_90_ARTISTS) ||
        (year !== null && year >= 1988 && year <= 2003 && containsAny(combined, ['pagode', ...PAGODE_ATUAL_ARTISTS]))
      ) {
        return 'Pagode 90';
      }
      if (containsAny(combined, ['samba raiz', 'samba de roda', 'partido alto']) || matchesArtist(artistFolded, SAMBA_RAIZ_ARTISTS)) {
        return 'Samba Raiz';
      }
      if (containsAny(combined, ['pagode']) || matchesArtist(artistFolded, PAGODE_ATUAL_ARTISTS)) {
        return 'Pagode Atual';
      }
      return 'Samba Raiz';
    }
    case 'Sertanejo': {
      if (containsAny(combined, ['agronejo', 'agro', 'boiadeira']) || matchesArtist(artistFolded, SERTANEJO_AGRONEJO_ARTISTS)) {
        return 'Agronejo';
      }
      if (containsAny(combined, ['feminejo']) || matchesArtist(artistFolded, SERTANEJO_FEMINEJO_ARTISTS)) {
        return 'Feminejo';
      }
      if (
        containsAny(combined, ['raiz', 'modao', 'moda de viola', 'caipira']) ||
        matchesArtist(artistFolded, SERTANEJO_RAIZ_ARTISTS) ||
        (year !== null && year < 2005)
      ) {
        return 'Sertanejo Raiz';
      }
      return 'Sertanejo Universitário';
    }
    case 'Gospel': {
      if (containsAny(combined, ['pentecostal', 'fogo', 'manto']) || matchesArtist(artistFolded, GOSPEL_ARTISTS_PENTECOSTAL)) {
        return 'Gospel Pentecostal';
      }
      if (containsAny(combined, ['gospel rock', 'jovem']) || matchesArtist(artistFolded, GOSPEL_ARTISTS_JOVEM)) {
        return 'Gospel Jovem';
      }
      if (containsAny(combined, ['louvor', 'adoracao', 'worship']) || matchesArtist(artistFolded, GOSPEL_ARTISTS_ADORACAO)) {
        return 'Louvor & Adoração';
      }
      return 'Louvor & Adoração';
    }
    case 'Rock': {
      if (
        containsAny(combined, ['metal', 'heavy', 'thrash', 'hardcore', 'nu metal', 'hard rock']) ||
        matchesArtist(artistFolded, ROCK_METAL_ARTISTS)
      ) {
        return 'Metal & Hard Rock';
      }
      if (containsAny(combined, ['rock nacional', 'brazilian rock', 'rock br']) || matchesArtist(artistFolded, ROCK_NACIONAL_ARTISTS)) {
        return 'Rock Nacional';
      }
      if (containsAny(combined, ['pop rock', 'indie rock'])) {
        return 'Pop Rock';
      }
      if (
        containsAny(combined, ['classic rock', 'rock classico']) ||
        matchesArtist(artistFolded, ROCK_CLASSICO_ARTISTS) ||
        (year !== null && year < 1992)
      ) {
        return 'Rock Clássico';
      }
      return null;
    }
    case 'MPB': {
      if (containsAny(combined, ['bossa nova', 'bossa']) || matchesArtist(artistFolded, MPB_BOSSA_ARTISTS)) {
        return 'Bossa Nova';
      }
      if (containsAny(combined, ['nova mpb']) || matchesArtist(artistFolded, MPB_NOVA_ARTISTS) || (year !== null && year >= 2012)) {
        return 'Nova MPB';
      }
      return 'MPB Clássica';
    }
    case 'Forró & Piseiro': {
      if (containsAny(combined, ['piseiro', 'pisadinha']) || matchesArtist(artistFolded, FORRO_PISEIRO_ARTISTS) || (year !== null && year >= 2019)) {
        return 'Piseiro';
      }
      if (containsAny(combined, ['forro eletronico', 'das antigas']) || matchesArtist(artistFolded, FORRO_ELETRONICO_ARTISTS)) {
        return 'Forró Eletrônico';
      }
      if (containsAny(combined, ['pe de serra', 'xote', 'baiao', 'tradicional']) || matchesArtist(artistFolded, FORRO_TRADICIONAL_ARTISTS)) {
        return 'Forró Tradicional';
      }
      return 'Piseiro';
    }
    case 'Rap & Trap': {
      if (containsAny(combined, ['trap br', 'trap brasileiro', 'trap']) && (matchesArtist(artistFolded, TRAP_BR_ARTISTS) || containsAny(combined, ['br', 'brasil']))) {
        return 'Trap BR';
      }
      if (matchesArtist(artistFolded, TRAP_BR_ARTISTS)) return 'Trap BR';
      if (containsAny(combined, ['rap nacional', 'brazilian hip hop', 'hip hop br']) || matchesArtist(artistFolded, RAP_NACIONAL_ARTISTS)) {
        return 'Rap Nacional';
      }
      if (matchesArtist(artistFolded, HIPHOP_INTL_ARTISTS)) return 'Hip Hop Internacional';
      return null;
    }
    case 'Eletrônica': {
      if (
        containsAny(combined, ['brazilian bass', 'slap house', 'brazilian electronic']) ||
        matchesArtist(artistFolded, ELETRONICA_BRAZILIAN_BASS)
      ) {
        return 'Brazilian Bass';
      }
      if (containsAny(combined, ['psytrance', 'psy', 'techno', 'trance']) || matchesArtist(artistFolded, ELETRONICA_PSY_TECHNO)) {
        return 'Psytrance & Techno';
      }
      return 'EDM & House';
    }
    case 'Reggae': {
      if (containsAny(combined, ['brazilian reggae', 'reggae nacional']) || matchesArtist(artistFolded, REGGAE_NACIONAL_ARTISTS)) {
        return 'Reggae Nacional';
      }
      return 'Reggae Roots';
    }
    case 'Flashback': {
      if (
        containsAny(combined, ['anos 90', '90s', '2000', 'eurodance']) ||
        matchesArtist(artistFolded, FLASHBACK_90_2000_ARTISTS) ||
        (year !== null && year >= 1990 && year <= 2005)
      ) {
        return 'Flashback 90s/2000s';
      }
      return 'Flashback 70s/80s';
    }
    case 'Pop': {
      if (containsAny(combined, ['brazilian pop', 'pop nacional', 'pop br']) || matchesArtist(artistFolded, POP_NACIONAL_ARTISTS)) {
        return 'Pop Nacional';
      }
      if (matchesArtist(artistFolded, POP_INTL_ARTISTS)) return 'Pop Internacional';
      return null;
    }
  }
}

/**
 * Normalizes raw external genres (Spotify/Deezer/iTunes/MusicBrainz/ID3) plus track title/artist/album/year
 * into one of the canonical categories and an optional subcategory.
 * Gospel is checked first with high precision to keep it strictly isolated.
 */
export function normalizeGenreAndSubgenre(
  rawGenres: readonly string[],
  context: ClassificationContext,
): ClassificationOutcome | null {
  const rawFolded = rawGenres.map(fold).filter(Boolean).join(' ');
  const hintFolded = (context.hints ?? []).map(fold).filter(Boolean).join(' ');
  const combinedRawFolded = [rawFolded, hintFolded].filter(Boolean).join(' ');
  const titleFolded = fold(context.title);
  const artistFolded = fold(context.artist);
  const albumFolded = fold(context.album ?? '');
  const year = context.year ?? null;
  const contextText = `${titleFolded} ${artistFolded} ${albumFolded}`.trim();
  const signalText = `${contextText} ${hintFolded}`.trim();

  // 1. Strict Gospel priority (prevents Gospel from ever falling into Pop/MPB/Rock).
  if (
    containsAny(rawFolded, GOSPEL_RAW_KEYWORDS) ||
    containsAny(contextText, GOSPEL_TEXT_KEYWORDS) ||
    matchesArtist(artistFolded, GOSPEL_ARTISTS_ADORACAO) ||
    matchesArtist(artistFolded, GOSPEL_ARTISTS_PENTECOSTAL) ||
    matchesArtist(artistFolded, GOSPEL_ARTISTS_JOVEM)
  ) {
    return {
      genre: 'Gospel',
      subgenre: detectSubgenreForCategory('Gospel', combinedRawFolded, titleFolded, artistFolded, year),
    };
  }

  // 2a. Strong deterministic Funk BR signals (take precedence over mislabeled external Hip-Hop/Dance tags).
  const hasMtgSignal = containsAny(`${signalText} ${rawFolded}`, ['mtg']);
  const hasDjMcSignal = hasDjAndMcCombo(artistFolded) || (!artistFolded && hasDjAndMcCombo(titleFolded));
  const hasStrongFunkArtist = matchesArtist(artistFolded, [...FUNK_ARTISTS_BRUXARIA, ...FUNK_ARTISTS_MANDELAO]);
  const hasStrongFunkKeyword = containsAny(signalText, [
    'funk carioca',
    'funk brasileiro',
    'baile funk',
    'brega funk',
    'mandelao',
    'bruxaria',
    'ritmada',
    'automotivo',
    'bololo',
    'furacao 2000',
    'tamborzao',
    'dz7',
  ]);
  const hasBailePattern = /\bbaile\s+d[aeo]s?\s+[a-z0-9]+/.test(`${titleFolded} ${albumFolded}`);
  const rawContradictsBaile = containsAny(rawFolded, ['forro', 'piseiro', 'sertanejo', 'samba', 'pagode', 'rock', 'mpb']);

  if (
    hasMtgSignal ||
    hasDjMcSignal ||
    hasStrongFunkArtist ||
    hasStrongFunkKeyword ||
    (hasBailePattern && !rawContradictsBaile)
  ) {
    return {
      genre: 'Funk',
      subgenre: detectSubgenreForCategory('Funk', combinedRawFolded, titleFolded, artistFolded, year),
    };
  }

  // 2b. Map raw external genres (Spotify / Deezer / iTunes / MusicBrainz / ID3).
  if (rawFolded) {
    const mapRaw = (): CanonicalCategory | null => {
      if (
        !containsAny(rawFolded, ['soul & funk', 'soul/funk', 'funk/soul']) &&
        containsAny(rawFolded, ['funk', 'baile funk', 'brega funk', 'mandelao', 'bruxaria', 'funk carioca', 'funk brasileiro'])
      ) {
        return 'Funk';
      }
      if (containsAny(rawFolded, ['pagode', 'samba'])) return 'Samba & Pagode';
      if (containsAny(rawFolded, ['sertanejo', 'arrocha', 'agronejo', 'modao'])) return 'Sertanejo';
      if (containsAny(rawFolded, ['forro', 'piseiro', 'pisadinha', 'xote', 'baiao'])) return 'Forró & Piseiro';
      if (containsAny(rawFolded, ['mpb', 'bossa nova', 'tropicalia', 'musica popular brasileira'])) return 'MPB';
      if (containsAny(rawFolded, ['hip hop', 'hip-hop', 'rap', 'trap', 'boom bap', 'drill'])) return 'Rap & Trap';
      if (containsAny(rawFolded, ['rock', 'metal', 'punk', 'grunge', 'indie', 'alternative'])) {
        if (matchesArtist(artistFolded, FLASHBACK_70_80_ARTISTS) && !matchesArtist(artistFolded, ROCK_CLASSICO_ARTISTS)) {
          return 'Flashback';
        }
        return 'Rock';
      }
      if (containsAny(rawFolded, ['disco', 'synthpop', 'new wave', 'eurodance', 'italo', 'flashback', 'oldies'])) {
        return 'Flashback';
      }
      if (
        containsAny(rawFolded, [
          'electronic',
          'eletronica',
          'electronica',
          'electro',
          'edm',
          'house',
          'deep house',
          'tech house',
          'slap house',
          'techno',
          'trance',
          'psytrance',
          'brazilian bass',
          'drum and bass',
          'dnb',
          'dubstep',
          'dance',
        ])
      ) {
        if (year !== null && year <= 1989 && containsAny(rawFolded, ['disco', 'dance', 'synth'])) return 'Flashback';
        if (matchesArtist(artistFolded, FLASHBACK_70_80_ARTISTS) || matchesArtist(artistFolded, FLASHBACK_90_2000_ARTISTS)) {
          return 'Flashback';
        }
        return 'Eletrônica';
      }
      if (containsAny(rawFolded, ['reggae', 'dub', 'ska'])) return 'Reggae';
      if (containsAny(rawFolded, ['pop', 'electropop', 'europop', 'britpop', 'afropop', 'r&b', 'soul', 'latin'])) {
        if (
          matchesArtist(artistFolded, FLASHBACK_70_80_ARTISTS) ||
          matchesArtist(artistFolded, FLASHBACK_90_2000_ARTISTS) ||
          (year !== null && year >= 1970 && year <= 1989 && !matchesArtist(artistFolded, MPB_CLASSICA_ARTISTS))
        ) {
          return 'Flashback';
        }
        return 'Pop';
      }
      return null;
    };

    const mapped = mapRaw();
    if (mapped) {
      return {
        genre: mapped,
        subgenre: detectSubgenreForCategory(mapped, combinedRawFolded, titleFolded, artistFolded, year),
      };
    }
  }

  // 3. Heuristic BR + year + title/artist rules.
  const inferHeuristicCategory = (): CanonicalCategory | null => {
    if (
      hasBailePattern ||
      containsAny(`${titleFolded} ${albumFolded}`, ['funk', 'mandelao', 'bruxaria', 'baile', 'furacao 2000', 'tamborzao', 'automotivo', 'bololo']) ||
      matchesArtist(artistFolded, [
        ...FUNK_ARTISTS_2000,
        ...FUNK_ARTISTS_MELODY,
        ...FUNK_ARTISTS_OSTENTACAO,
        ...FUNK_ARTISTS_MANDELAO,
        ...FUNK_ARTISTS_BRUXARIA,
        ...FUNK_ARTISTS_POP,
      ])
    ) {
      return 'Funk';
    }
    if (
      containsAny(`${titleFolded} ${albumFolded}`, ['pagode', 'samba', 'rodas de samba']) ||
      matchesArtist(artistFolded, [...PAGODE_90_ARTISTS, ...PAGODE_ATUAL_ARTISTS, ...SAMBA_RAIZ_ARTISTS])
    ) {
      return 'Samba & Pagode';
    }
    if (
      containsAny(`${titleFolded} ${albumFolded}`, ['sertanejo', 'modao', 'moda de viola', 'agronejo']) ||
      matchesArtist(artistFolded, [
        ...SERTANEJO_RAIZ_ARTISTS,
        ...SERTANEJO_FEMINEJO_ARTISTS,
        ...SERTANEJO_AGRONEJO_ARTISTS,
        ...SERTANEJO_UNIV_ARTISTS,
      ])
    ) {
      return 'Sertanejo';
    }
    if (
      containsAny(`${titleFolded} ${albumFolded}`, ['piseiro', 'pisadinha', 'forro', 'xote']) ||
      matchesArtist(artistFolded, [...FORRO_PISEIRO_ARTISTS, ...FORRO_ELETRONICO_ARTISTS, ...FORRO_TRADICIONAL_ARTISTS])
    ) {
      return 'Forró & Piseiro';
    }
    if (
      containsAny(`${titleFolded} ${albumFolded}`, ['bossa nova', 'mpb']) ||
      matchesArtist(artistFolded, [...MPB_BOSSA_ARTISTS, ...MPB_NOVA_ARTISTS, ...MPB_CLASSICA_ARTISTS])
    ) {
      return 'MPB';
    }
    if (
      containsAny(`${titleFolded} ${albumFolded}`, ['trap', 'boombap', 'rap nacional', 'cypher', 'poesia acustica']) ||
      matchesArtist(artistFolded, [...RAP_NACIONAL_ARTISTS, ...TRAP_BR_ARTISTS, ...HIPHOP_INTL_ARTISTS])
    ) {
      return 'Rap & Trap';
    }
    if (
      containsAny(`${titleFolded} ${albumFolded}`, ['reggae']) ||
      matchesArtist(artistFolded, [...REGGAE_NACIONAL_ARTISTS, ...REGGAE_ROOTS_ARTISTS])
    ) {
      return 'Reggae';
    }
    if (
      containsAny(`${titleFolded} ${albumFolded}`, ['rock', 'metal', 'acustico mtv']) ||
      matchesArtist(artistFolded, [...ROCK_NACIONAL_ARTISTS, ...ROCK_METAL_ARTISTS, ...ROCK_CLASSICO_ARTISTS])
    ) {
      return 'Rock';
    }
    if (
      containsAny(`${titleFolded} ${albumFolded}`, ['remix', 'psytrance', 'techno', 'house', 'edm', 'dj set', 'brazilian bass']) ||
      matchesArtist(artistFolded, [...ELETRONICA_BRAZILIAN_BASS, ...ELETRONICA_PSY_TECHNO, ...ELETRONICA_EDM])
    ) {
      return 'Eletrônica';
    }
    if (
      containsAny(`${titleFolded} ${albumFolded}`, ['flashback', 'anos 80', 'anos 70', 'eurodance', 'disco']) ||
      matchesArtist(artistFolded, [...FLASHBACK_70_80_ARTISTS, ...FLASHBACK_90_2000_ARTISTS])
    ) {
      return 'Flashback';
    }
    if (matchesArtist(artistFolded, [...POP_NACIONAL_ARTISTS, ...POP_INTL_ARTISTS])) {
      return 'Pop';
    }
    if (year !== null && year >= 1970 && year <= 1989) {
      return 'Flashback';
    }
    return null;
  };

  const heuristicCat = inferHeuristicCategory();
  if (!heuristicCat) return null;
  return {
    genre: heuristicCat,
    subgenre: detectSubgenreForCategory(heuristicCat, combinedRawFolded, titleFolded, artistFolded, year),
  };
}

function isValidDeezerGenreName(name: string | undefined): name is string {
  const trimmed = name?.trim();
  if (!trimmed) return false;
  const folded = fold(trimmed);
  return folded !== 'all' && folded !== 'todos';
}

function escapeLucenePhrase(value: string): string {
  return value.replace(/[\\"]/g, '\\$&');
}

function parseReleaseYear(releaseDate: string | undefined): number | null {
  if (!releaseDate) return null;
  const match = releaseDate.match(/^(\d{4})\b/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1000 && year <= 2100 ? year : null;
}

/**
 * Cascading zero-AI track classifier:
 * 1. Spotify Artist Genres (when configured)
 * 2. Deezer Search API (free, keyless)
 * 3. iTunes Search API (free, keyless, strict artist match validation)
 * 4. MusicBrainz Artist API (free, keyless, custom User-Agent + rate limited)
 * 5. Brazilian heuristic + release year normalization
 * Results are cached per artist in `artist_genres` and never overwrite `genre_manual = 1`.
 */
export class ClassifierService {
  private readonly deezerGenreCache = new Map<number, string>();
  private readonly musicBrainzMinIntervalMs: number;
  private musicBrainzQueue: Promise<void> = Promise.resolve();
  private lastMusicBrainzRequestAt = 0;

  constructor(
    private readonly db: Db,
    private readonly tracks: TrackRepository,
    private readonly spotify?: SpotifyService,
    private readonly fetchFn: FetchFn = fetch,
    private readonly log: (msg: string) => void = console.log,
    private readonly externalLookup = true,
    options: { musicBrainzMinIntervalMs?: number } = {},
  ) {
    this.musicBrainzMinIntervalMs = options.musicBrainzMinIntervalMs ?? MUSICBRAINZ_MIN_INTERVAL_MS;
  }

  private getCachedArtist(artist: string): {
    rawGenres: string[];
    genre: string | null;
    subgenre: string | null;
    source: string;
  } | null {
    const key = artist.trim().toLowerCase();
    if (!key) return null;
    const row = this.db.prepare('SELECT * FROM artist_genres WHERE artist_key = ?').get(key) as
      | ArtistGenreRow
      | undefined;
    if (!row) return null;
    if (Date.now() - row.fetched_at > ARTIST_CACHE_TTL_MS) return null;
    if (!VALID_CACHE_SOURCES.has(row.source)) return null;
    let rawGenres: string[] = [];
    if (row.raw_genres) {
      try {
        const parsed = JSON.parse(row.raw_genres);
        if (Array.isArray(parsed)) rawGenres = parsed.filter((g): g is string => typeof g === 'string' && g.trim().length > 0);
      } catch {
        rawGenres = [];
      }
    }
    if (rawGenres.length === 0) return null;
    return {
      rawGenres,
      genre: row.genre,
      subgenre: row.subgenre,
      source: row.source,
    };
  }

  private saveArtistCache(
    artistName: string,
    data: { rawGenres: string[]; genre: string | null; subgenre: string | null; source: string },
  ): void {
    const key = artistName.trim().toLowerCase();
    if (!key) return;
    this.db
      .prepare(
        `INSERT INTO artist_genres (artist_key, artist_name, genre, subgenre, source, raw_genres, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (artist_key) DO UPDATE SET
           artist_name = excluded.artist_name,
           genre = excluded.genre,
           subgenre = excluded.subgenre,
           source = excluded.source,
           raw_genres = excluded.raw_genres,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        key,
        artistName.trim(),
        data.genre,
        data.subgenre,
        data.source,
        JSON.stringify(data.rawGenres),
        Date.now(),
      );
  }

  private async fetchFromSpotify(
    source: TrackSource | undefined,
    sourceId: string | undefined,
    title: string,
    artistCandidates: readonly string[],
  ): Promise<{ genres: string[]; year: number | null; matchedArtist?: string } | null> {
    if (!this.spotify?.configured) return null;
    let discoveredYear: number | null = null;
    try {
      if (source === 'spotify' && sourceId) {
        const info = await this.spotify.getTrackArtistGenres(sourceId);
        if (info.year !== null) discoveredYear = info.year;
        if (info.genres.length > 0) {
          return { genres: info.genres, year: info.year, matchedArtist: info.artistName ?? artistCandidates[0] };
        }
      }
      for (const candidate of artistCandidates.slice(0, 3)) {
        const genres = await this.spotify.searchArtistGenres(candidate);
        if (genres.length > 0) {
          return { genres, year: discoveredYear, matchedArtist: candidate };
        }
      }
      if (discoveredYear !== null) {
        return { genres: [], year: discoveredYear };
      }
    } catch (err) {
      this.log(`[classifier] falha no Spotify para "${artistCandidates[0] || title}": ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  private async resolveDeezerGenreName(genreId: number): Promise<string | null> {
    if (!Number.isInteger(genreId) || genreId <= 0) return null;
    const cached = this.deezerGenreCache.get(genreId);
    if (cached) return cached;
    try {
      const res = await this.fetchFn(`https://api.deezer.com/genre/${genreId}`, {
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { id?: number; name?: string };
      if (!isValidDeezerGenreName(body.name)) return null;
      const name = body.name.trim();
      this.deezerGenreCache.set(genreId, name);
      return name;
    } catch (err) {
      this.log(`[classifier] falha ao resolver gênero Deezer #${genreId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async fetchFromDeezer(
    title: string,
    artistCandidates: readonly string[],
  ): Promise<{ genres: string[]; year: number | null; matchedArtist?: string } | null> {
    if (!this.externalLookup || artistCandidates.length === 0) return null;
    for (const candidate of artistCandidates.slice(0, 3)) {
      const queries = title ? [`${candidate} ${title}`, candidate] : [candidate];
      for (const q of queries) {
        try {
          const params = new URLSearchParams({ q: q.trim(), limit: '5' });
          const res = await this.fetchFn(`https://api.deezer.com/search?${params}`, {
            signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
          });
          if (!res.ok) continue;
          const body = (await res.json()) as { data?: DeezerSearchItem[] };
          const items = Array.isArray(body.data) ? body.data : [];
          const match = items.find((item) => artistsMatch([candidate], item.artist?.name ?? ''));
          if (!match) continue;

          const genres: string[] = [];
          let year: number | null = null;

          for (const g of match.album?.genres?.data ?? []) {
            if (isValidDeezerGenreName(g.name)) genres.push(g.name.trim());
          }

          let genreId =
            typeof match.album?.genre_id === 'number' && Number.isInteger(match.album.genre_id) && match.album.genre_id > 0
              ? match.album.genre_id
              : null;
          const albumId = match.album?.id;
          if (genres.length === 0 && !genreId && typeof albumId === 'number' && Number.isInteger(albumId) && albumId > 0) {
            try {
              const albumRes = await this.fetchFn(`https://api.deezer.com/album/${albumId}`, {
                signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
              });
              if (albumRes.ok) {
                const albumBody = (await albumRes.json()) as DeezerAlbumResponse;
                year = parseReleaseYear(albumBody.release_date);
                for (const g of albumBody.genres?.data ?? []) {
                  if (isValidDeezerGenreName(g.name)) genres.push(g.name.trim());
                }
                if (typeof albumBody.genre_id === 'number' && Number.isInteger(albumBody.genre_id) && albumBody.genre_id > 0) {
                  genreId = albumBody.genre_id;
                }
              }
            } catch (err) {
              this.log(`[classifier] falha ao consultar álbum Deezer #${albumId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          if (genres.length === 0 && genreId) {
            const resolved = await this.resolveDeezerGenreName(genreId);
            if (resolved) genres.push(resolved);
          }

          if (genres.length > 0 || year !== null) {
            return { genres: [...new Set(genres)], year, matchedArtist: candidate };
          }
        } catch (err) {
          this.log(`[classifier] falha na Deezer para "${q}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return null;
  }

  private async fetchFromItunes(
    title: string,
    artistCandidates: readonly string[],
  ): Promise<{ genres: string[]; year: number | null; matchedArtist?: string } | null> {
    if (!this.externalLookup || artistCandidates.length === 0) return null;
    for (const candidate of artistCandidates.slice(0, 3)) {
      const term = [candidate, title].filter(Boolean).join(' ').trim();
      if (!term) continue;
      try {
        const params = new URLSearchParams({
          term,
          media: 'music',
          entity: 'song',
          country: 'BR',
          limit: '5',
        });
        const res = await this.fetchFn(`https://itunes.apple.com/search?${params}`, {
          signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { results?: ItunesSearchItem[] };
        const items = Array.isArray(body.results) ? body.results : [];
        if (items.length === 0) continue;

        // Strict artist validation: never accept homonymous songs by unrelated artists.
        const best = items.find((item) => artistsMatch([candidate], item.artistName ?? ''));
        if (!best) continue;

        const genre = best.primaryGenreName?.trim();
        const year = parseReleaseYear(best.releaseDate);
        if (!genre && year === null) continue;
        return { genres: genre ? [genre] : [], year, matchedArtist: candidate };
      } catch (err) {
        this.log(`[classifier] falha no iTunes para "${term}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return null;
  }

  private async waitMusicBrainzRateLimit(): Promise<void> {
    if (this.musicBrainzMinIntervalMs <= 0) return;
    const prev = this.musicBrainzQueue;
    let release!: () => void;
    this.musicBrainzQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      const elapsed = Date.now() - this.lastMusicBrainzRequestAt;
      const waitMs = this.musicBrainzMinIntervalMs - elapsed;
      if (waitMs > 0 && this.lastMusicBrainzRequestAt > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      this.lastMusicBrainzRequestAt = Date.now();
    } finally {
      release();
    }
  }

  private extractMusicBrainzTags(item: MusicBrainzArtistItem): string[] {
    const combined = [...(item.genres ?? []), ...(item.tags ?? [])]
      .filter((t) => typeof t.name === 'string' && t.name.trim().length > 0 && (t.count === undefined || t.count > 0))
      .sort((a, b) => (b.count ?? 1) - (a.count ?? 1));
    const seen = new Set<string>();
    const names: string[] = [];
    for (const entry of combined) {
      const name = entry.name!.trim();
      const key = fold(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    return names;
  }

  private async fetchFromMusicBrainz(
    artistCandidates: readonly string[],
  ): Promise<{ genres: string[]; matchedArtist?: string } | null> {
    if (!this.externalLookup || artistCandidates.length === 0) return null;
    const headers = {
      'User-Agent': MUSICBRAINZ_USER_AGENT,
      Accept: 'application/json',
    };

    for (const candidate of artistCandidates.slice(0, 3)) {
      try {
        await this.waitMusicBrainzRateLimit();
        const params = new URLSearchParams({
          query: `artist:"${escapeLucenePhrase(candidate)}"`,
          fmt: 'json',
          limit: '5',
        });
        const res = await this.fetchFn(`https://musicbrainz.org/ws/2/artist?${params}`, {
          headers,
          signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { artists?: MusicBrainzArtistItem[] };
        const items = Array.isArray(body.artists) ? body.artists : [];
        const match = items.find(
          (item) => (item.score === undefined || item.score >= 70) && artistsMatch([candidate], item.name ?? ''),
        );
        if (!match) continue;

        let tags = this.extractMusicBrainzTags(match);
        if (tags.length === 0 && match.id) {
          await this.waitMusicBrainzRateLimit();
          const detailRes = await this.fetchFn(
            `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(match.id)}?inc=tags+genres&fmt=json`,
            { headers, signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) },
          );
          if (detailRes.ok) {
            const detail = (await detailRes.json()) as MusicBrainzArtistItem;
            tags = this.extractMusicBrainzTags(detail);
          }
        }

        if (tags.length > 0) {
          return { genres: tags, matchedArtist: candidate };
        }
      } catch (err) {
        this.log(`[classifier] falha no MusicBrainz para "${candidate}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return null;
  }

  private async resolveExternalMetadata(input: {
    source?: TrackSource;
    sourceId?: string;
    cleanTitle: string;
    cleanArtist: string;
    artistCandidates: readonly string[];
    initialYear: number | null;
    force?: boolean;
  }): Promise<{
    externalGenres: string[];
    discoveredYear: number | null;
    source: ClassificationSource | null;
  }> {
    const externalGenres: string[] = [];
    let discoveredYear = input.initialYear;
    let source: ClassificationSource | null = null;
    let matchedArtist: string | undefined;

    if (!input.force) {
      for (const candidate of input.artistCandidates) {
        const cached = this.getCachedArtist(candidate);
        if (cached) {
          externalGenres.push(...cached.rawGenres);
          return { externalGenres, discoveredYear, source: 'cache' };
        }
      }
    }

    const spotifyInfo = await this.fetchFromSpotify(
      input.source,
      input.sourceId,
      input.cleanTitle,
      input.artistCandidates,
    );
    if (spotifyInfo) {
      if (discoveredYear === null && spotifyInfo.year !== null) discoveredYear = spotifyInfo.year;
      if (spotifyInfo.genres.length > 0) {
        externalGenres.push(...spotifyInfo.genres);
        source = 'spotify';
        matchedArtist = spotifyInfo.matchedArtist;
      }
    }

    if (externalGenres.length === 0) {
      const deezerInfo = await this.fetchFromDeezer(input.cleanTitle, input.artistCandidates);
      if (deezerInfo) {
        if (discoveredYear === null && deezerInfo.year !== null) discoveredYear = deezerInfo.year;
        if (deezerInfo.genres.length > 0) {
          externalGenres.push(...deezerInfo.genres);
          source = 'deezer';
          matchedArtist = deezerInfo.matchedArtist;
        }
      }
    }

    if (externalGenres.length === 0) {
      const itunesInfo = await this.fetchFromItunes(input.cleanTitle, input.artistCandidates);
      if (itunesInfo) {
        if (discoveredYear === null && itunesInfo.year !== null) discoveredYear = itunesInfo.year;
        if (itunesInfo.genres.length > 0) {
          externalGenres.push(...itunesInfo.genres);
          source = 'itunes';
          matchedArtist = itunesInfo.matchedArtist;
        }
      }
    }

    if (externalGenres.length === 0) {
      const mbInfo = await this.fetchFromMusicBrainz(input.artistCandidates);
      if (mbInfo && mbInfo.genres.length > 0) {
        externalGenres.push(...mbInfo.genres);
        source = 'musicbrainz';
        matchedArtist = mbInfo.matchedArtist;
      }
    }

    const cacheArtist = matchedArtist || input.cleanArtist;
    if (cacheArtist && externalGenres.length > 0 && source && VALID_CACHE_SOURCES.has(source)) {
      const baseOutcome = normalizeGenreAndSubgenre(externalGenres, {
        title: '',
        artist: cacheArtist,
      });
      if (source !== 'musicbrainz' || baseOutcome !== null) {
        this.saveArtistCache(cacheArtist, {
          rawGenres: externalGenres,
          genre: baseOutcome?.genre ?? null,
          subgenre: baseOutcome?.subgenre ?? null,
          source,
        });
      }
    }

    return { externalGenres, discoveredYear, source };
  }

  /** Classifies unsaved track metadata (e.g. discovery previews) without mutating the database. */
  async classifyMetadata(input: {
    title: string;
    artist: string;
    album?: string | null;
    year?: number | null;
    source?: TrackSource;
    sourceId?: string;
    rawGenres?: readonly string[];
  }): Promise<ClassificationOutcome | null> {
    const cleaned = cleanTrackMetadataForClassification(input.title, input.artist);
    const { externalGenres, discoveredYear } = await this.resolveExternalMetadata({
      source: input.source,
      sourceId: input.sourceId,
      cleanTitle: cleaned.searchTitle,
      cleanArtist: cleaned.artist,
      artistCandidates: cleaned.artistCandidates,
      initialYear: input.year ?? null,
    });

    const context: ClassificationContext = {
      title: cleaned.title,
      artist: cleaned.artist,
      album: input.album,
      year: discoveredYear,
      hints: cleaned.signals,
    };
    const combinedRaw = [...externalGenres, ...(input.rawGenres ?? [])];
    return (
      (externalGenres.length > 0 ? normalizeGenreAndSubgenre(externalGenres, context) : null) ??
      normalizeGenreAndSubgenre(combinedRaw, context)
    );
  }

  async classifyTrack(track: Track, options: { force?: boolean } = {}): Promise<TrackClassificationResult> {
    // Manual host categorizations are strictly locked even on forced re-classification.
    if (track.genreManual) {
      return {
        updated: false,
        genre: track.genre,
        subgenre: track.subgenre,
        source: null,
        skippedManual: true,
      };
    }

    const cleaned = cleanTrackMetadataForClassification(track.title, track.artist);
    const force = options.force === true;

    const resolved = await this.resolveExternalMetadata({
      source: track.source,
      sourceId: track.sourceId,
      cleanTitle: cleaned.searchTitle,
      cleanArtist: cleaned.artist,
      artistCandidates: cleaned.artistCandidates,
      initialYear: track.year,
      force,
    });
    const externalGenres = resolved.externalGenres;
    const discoveredYear = resolved.discoveredYear;
    const source = resolved.source;

    const hasCanonicalGenre = isCanonicalCategory(track.genre);
    // When forcing re-classification, never feed a previous canonical auto-genre back in.
    const trackGenreTag =
      track.genre?.trim() && (!force || !hasCanonicalGenre) ? [track.genre.trim()] : [];

    const context: ClassificationContext = {
      title: cleaned.title,
      artist: cleaned.artist,
      album: track.album,
      year: discoveredYear,
      hints: cleaned.signals,
    };
    const outcome =
      (externalGenres.length > 0 ? normalizeGenreAndSubgenre(externalGenres, context) : null) ??
      normalizeGenreAndSubgenre([...externalGenres, ...trackGenreTag], context);

    const patch: { title?: string; artist?: string; genre?: string; subgenre?: string | null; year?: number } = {};
    if (cleaned.extractedArtistFromTitle) {
      patch.artist = cleaned.artist;
      patch.title = cleaned.title;
    }

    const hasSubgenre = Boolean(track.subgenre?.trim());
    if (force) {
      if (outcome?.genre && track.genre?.trim() !== outcome.genre) {
        patch.genre = outcome.genre;
      }
      if (outcome && (track.subgenre?.trim() ?? null) !== (outcome.subgenre ?? null)) {
        patch.subgenre = outcome.subgenre;
      }
    } else {
      if (!hasCanonicalGenre && outcome?.genre && track.genre?.trim() !== outcome.genre) {
        patch.genre = outcome.genre;
      }
      if (!hasSubgenre && outcome?.subgenre) {
        patch.subgenre = outcome.subgenre;
      }
    }
    if (track.year === null && discoveredYear !== null) {
      patch.year = discoveredYear;
    }

    if (Object.keys(patch).length > 0) {
      this.tracks.update(track.id, patch);
      return {
        updated: true,
        genre: patch.genre ?? track.genre,
        subgenre: patch.subgenre !== undefined ? patch.subgenre : track.subgenre,
        source: source ?? 'heuristic',
      };
    }

    return {
      updated: false,
      genre: track.genre,
      subgenre: track.subgenre,
      source: outcome ? (source ?? 'heuristic') : null,
    };
  }

  async autocategorizeAll(options: { force?: boolean } = {}): Promise<AutocategorizeSummary> {
    const force = options.force === true;
    const { candidates, skippedManual } = this.tracks.listTracksForAutocategorize({ force });
    let updated = 0;
    let failed = 0;
    const updatedTrackIds: string[] = [];

    for (const track of candidates) {
      try {
        const res = await this.classifyTrack(track, { force });
        if (res.updated) {
          updated += 1;
          updatedTrackIds.push(track.id);
        }
      } catch (err) {
        failed += 1;
        this.log(`[classifier] erro ao classificar "${track.title}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      processed: candidates.length,
      updated,
      skippedManual,
      failed,
      updatedTrackIds,
    };
  }
}
