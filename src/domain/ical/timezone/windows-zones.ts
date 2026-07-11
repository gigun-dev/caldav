// =============================================================================
// timezone/windows-zones — Windows タイムゾーン名 → IANA 名の対応表
// =============================================================================
//
// 【なぜこの表が要るのか(docs/modeling/08 §3)】
// Outlook / Exchange 系クライアントは TZID に IANA 名ではなく Windows 名
// (例 "Tokyo Standard Time")を入れてくる。sabre/vobject の TimeZoneUtil も
// 「IANA 直引き → Windows/Lotus 名マップ → 推測」の順で解決しており、本作の
// 解決チェーン(08 §6-2)の第2段がこの表にあたる。
//
// 【出典】 Unicode CLDR の windowsZones.xml(territory="001" = 各 Windows 名の
// 代表 IANA ゾーン)を手で写経したもの。CLDR 45(2024)相当。
// https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml
// tzdb 側の政変(例: カザフスタンの UTC+5 統一)で CLDR が代表ゾーンを差し替える
// ことがあるが、Windows 名の集合自体はほぼ固定なので更新頻度は低い。
// 値の一部(Asia/Calcutta, Europe/Kiev, America/Godthab 等)は CLDR が使う
// 旧名エイリアスのままにしてある — ICU(= Workers の Intl)はエイリアスを解決できる。
//
// 【使い方の約束】キーの照合は大文字小文字を無視する(Windows 名の表記ゆれ対策)。
// lookup 関数だけを公開し、表そのものは module private にする。
// =============================================================================

// Windows 名(表示名ではなく registry の "Standard Time" 名)→ 代表 IANA 名。
// CLDR の並び(UTC-12 → UTC+14)を保ってある(見比べ・更新のしやすさ優先)。
const WINDOWS_TO_IANA: Record<string, string> = {
	"Dateline Standard Time": "Etc/GMT+12",
	"UTC-11": "Etc/GMT+11",
	"Aleutian Standard Time": "America/Adak",
	"Hawaiian Standard Time": "Pacific/Honolulu",
	"Marquesas Standard Time": "Pacific/Marquesas",
	"Alaskan Standard Time": "America/Anchorage",
	"UTC-09": "Etc/GMT+9",
	"Pacific Standard Time (Mexico)": "America/Tijuana",
	"UTC-08": "Etc/GMT+8",
	"Pacific Standard Time": "America/Los_Angeles",
	"US Mountain Standard Time": "America/Phoenix",
	"Mountain Standard Time (Mexico)": "America/Mazatlan",
	"Mountain Standard Time": "America/Denver",
	"Yukon Standard Time": "America/Whitehorse",
	"Central America Standard Time": "America/Guatemala",
	"Central Standard Time": "America/Chicago",
	"Easter Island Standard Time": "Pacific/Easter",
	"Central Standard Time (Mexico)": "America/Mexico_City",
	"Canada Central Standard Time": "America/Regina",
	"SA Pacific Standard Time": "America/Bogota",
	"Eastern Standard Time (Mexico)": "America/Cancun",
	"Eastern Standard Time": "America/New_York",
	"Haiti Standard Time": "America/Port-au-Prince",
	"Cuba Standard Time": "America/Havana",
	"US Eastern Standard Time": "America/Indianapolis",
	"Turks And Caicos Standard Time": "America/Grand_Turk",
	"Paraguay Standard Time": "America/Asuncion",
	"Atlantic Standard Time": "America/Halifax",
	"Venezuela Standard Time": "America/Caracas",
	"Central Brazilian Standard Time": "America/Cuiaba",
	"SA Western Standard Time": "America/La_Paz",
	"Pacific SA Standard Time": "America/Santiago",
	"Newfoundland Standard Time": "America/St_Johns",
	"Tocantins Standard Time": "America/Araguaina",
	"E. South America Standard Time": "America/Sao_Paulo",
	"SA Eastern Standard Time": "America/Cayenne",
	"Argentina Standard Time": "America/Buenos_Aires",
	"Greenland Standard Time": "America/Godthab",
	"Montevideo Standard Time": "America/Montevideo",
	"Magallanes Standard Time": "America/Punta_Arenas",
	"Saint Pierre Standard Time": "America/Miquelon",
	"Bahia Standard Time": "America/Bahia",
	"UTC-02": "Etc/GMT+2",
	"Azores Standard Time": "Atlantic/Azores",
	"Cape Verde Standard Time": "Atlantic/Cape_Verde",
	UTC: "Etc/UTC",
	"GMT Standard Time": "Europe/London",
	"Greenwich Standard Time": "Atlantic/Reykjavik",
	"Sao Tome Standard Time": "Africa/Sao_Tome",
	"Morocco Standard Time": "Africa/Casablanca",
	"W. Europe Standard Time": "Europe/Berlin",
	"Central Europe Standard Time": "Europe/Budapest",
	"Romance Standard Time": "Europe/Paris",
	"Central European Standard Time": "Europe/Warsaw",
	"W. Central Africa Standard Time": "Africa/Lagos",
	"Jordan Standard Time": "Asia/Amman",
	"GTB Standard Time": "Europe/Bucharest",
	"Middle East Standard Time": "Asia/Beirut",
	"Egypt Standard Time": "Africa/Cairo",
	"E. Europe Standard Time": "Europe/Chisinau",
	"Syria Standard Time": "Asia/Damascus",
	"West Bank Standard Time": "Asia/Hebron",
	"South Africa Standard Time": "Africa/Johannesburg",
	"FLE Standard Time": "Europe/Kiev",
	"Israel Standard Time": "Asia/Jerusalem",
	"South Sudan Standard Time": "Africa/Juba",
	"Kaliningrad Standard Time": "Europe/Kaliningrad",
	"Sudan Standard Time": "Africa/Khartoum",
	"Libya Standard Time": "Africa/Tripoli",
	"Namibia Standard Time": "Africa/Windhoek",
	"Arabic Standard Time": "Asia/Baghdad",
	"Turkey Standard Time": "Europe/Istanbul",
	"Arab Standard Time": "Asia/Riyadh",
	"Belarus Standard Time": "Europe/Minsk",
	"Russian Standard Time": "Europe/Moscow",
	"E. Africa Standard Time": "Africa/Nairobi",
	"Iran Standard Time": "Asia/Tehran",
	"Arabian Standard Time": "Asia/Dubai",
	"Astrakhan Standard Time": "Europe/Astrakhan",
	"Azerbaijan Standard Time": "Asia/Baku",
	"Russia Time Zone 3": "Europe/Samara",
	"Mauritius Standard Time": "Indian/Mauritius",
	"Saratov Standard Time": "Europe/Saratov",
	"Georgian Standard Time": "Asia/Tbilisi",
	"Volgograd Standard Time": "Europe/Volgograd",
	"Caucasus Standard Time": "Asia/Yerevan",
	"Afghanistan Standard Time": "Asia/Kabul",
	"West Asia Standard Time": "Asia/Tashkent",
	"Ekaterinburg Standard Time": "Asia/Yekaterinburg",
	"Pakistan Standard Time": "Asia/Karachi",
	"Qyzylorda Standard Time": "Asia/Qyzylorda",
	"India Standard Time": "Asia/Calcutta",
	"Sri Lanka Standard Time": "Asia/Colombo",
	"Nepal Standard Time": "Asia/Katmandu",
	// カザフスタンの UTC+5 統一(2024-03)以降、CLDR は Central Asia の代表を
	// Asia/Bishkek に差し替えた(旧: Asia/Almaty)。
	"Central Asia Standard Time": "Asia/Bishkek",
	"Bangladesh Standard Time": "Asia/Dhaka",
	"Omsk Standard Time": "Asia/Omsk",
	"Myanmar Standard Time": "Asia/Rangoon",
	"SE Asia Standard Time": "Asia/Bangkok",
	"Altai Standard Time": "Asia/Barnaul",
	"W. Mongolia Standard Time": "Asia/Hovd",
	"North Asia Standard Time": "Asia/Krasnoyarsk",
	"N. Central Asia Standard Time": "Asia/Novosibirsk",
	"Tomsk Standard Time": "Asia/Tomsk",
	"China Standard Time": "Asia/Shanghai",
	"North Asia East Standard Time": "Asia/Irkutsk",
	"Singapore Standard Time": "Asia/Singapore",
	"W. Australia Standard Time": "Australia/Perth",
	"Taipei Standard Time": "Asia/Taipei",
	"Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
	"Aus Central W. Standard Time": "Australia/Eucla",
	"Transbaikal Standard Time": "Asia/Chita",
	"Tokyo Standard Time": "Asia/Tokyo",
	"North Korea Standard Time": "Asia/Pyongyang",
	"Korea Standard Time": "Asia/Seoul",
	"Yakutsk Standard Time": "Asia/Yakutsk",
	"Cen. Australia Standard Time": "Australia/Adelaide",
	"AUS Central Standard Time": "Australia/Darwin",
	"E. Australia Standard Time": "Australia/Brisbane",
	"AUS Eastern Standard Time": "Australia/Sydney",
	"West Pacific Standard Time": "Pacific/Port_Moresby",
	"Tasmania Standard Time": "Australia/Hobart",
	"Vladivostok Standard Time": "Asia/Vladivostok",
	"Lord Howe Standard Time": "Australia/Lord_Howe",
	"Bougainville Standard Time": "Pacific/Bougainville",
	"Russia Time Zone 10": "Asia/Srednekolymsk",
	"Magadan Standard Time": "Asia/Magadan",
	"Norfolk Standard Time": "Pacific/Norfolk",
	"Sakhalin Standard Time": "Asia/Sakhalin",
	"Central Pacific Standard Time": "Pacific/Guadalcanal",
	"Russia Time Zone 11": "Asia/Kamchatka",
	"New Zealand Standard Time": "Pacific/Auckland",
	"UTC+12": "Etc/GMT-12",
	"Fiji Standard Time": "Pacific/Fiji",
	"Chatham Islands Standard Time": "Pacific/Chatham",
	"UTC+13": "Etc/GMT-13",
	"Tonga Standard Time": "Pacific/Tongatapu",
	"Samoa Standard Time": "Pacific/Apia",
	"Line Islands Standard Time": "Pacific/Kiritimati",
};

// 大文字小文字を無視した引き当て用に、小文字キーの索引を一度だけ構築しておく。
// (Windows 名は "TOKYO STANDARD TIME" のような全大文字で来る実装例があるため。)
const LOWER_INDEX: ReadonlyMap<string, string> = new Map(
	Object.entries(WINDOWS_TO_IANA).map(([win, iana]) => [win.toLowerCase(), iana]),
);

/**
 * Windows タイムゾーン名 → IANA 名(見つからなければ undefined)。
 * 照合は大文字小文字を無視。前後の空白は呼び出し側でトリム済みの想定だが、
 * 念のためここでもトリムする(表記ゆれで解決チェーンを落とさないため)。
 */
export function windowsToIana(name: string): string | undefined {
	return LOWER_INDEX.get(name.trim().toLowerCase());
}
