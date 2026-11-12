/* ===== 00-prelude.js ===== */
"use strict";

/* Manager 1.0.0
   一个笔记管理视图。顶栏是纯文字的范围切换，右侧四个固定图标，
   分割线下方是文件夹标题与笔记，排版沿用 Thinker 的字号阶梯。

   源码按节分文件放在 src/，build.cjs 按文件名顺序拼成 main.js。
   每一节只用 const 声明一次，拼接后仍是同一个作用域。 */

const obsidian = require("obsidian");
const { Plugin, ItemView, Menu, Notice, setIcon, Setting, PluginSettingTab, getLanguage } = obsidian;

const MG_VIEW_TYPE = "manager-view";
/* 核心插件的彩带图标已经被 files / search / bookmark / tags / list-tree /
   git-fork / layout-dashboard / calendar-days / file-stack / dice / terminal /
   file-search / layout-grid / file-plus 这些占完了。notebook-pen 不在其中。 */
const MG_ICON = "notebook-pen";

const MG_DEFAULT = {
	tabOrder: [],
	noteOrder: {},
	folderOrder: {},
	collapsed: [],
	sortMode: "name-asc",
	searchScope: "title",
	listLimit: 120,
	openOnStartup: false,
	showAll: true,
	showRecent: true,
	showSettingsIcon: true,
	showEmptyFolders: false,
	animations: true,
	keyboardMode: false,
	homePage: false,
	collapseSidebar: true,
	blockedFolders: ""
};


/* ---------- 路径 ----------

   Obsidian 的根目录有两种写法：文件夹的 path 是 "/"，文件的 parent 是 ""。
   全库统一成没有首尾斜杠的字符串，根目录就是空串。 */

function mgDir(path) {
	if (!path) return "";
	const clean = String(path).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const cut = clean.lastIndexOf("/");
	return cut < 0 ? "" : clean.slice(0, cut);
}

function mgBase(path) {
	if (!path) return "";
	const clean = String(path).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const cut = clean.lastIndexOf("/");
	return cut < 0 ? clean : clean.slice(cut + 1);
}

function mgJoin(dir, name) {
	const clean = dir ? String(dir).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
	return clean ? clean + "/" + name : name;
}

function mgDepth(path) {
	const clean = path ? String(path).replace(/^\/+|\/+$/g, "") : "";
	return clean ? clean.split("/").length : 0;
}

function mgStem(name) {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

function mgExt(name) {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot) : "";
}

/* 同名不覆盖。文件名是 Obsidian 链接的解析单位，撞名会让 [[笔记]] 指错，
   所以第二个开始带序号，扩展名留在最后。 */
function mgUnique(taken, wanted, isFolder) {
	const used = new Set(taken || []);
	if (!used.has(wanted)) return wanted;
	const extension = isFolder ? "" : mgExt(wanted);
	const stem = extension ? wanted.slice(0, -extension.length) : wanted;
	let index = 2;
	while (used.has(stem + " " + index + extension)) index += 1;
	return stem + " " + index + extension;
}

/* ---------- 排序 ----------

   名称用中文排序规则，时间直接比较毫秒。手工顺序存在设置里，它排在最前面，
   不在手工顺序里的条目按当前排序规则跟在后面，这样新文件不会插到第一行。 */

function mgComparator(mode) {
	const descending = String(mode || "").endsWith("-desc");
	return function (a, b) {
		let value = 0;
		if (String(mode).startsWith("mtime")) value = a.mtime - b.mtime;
		else if (String(mode).startsWith("ctime")) value = a.ctime - b.ctime;
		else value = String(a.title || "").localeCompare(String(b.title || ""), "zh");
		return descending ? -value : value;
	};
}

function mgApplyOrder(list, order, pathOf) {
	if (!order || order.length === 0) return list.slice();
	const rank = new Map();
	order.forEach((path, index) => rank.set(path, index));
	const pick = pathOf || ((item) => item.path);
	return list
		.map((item, index) => ({ item, index }))
		.sort((a, b) => {
			const ra = rank.has(pick(a.item)) ? rank.get(pick(a.item)) : Number.MAX_SAFE_INTEGER;
			const rb = rank.has(pick(b.item)) ? rank.get(pick(b.item)) : Number.MAX_SAFE_INTEGER;
			if (ra !== rb) return ra - rb;
			return a.index - b.index;
		})
		.map((slot) => slot.item);
}

function mgRelative(ms, now) {
	const at = typeof now === "number" ? now : Date.now();
	const gap = Math.max(0, at - Number(ms || 0));
	const minute = 60000;
	const hour = 3600000;
	const day = 86400000;
	if (gap < minute) return "刚刚";
	if (gap < hour) return Math.floor(gap / minute) + " 分钟前";
	if (gap < day) return Math.floor(gap / hour) + " 小时前";
	if (gap < day * 7) return Math.floor(gap / day) + " 天前";
	const date = new Date(Number(ms));
	const pad = (value) => String(value).padStart(2, "0");
	const sameYear = new Date(at).getFullYear() === date.getFullYear();
	const head = sameYear ? "" : String(date.getFullYear()) + "-";
	return head + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function mgNumber(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/* 屏蔽名单是一行一个路径。写成 Life 就屏蔽 Life 和它下面所有子目录,
   写成 Life/日记 只屏蔽那一棵。首尾斜杠和反斜杠都归一化掉,
   否则从 Windows 复制来的路径永远匹配不上 vault 里的正斜杠路径。 */
/* ---------- 过滤 ----------

   搜索框里的词分两类: 带前缀的是条件, 剩下的才是名字. 条件全部在纯函数里
   解析, 视图只管把结果画出来, 所以同一套语法在标题搜索和全文搜索上都能用.

   .pdf     按扩展名, 可以写多个
   >10mb    按体积, 也支持 <500kb 和 b / kb / mb / gb
   today    今天改过; week 七天; month 三十天; 2026-11 或 2026-11-11
   empty    只看空文件夹
   其余     按名字, 多个词是并且关系 */

const MG_SIZE_UNITS = { b: 1, kb: 1024, mb: 1048576, gb: 1073741824 };

function mgStartOfDay(time) {
	const date = new Date(time);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function mgParseFilter(text) {
	const out = { terms: [], exts: [], minSize: 0, maxSize: 0, from: 0, to: 0, empty: false };
	const raw = String(text || "").trim().toLowerCase();
	if (!raw) return out;
	const now = Date.now();
	const day = 86400000;

	for (const token of raw.split(/\s+/)) {
		if (!token) continue;

		if (/^\.[a-z0-9]+$/.test(token)) {
			out.exts.push(token.slice(1));
			continue;
		}

		const size = /^([<>])(\d+(?:\.\d+)?)(b|kb|mb|gb)$/.exec(token);
		if (size) {
			const bytes = Number(size[2]) * MG_SIZE_UNITS[size[3]];
			if (size[1] === ">") out.minSize = bytes;
			else out.maxSize = bytes;
			continue;
		}

		if (token === "today") {
			out.from = mgStartOfDay(now);
			continue;
		}
		if (token === "week") {
			out.from = mgStartOfDay(now) - 6 * day;
			continue;
		}
		if (token === "month") {
			out.from = mgStartOfDay(now) - 29 * day;
			continue;
		}
		if (token === "empty") {
			out.empty = true;
			continue;
		}

		const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
		if (ymd) {
			out.from = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).getTime();
			out.to = out.from + day;
			continue;
		}

		const ym = /^(\d{4})-(\d{2})$/.exec(token);
		if (ym) {
			out.from = new Date(Number(ym[1]), Number(ym[2]) - 1, 1).getTime();
			out.to = new Date(Number(ym[1]), Number(ym[2]), 1).getTime();
			continue;
		}

		out.terms.push(token);
	}

	return out;
}

/* 只按名字比, 给文件夹标题用. */
function mgMatchTerms(name, filter) {
	const hay = String(name || "").toLowerCase();
	for (const term of filter.terms) {
		if (hay.indexOf(term) < 0) return false;
	}
	return true;
}

/* 文件能不能留在这张表上. */
function mgMatchFilter(entry, filter) {
	if (!filter) return true;
	if (filter.empty) return false;
	if (filter.exts.length > 0 && filter.exts.indexOf(String(entry.ext || "").toLowerCase()) < 0) return false;
	if (filter.minSize > 0 && mgNumber(entry.size) < filter.minSize) return false;
	if (filter.maxSize > 0 && mgNumber(entry.size) > filter.maxSize) return false;
	if (filter.from > 0 && mgNumber(entry.mtime) < filter.from) return false;
	if (filter.to > 0 && mgNumber(entry.mtime) >= filter.to) return false;
	return mgMatchTerms(entry.title || entry.name, filter);
}

/* 带了扩展名 / 体积 / 时间条件时, 结果按文件平铺, 文件夹标题让位. */
function mgFilterIsStructured(filter) {
	return (
		filter.exts.length > 0 ||
		filter.minSize > 0 ||
		filter.maxSize > 0 ||
		filter.from > 0 ||
		filter.to > 0
	);
}

function mgBlockedList(text) {
	const out = [];
	const seen = new Set();
	const lines = String(text == null ? "" : text).split(/\r?\n/);
	for (const line of lines) {
		const path = String(line).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
		if (!path || seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

function mgUnder(path, prefix) {
	if (!prefix) return false;
	return path === prefix || path.indexOf(prefix + "/") === 0;
}

/* ===== 05-i18n.js ===== */
"use strict";

/* ---------- 文案 ----------

   界面上出现的每一句话都在这里, 按 Obsidian 自己的语言设置选一份. 找不到
   对应语言时先退到同语系的基础语言 (zh-TW 退到 zh), 再退到英文.

   翻译按各语言自己的习惯写, 不做逐字对照: 日文的 "件" 不是 "条结果",
   德文的复合词也不能硬拆. */

const MG_LANGS = {
	zh: {
		root: "根目录",
		recent: "最近",
		all: "全部",
		untitled: "未命名",
		untitledFolder: "未命名文件夹",
		empty: "这里还没有笔记",
		emptyHint: "点右侧的加号新建一篇",
		emptySearch: "没有匹配的文件",
		emptySearchHint: "换一个词试试",
		searchPlaceholder: "搜索",
		searchTitle: "搜索笔记标题",
		searchFull: "全局搜索",
		searching: "正在搜索",
		hitCount: "条结果",
		newNote: "新建笔记",
		newFolder: "新建文件夹",
		editOrder: "调整顺序",
		sortTitle: "文件排序",
		moved: "已移动",
		renamed: "已改名",
		created: "已创建",
		cantUseView: "最近和全部不能作为创建位置",
		createFailed: "创建失败",
		renameFailed: "改名失败",
		moveFailed: "移动失败",
		cantMoveIntoSelf: "不能把文件夹移进它自己",
		nameAsc: "名称 A 到 Z",
		nameDesc: "名称 Z 到 A",
		mtimeDesc: "修改时间 新到旧",
		mtimeAsc: "修改时间 旧到新",
		ctimeDesc: "创建时间 新到旧",
		ctimeAsc: "创建时间 旧到新",
		ribbonOpen: "打开 Manager",
		ribbonSettings: "Manager 设置",
		cmdOpen: "打开 Manager",
		setBlocked: "屏蔽文件夹",
		setEmptyFolders: "显示空文件夹",
		setRecent: "显示最近",
		setAll: "显示全部",
		setSettingsIcon: "左侧新增设置图标",
		setHomePage: "设为首页",
		setAnimations: "界面动画",
		setCollapse: "开启时收起左侧边栏",
		kbMode: "键盘模式",
		setSupport: "支持作者 - 微信扫码",
	},

	"zh-TW": {
		root: "根目錄",
		recent: "最近",
		all: "全部",
		untitled: "未命名",
		untitledFolder: "未命名資料夾",
		empty: "這裡還沒有筆記",
		emptyHint: "點右側的加號新增一篇",
		emptySearch: "沒有符合的檔案",
		emptySearchHint: "換一個詞試試",
		searchPlaceholder: "搜尋",
		searchTitle: "搜尋筆記標題",
		searchFull: "全文搜尋",
		searching: "正在搜尋",
		hitCount: "筆結果",
		newNote: "新增筆記",
		newFolder: "新增資料夾",
		editOrder: "調整順序",
		sortTitle: "檔案排序",
		moved: "已移動",
		renamed: "已改名",
		created: "已建立",
		cantUseView: "最近與全部不能作為建立位置",
		createFailed: "建立失敗",
	renameFailed: "改名失敗",
		moveFailed: "移動失敗",
		cantMoveIntoSelf: "不能把資料夾移進它自己",
		nameAsc: "名稱 A 到 Z",
		nameDesc: "名稱 Z 到 A",
		mtimeDesc: "修改時間 新到舊",
		mtimeAsc: "修改時間 舊到新",
		ctimeDesc: "建立時間 新到舊",
		ctimeAsc: "建立時間 舊到新",
		ribbonOpen: "開啟 Manager",
		ribbonSettings: "Manager 設定",
		cmdOpen: "開啟 Manager",
		setBlocked: "封鎖資料夾",
		setEmptyFolders: "顯示空資料夾",
		setRecent: "顯示最近",
		setAll: "顯示全部",
		setSettingsIcon: "側邊欄設定圖示",
		setHomePage: "設為首頁",
		setAnimations: "介面動畫",
		setCollapse: "開啟時收起左側邊欄",
		kbMode: "鍵盤模式",
		setSupport: "支持作者 - 微信掃碼",
	},

	en: {
		root: "Root",
		recent: "Recent",
		all: "All",
		untitled: "Untitled",
		untitledFolder: "Untitled folder",
		empty: "Nothing here yet",
		emptyHint: "Create a note with the + button",
		emptySearch: "No files match",
		emptySearchHint: "Try a different word",
		searchPlaceholder: "Search",
		searchTitle: "Search note titles",
		searchFull: "Search all text",
		searching: "Searching",
		hitCount: "results",
		newNote: "New note",
		newFolder: "New folder",
		editOrder: "Reorder",
		sortTitle: "Sort files",
		moved: "Moved",
		renamed: "Renamed",
		created: "Created",
		cantUseView: "Recent and All cannot hold new files",
		createFailed: "Could not create",
		renameFailed: "Could not rename",
		moveFailed: "Could not move",
		cantMoveIntoSelf: "A folder cannot be moved into itself",
		nameAsc: "Name, A to Z",
		nameDesc: "Name, Z to A",
		mtimeDesc: "Modified, newest first",
		mtimeAsc: "Modified, oldest first",
		ctimeDesc: "Created, newest first",
		ctimeAsc: "Created, oldest first",
		ribbonOpen: "Open Manager",
		ribbonSettings: "Manager settings",
		cmdOpen: "Open Manager",
		setBlocked: "Blocked folders",
		setEmptyFolders: "Show empty folders",
		setRecent: "Show Recent",
		setAll: "Show All",
		setSettingsIcon: "Settings icon in sidebar",
		setHomePage: "Open on startup",
		setAnimations: "Interface animations",
		setCollapse: "Collapse left sidebar",
		kbMode: "Keyboard mode",
		setSupport: "Support the author - WeChat QR",
	},

	ja: {
		root: "ルート",
		recent: "最近",
		all: "すべて",
		untitled: "無題",
		untitledFolder: "無題のフォルダ",
		empty: "まだ何もありません",
		emptyHint: "右の＋からノートを作成",
		emptySearch: "一致するファイルがありません",
		emptySearchHint: "別の言葉で試してください",
		searchPlaceholder: "検索",
		searchTitle: "ノート名で検索",
		searchFull: "全文検索",
		searching: "検索中",
		hitCount: "件",
		newNote: "新規ノート",
		newFolder: "新規フォルダ",
		editOrder: "並べ替え",
		sortTitle: "ファイルの並び順",
		moved: "移動しました",
		renamed: "名前を変更しました",
		created: "作成しました",
		cantUseView: "最近とすべてには作成できません",
		createFailed: "作成できませんでした",
		renameFailed: "名前を変更できませんでした",
		moveFailed: "移動できませんでした",
		cantMoveIntoSelf: "フォルダを自分自身の中には移動できません",
		nameAsc: "名前 昇順",
		nameDesc: "名前 降順",
		mtimeDesc: "更新日 新しい順",
		mtimeAsc: "更新日 古い順",
		ctimeDesc: "作成日 新しい順",
		ctimeAsc: "作成日 古い順",
		ribbonOpen: "Manager を開く",
		ribbonSettings: "Manager の設定",
		cmdOpen: "Manager を開く",
		setBlocked: "除外するフォルダ",
		setEmptyFolders: "空のフォルダを表示",
		setRecent: "「最近」を表示",
		setAll: "「すべて」を表示",
		setSettingsIcon: "サイドバーに設定アイコン",
		setHomePage: "起動時に開く",
		setAnimations: "UI アニメーション",
		setCollapse: "左サイドバーを畳む",
		kbMode: "キーボード操作",
		setSupport: "作者を支援 - WeChat QR",
	},

	ko: {
		root: "루트",
		recent: "최근",
		all: "전체",
		untitled: "제목 없음",
		untitledFolder: "제목 없는 폴더",
		empty: "아직 아무것도 없습니다",
		emptyHint: "오른쪽 + 로 새로 만들기",
		emptySearch: "일치하는 파일이 없습니다",
		emptySearchHint: "다른 단어로 시도해 보세요",
		searchPlaceholder: "검색",
		searchTitle: "노트 제목 검색",
		searchFull: "전체 텍스트 검색",
		searching: "검색 중",
		hitCount: "개",
		newNote: "새 노트",
		newFolder: "새 폴더",
		editOrder: "순서 조정",
		sortTitle: "파일 정렬",
		moved: "이동했습니다",
		renamed: "이름을 바꿨습니다",
		created: "만들었습니다",
		cantUseView: "최근과 전체에는 만들 수 없습니다",
		createFailed: "만들지 못했습니다",
		renameFailed: "이름을 바꾸지 못했습니다",
		moveFailed: "이동하지 못했습니다",
		cantMoveIntoSelf: "폴더를 자기 안으로 옮길 수 없습니다",
		nameAsc: "이름 오름차순",
		nameDesc: "이름 내림차순",
		mtimeDesc: "수정일 최신순",
		mtimeAsc: "수정일 오래된순",
		ctimeDesc: "생성일 최신순",
		ctimeAsc: "생성일 오래된순",
		ribbonOpen: "Manager 열기",
		ribbonSettings: "Manager 설정",
		cmdOpen: "Manager 열기",
		setBlocked: "숨길 폴더",
		setEmptyFolders: "빈 폴더 표시",
		setRecent: "최근 표시",
		setAll: "전체 표시",
		setSettingsIcon: "사이드바 설정 아이콘",
		setHomePage: "시작 시 열기",
		setAnimations: "인터페이스 애니메이션",
		setCollapse: "왼쪽 사이드바 접기",
		kbMode: "키보드 모드",
		setSupport: "작가 후원 - 위챗 QR",
	},

	de: {
		root: "Stammverzeichnis",
		recent: "Zuletzt",
		all: "Alle",
		untitled: "Unbenannt",
		untitledFolder: "Unbenannter Ordner",
		empty: "Hier ist noch nichts",
		emptyHint: "Mit + eine Notiz anlegen",
		emptySearch: "Keine Treffer",
		emptySearchHint: "Anderes Wort versuchen",
		searchPlaceholder: "Suchen",
		searchTitle: "Notiztitel durchsuchen",
		searchFull: "Volltext durchsuchen",
		searching: "Suche läuft",
		hitCount: "Treffer",
		newNote: "Neue Notiz",
		newFolder: "Neuer Ordner",
		editOrder: "Reihenfolge ändern",
		sortTitle: "Dateien sortieren",
		moved: "Verschoben",
		renamed: "Umbenannt",
		created: "Erstellt",
		cantUseView: "In Zuletzt und Alle kann nichts angelegt werden",
		createFailed: "Anlegen fehlgeschlagen",
		renameFailed: "Umbenennen fehlgeschlagen",
		moveFailed: "Verschieben fehlgeschlagen",
		cantMoveIntoSelf: "Ein Ordner kann nicht in sich selbst verschoben werden",
		nameAsc: "Name A bis Z",
		nameDesc: "Name Z bis A",
		mtimeDesc: "Geändert, neueste zuerst",
		mtimeAsc: "Geändert, älteste zuerst",
		ctimeDesc: "Erstellt, neueste zuerst",
		ctimeAsc: "Erstellt, älteste zuerst",
		ribbonOpen: "Manager öffnen",
		ribbonSettings: "Manager-Einstellungen",
		cmdOpen: "Manager öffnen",
		setBlocked: "Ausgeblendete Ordner",
		setEmptyFolders: "Leere Ordner zeigen",
		setRecent: "Zuletzt zeigen",
		setAll: "Alle zeigen",
		setSettingsIcon: "Zahnrad in der Seitenleiste",
		setHomePage: "Beim Start öffnen",
		setAnimations: "Oberflächenanimationen",
		setCollapse: "Linke Seitenleiste einklappen",
		kbMode: "Tastaturmodus",
		setSupport: "Autor unterstützen - WeChat-QR",
	},

	fr: {
		root: "Racine",
		recent: "Récents",
		all: "Tout",
		untitled: "Sans titre",
		untitledFolder: "Dossier sans titre",
		empty: "Rien ici pour l'instant",
		emptyHint: "Créez une note avec +",
		emptySearch: "Aucun fichier trouvé",
		emptySearchHint: "Essayez un autre mot",
		searchPlaceholder: "Rechercher",
		searchTitle: "Rechercher par titre",
		searchFull: "Rechercher dans le texte",
		searching: "Recherche en cours",
		hitCount: "résultats",
		newNote: "Nouvelle note",
		newFolder: "Nouveau dossier",
		editOrder: "Réordonner",
		sortTitle: "Trier les fichiers",
		moved: "Déplacé",
		renamed: "Renommé",
		created: "Créé",
		cantUseView: "Impossible de créer dans Récents ou Tout",
		createFailed: "Création impossible",
		renameFailed: "Renommage impossible",
		moveFailed: "Déplacement impossible",
		cantMoveIntoSelf: "Un dossier ne peut pas être déplacé dans lui-même",
		nameAsc: "Nom, A à Z",
		nameDesc: "Nom, Z à A",
		mtimeDesc: "Modifié, récent d'abord",
		mtimeAsc: "Modifié, ancien d'abord",
		ctimeDesc: "Créé, récent d'abord",
		ctimeAsc: "Créé, ancien d'abord",
		ribbonOpen: "Ouvrir Manager",
		ribbonSettings: "Réglages de Manager",
		cmdOpen: "Ouvrir Manager",
		setBlocked: "Dossiers masqués",
		setEmptyFolders: "Afficher les dossiers vides",
		setRecent: "Afficher Récents",
		setAll: "Afficher Tout",
		setSettingsIcon: "Icône réglages dans la barre",
		setHomePage: "Ouvrir au démarrage",
		setAnimations: "Animations de l'interface",
		setCollapse: "Replier la barre latérale",
		kbMode: "Mode clavier",
		setSupport: "Soutenir l'auteur - QR WeChat",
	},

	es: {
		root: "Raíz",
		recent: "Recientes",
		all: "Todo",
		untitled: "Sin título",
		untitledFolder: "Carpeta sin título",
		empty: "Aquí no hay nada",
		emptyHint: "Crea una nota con +",
		emptySearch: "Ningún archivo coincide",
		emptySearchHint: "Prueba otra palabra",
		searchPlaceholder: "Buscar",
		searchTitle: "Buscar por título",
		searchFull: "Buscar en el texto",
		searching: "Buscando",
		hitCount: "resultados",
		newNote: "Nueva nota",
		newFolder: "Nueva carpeta",
		editOrder: "Reordenar",
		sortTitle: "Ordenar archivos",
		moved: "Movido",
		renamed: "Renombrado",
		created: "Creado",
		cantUseView: "No se puede crear en Recientes ni en Todo",
		createFailed: "No se pudo crear",
		renameFailed: "No se pudo renombrar",
		moveFailed: "No se pudo mover",
		cantMoveIntoSelf: "Una carpeta no puede moverse dentro de sí misma",
		nameAsc: "Nombre, A a Z",
		nameDesc: "Nombre, Z a A",
		mtimeDesc: "Modificado, reciente primero",
		mtimeAsc: "Modificado, antiguo primero",
		ctimeDesc: "Creado, reciente primero",
		ctimeAsc: "Creado, antiguo primero",
		ribbonOpen: "Abrir Manager",
		ribbonSettings: "Ajustes de Manager",
		cmdOpen: "Abrir Manager",
		setBlocked: "Carpetas ocultas",
		setEmptyFolders: "Mostrar carpetas vacías",
		setRecent: "Mostrar Recientes",
		setAll: "Mostrar Todo",
		setSettingsIcon: "Icono de ajustes en la barra",
		setHomePage: "Abrir al iniciar",
		setAnimations: "Animaciones de la interfaz",
		setCollapse: "Plegar barra lateral",
		kbMode: "Modo teclado",
		setSupport: "Apoyar al autor - QR de WeChat",
	}
};

function mgLanguage() {
	let raw = "";
	try {
		raw = typeof getLanguage === "function" ? getLanguage() : "";
	} catch (error) {
		raw = "";
	}
	const tag = String(raw || "en");
	if (MG_LANGS[tag]) return tag;
	const base = tag.split("-")[0];
	if (MG_LANGS[base]) return base;
	return "en";
}

const MG_TEXT = MG_LANGS[mgLanguage()] || MG_LANGS.en;

const MG_SORTS = [
	{ key: "name-asc", label: MG_TEXT.nameAsc },
	{ key: "name-desc", label: MG_TEXT.nameDesc },
	{ key: "mtime-desc", label: MG_TEXT.mtimeDesc },
	{ key: "mtime-asc", label: MG_TEXT.mtimeAsc },
	{ key: "ctime-desc", label: MG_TEXT.ctimeDesc },
	{ key: "ctime-asc", label: MG_TEXT.ctimeAsc }
];

/* ===== 10-index.js ===== */
"use strict";

/* ---------- 索引 ----------

   一次全库扫描，只读 metadataCache 之外的文件属性，不读正文。正文只在
   全局搜索真的需要时按篇读，读完缓存。一万篇的库 build 一次在 20ms 量级，
   所以任何一次文件变动都直接重建，不做增量。 */

class MgIndex {
	constructor(app) {
		this.app = app;
		this.entries = [];
		this.folders = [];
		this.byPath = new Map();
		this.folderPaths = new Set();
		this.blocked = [];
	}

	/* 屏蔽名单在扫描这一层就剔掉, 后面的顶栏、全部、最近、树都不用再各判一次.
	   被屏蔽的是整棵子树, 所以 Life 一写进去, Life/日记 也不会出现.

	   收的是库里全部文件, 不只有 md: pdf、图片、音频、视频、canvas 在 Obsidian
	   里都能打开, 只列笔记等于把它们藏起来. 标题上 md 去掉扩展名, 其它保留,
	   因为 "扫描件" 和 "扫描件.pdf" 差别很大. */
	build(blocked) {
		this.blocked = Array.isArray(blocked) ? blocked : mgBlockedList(blocked);
		const vault = this.app.vault;
		const files = typeof vault.getFiles === "function"
			? vault.getFiles()
			: typeof vault.getMarkdownFiles === "function"
				? vault.getMarkdownFiles()
				: [];
		this.entries = (files || [])
			.filter((file) => !this.isHidden(file.path) && !this.isBlocked(file.path))
			.map((file) => {
				const stat = file.stat || {};
				const name = String(file.name || mgBase(file.path));
				const ext = String(file.extension || mgExt(name).replace(".", "")).toLowerCase();
				return {
					path: String(file.path),
					name,
					ext,
					title: ext === "md" ? String(file.basename || mgStem(name)) : name,
					parent: mgDir(file.path),
					mtime: mgNumber(stat.mtime),
					ctime: mgNumber(stat.ctime),
					size: mgNumber(stat.size)
				};
			});
		this.byPath = new Map(this.entries.map((entry) => [entry.path, entry]));

		const all = typeof vault.getAllLoadedFiles === "function" ? vault.getAllLoadedFiles() : [];
		const folders = [];
		for (const file of all || []) {
			if (!file || !file.children) continue;
			const path = String(file.path || "").replace(/^\/+|\/+$/g, "");
			if (!path || this.isBlocked(path)) continue;
			folders.push({ path, name: String(file.name || mgBase(path)) });
		}
		this.folders = folders;
		this.folderPaths = new Set(folders.map((folder) => folder.path));
		return this;
	}

	/* 任何一段以点开头就当隐藏, 和 Obsidian 的文件浏览器保持一致. */
	isHidden(path) {
		const parts = String(path || "").split("/");
		for (const part of parts) {
			if (part.charAt(0) === ".") return true;
		}
		return false;
	}

	isBlocked(path) {
		const target = String(path || "").replace(/^\/+|\/+$/g, "");
		if (!target) return false;
		for (const prefix of this.blocked) {
			if (mgUnder(target, prefix)) return true;
		}
		return false;
	}

	note(path) {
		return this.byPath.get(path) || null;
	}

	rootFolders() {
		return this.folders.filter((folder) => mgDir(folder.path) === "");
	}

	childFolders(dir) {
		const base = dir || "";
		return this.folders.filter((folder) => mgDir(folder.path) === base);
	}

	hasFolder(path) {
		return this.folderPaths.has(path || "");
	}

	notesIn(dir) {
		const base = dir || "";
		return this.entries.filter((entry) => entry.parent === base);
	}

	/* 递归计数，给文件夹标题右侧那个数字用。只数笔记，不数子文件夹。 */
	countIn(dir) {
		const base = dir || "";
		const prefix = base ? base + "/" : "";
		let total = 0;
		for (const entry of this.entries) {
			if (entry.parent === base) total += 1;
			else if (prefix && entry.path.startsWith(prefix)) total += 1;
		}
		return total;
	}

	recent() {
		return this.entries.slice().sort((a, b) => b.mtime - a.mtime);
	}

	searchTitle(query) {
		const needle = String(query || "").trim().toLowerCase();
		if (!needle) return this.entries.slice();
		return this.entries.filter((entry) => entry.title.toLowerCase().includes(needle));
	}

	absolute(path) {
		return this.app.vault.getAbstractFileByPath(path);
	}
}

/* ---------- 行 ----------

   列表是行的数组，不是树的递归渲染。折叠、分页、搜索都只改这个数组，
   视图那边照着数组铺 DOM，铺完不再关心层级。 */

const MG_LEVEL_MAX = 4;

function mgSortNotes(list, mode, order) {
	const sorted = list.slice().sort(mgComparator(mode));
	return mgApplyOrder(sorted, order);
}

function mgSortFolders(list, mode, order) {
	const descending = String(mode || "").endsWith("-desc");
	const sorted = list.slice().sort((a, b) => {
		const value = String(a.name).localeCompare(String(b.name), "zh");
		return descending ? -value : value;
	});
	return mgApplyOrder(sorted, order, (folder) => folder.path);
}

function mgSnippet(text, needle) {
	const source = String(text || "");
	const word = String(needle || "");
	if (!word) return "";
	const at = source.toLowerCase().indexOf(word.toLowerCase());
	if (at < 0) return "";
	const start = Math.max(0, at - 24);
	const end = Math.min(source.length, at + word.length + 44);
	let out = source.slice(start, end).replace(/\s+/g, " ").trim();
	if (start > 0) out = "..." + out;
	if (end < source.length) out = out + "...";
	return out;
}

function mgBuildRows(input) {
	const category = input.category || "all";
	const index = input.index;
	const collapsed = new Set(input.collapsed || []);
	const mode = input.sortMode || "name-asc";
	const noteOrder = input.noteOrder || {};
	const folderOrder = input.folderOrder || {};
	const cap = Math.max(1, mgNumber(input.limit) || 120);
	const showEmpty = input.showEmpty === true;
	const filter = mgParseFilter(input.filter);
	const rows = [];
	let shown = 0;
	let total = 0;
	let cut = false;

	const pushNote = (entry, level, snippet) => {
		if (!mgMatchFilter(entry, filter)) return;
		total += 1;
		if (shown >= cap) {
			cut = true;
			return;
		}
		rows.push({ type: "note", entry, level: mgClampLevel(level), snippet: snippet || "" });
		shown += 1;
	};

	const flat = (list) => {
		for (const entry of list) pushNote(entry, 0, entry.snippet);
	};

	if (category === "all") {
		flat(mgSortNotes(index.entries, mode, null));
		return { rows, total, shown, truncated: cut };
	}

	if (category === "recent") {
		flat(index.recent());
		return { rows, total, shown, truncated: cut };
	}

	if (category === "root") {
		flat(mgSortNotes(index.notesIn(""), mode, noteOrder[""] || []));
		return { rows, total, shown, truncated: cut };
	}

	/* 每个目录的递归笔记数一次算完. 之前每画一个文件夹标题都要扫一遍全库,
	   一万篇加两百个文件夹就是两百万次比较, 而这里只要一次遍历乘层数. */
	const counts = new Map();
	for (const entry of index.entries) {
		let dir = entry.parent;
		while (dir) {
			counts.set(dir, (counts.get(dir) || 0) + 1);
			dir = mgDir(dir);
		}
	}
	const countOf = (path) => counts.get(path) || 0;

	const walk = (dir, level) => {
		const notes = mgSortNotes(index.notesIn(dir), mode, noteOrder[dir] || []);
		for (const entry of notes) pushNote(entry, level, entry.snippet);
		const kids = mgSortFolders(index.childFolders(dir), mode, folderOrder[dir] || []);
		for (const kid of kids) {
			const count = countOf(kid.path);
			const next = level + 1;

			/* 只看空文件夹: 有内容的一律跳过, 也不再往下走. */
			if (filter.empty) {
				if (count > 0) continue;
				rows.push({
					type: "folder",
					path: kid.path,
					name: kid.name,
					level: mgClampLevel(next),
					count,
					open: false
				});
				continue;
			}

			/* 带了扩展名 / 体积 / 时间条件时, 结果按文件平铺, 文件夹标题让位,
			   但子目录还是要走一遍, 不然只在第一层里找. */
			if (mgFilterIsStructured(filter)) {
				walk(kid.path, 0);
				continue;
			}

			if (!mgMatchTerms(kid.name, filter)) continue;

			/* 一棵子树里一篇笔记都没有, 标题就不出现. 只有创建或调整模式下
			   才放出来, 因为那时候用户要能点到它. */
			if (count === 0 && !showEmpty) continue;

			rows.push({
				type: "folder",
				path: kid.path,
				name: kid.name,
				level: mgClampLevel(next),
				count,
				open: !collapsed.has(kid.path)
			});
			if (collapsed.has(kid.path)) rows.push({ type: "dots", level: mgClampLevel(next), path: kid.path });
			else walk(kid.path, next);
		}
	};

	walk(category, 0);
	return { rows, total, shown, truncated: cut };
}

function mgClampLevel(level) {
	const n = mgNumber(level);
	if (n < 1) return 1;
	return n > MG_LEVEL_MAX ? MG_LEVEL_MAX : n;
}

/* ===== 20-view.js ===== */
"use strict";

function mgEl(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = String(text);
	return node;
}

function mgClear(node) {
	if (!node) return;
	while (node.firstChild) node.removeChild(node.firstChild);
}

function mgIconButton(cls, iconName, label) {
	const button = mgEl("button", "mg-icon " + cls);
	button.type = "button";
	button.setAttribute("aria-label", label);
	button.setAttribute("title", label);
	setIcon(button, iconName);
	return button;
}

class MgView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.index = new MgIndex(plugin.app);
		this.category = "root";
		this.query = "";
		this.cursor = -1;
		this.selected = [];
		this.scope = plugin.data.searchScope || "title";
		this.collapsed = new Set(plugin.data.collapsed || []);
		this.sortMode = plugin.data.sortMode || "name-asc";
		this.limit = mgNumber(plugin.data.listLimit) || 120;
		this.creating = null;
		this.editing = null;
		this.dragPath = null;
		this.dropHint = "";
		this.textCache = new Map();
		this.fullHits = new Map();
		this.searchToken = 0;
		this.searching = false;
		this.rows = [];
		this.tabsEl = null;
		this.searchEl = null;
		this.inputEl = null;
		this.actionsEl = null;
		this.statusEl = null;
		this.listEl = null;
		this.plusBtn = null;
		this.editBtn = null;
		this.searchBtn = null;
		this.debounce = 0;
	}

	getViewType() {
		return MG_VIEW_TYPE;
	}

	getDisplayText() {
		return "Manager";
	}

	getIcon() {
		return MG_ICON;
	}

	async onOpen() {
		this.registerEvent(this.app.vault.on("create", () => this.scheduleRebuild()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleRebuild()));
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleRebuild()));
		this.index.build(this.plugin.data.blockedFolders);
		this.render();
	}

	async onClose() {
		if (this.debounce) window.clearTimeout(this.debounce);
		this.debounce = 0;
		if (this.scanTimer) window.clearTimeout(this.scanTimer);
		this.scanTimer = 0;
		this.searchToken += 1;
		this.textCache.clear();
	}

	scheduleRebuild() {
		if (this.debounce) window.clearTimeout(this.debounce);
		this.debounce = window.setTimeout(() => {
			this.debounce = 0;
			this.rebuild();
		}, 120);
	}

	rebuild() {
		if (this.contentEl) this.contentEl.classList.toggle("is-static", this.plugin.data.animations === false);
		this.index.build(this.plugin.data.blockedFolders);
		this.syncCategory();
		this.renderTabs();
		this.renderList();
	}

	render() {
		const root = this.contentEl;
		mgClear(root);
		root.classList.add("mg-view");
		root.classList.toggle("is-static", this.plugin.data.animations === false);
		this.keyboardMode = this.plugin.data.keyboardMode === true;

		const page = mgEl("div", "mg-page");
		root.appendChild(page);

		const nav = mgEl("div", "mg-nav");
		this.navEl = nav;
		page.appendChild(nav);

		this.tabsEl = mgEl("div", "mg-tabs");
		this.tabsEl.setAttribute("role", "tablist");
		nav.appendChild(this.tabsEl);

		this.searchEl = mgEl("div", "mg-search");
		const box = mgEl("div", "mg-search-box");
		this.inputEl = document.createElement("input");
		this.inputEl.type = "text";
		this.inputEl.className = "mg-search-input";
		this.inputEl.spellcheck = false;
		this.inputEl.setAttribute("autocomplete", "off");
		this.inputEl.placeholder = MG_TEXT.searchPlaceholder;
		this.inputEl.value = this.query;
		box.appendChild(this.inputEl);
		this.searchEl.appendChild(box);
		nav.appendChild(this.searchEl);

		this.actionsEl = mgEl("div", "mg-actions");
		nav.appendChild(this.actionsEl);

		this.searchBtn = mgIconButton("mg-search-btn", "search", MG_TEXT.searchPlaceholder);
		this.plusBtn = mgIconButton("mg-plus-btn", "plus", MG_TEXT.newNote);
		this.editBtn = mgIconButton("mg-edit-btn", "pencil", MG_TEXT.editOrder);
		this.sortBtn = mgIconButton("mg-sort-btn", "arrow-up-narrow-wide", MG_TEXT.sortTitle);
		this.kbBtn = mgIconButton("mg-kb-btn", "keyboard", MG_TEXT.kbMode);
		this.actionsEl.appendChild(this.searchBtn);
		this.actionsEl.appendChild(this.plusBtn);
		this.actionsEl.appendChild(this.editBtn);
		this.actionsEl.appendChild(this.sortBtn);
		this.actionsEl.appendChild(this.kbBtn);
		this.syncSortIcon();
		this.bindActions();

		this.statusEl = mgEl("div", "mg-status");
		this.statusEl.setAttribute("role", "status");
		this.statusEl.setAttribute("aria-live", "polite");
		page.appendChild(this.statusEl);

		this.listEl = mgEl("div", "mg-list");
		this.listEl.tabIndex = 0;
		page.appendChild(this.listEl);
		this.bindList();

		this.bindDrag();
		this.renderTabs();
		this.renderList();
		this.focusActiveTab();
	}

	/* 文件夹多到要横向滚动时, 启动后落在第五个文件夹上的话,
	   选中项可能在视野外, 顶栏看上去像什么都没选. */
	focusActiveTab() {
		if (!this.tabsEl) return;
		const active = this.tabsEl.querySelector(".mg-tab.is-on");
		if (!active || typeof active.scrollIntoView !== "function") return;
		active.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	bindActions() {
		this.searchBtn.addEventListener("mousedown", (event) => event.preventDefault());
		this.searchBtn.addEventListener("click", () => this.toggleSearch());
		this.searchBtn.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.openSearchMenu(event);
		});

		this.plusBtn.addEventListener("click", (event) => this.onPlusClick(event));
		this.plusBtn.addEventListener("contextmenu", (event) => event.preventDefault());

		this.editBtn.addEventListener("click", () => this.onEditClick());

		this.sortBtn.addEventListener("click", (event) => this.openSortMenu(event));
		this.kbBtn.addEventListener("click", () => this.onKeyboardClick());
		this.kbBtn.addEventListener("contextmenu", (event) => event.preventDefault());

		const stop = (event) => event.stopPropagation();
		this.searchEl.addEventListener("click", stop);
		this.inputEl.addEventListener("compositionstart", () => {
			this.composing = true;
		});
		this.inputEl.addEventListener("compositionend", () => {
			this.composing = false;
			this.query = this.inputEl.value;
			this.limit = this.pageSize();
			this.renderList();
			this.scheduleFullScan();
		});
		this.inputEl.addEventListener("input", () => {
			if (this.composing) return;
			this.query = this.inputEl.value;
			this.limit = this.pageSize();
			this.renderList();
			this.scheduleFullScan();
		});
		this.inputEl.addEventListener("blur", () => {
			this.searchEl.classList.remove("is-open");
			this.searchBtn.classList.toggle("is-on", this.query.length > 0);
			this.renderList();
		});
		this.inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.clearSearch();
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				this.inputEl.blur();
			}
		});

		this.contentEl.addEventListener("click", (event) => {
			const blank = event.target === this.contentEl || event.target === this.listEl || (event.target.classList && event.target.classList.contains("mg-empty"));
			if (blank) this.leaveModes();
		});
		/* 挂在 document 上，因为纯鼠标操作时焦点可能不在本视图里，
		   Esc 也要能退出创建或调整模式。 */
		this.registerDomEvent(document, "keydown", (event) => {
			if (event.key !== "Escape") return;
			if (!this.creating && !this.editing) return;
			event.preventDefault();
			this.leaveModes();
		});
	}

	/* 在输入框里打字时, j / k / Home 这些都是文字, 不能当导航用. */
	isTyping(node) {
		if (!node || !node.tagName) return false;
		const tag = node.tagName.toLowerCase();
		return tag === "input" || tag === "textarea" || node.isContentEditable === true;
	}

	bindList() {
		this.listEl.addEventListener("click", (event) => this.onListClick(event));
		this.listEl.addEventListener("keydown", (event) => this.onListKey(event));
		this.listEl.addEventListener("dblclick", (event) => this.onListDoubleClick(event));
		this.listEl.addEventListener("contextmenu", (event) => this.onListMenu(event));
		this.listEl.addEventListener("scroll", () => {
			const node = this.listEl;
			if (node.scrollTop + node.clientHeight < node.scrollHeight - 80) return;
			if (!this.truncated) return;
			if (this.searching) return;
			this.limit += this.pageSize();
			this.renderList();
		});
		this.tabsEl.addEventListener("click", (event) => this.onTabClick(event));
		this.tabsEl.addEventListener("contextmenu", (event) => event.preventDefault());
		/* 滚动时每帧最多算一次, 不然十二个矩形每滚一像素量一遍. */
		this.tabsEl.addEventListener("scroll", () => {
			if (this.overflowFrame) return;
			this.overflowFrame = requestAnimationFrame(() => {
				this.overflowFrame = 0;
				this.syncOverflow();
			});
		});
		this.registerDomEvent(window, "resize", () => this.scheduleOverflowCheck());
	}

	pageSize() {
		return Math.max(60, mgNumber(this.plugin.data.listLimit) || 120);
	}

	/* 最近与全部是"怎么看", 根目录与文件夹是"看哪里", 两类不混在一组.
	   根目录本质也是一个位置, 排在第一层文件夹前面, 而且只在真的躺着笔记
	   时才出现; 空库打开时它只会让人点进去看到一个空列表. */
	tabItems() {
		const settings = this.plugin.data;
		const items = [];
		if (settings.showRecent !== false) items.push({ key: "recent", label: MG_TEXT.recent, group: "view", icon: "history" });
		if (settings.showAll !== false) items.push({ key: "all", label: MG_TEXT.all, group: "view", icon: "layers" });
		const rootCount = this.index.notesIn("").length;
		if (rootCount > 0 || this.creating) items.push({ key: "root", label: MG_TEXT.root, group: "folder" });
		for (const folder of this.index.rootFolders()) items.push({ key: folder.path, label: folder.name, group: "folder" });
		const ordered = mgApplyOrder(items, settings.tabOrder || [], (item) => item.key);
		return ordered;
	}

	/* 当前范围不在了就挑一个还站得住的: 先找位置, 位置全空才退回最近/全部. */
	syncCategory() {
		const items = this.tabItems();
		if (items.some((item) => item.key === this.category)) return;
		const place = items.filter((item) => item.group === "folder")[0] || items[0];
		this.category = place ? place.key : "root";
	}

	renderTabs() {
		const wrap = this.tabsEl;
		mgClear(wrap);
		const items = this.tabItems();
		let previous = null;
		for (const item of items) {
			const tab = mgEl("button", "mg-tab");
			tab.type = "button";
			/* 视图用图标, 把横向空间让给文件夹名; 文件夹仍是文字, 因为
			   名字本身是内容, 换成图标就没法读了. 图标那一路也要包一层,
			   否则 svg 的基线会把整行顶歪. */
			if (item.icon) {
				const glyph = mgEl("span", "mg-tab-icon");
				setIcon(glyph, item.icon);
				tab.appendChild(glyph);
				tab.classList.add("is-icon");
			} else {
				tab.appendChild(mgEl("span", "mg-tab-label", item.label));
			}
			tab.dataset.key = item.key;
			tab.setAttribute("role", "tab");
			/* 名字太长时顶栏会被一个文件夹占满, 截断并留全名在 title 里. */
			tab.setAttribute("title", item.label);
			tab.setAttribute("aria-label", item.label);
			if (item.key === this.category) tab.classList.add("is-on");
			const chosen = this.creating && (this.creating.parent === item.key || (this.creating.parent === "" && item.key === "root"));
			if (chosen) tab.classList.add("is-target");
			/* 一眼分成两组: 三种看全库的方式, 和库里的文件夹.
			   只靠间距拉开, 不加分隔符也不加竖线. */
			if (previous === "view" && item.group === "folder") tab.classList.add("is-group-start");
			previous = item.group;
			const real = item.key === "root" || this.index.hasFolder(item.key);
			tab.draggable = this.editing === "order" && real && item.key !== "root";
			wrap.appendChild(tab);
		}
		this.scheduleOverflowCheck();
	}

	/* 顶栏溢出时右边要淡出去, 否则最后一个文件夹会被图标区硬切一半.
	   滚动到最右就没有"后面还有"了, 渐隐跟着收掉. */
	syncOverflow() {
		const tabs = this.tabsEl;
		const nav = this.navEl;
		if (!tabs || !nav) return;
		const more = tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft > 1;
		nav.classList.toggle("is-overflow", more);
	}

	scheduleOverflowCheck() {
		if (typeof requestAnimationFrame !== "function") {
			this.syncOverflow();
			return;
		}
		requestAnimationFrame(() => this.syncOverflow());
	}

	renderList(animate) {
		const list = this.listEl;
		if (!list) return;
		mgClear(list);
		this.rows = [];

		const searching = this.query.trim().length > 0;
		const result = this.buildList(searching);
		this.truncated = result.truncated;

		if (result.rows.length === 0) {
			list.appendChild(this.emptyNode(searching));
			this.syncStatus(0, 0);
			if (animate) this.animateList();
			return;
		}

		const fragment = document.createDocumentFragment();
		for (const row of result.rows) {
			if (row.type === "folder") fragment.appendChild(this.folderNode(row));
			else if (row.type === "dots") fragment.appendChild(this.dotsNode(row));
			else fragment.appendChild(this.noteNode(row));
		}
		list.appendChild(fragment);
		this.syncStatus(result.shown, result.total);
		this.collectRows();
		if (animate) this.animateList();
	}

	/* 键盘只在看得见的行之间走, 省略号行和空状态不参与. */
	collectRows() {
		this.rowNodes = this.listEl ? [...this.listEl.querySelectorAll(".mg-note, .mg-folder")] : [];
		if (this.cursor >= this.rowNodes.length) this.cursor = this.rowNodes.length - 1;
		if (this.cursor >= 0) this.paintCursor();
	}

	/* 只给"整块内容换掉"的场合用: 切顶栏、换排序、折叠展开. 搜索每敲一个
	   字闪一次会晕, 滚到底追加也不用, 所以那两处不传这个开关. */
	animationsOn() {
		return this.plugin.data.animations !== false;
	}

	animateList() {
		if (!this.animationsOn()) return;
		const list = this.listEl;
		if (!list) return;
		/* 读一次布局, 让"移除类"这一步真的落到样式上, 同一个任务里再加回来
		   不会重启动画. */
		list.classList.remove("is-enter");
		void list.offsetWidth;
		list.classList.add("is-enter");
		if (this.enterTimer) window.clearTimeout(this.enterTimer);
		this.enterTimer = window.setTimeout(() => {
			this.enterTimer = 0;
			list.classList.remove("is-enter");
		}, 240);
	}

	buildList(searching) {
		const limit = this.limit;
		if (!searching) {
			return mgBuildRows({
				category: this.category,
				showEmpty: this.plugin.data.showEmptyFolders === true || Boolean(this.creating || this.editing || this.renaming),
				index: this.index,
				collapsed: [...this.collapsed],
				sortMode: this.sortMode,
				noteOrder: this.plugin.data.noteOrder || {},
				folderOrder: this.plugin.data.folderOrder || {},
				limit
			});
		}

		const filter = mgParseFilter(this.query);
		const words = filter.terms.join(" ");
		const pool = words ? this.index.searchTitle(words) : this.index.entries.slice();
		const titleHits = pool.filter((entry) => mgMatchFilter(entry, filter));
		const rows = [];
		let total = 0;

		if (this.scope === "full") {
			const seen = new Set(titleHits.map((entry) => entry.path));
			const merged = titleHits.map((entry) => ({ entry, snippet: "" }));
			for (const entry of this.index.entries) {
				if (seen.has(entry.path)) continue;
				if (!mgMatchFilter(entry, filter)) continue;
				const snippet = this.fullHits.get(entry.path);
				if (snippet) merged.push({ entry, snippet });
			}
			merged.sort(mgComparator(this.sortMode === "name-desc" ? "name-desc" : "name-asc"));
			for (const hit of merged) {
				total += 1;
				if (rows.length < limit) rows.push({ type: "note", entry: hit.entry, level: 1, snippet: hit.snippet });
			}
			return { rows, total, shown: rows.length, truncated: total > rows.length };
		}

		const sorted = mgSortNotes(titleHits, this.sortMode, null);
		for (const entry of sorted) {
			total += 1;
			if (rows.length < limit) rows.push({ type: "note", entry, level: 1, snippet: "" });
		}
		return { rows, total, shown: rows.length, truncated: total > rows.length };
	}

	/* 空状态两行: 一行说现在没有什么, 一行说下一步做什么. */
	emptyNode(searching) {
		const box = mgEl("div", "mg-empty");
		box.appendChild(mgEl("div", "mg-empty-title", searching ? MG_TEXT.emptySearch : MG_TEXT.empty));
		box.appendChild(mgEl("div", "mg-empty-hint", searching ? MG_TEXT.emptySearchHint : MG_TEXT.emptyHint));
		return box;
	}

	folderNode(row) {
		if (this.renaming && this.renaming.path === row.path) return this.renameNode({ path: row.path, name: row.name }, "folder");
		const head = mgEl("div", "mg-folder is-level-" + row.level);
		head.dataset.path = row.path;
		head.dataset.kind = "folder";
		if (this.creating && this.creating.parent === row.path) head.classList.add("is-target");
		if (this.editing === "order") head.draggable = true;

		const chevron = mgEl("span", "mg-chevron");
		setIcon(chevron, "chevron-right");
		chevron.setAttribute("aria-hidden", "true");
		head.appendChild(chevron);

		const name = mgEl("span", "mg-folder-name", row.name);
		name.dataset.path = row.path;
		name.dataset.kind = "folder";
		head.appendChild(name);

		/* 空文件夹不写 0: 一整列 0 是噪音, 标题本身已经在说这里是空的. */
		if (row.count > 0) head.appendChild(mgEl("span", "mg-folder-count", String(row.count)));

		head.setAttribute("title", row.path);
		if (row.open) head.classList.add("is-open");
		return head;
	}

	dotsNode(row) {
		const dots = mgEl("div", "mg-dots is-level-" + row.level, "...");
		dots.dataset.path = row.path;
		dots.dataset.kind = "dots";
		return dots;
	}

	renameNode(entry, kind) {
		const line = mgEl("div", "mg-note is-renaming");
		line.dataset.path = entry.path;
		line.dataset.kind = kind;
		const input = document.createElement("input");
		input.type = "text";
		input.className = "mg-rename";
		input.spellcheck = false;
		input.value = kind === "note" ? entry.title : entry.name || mgBase(entry.path);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				void this.commitRename(input.value);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.renaming = null;
				this.renderList();
			}
		});
		input.addEventListener("blur", () => {
			if (this.renaming && this.renaming.path === entry.path) void this.commitRename(input.value);
		});
		line.appendChild(input);
		return line;
	}

	noteNode(row) {
		const entry = row.entry;
		if (this.renaming && this.renaming.path === entry.path) return this.renameNode(entry, "note");
		const line = mgEl("div", "mg-note");
		line.dataset.path = entry.path;
		line.dataset.kind = "note";
		if (this.editing === "order") line.draggable = true;
		line.setAttribute("role", "button");
		line.setAttribute("tabindex", "-1");

		const main = mgEl("div", "mg-note-main");
		const title = mgEl("div", "mg-note-title", entry.title);
		title.dataset.path = entry.path;
		title.dataset.kind = "note";
		main.appendChild(title);

		let meta = row.snippet || "";
		if (!meta) {
			const flatView = this.category === "all" || this.category === "recent" || this.query.trim().length > 0;
			if (flatView) meta = entry.parent || MG_TEXT.root;
		}
		if (meta) {
			main.appendChild(mgEl("div", "mg-note-meta", meta));
			line.classList.add("is-two-line");
		}
		line.appendChild(main);
		line.appendChild(mgEl("span", "mg-note-when", mgRelative(entry.mtime)));
		return line;
	}

	syncStatus(shown, total) {
		const status = this.statusEl;
		if (!status) return;
		status.classList.remove("is-on");
		status.textContent = "";

		if (this.searching) {
			status.textContent = MG_TEXT.searching + " " + this.searchScanned + "/" + this.index.entries.length;
			status.classList.add("is-on");
			return;
		}
		if (this.query.trim()) {
			status.textContent = this.query.trim() + " · " + total + " " + MG_TEXT.hitCount;
			status.classList.add("is-on");
			return;
		}
		if (this.truncated) {
			status.textContent = shown + "/" + total;
			status.classList.add("is-on");
		}
	}

	/* 搜索是覆盖在范围行上的一层，展开时宽从零长到图标左边，收起时退回去。
	   点图标就开，点别处就收，词留在框里，状态行会说清楚现在被过滤了。 */
	toggleSearch() {
		if (this.searchEl.classList.contains("is-open")) {
			this.inputEl.blur();
			return;
		}
		this.searchEl.classList.add("is-open");
		this.searchBtn.classList.add("is-on");
		this.inputEl.value = this.query;
		this.inputEl.focus();
		const end = this.inputEl.value.length;
		try {
			this.inputEl.setSelectionRange(end, end);
		} catch (error) {
			/* 某些环境在 focus 落定前不接受 selection range */
		}
	}

	clearSearch() {
		this.query = "";
		this.cursor = -1;
		this.selected = [];
		this.inputEl.value = "";
		this.fullHits.clear();
		this.searchEl.classList.remove("is-open");
		this.searchBtn.classList.remove("is-on");
		this.limit = this.pageSize();
		this.renderList();
		this.inputEl.blur();
	}

	openSearchMenu(event) {
		const menu = new Menu();
		const add = (label, scope) => {
			menu.addItem((item) => {
				item.setTitle(label);
				item.setChecked(this.scope === scope);
				item.onClick(() => {
					this.scope = scope;
					this.plugin.data.searchScope = scope;
					void this.plugin.saveData(this.plugin.data);
					this.fullHits.clear();
					this.fullSearchQuery = "";
					this.renderList();
					this.scheduleFullScan();
				});
			});
		};
		add(MG_TEXT.searchTitle, "title");
		add(MG_TEXT.searchFull, "full");
		menu.showAtMouseEvent(event);
	}

	/* 箭头跟着排序方向走: 升序朝上, 降序朝下. 一个图标比读菜单里的
	   勾选快, 不用打开菜单也知道现在按什么排. */
	syncSortIcon() {
		if (!this.sortBtn) return;
		const descending = String(this.sortMode || "").endsWith("-desc");
		setIcon(this.sortBtn, descending ? "arrow-down-wide-narrow" : "arrow-up-narrow-wide");
	}

	openSortMenu(event) {
		const menu = new Menu();
		for (const option of MG_SORTS) {
			menu.addItem((item) => {
				item.setTitle(option.label);
				item.setChecked(this.sortMode === option.key);
				item.onClick(() => {
					this.sortMode = option.key;
					this.plugin.data.sortMode = option.key;
					void this.plugin.saveData(this.plugin.data);
					this.syncSortIcon();
					this.limit = this.pageSize();
					this.renderList(true);
				});
			});
		}
		menu.showAtMouseEvent(event);
	}
}

/* ===== 30-interact.js ===== */
"use strict";

/* ---------- 交互 ----------

   三个模式互斥：创建、调顺序、调名称。同一时刻只有一个在跑，进入任何一个
   都把另外两个清掉，退出时三个一起清。图标是唯一的真相：加号变对号就是
   在创建，铅笔变对号就是在调，没有第二种状态可读。 */

/* 图标在加号和对号之间切换时弹一下, 但只在真的切换那一次弹:
   updateModeIcons 每次重绘都会被调到, 无脑加类会让它在原地一直弹. */
MgView.prototype.popIcon = function (button, changed) {
	if (!button || !changed || !this.animationsOn()) return;
	button.classList.remove("is-swap");
	void button.offsetWidth;
	button.classList.add("is-swap");
};

/* 键盘模式: 单击只把焦点挪过去, 双击才打开. 默认单击直接开, 那是文件
   浏览器一直以来的手感, 但拿它来整理时手指容易误触. */
MgView.prototype.onKeyboardClick = function () {
	this.keyboardMode = this.keyboardMode !== true;
	this.plugin.data.keyboardMode = this.keyboardMode;
	void this.plugin.saveData(this.plugin.data);
	this.updateModeIcons();
	if (this.keyboardMode && this.listEl && typeof this.listEl.focus === "function") {
		try {
			this.listEl.focus({ preventScroll: true });
		} catch (error) {
			this.listEl.focus();
		}
	}
};

MgView.prototype.onListDoubleClick = function (event) {
	if (!this.keyboardMode) return;
	const node = event.target && event.target.closest ? event.target.closest(".mg-note") : null;
	if (!node) return;
	this.openNote(node.dataset.path, event);
};

MgView.prototype.updateModeIcons = function () {
	const creating = Boolean(this.creating);
	const editing = Boolean(this.editing);
	if (this.plusBtn) {
		const was = this.plusBtn.dataset.mode || "off";
		const now = creating ? "on" : "off";
		setIcon(this.plusBtn, creating ? "check" : "plus");
		this.plusBtn.classList.toggle("is-on", creating);
		this.plusBtn.setAttribute("aria-label", creating ? MG_TEXT.created : MG_TEXT.newNote);
		this.plusBtn.dataset.mode = now;
		this.popIcon(this.plusBtn, was !== now);
	}
	if (this.kbBtn) {
		this.kbBtn.classList.toggle("is-on", this.keyboardMode === true);
		this.kbBtn.setAttribute("aria-pressed", this.keyboardMode === true ? "true" : "false");
	}
	if (this.editBtn) {
		const was = this.editBtn.dataset.mode || "off";
		const now = editing ? "on" : "off";
		setIcon(this.editBtn, editing ? "check" : "pencil");
		this.editBtn.classList.toggle("is-on", editing);
		this.editBtn.dataset.mode = now;
		this.popIcon(this.editBtn, was !== now);
	}
	if (this.listEl) {
		this.listEl.classList.toggle("is-reorder", this.editing === "order");
		this.listEl.classList.toggle("is-creating", creating);
	}
	if (this.tabsEl) {
		this.tabsEl.classList.toggle("is-reorder", this.editing === "order");
		this.tabsEl.classList.toggle("is-creating", creating);
	}
};

MgView.prototype.leaveModes = function () {
	if (!this.creating && !this.editing) return;
	this.creating = null;
	this.editing = null;
	this.renaming = null;
	this.dragPath = null;
	this.closeCreateMenu();
	this.updateModeIcons();
	this.renderTabs();
	this.renderList();
};

MgView.prototype.onTabClick = function (event) {
	const target = event.target && event.target.closest ? event.target.closest(".mg-tab") : null;
	if (!target) return;
	const key = target.dataset.key;
	const real = key === "root" || this.index.hasFolder(key);

	if (this.creating) {
		if (!real) {
			new Notice(MG_TEXT.cantUseView);
			return;
		}
		this.creating.parent = key === "root" ? "" : key;
		this.category = key;
		this.limit = this.pageSize();
		this.renderTabs();
		this.renderList();
		return;
	}

	if (key === this.category) return;
	this.category = key;
	this.limit = this.pageSize();
	this.renderTabs();
	this.renderList(true);
	this.focusActiveTab();
};

MgView.prototype.onListClick = function (event) {
	const node = event.target && event.target.closest ? event.target.closest(".mg-note, .mg-folder, .mg-dots") : null;
	if (!node) return;
	const path = node.dataset.path;
	const kind = node.dataset.kind;

	if (kind === "dots") {
		if (path) this.toggleCollapse(path);
		return;
	}

	if (kind === "folder") {
		if (this.creating) {
			this.creating.parent = path;
			this.renderTabs();
			this.renderList();
			return;
		}
		if (this.editing === "order") return;
		this.toggleCollapse(path);
		return;
	}

	if (kind === "note") {
		if (this.creating) return;
		if (this.editing === "order") return;
		if (this.keyboardMode) {
			const index = (this.rowNodes || []).indexOf(node);
			if (index >= 0) this.focusRow(index);
			return;
		}
		this.openNote(path, event);
	}
};

/* 右键文件夹和右键笔记都发同一个 file-menu 事件, 由核心的文件浏览器去填.
   自己造菜单只能造出改名和删除两项, 而侧边栏那份里还有在系统中显示、复制
   路径、打开方式这些, 重造一遍永远追不上. */
MgView.prototype.onListMenu = function (event) {
	const node = event.target && event.target.closest ? event.target.closest(".mg-note, .mg-folder") : null;
	if (!node) return;
	const path = node.dataset ? node.dataset.path : null;
	if (!path) return;
	event.preventDefault();
	const file = this.app.vault.getAbstractFileByPath(path);
	if (!file) return;
	const menu = new Menu();
	this.app.workspace.trigger("file-menu", menu, file, "file-explorer", this.leaf);
	menu.showAtMouseEvent(event);
};

MgView.prototype.toggleCollapse = function (path) {
	if (!path) return;
	if (this.collapsed.has(path)) this.collapsed.delete(path);
	else this.collapsed.add(path);
	this.plugin.data.collapsed = [...this.collapsed];
	void this.plugin.saveData(this.plugin.data);
	this.renderList(true);
};

MgView.prototype.openNote = function (path, event) {
	const file = this.app.vault.getAbstractFileByPath(path);
	if (!file) return;
	const newLeaf = Boolean(event && (event.ctrlKey || event.metaKey));
	const leaf = newLeaf ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf(false);
	void leaf.openFile(file);
};

/* ---------- 创建 ---------- */

MgView.prototype.onPlusClick = function (event) {
	if (this.creating) {
		void this.commitCreate();
		return;
	}
	/* 面板落在指针右下，而不是按钮正下方：加号在行的最右边，往下弹会
	   贴住窗口边缘。键盘触发没有坐标时退回按钮位置。 */
	const rect = this.plusBtn.getBoundingClientRect();
	const x = event && typeof event.clientX === "number" && event.clientX > 0 ? event.clientX + 4 : rect.left;
	const y = event && typeof event.clientY === "number" && event.clientY > 0 ? event.clientY + 12 : rect.bottom + 6;
	this.openCreateMenu(x, y);
};

MgView.prototype.openCreateMenu = function (left, top) {
	this.closeCreateMenu();
	const panel = mgEl("div", "mg-menu");
	if (this.animationsOn()) panel.classList.add("is-animated");
	panel.style.left = left + "px";
	panel.style.top = top + "px";

	/* 纯文字菜单. 之前带图标时, 图标那一格会连按钮底色一起露出来,
	   在深色主题下就是一块比面板略亮的方块. */
	const make = (kind, label) => {
		const item = mgEl("button", "mg-menu-item", label);
		item.type = "button";
		item.addEventListener("click", () => {
			this.closeCreateMenu();
			this.startCreate(kind);
		});
		return item;
	};

	panel.appendChild(make("note", MG_TEXT.newNote));
	panel.appendChild(make("folder", MG_TEXT.newFolder));
	document.body.appendChild(panel);
	this.createPanel = panel;

	/* 贴近窗口右边或底边时翻回来，否则最后一项会被裁在窗口外。 */
	const box = panel.getBoundingClientRect();
	const width = box.width || 160;
	const height = box.height || 72;
	if (left + width > window.innerWidth - 8) panel.style.left = Math.max(8, window.innerWidth - width - 8) + "px";
	if (top + height > window.innerHeight - 8) panel.style.top = Math.max(8, top - height - 24) + "px";

	const off = (event) => {
		if (this.createPanel && this.createPanel.contains(event.target)) return;
		this.closeCreateMenu();
	};
	this.createOff = off;
	window.setTimeout(() => document.addEventListener("mousedown", off), 0);
};

MgView.prototype.closeCreateMenu = function () {
	if (this.createOff) document.removeEventListener("mousedown", this.createOff);
	this.createOff = null;
	if (this.createPanel && this.createPanel.parentNode) this.createPanel.parentNode.removeChild(this.createPanel);
	this.createPanel = null;
};

MgView.prototype.startCreate = function (kind) {
	this.renaming = null;
	this.dragPath = null;
	this.creating = { kind: kind === "folder" ? "folder" : "note", parent: null };
	this.editing = null;
	this.updateModeIcons();
	this.renderTabs();
	this.renderList();
};

MgView.prototype.siblingNames = function (dir, excludePath) {
	const base = dir || "";
	const files = [];
	const folders = [];
	for (const entry of this.index.entries) {
		if (entry.parent === base && entry.path !== excludePath) files.push(entry.name);
	}
	for (const folder of this.index.folders) {
		if (mgDir(folder.path) === base && folder.path !== excludePath) folders.push(folder.name);
	}
	return { files, folders };
};

MgView.prototype.commitCreate = async function () {
	const state = this.creating;
	const parent = state && state.parent != null ? state.parent : null;
	if (!state || parent === null) {
		this.leaveModes();
		return;
	}

	const names = this.siblingNames(parent);
	try {
		if (state.kind === "folder") {
			const name = mgUnique(names.folders, MG_TEXT.untitledFolder, true);
			const path = mgJoin(parent, name);
			await this.app.vault.createFolder(path);
			this.creating = null;
			this.updateModeIcons();
			this.rebuild();
			this.beginRename(path, "folder");
			return;
		}

		const name = mgUnique(names.files, MG_TEXT.untitled + ".md", false);
		const path = mgJoin(parent, name);
		const file = await this.app.vault.create(path, "");
		this.creating = null;
		this.updateModeIcons();
		this.rebuild();
		/* 笔记建完直接进编辑器, 名字留在列表里用笔去改. 文件夹没有编辑器,
		   所以只有文件夹建完当场进改名. */
		if (file) void this.app.workspace.getLeaf("tab").openFile(file);
	} catch (error) {
		new Notice(MG_TEXT.createFailed + ": " + (error && error.message ? error.message : String(error)));
		this.leaveModes();
	}
};

/* ---------- 改名 ---------- */

/* 笔只有一个模式了: 按下就进排序, 再按就退出来. 改名交给右键菜单,
   那里是 Obsidian 自己的重命名, 和左侧边栏一模一样. */
MgView.prototype.onEditClick = function () {
	if (this.editing) {
		this.leaveModes();
		return;
	}
	this.startEdit();
};

MgView.prototype.startEdit = function () {
	this.creating = null;
	this.renaming = null;
	this.dragPath = null;
	this.editing = "order";
	this.updateModeIcons();
	this.renderTabs();
	this.renderList();
};

MgView.prototype.beginRename = function (path, kind) {
	if (!path) return;
	this.renaming = { path, kind };
	this.renderList();
	const input = this.listEl ? this.listEl.querySelector(".mg-rename") : null;
	if (!input) return;
	input.focus();
	const dot = kind === "note" ? input.value.lastIndexOf(".") : -1;
	try {
		input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
	} catch (error) {
		/* 忽略不接受选区范围的环境 */
	}
};

MgView.prototype.commitRename = async function (value) {
	const state = this.renaming;
	this.renaming = null;
	if (!state) return;
	const raw = String(value || "").trim();
	if (!raw) {
		this.renderList();
		return;
	}

	const file = this.app.vault.getAbstractFileByPath(state.path);
	if (!file) {
		this.renderList();
		return;
	}

	const parent = mgDir(state.path);
	const names = this.siblingNames(parent, state.path);
	const isFolder = state.kind === "folder";
	const clean = isFolder ? raw.replace(/[\\/:*?"<>|]/g, "").trim() : raw.replace(/\.md$/i, "").replace(/[\\/:*?"<>|]/g, "").trim();
	if (!clean) {
		this.renderList();
		return;
	}

	const wanted = isFolder ? clean : clean + ".md";
	const currentName = isFolder ? mgBase(state.path) : mgBase(state.path);
	if (wanted === currentName) {
		this.renderList();
		return;
	}

	const final = mgUnique(isFolder ? names.folders : names.files, wanted, isFolder);
	const nextPath = mgJoin(parent, final);
	try {
		await this.app.vault.rename(file, nextPath);
		if (this.category === state.path) this.category = nextPath;
		this.rebuild();
	} catch (error) {
		new Notice(MG_TEXT.renameFailed + ": " + (error && error.message ? error.message : String(error)));
		this.renderList();
	}
};

/* ---------- 拖拽 ---------- */

MgView.prototype.bindDrag = function () {
	const list = this.listEl;
	const tabs = this.tabsEl;

	tabs.addEventListener("dragstart", (event) => {
		if (this.editing !== "order") {
			event.preventDefault();
			return;
		}
		const tab = event.target.closest ? event.target.closest(".mg-tab") : null;
		if (!tab) return;
		const key = tab.dataset.key;
		if (key === "root" || key === "recent" || key === "all" || !this.index.hasFolder(key)) {
			event.preventDefault();
			return;
		}
		this.dragPath = key;
		this.dragKind = "tab";
		tab.classList.add("is-dragging");
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = "move";
			try {
				event.dataTransfer.setData("text/plain", key);
			} catch (error) {
				/* 无 dataTransfer 的环境仍可在原地拖 */
			}
		}
	});

	list.addEventListener("dragstart", (event) => {
		if (this.editing !== "order") {
			event.preventDefault();
			return;
		}
		const node = event.target.closest ? event.target.closest("[data-kind]") : null;
		if (!node) return;
		const kind = node.dataset.kind;
		if (kind !== "note" && kind !== "folder") {
			event.preventDefault();
			return;
		}
		this.dragPath = node.dataset.path;
		this.dragKind = kind;
		node.classList.add("is-dragging");
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = "move";
			try {
				event.dataTransfer.setData("text/plain", node.dataset.path);
			} catch (error) {
				/* 同上 */
			}
		}
	});

	const clearHint = () => {
		if (!list) return;
		for (const node of list.querySelectorAll(".is-drop, .is-drop-into")) {
			node.classList.remove("is-drop", "is-drop-into");
		}
		for (const node of tabs.querySelectorAll(".is-drop")) node.classList.remove("is-drop");
	};

	tabs.addEventListener("dragover", (event) => {
		if (this.editing !== "order" || !this.dragPath) return;
		const tab = event.target.closest ? event.target.closest(".mg-tab") : null;
		if (!tab) return;
		const key = tab.dataset.key;
		if (key === this.dragPath) return;
		if (this.dragKind === "tab") {
			if (key === "root" || key === "recent" || key === "all" || !this.index.hasFolder(key)) return;
		} else if (key === "recent" || key === "all") {
			return;
		}
		event.preventDefault();
		clearHint();
		tab.classList.add("is-drop");
	});

	tabs.addEventListener("drop", (event) => {
		if (this.editing !== "order" || !this.dragPath) return;
		const tab = event.target.closest ? event.target.closest(".mg-tab") : null;
		if (!tab) return;
		const target = tab.dataset.key;
		const dragged = this.dragPath;
		const kind = this.dragKind;
		clearHint();
		if (kind === "tab") {
			event.preventDefault();
			this.reorderTab(dragged, target);
			return;
		}
		if (target === "recent" || target === "all") return;
		event.preventDefault();
		void this.moveInto(dragged, target === "root" ? "" : target);
	});

	list.addEventListener("dragover", (event) => {
		if (this.editing !== "order" || !this.dragPath) return;
		const node = event.target.closest ? event.target.closest("[data-kind]") : null;
		if (!node || node.dataset.path === this.dragPath) return;
		if (this.dragKind === "folder" && node.dataset.path.startsWith(this.dragPath + "/")) return;
		event.preventDefault();
		clearHint();
		if (node.dataset.kind === "folder") node.classList.add("is-drop-into");
		else if (node.dataset.kind === "note") node.classList.add("is-drop");
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
	});

	list.addEventListener("drop", (event) => {
		if (this.editing !== "order" || !this.dragPath) return;
		const node = event.target.closest ? event.target.closest("[data-kind]") : null;
		const dragged = this.dragPath;
		const kind = this.dragKind;
		clearHint();
		if (!node) return;
		if (node.dataset.path === dragged) return;
		event.preventDefault();
		const targetPath = node.dataset.path;
		const targetKind = node.dataset.kind;
		if (kind === "folder" && targetPath.startsWith(dragged + "/")) return;

		if (targetKind === "folder") {
			void this.moveInto(dragged, targetPath);
			return;
		}

		const targetDir = mgDir(targetPath);
		const sourceDir = mgDir(dragged);
		if (kind === "note" && targetDir === sourceDir) {
			this.reorderNote(targetDir, dragged, targetPath);
			return;
		}
		void this.moveInto(dragged, targetDir);
	});

	list.addEventListener("dragend", () => {
		clearHint();
		this.dragPath = null;
		this.dragKind = null;
		for (const node of list.querySelectorAll(".is-dragging")) node.classList.remove("is-dragging");
		for (const node of tabs.querySelectorAll(".is-dragging")) node.classList.remove("is-dragging");
	});

	tabs.addEventListener("dragend", () => {
		this.dragPath = null;
		this.dragKind = null;
		for (const node of tabs.querySelectorAll(".is-dragging")) node.classList.remove("is-dragging");
	});
};

MgView.prototype.reorderTab = function (draggedKey, targetKey) {
	if (!draggedKey || !targetKey || draggedKey === targetKey) return;
	const keys = [...this.tabsEl.querySelectorAll(".mg-tab")].map((node) => node.dataset.key);
	const from = keys.indexOf(draggedKey);
	const to = keys.indexOf(targetKey);
	if (from < 0 || to < 0) return;
	keys.splice(from, 1);
	keys.splice(to, 0, draggedKey);
	this.plugin.data.tabOrder = keys;
	void this.plugin.saveData(this.plugin.data);
	this.renderTabs();
};

MgView.prototype.currentNoteOrder = function (dir) {
	const base = dir || "";
	const notes = mgSortNotes(this.index.notesIn(base), this.sortMode, (this.plugin.data.noteOrder || {})[base] || []);
	return notes.map((entry) => entry.path);
};

MgView.prototype.reorderNote = function (dir, draggedPath, targetPath) {
	const order = this.currentNoteOrder(dir);
	const from = order.indexOf(draggedPath);
	const to = order.indexOf(targetPath);
	if (from < 0 || to < 0) return;
	order.splice(from, 1);
	order.splice(to, 0, draggedPath);
	if (!this.plugin.data.noteOrder) this.plugin.data.noteOrder = {};
	this.plugin.data.noteOrder[dir || ""] = order;
	void this.plugin.saveData(this.plugin.data);
	this.renderList();
};

MgView.prototype.moveInto = async function (sourcePath, destDir) {
	const base = destDir || "";
	if (mgDir(sourcePath) === base) return;
	const file = this.app.vault.getAbstractFileByPath(sourcePath);
	if (!file) return;
	const isFolder = Array.isArray(file.children);
	if (isFolder && base && (base === sourcePath || base.startsWith(sourcePath + "/"))) {
		new Notice(MG_TEXT.cantMoveIntoSelf);
		return;
	}
	const names = this.siblingNames(base, null);
	const name = mgBase(sourcePath);
	const final = mgUnique(isFolder ? names.folders : names.files, name, isFolder);
	const nextPath = mgJoin(base, final);
	try {
		await this.app.vault.rename(file, nextPath);
		if (this.category === sourcePath) this.category = nextPath;
		this.rebuild();
		new Notice(MG_TEXT.moved + "：" + final);
	} catch (error) {
		new Notice(MG_TEXT.moveFailed + ": " + (error && error.message ? error.message : String(error)));
	}
};

/* ---------- 键盘 ----------

   列表自己拿焦点, 上下键移动焦点环, Enter 打开. 视图里没有多选的真实
   用途, Ctrl+A 先把可见行标出来, 留给以后整批移动. */

MgView.prototype.onListKey = function (event) {
	const rows = this.rowNodes || [];
	if (rows.length === 0) return;
	const page = Math.max(1, Math.floor((this.listEl.clientHeight || 400) / 34));
	let next = this.cursor;
	const key = event.key;

	if (key === "ArrowDown" || key === "j") next += 1;
	else if (key === "ArrowUp" || key === "k") next -= 1;
	else if (key === "Home") next = 0;
	else if (key === "End") next = rows.length - 1;
	else if (key === "PageDown") next += page;
	else if (key === "PageUp") next -= page;
	else if (key === "Enter") {
		event.preventDefault();
		this.activateRow(rows[Math.max(0, this.cursor)]);
		return;
	} else if ((key === "a" || key === "A") && (event.ctrlKey || event.metaKey)) {
		event.preventDefault();
		this.selectVisible();
		return;
	} else return;

	event.preventDefault();
	this.focusRow(Math.max(0, Math.min(rows.length - 1, next)));
};

MgView.prototype.focusRow = function (index) {
	const rows = this.rowNodes || [];
	if (rows.length === 0) return;
	this.cursor = index;
	this.paintCursor();
	const node = rows[index];
	if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
};

MgView.prototype.paintCursor = function () {
	const rows = this.rowNodes || [];
	for (let i = 0; i < rows.length; i += 1) rows[i].classList.toggle("is-focus", i === this.cursor);
};

MgView.prototype.activateRow = function (node) {
	if (!node || !node.dataset) return;
	const path = node.dataset.path;
	if (!path) return;
	if (node.classList.contains("mg-folder")) this.toggleCollapse(path);
	else this.openNote(path);
};

MgView.prototype.selectVisible = function () {
	const rows = this.rowNodes || [];
	this.selected = rows.map((node) => node.dataset.path).filter(Boolean);
	for (const node of rows) node.classList.add("is-checked");
};

/* ===== 40-search.js ===== */
"use strict";

/* ---------- 全文搜索 ----------

   标题匹配是同步的，敲一个字列表就换一次。全文匹配要读正文，一万篇的库
   第一次扫完要几秒，所以它跑在输入停下来之后，并且边扫边出结果：状态行
   报进度，列表逐段变长。换词就把上一轮的 token 作废，旧结果不会再写回。 */

MgView.prototype.scheduleFullScan = function () {
	if (this.scanTimer) window.clearTimeout(this.scanTimer);
	this.scanTimer = 0;
	const needle = this.query.trim();
	/* 标题范围走的是同步匹配, 结果数 renderList 已经写好了. 这里再调一次
	   syncStatus(0, 0) 会把它盖成"0 条结果", 列表明明有内容却报零. */
	if (this.scope !== "full" || !needle) {
		this.searching = false;
		this.searchScanned = 0;
		return;
	}
	this.scanTimer = window.setTimeout(() => this.startFullSearch(needle), 240);
};

MgView.prototype.startFullSearch = function (needle) {
	const word = String(needle || "").trim();
	if (!word) return;
	if (this.fullSearchQuery === word && (this.searching || this.fullSearchDone)) return;
	this.fullSearchQuery = word;
	this.fullHits.clear();
	this.searchToken += 1;
	this.searching = true;
	this.searchScanned = 0;
	this.fullSearchDone = false;
	void this.runFullSearch(word, this.searchToken);
	this.renderList();
};

MgView.prototype.runFullSearch = async function (needle, token) {
	const lower = needle.toLowerCase();
	const entries = this.index.entries;
	let scanned = 0;
	for (const entry of entries) {
		if (token !== this.searchToken) return;
		scanned += 1;
		/* 只有 md 值得读正文, 二进制文件读出来是乱码. */
		if (entry.ext && entry.ext !== "md") continue;
		if (!this.fullHits.has(entry.path)) {
			let text = this.textCache.get(entry.path);
			if (text === undefined) {
				const file = this.app.vault.getAbstractFileByPath(entry.path);
				if (file && typeof this.app.vault.cachedRead === "function") {
					try {
						text = await this.app.vault.cachedRead(file);
					} catch (error) {
						text = "";
					}
				} else {
					text = "";
				}
				this.textCache.set(entry.path, text || "");
			}
			if (text && text.toLowerCase().includes(lower)) {
				this.fullHits.set(entry.path, mgSnippet(text, needle));
			}
		}
		if (scanned % 40 === 0) {
			if (token !== this.searchToken) return;
			this.searchScanned = scanned;
			this.renderList();
			await new Promise((resolve) => window.setTimeout(resolve, 0));
		}
	}
	if (token !== this.searchToken) return;
	this.searching = false;
	this.searchScanned = entries.length;
	this.fullSearchDone = true;
	this.renderList();
};

/* ===== 45-settings.js ===== */
"use strict";

/* ---------- 设置页 ----------

   每项只有一个名称和一个控件, 没有说明小字. 文案全部来自 05-i18n, 跟着
   Obsidian 的语言走; 只有 "Manager" 这个插件名不翻译. */

class ManagerSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const container = this.containerEl;
		container.empty();
		const data = this.plugin.data;

		const flag = (name, value, apply) => {
			new Setting(container).setName(name).addToggle((toggle) =>
				toggle.setValue(value).onChange((next) => {
					apply(next);
					void this.plugin.saveData(data);
				})
			);
		};

		new Setting(container).setName("Manager").setHeading();

		new Setting(container)
			.setName(MG_TEXT.setBlocked)
			.addTextArea((area) => {
				area
					.setPlaceholder("Archive\nLife/日记")
					.setValue(data.blockedFolders || "")
					.onChange((value) => {
						data.blockedFolders = value;
						this.plugin.queueSave();
						this.plugin.queueRefresh();
					});
				area.inputEl.rows = 4;
				if (area.inputEl.classList) area.inputEl.classList.add("mg-setting-textarea");
			});

		flag(MG_TEXT.setEmptyFolders, data.showEmptyFolders === true, (value) => {
			data.showEmptyFolders = value;
			this.plugin.refreshViews();
		});

		flag(MG_TEXT.setRecent, data.showRecent !== false, (value) => {
			data.showRecent = value;
			this.plugin.refreshViews();
		});

		flag(MG_TEXT.setAll, data.showAll !== false, (value) => {
			data.showAll = value;
			this.plugin.refreshViews();
		});

		flag(MG_TEXT.setSettingsIcon, data.showSettingsIcon !== false, (value) => {
			data.showSettingsIcon = value;
			this.plugin.syncSettingsRibbon();
		});

		flag(MG_TEXT.setHomePage, data.homePage === true, (value) => {
			data.homePage = value;
		});

		flag(MG_TEXT.setAnimations, data.animations !== false, (value) => {
			data.animations = value;
			this.plugin.refreshViews();
		});

		flag(MG_TEXT.setCollapse, data.collapseSidebar !== false, (value) => {
			data.collapseSidebar = value;
			if (value) this.plugin.collapseLeft(false);
		});

		new Setting(container).setName(MG_TEXT.setSupport).setHeading();

		const support = document.createElement("div");
		support.className = "mg-support";

		const code = document.createElement("img");
		code.className = "mg-support-code";
		code.alt = MG_TEXT.setSupport;
		code.src = this.plugin.supportImage();
		support.appendChild(code);

		container.appendChild(support);
	}
}

/* ===== 50-plugin.js ===== */
"use strict";

/* ---------- 插件 ----------

   启动这一段是整份代码里唯一跟时间赛跑的地方. Obsidian 会先把上次的
   layout 恢复并画出来, 然后才回调 onLayoutReady, 所以"等布局好了再收侧栏"
   永远慢一帧, 用户看到的就是侧栏闪一下再关.

   做法是在 onload 就把 body 类挂上, 让样式层面先把左栏从画面里拿掉,
   主区域也先藏起来, 等 Manager 铺好再一起放出来. Thinker 当年只遮了左栏,
   所以还会闪一下上次打开的笔记, 这里两个都遮. */

class ManagerPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.registerView(MG_VIEW_TYPE, (leaf) => new MgView(leaf, this));

		this.homeRibbon = this.addRibbonIcon(MG_ICON, MG_TEXT.ribbonOpen, () => {
			void this.activateView();
		});
		this.settingsRibbon = null;
		this.syncSettingsRibbon();

		this.addCommand({
			id: "open-manager",
			name: MG_TEXT.cmdOpen,
			callback: () => {
				void this.activateView();
			}
		});

		this.addSettingTab(new ManagerSettingTab(this.app, this));

		/* 遮罩要赶在 layout 恢复之前挂上, onLayoutReady 里再挂就已经晚了. */
		this.hideForBoot();
		this.app.workspace.onLayoutReady(() => {
			void this.onReady();
		});
	}

	async onReady() {
		try {
			if (this.data.collapseSidebar !== false) this.collapseLeft(true);
			if (this.data.homePage === true) await this.activateView({ quiet: true });
		} catch (error) {
			console.error("Manager: startup failed", error);
		}
		this.releaseBoot();
	}

	onunload() {
		this.clearBoot();
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = 0;
		/* 防抖的写入不能跟着卸载一起丢掉, 卸载前补一次. */
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = 0;
			void this.saveData(this.data);
		}
	}

	async loadSettings() {
		const raw = (await this.loadData()) || {};
		this.data = Object.assign({}, raw);
		for (const key of Object.keys(MG_DEFAULT)) {
			if (this.data[key] === undefined) this.data[key] = MG_DEFAULT[key];
		}
		if (!this.data.noteOrder || typeof this.data.noteOrder !== "object") this.data.noteOrder = {};
		if (!this.data.folderOrder || typeof this.data.folderOrder !== "object") this.data.folderOrder = {};
		if (!Array.isArray(this.data.collapsed)) this.data.collapsed = [];
		if (!Array.isArray(this.data.tabOrder)) this.data.tabOrder = [];
		this.data.showAll = this.data.showAll !== false;
		this.data.showRecent = this.data.showRecent !== false;
		this.data.showSettingsIcon = this.data.showSettingsIcon !== false;
		this.data.showEmptyFolders = this.data.showEmptyFolders === true;
		this.data.animations = this.data.animations !== false;
		this.data.homePage = this.data.homePage === true;
		this.data.collapseSidebar = this.data.collapseSidebar !== false;
		this.data.blockedFolders = typeof this.data.blockedFolders === "string" ? this.data.blockedFolders : "";
	}

	/* ---------- 打开视图 ---------- */

	async activateView(options) {
		const opts = options || {};
		const workspace = this.app.workspace;
		if (this.data.collapseSidebar !== false && !opts.quiet) this.collapseLeft(false);

		const existing = workspace.getLeavesOfType(MG_VIEW_TYPE);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return existing[0];
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: MG_VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
		return leaf;
	}

	/* ---------- 左侧边栏 ----------

	   instant 用两次: 一次是启动, 一次是在设置里刚打开这个开关时.
	   启动那次要连过渡一起按住, 否则收起动作本身就是那一下闪. */

	collapseLeft(instant) {
		const split = this.app.workspace.leftSplit;
		if (!split || split.collapsed) return;
		const el = split.containerEl;
		if (instant && el && el.style) el.style.transition = "none";
		try {
			split.collapse();
		} catch (error) {
			console.error("Manager: could not collapse the left sidebar", error);
		}
		if (instant && el && el.style) {
			setTimeout(() => {
				el.style.transition = "";
			}, 600);
		}
	}

	/* 左栏遮到收起动作落定为止, 主区域遮到 Manager 铺好为止, 两者不同步:
	   主区域两帧就够, 左栏要等布局, 用同一个时长会让启动多黑半秒. */
	hideForBoot() {
		if (typeof document === "undefined" || !document) return;
		const body = document.body;
		if (!body || !body.classList) return;
		if (this.data.collapseSidebar !== false) body.classList.add("mg-booting-left");
		if (this.data.homePage === true) body.classList.add("mg-booting-main");
	}

	releaseBoot() {
		if (typeof document === "undefined" || !document) return;
		const body = document.body;
		const dropMain = () => {
			if (body && body.classList) body.classList.remove("mg-booting-main");
		};
		/* 主区域等两帧: setViewState 的 promise 落了, 布局还没换完,
		   早一帧放出来就是那一下白闪. */
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(dropMain));
		else dropMain();
		if (this.bootTimer) clearTimeout(this.bootTimer);
		this.bootTimer = setTimeout(() => {
			this.bootTimer = 0;
			if (body && body.classList) body.classList.remove("mg-booting-left");
		}, 320);
	}

	clearBoot() {
		if (typeof document === "undefined" || !document) return;
		const body = document.body;
		if (!body || !body.classList) return;
		body.classList.remove("mg-booting-main", "mg-booting-left");
	}

	/* ---------- 设置入口 ---------- */

	syncSettingsRibbon() {
		const want = this.data.showSettingsIcon !== false;
		if (want && !this.settingsRibbon) {
			this.settingsRibbon = this.addRibbonIcon("settings", MG_TEXT.ribbonSettings, () => this.openSettings());
			return;
		}
		if (!want && this.settingsRibbon) {
			if (typeof this.settingsRibbon.remove === "function") this.settingsRibbon.remove();
			this.settingsRibbon = null;
		}
	}

	/* app.setting 是内部接口, 但它比"执行 app:open-settings 再找页签"稳:
	   后者会在设置面板还没建好时打不开目标页. */
	openSettings() {
		const setting = this.app.setting;
		if (setting && typeof setting.open === "function") {
			setting.open();
			if (typeof setting.openTabById === "function") {
				setTimeout(() => {
					try {
						setting.openTabById(this.manifest.id);
					} catch (error) {
						console.error("Manager: could not open the settings tab", error);
					}
				}, 0);
			}
			return;
		}
		if (this.app.commands && typeof this.app.commands.executeCommandById === "function") {
			this.app.commands.executeCommandById("app:open-settings");
		}
	}

	/* 赞赏码在插件目录里, 不在库里, 所以不能走 TFile 那条路. manifest.dir 是
	   相对库根的路径, 交给 adapter 换成可访问的地址; 拿不到就退回相对路径. */
	supportImage() {
		const dir = (this.manifest && this.manifest.dir) || ".obsidian/plugins/manager";
		const rel = dir + "/assets/wechat.png";
		const vault = this.app && this.app.vault;
		const adapter = vault && vault.adapter;
		if (adapter && typeof adapter.getResourcePath === "function") {
			try {
				return adapter.getResourcePath(rel);
			} catch (error) {
				return rel;
			}
		}
		return rel;
	}

	/* 设置改了要让已经开着的视图立刻重算, 不然得关掉再开才看得到. */
	refreshViews() {
		const leaves = this.app.workspace.getLeavesOfType(MG_VIEW_TYPE);
		for (const leaf of leaves) {
			const view = leaf && leaf.view;
			if (view && typeof view.rebuild === "function") view.rebuild();
		}
	}

	queueRefresh() {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = 0;
			this.refreshViews();
		}, 240);
	}

	/* 屏蔽名单是一行一行敲出来的, 每敲一个字写一次盘没必要, 攒一下. */
	queueSave() {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = 0;
			void this.saveData(this.data);
		}, 400);
	}
}

module.exports = ManagerPlugin;
module.exports.__view = MgView;
module.exports.__settings = ManagerSettingTab;
module.exports.__core = {
	mgDir,
	mgBase,
	mgJoin,
	mgDepth,
	mgStem,
	mgExt,
	mgUnique,
	mgComparator,
	mgApplyOrder,
	mgRelative,
	mgNumber,
	mgBlockedList,
	mgParseFilter,
	mgMatchFilter,
	mgMatchTerms,
	mgFilterIsStructured,
	mgUnder,
	mgSortNotes,
	mgSortFolders,
	mgSnippet,
	mgBuildRows,
	mgClampLevel,
	MG_DEFAULT,
	MG_SORTS,
	MG_TEXT,
	MG_LANGS,
	mgLanguage,
	MG_ICON
};
