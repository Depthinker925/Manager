/* Manager 的测试. 这个插件没有构建步骤, 只有一个 main.js:
   把 obsidian 换成替身, require 进来, 直接跑 __core 里那几个纯函数.
   跑法: node test.cjs */

const path = require("path");
const Module = require("module");

const stub = {
	Plugin: class {},
	ItemView: class {
		constructor(leaf) {
			this.leaf = leaf;
			this.app = leaf && leaf.app;
		}
	},
	Menu: class {
		addItem() {
			return this;
		}
		showAtMouseEvent() {}
		showAtPosition() {}
	},
	Modal: class {
		constructor(app) {
			this.app = app;
			this.contentEl = {
				firstChild: null,
				appendChild() {},
				removeChild() {},
				classList: { add() {}, remove() {}, toggle() {} }
			};
		}
		open() {}
		close() {}
	},
	Notice: class {},
	Setting: class {},
	PluginSettingTab: class {},
	setIcon() {},
	getLanguage: () => "en"
};

const load = Module._load;
Module._load = function (request, parent, isMain) {
	return request === "obsidian" ? stub : load.call(this, request, parent, isMain);
};

const core = require(path.join(__dirname, "main.js")).__core;

let pass = 0;
const fails = [];
const eq = (name, got, want) => {
	if (JSON.stringify(got) === JSON.stringify(want)) {
		pass += 1;
		return;
	}
	fails.push(name + "\n    got  " + JSON.stringify(got) + "\n    want " + JSON.stringify(want));
};

const notes = [
	{ path: "Life/b.md", title: "b", parent: "Life", mtime: 20, ctime: 10, ext: "md" },
	{ path: "Life/a.md", title: "a", parent: "Life", mtime: 10, ctime: 10, ext: "md" }
];
const index = {
	entries: notes,
	notesIn: (dir) => (dir === "Life" ? notes : []),
	childFolders: () => [],
	rootFolders: () => [{ path: "Life", name: "Life" }],
	countIn: () => notes.length
};

eq("mgDir 取所在目录", core.mgDir("Life/日记/a.md"), "Life/日记");
eq("mgDir 顶层为空", core.mgDir("a.md"), "");
eq("mgUnique 不撞名原样返回", core.mgUnique(["a"], "b"), "b");
eq("mgUnique 撞名加序号", core.mgUnique(["a.md"], "a.md"), "a 2.md");
eq("mgBlockedList 按行拆", core.mgBlockedList("A\nB"), ["A", "B"]);
eq("mgBlockedList 归一化斜杠", core.mgBlockedList("/A/"), ["A"]);
eq("mgSortNotes 按名称", core.mgSortNotes(notes, "name-asc", []).map((n) => n.title), ["a", "b"]);
eq("mgSortNotes 按修改时间", core.mgSortNotes(notes, "mtime-desc", []).map((n) => n.title), ["b", "a"]);

const built = core.mgBuildRows({
	category: "Life",
	sortMode: "name-asc",
	index,
	noteOrder: {},
	folderOrder: {},
	collapsed: [],
	limit: 50
});
eq("mgBuildRows 笔记条数", built.rows.length, 2);
eq("mgBuildRows 按名称排", built.rows.map((row) => row.entry.title), ["a", "b"]);
eq("mgBuildRows 报了总数", built.total, 2);

/* ---------- 过滤 ---------- */

const today = Date.now();
const big = 20 * 1048576;
const pdf = { path: "Life/b.pdf", title: "b.pdf", name: "b.pdf", parent: "Life", ext: "pdf", size: big, mtime: today };

eq("解析扩展名", core.mgParseFilter(".pdf").exts, ["pdf"]);
eq("解析多个扩展名", core.mgParseFilter(".pdf .png").exts, ["pdf", "png"]);
eq("解析体积下限", core.mgParseFilter(">10mb").minSize, 10 * 1048576);
eq("解析体积上限", core.mgParseFilter("<500kb").maxSize, 500 * 1024);
eq("解析今天", core.mgParseFilter("today").from > 0, true);
eq("解析空文件夹", core.mgParseFilter("empty").empty, true);
eq("年月转区间", core.mgParseFilter("2026-11").to > core.mgParseFilter("2026-11").from, true);
eq("剩下的词当名字", core.mgParseFilter("报告 .pdf").terms, ["报告"]);

eq("扩展名匹配", core.mgMatchFilter(pdf, core.mgParseFilter(".pdf")), true);
eq("扩展名不匹配", core.mgMatchFilter(pdf, core.mgParseFilter(".png")), false);
eq("体积达标", core.mgMatchFilter(pdf, core.mgParseFilter(">10mb")), true);
eq("体积不达标", core.mgMatchFilter(pdf, core.mgParseFilter(">100mb")), false);
eq("时间达标", core.mgMatchFilter(pdf, core.mgParseFilter("today")), true);
eq("名字不匹配", core.mgMatchFilter(pdf, core.mgParseFilter("zzz")), false);
eq("空文件夹条件排掉文件", core.mgMatchFilter(pdf, core.mgParseFilter("empty")), false);

const mixed = {
	entries: [pdf, { path: "Life/a.md", title: "a", parent: "Life", ext: "md", size: 10, mtime: 10 }],
	notesIn: () => mixed.entries,
	childFolders: () => [],
	rootFolders: () => [],
	recent: () => mixed.entries,
	countIn: () => 2
};
const onlyPdf = core.mgBuildRows({
	category: "all",
	sortMode: "name-asc",
	index: mixed,
	noteOrder: {},
	folderOrder: {},
	collapsed: [],
	limit: 50,
	filter: ".pdf"
});
eq("行构建按扩展名收窄", onlyPdf.rows.length, 1);
eq("留下的是 pdf", onlyPdf.rows[0].entry.ext, "pdf");

const allRows = core.mgBuildRows({
	category: "all",
	sortMode: "name-asc",
	index: mixed,
	noteOrder: {},
	folderOrder: {},
	collapsed: [],
	limit: 50,
	filter: ""
});
eq("空条件不筛", allRows.rows.length, 2);

console.log(pass + " passed, " + fails.length + " failed");
if (fails.length) {
	for (const line of fails) console.log("FAIL " + line);
	process.exit(1);
}
