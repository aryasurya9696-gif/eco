export interface CountryOption {
  code: string; // ISO 3166-1 alpha-2, e.g. "US" — what the leads API expects
  name: string; // "United States"
  flag: string; // "🇺🇸"
}

/** Markets most searches target; listed first, in this order. */
export const POPULAR_CODES = [
  'US', 'GB', 'CA', 'IN', 'DE', 'FR', 'AU', 'SG', 'NL', 'AE', 'IE', 'ES', 'SE', 'CH', 'IL', 'BR',
];

/**
 * Every assigned ISO 3166-1 alpha-2 code.
 *
 * The selector used to offer 31 hand-picked countries, so anyone prospecting
 * outside them (Nigeria, Vietnam, Argentina…) could not filter by country at
 * all. Names come from Intl.DisplayNames, so the list stays a list of codes —
 * the value the API actually takes — and cannot drift into typos.
 */
const ALL_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
  'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

function flagOf(code: string): string {
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function buildCountries(): CountryOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    names = null;
  }
  return ALL_CODES.map((code) => ({ code, name: names?.of(code) ?? code, flag: flagOf(code) }));
}

export const COUNTRIES: CountryOption[] = buildCountries();

export function countryByCode(code?: string | null): CountryOption | undefined {
  if (!code) return undefined;
  return COUNTRIES.find((c) => c.code === code.toUpperCase());
}
