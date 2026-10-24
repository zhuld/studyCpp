/*
 * reader.js — md 驱动的交互阅读器
 *
 * 站点不再加载 course-content.json：启动时读取 md/manifest.json，
 * 目录按章组织，正文直接渲染 md/*.md；章节内 h2/h3 自动生成二级目录，
 * 代码块支持高亮、复制、载入工作台与在线运行。
 *
 * 仅本机个人学习使用：md/ 已被 .gitignore 排除。
 */
"use strict";

(function () {

  /* ============================== 常量 ============================== */

  var WANDBOX_LIST = "https://wandbox.org/api/list.json";
  var WANDBOX_RUN = "https://wandbox.org/api/compile.json";
  var LOCAL_HEADER_DIR = "md/headfiles/";
  var FALLBACK_COMPILER = "gcc-13.2.0";
  var DEFAULT_STD = "c++20";
  var STARTER_CODE =
    "#include <iostream>\n" +
    "\n" +
    "int main()\n" +
    "{\n" +
    "    std::cout << \"hello, C++\\n\";\n" +
    "    return 0;\n" +
    "}\n";

  var STORAGE = {
    theme: "cpp-primer-theme-v1",
    fontSize: "cpp-primer-font-size-v1",
    toc: "cpp-primer-toc-collapsed-v1",
    chapter: "cpp-primer-source-chapter-v1",
    position: "cpp-primer-source-position-v1"
  };

  /* ============================== 工具 ============================== */

  var $ = function (id) { return document.getElementById(id); };

  function scrollBehavior() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto" : "smooth";
  }

  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- 复制按钮图标（内联 SVG，跟随 currentColor 变色） ---------- */

  var SVG_NS = "http://www.w3.org/2000/svg";

  /* 三个状态：复制 / 已复制 / 复制失败 */
  var COPY_ICON_SHAPES = {
    copy: [
      { tag: "rect", attrs: { x: 9, y: 9, width: 11, height: 11, rx: 2 } },
      { tag: "path", attrs: { d: "M5 15H4.5A2.5 2.5 0 0 1 2 12.5v-8A2.5 2.5 0 0 1 4.5 2h8A2.5 2.5 0 0 1 15 4.5V5" } }
    ],
    done: [
      { tag: "path", attrs: { d: "M20 6.5 9.5 17 4 11.5" } }
    ],
    fail: [
      { tag: "circle", attrs: { cx: 12, cy: 12, r: 9 } },
      { tag: "path", attrs: { d: "M12 7.5v5" } },
      { tag: "path", attrs: { d: "M12 15.8h.01" } }
    ]
  };

  function makeIcon(name) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    (COPY_ICON_SHAPES[name] || []).forEach(function (shape) {
      var node = document.createElementNS(SVG_NS, shape.tag);
      Object.keys(shape.attrs).forEach(function (key) {
        node.setAttribute(key, shape.attrs[key]);
      });
      svg.appendChild(node);
    });
    return svg;
  }

  /* 换图标：按钮内只保留一个 SVG，旧的先摘掉 */
  function setIcon(button, name) {
    var old = button.querySelector("svg");
    if (old) button.removeChild(old);
    button.insertBefore(makeIcon(name), button.firstChild);
  }

  /* ============================== 状态 ============================== */

  var state = {
    compilers: [],
    chapters: [],
    secCounts: {},
    active: null,
    headings: [],
    /* 全书索引：小节号 -> 章编号，「6.2.5 节」这类跨章引用据此跳转 */
    secIndex: {},
    running: false,
    loadedCode: "",
    token: 0
  };

  var READING_FONT_MIN = 15;
  var READING_FONT_MAX = 21;
  var READING_FONT_STEP = 1;
  var readingProgressFrame = 0;

  var POSITION_SAVE_DELAY = 400;
  var positionTimer = 0;
  var restoringPosition = false;
  /* 章节号 -> { anchor, offset } 或 { y }；锚点优先，图片加载导致布局变化时仍能定位 */
  var positionMap = {};

  var codeEl, hlEl, gutterEl, stdinEl;
  var workbench, workbenchDrag, workbenchResize;

  var highlight = (window.CPP_HIGHLIGHT && window.CPP_HIGHLIGHT.highlight) ||
    function (code) { return esc(code); };

  /* ============================== 目录数据 ============================== */

  function partOf(number) {
    if (number === "0" || number === "1") return "开始";
    if (number === "20") return "附录";
    var n = parseInt(number, 10);
    if (n >= 2 && n <= 7) return "第Ⅰ部分 C++基础";
    if (n >= 8 && n <= 12) return "第Ⅱ部分 C++标准库";
    if (n >= 13 && n <= 16) return "第Ⅲ部分 类设计者的工具";
    return "第Ⅳ部分 高级主题";
  }

  /* 「第Ⅰ部分 …」这类部分扉页：标题本身不作为小节，目录里的部分名可直接跳转 */
  var PART_LABEL_RE = /^第\s*[ⅠⅡⅢⅣⅤ]+\s*部分/;
  var pendingPartScroll = false;

  function normChapters(manifest) {
    var keys = Object.keys((manifest && manifest.chapters) || {});
    keys.sort(function (a, b) {
      var an = a === "A" ? 1000 : parseInt(a, 10);
      var bn = b === "A" ? 1000 : parseInt(b, 10);
      if (isNaN(an)) an = 1001;
      if (isNaN(bn)) bn = 1001;
      return an - bn;
    });
    var chapters = [];
    keys.forEach(function (key) {
      var item = manifest.chapters[key];
      if (!item || !item.file) return;
      chapters.push({
        number: key,
        title: item.title || key,
        file: item.file,
        part: partOf(key),
        /* null = 尚未确认；由 loadSectionCounts 预取各章 md 后置为 true/false */
        available: null
      });
    });
    return chapters;
  }

  /* ============================== 正文渲染 ============================== */

  function collectHeadings(root) {
    var list = [];
    Array.prototype.forEach.call(root.querySelectorAll("h2, h3"), function (heading) {
      if (!heading.id) return;
      if (heading.hasAttribute("data-part-heading")) return;
      list.push({
        id: heading.id,
        level: heading.tagName === "H2" ? 2 : 3,
        text: heading.textContent.replace(/\s+/g, " ").trim()
      });
    });
    return list;
  }

  function prepareContent(root) {
    Array.prototype.forEach.call(root.querySelectorAll("pre.src-code"), function (pre) {
      var lang = (pre.getAttribute("data-lang") || "").toLowerCase();
      /* 非 C++ 围栏（如表格还原出的 ```text）只按等宽文本显示，不做语法着色 */
      if (lang && lang !== "cpp" && lang !== "c++" && lang !== "cc") return;
      var code = pre.querySelector("code");
      if (code) code.innerHTML = highlight(code.textContent);
    });
    addCopyButtons(root);
    decorateRunnableBlocks(root);

    Array.prototype.forEach.call(root.querySelectorAll("img"), function (img) {
      img.setAttribute("loading", "lazy");
      img.title = "点击查看原图";
      img.addEventListener("click", function () {
        window.open(img.src, "_blank", "noopener");
      });
    });

    var index = 0;
    var partIndex = 0;
    Array.prototype.forEach.call(root.querySelectorAll("h2, h3"), function (heading) {
      var text = heading.textContent.replace(/\s+/g, " ").trim();
      /* 部分扉页标题：作为跳转锚点，不进入小节列表 */
      if (heading.tagName === "H2" && PART_LABEL_RE.test(text)) {
        heading.id = "md-part-" + partIndex;
        partIndex++;
        heading.setAttribute("data-part-heading", heading.id);
        heading.classList.add("md-part-heading");
        return;
      }
      var sectionId = heading.id;
      heading.id = "md-topic-" + index;
      /* md.js 给带编号的小节写了 sec-2.1.1；转成独立锚点，
         正文里的「2.1.1 节」链接才能落到这里 */
      if (sectionId) {
        var anchor = el("span", "md-sec-anchor");
        anchor.id = sectionId;
        heading.insertBefore(anchor, heading.firstChild);
      }
      /* 目录条目用同一个值做定位，滚动高亮才能匹配 */
      heading.setAttribute("data-outline-topic", heading.id);
      heading.classList.add("md-heading-topic");
      index++;
    });
  }

  function chapterByNumber(number) {
    for (var i = 0; i < state.chapters.length; i++) {
      if (state.chapters[i].number === number) return state.chapters[i];
    }
    return null;
  }

  /* md.js 把本章已有的「X.X 节」直接写成 #sec- 锚点；其余引用留作
     .md-sec-ref，等 loadSectionCounts 预取建好全书索引后再升级为跨章链接。 */
  function indexSections(chapterNumber, markdown) {
    var lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
    var inFence = false;
    lines.forEach(function (line) {
      if (inFence) {
        if (/^```\s*$/.test(line)) inFence = false;
        return;
      }
      if (/^```[A-Za-z0-9_+-]*\s*$/.test(line)) { inFence = true; return; }
      var match = /^#{1,6}\s+(\d+(?:\.\d+)+)(?=\s|$)/.exec(line);
      if (!match || state.secIndex[match[1]]) return;
      state.secIndex[match[1]] = chapterNumber;
    });
  }

  function gotoSection(chapterNumber, sectionNumber) {
    var chapter = chapterByNumber(chapterNumber);
    if (!chapter) return;
    var target = "sec-" + sectionNumber;
    if (state.active && state.active.number === chapter.number) {
      var node = document.getElementById(target);
      if (node) node.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      return;
    }
    selectChapter(chapter, false, null, true, target);
  }

  function upgradeSecRefs() {
    var wrap = $("sections");
    if (!wrap) return;
    Array.prototype.forEach.call(wrap.querySelectorAll(".md-sec-ref"), function (node) {
      var number = node.getAttribute("data-sec-ref");
      var chapterNumber = state.secIndex[number];
      if (!chapterNumber) return;
      if (state.active && chapterNumber === state.active.number) return;
      var chapter = chapterByNumber(chapterNumber);
      if (!chapter || chapter.available === false) return;
      var link = document.createElement("a");
      link.className = "md-sec-link";
      link.setAttribute("href", "#sec-" + number);
      link.title = "跳到" + chapter.title + "的 " + number + " 节";
      while (node.firstChild) link.appendChild(node.firstChild);
      link.addEventListener("click", function (event) {
        event.preventDefault();
        gotoSection(chapterNumber, number);
      });
      node.parentNode.replaceChild(link, node);
    });
  }

  function decorateRunnableBlocks(root) {
    var detect = window.CPP_CODE_BLOCKS;
    if (!detect) return;
    Array.prototype.forEach.call(root.querySelectorAll("pre.src-code"), function (pre) {
      var lang = (pre.getAttribute("data-lang") || "").toLowerCase();
      /* 非 C++ 围栏（如表格还原出的 ```text）不提供编译运行入口 */
      if (lang && lang !== "cpp" && lang !== "c++" && lang !== "cc") return;
      var code = pre.textContent;
      if (!detect.isRunnableProgram(code)) return;
      var anchor = pre.parentNode && pre.parentNode.classList.contains("code-fig")
        ? pre.parentNode : pre;
      var bar = el("div", "card-actions");
      var load = el("button", "btn", "载入编辑器");
      var runButton = el("button", "btn primary", "▶ 运行");
      load.type = "button";
      runButton.type = "button";
      load.title = "把这段代码放进工作台，可继续修改";
      runButton.title = "载入工作台并在线编译运行";
      load.addEventListener("click", function () { setCode(code, ""); });
      runButton.addEventListener("click", function () { setCode(code, ""); run(); });
      bar.appendChild(load);
      bar.appendChild(runButton);
      if (/\b(?:cin|getline|scanf|getchar|fgets|read)\s*\(?/.test(code)) {
        bar.appendChild(el("span", "code-actions-note", "程序会读取 stdin, 请在工作台填写输入"));
      }
      anchor.insertAdjacentElement("afterend", bar);
    });
  }

  /* ============================== 代码块复制 ============================== */

  function copyText(text, done) {
    function fallback() {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(area);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
      } catch (e) { fallback(); }
    } else {
      fallback();
    }
  }

  function addCopyButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll("pre.src-code"), function (pre) {
      if (pre.parentNode && pre.parentNode.classList.contains("code-fig")) return;
      var fig = el("div", "code-fig");
      pre.parentNode.insertBefore(fig, pre);
      fig.appendChild(pre);

      /* 按钮内容是复制图标，不是文字；状态与提示写在 title / aria-label 上 */
      var button = el("button", "code-copy");
      button.type = "button";
      button.appendChild(makeIcon("copy"));
      button.title = "复制代码";
      button.setAttribute("aria-label", "复制代码");
      var timer = null;
      button.addEventListener("click", function () {
        copyText(pre.textContent, function (ok) {
          setIcon(button, ok ? "done" : "fail");
          button.title = ok ? "已复制" : "复制失败";
          button.setAttribute("aria-label", ok ? "已复制" : "复制失败");
          button.classList.toggle("copied", ok);
          button.classList.toggle("copy-fail", !ok);
          if (timer) clearTimeout(timer);
          timer = setTimeout(function () {
            setIcon(button, "copy");
            button.title = "复制代码";
            button.setAttribute("aria-label", "复制代码");
            button.classList.remove("copied", "copy-fail");
            timer = null;
          }, 1600);
        });
      });
      fig.appendChild(button);
    });
  }

  /* ============================== 目录 ============================== */

  function setChapterOpen(item, open) {
    item.classList.toggle("is-open", open);
    var tab = item.querySelector(".chapter-tab");
    if (tab) tab.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeGroupsExcept(keep) {
    Array.prototype.forEach.call(
      document.querySelectorAll("#chapterNav .chip-group.is-open"),
      function (group) {
        if (group !== keep) setGroupOpen(group, false);
      }
    );
  }

  function setGroupOpen(group, open) {
    if (open) closeGroupsExcept(group);
    group.classList.toggle("is-open", open);
    var tab = group.querySelector(".chip.has-subs");
    if (tab) tab.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function selectChip(chip, topic) {
    document.querySelectorAll(".chip").forEach(function (item) {
      item.classList.remove("current");
    });
    chip.classList.add("current");
    var group = chip.closest ? chip.closest(".chip-group") : null;
    closeGroupsExcept(group);
    setupSpy.pinned = topic || true;
    /* 平滑滚动结束后把选中权交回滚动位置，拖滚动条时也能继续跟随 */
    setupSpy.pinnedUntil = Date.now() + 1000;
  }

  function makeChip(heading, hasSubs, subCount) {
    var chip = el("button", "chip",
      '<span class="chip-label">' + esc(heading.text) + "</span>" +
      (subCount ? '<span class="chip-count">' + subCount + "</span>" : ""));
    chip.type = "button";
    chip.setAttribute("data-outline-topic", heading.id);
    chip.title = heading.text;
    if (hasSubs) {
      chip.classList.add("has-subs");
      chip.setAttribute("aria-expanded", "false");
      chip.setAttribute("aria-controls", "chapterSubs-" + heading.id);
    }
    chip.addEventListener("click", function () {
      if (hasSubs) {
        var group = chip.parentNode;
        setGroupOpen(group, !group.classList.contains("is-open"));
      }
      selectChip(chip, heading.id);
      var target = document.getElementById(heading.id);
      if (target) target.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    });
    return chip;
  }

  function renderChips() {
    if (!state.active) return;
    var item = document.querySelector(
      '.chapter-item[data-chapter="' + state.active.number + '"]');
    var nav = item ? item.querySelector(".chips") : null;
    if (!nav) return;
    nav.innerHTML = "";

    var headings = state.headings;
    var index = 0;
    while (index < headings.length) {
      var heading = headings[index];
      if (heading.level === 3) {
        nav.appendChild(makeChip(heading, false, 0));
        index++;
        continue;
      }
      var subs = [];
      var cursor = index + 1;
      while (cursor < headings.length && headings[cursor].level === 3) {
        subs.push(headings[cursor]);
        cursor++;
      }
      if (!subs.length) {
        nav.appendChild(makeChip(heading, false, 0));
        index++;
        continue;
      }
      var group = el("div", "chip-group");
      var drawer = el("div", "chip-subs");
      drawer.id = "chapterSubs-" + heading.id;
      var list = el("div", "chips");
      subs.forEach(function (sub) { list.appendChild(makeChip(sub, false, 0)); });
      drawer.appendChild(list);
      group.appendChild(makeChip(heading, true, subs.length));
      group.appendChild(drawer);
      nav.appendChild(group);
      index = cursor;
    }
  }

  function scrollToPartHeading() {
    var heading = document.querySelector("#sections [data-part-heading]");
    if (!heading) return false;
    heading.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    return true;
  }

  /* ---------- 一级菜单可用性 ----------
   * 一级菜单（章）对应的 md 不存在（HTTP 404）时置灰并且不可点击。可用性由
   * loadSectionCounts 启动时预取各章 md 判定，渲染目录时按状态套用。 */

  var CHAPTER_MISSING_TITLE = "本章的 md 文件不存在";

  function firstChapterOfPart(part) {
    for (var i = 0; i < state.chapters.length; i++) {
      var chapter = state.chapters[i];
      if (chapter.part === part && chapter.available !== false) return chapter;
    }
    return null;
  }

  /* 跳过已知缺失的章，供起始选择与部分导言跳转兜底 */
  function nextAvailableChapter(chapter) {
    if (!state.chapters.length) return null;
    var start = state.chapters.indexOf(chapter);
    for (var i = 1; i <= state.chapters.length; i++) {
      var candidate = state.chapters[(start + i) % state.chapters.length];
      if (candidate !== chapter && candidate.available !== false) return candidate;
    }
    return null;
  }

  function disableChapterTab(tab) {
    tab.disabled = true;
    tab.classList.add("is-missing");
    tab.setAttribute("aria-disabled", "true");
    tab.setAttribute("aria-expanded", "false");
    tab.removeAttribute("aria-controls");
    tab.title = CHAPTER_MISSING_TITLE;
  }

  function markChapterMissing(number) {
    var item = document.querySelector(
      '.chapter-item[data-chapter="' + number + '"]');
    var tab = item && item.querySelector(".chapter-tab");
    if (tab) disableChapterTab(tab);
  }

  function makePartLink(chapter) {
    var button = el("button", "toc-part toc-part-link", esc(chapter.part));
    button.type = "button";
    button.title = "转到" + chapter.part + "的导言";
    button.setAttribute("data-part", chapter.part);
    button.addEventListener("click", function () {
      /* 点击时再取首章：可用性是启动后异步确认的 */
      var first = firstChapterOfPart(chapter.part);
      if (!first) return;
      if (state.active && state.active.number === first.number) {
        scrollToPartHeading();
        return;
      }
      pendingPartScroll = true;
      selectChapter(first, false, null, true);
    });
    return button;
  }

  /* ---------- 一级菜单右侧的二级菜单数量徽标 ----------
   * 未激活章的小节列表尚未渲染（chips 只在激活时填充），因此数量通过
   * 启动时预取各章 md 源码统计得到：只数二级菜单（行首 h2），
   * 跳过围栏代码块，排除「第Ⅰ部分」这类部分扉页标题；
   * 三级抽屉里的 h3 子节不计入。 */

  function countSections(markdown) {
    var lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
    var count = 0;
    var inFence = false;
    lines.forEach(function (line) {
      /* 围栏判定与 md.js 渲染器保持一致：开栏为行首 ``` + 语言名，
         闭栏只认行首裸 ```，栏内的标题行不会进入目录 */
      if (inFence) {
        if (/^```\s*$/.test(line)) inFence = false;
        return;
      }
      if (/^```[A-Za-z0-9_+-]*\s*$/.test(line)) { inFence = true; return; }
      var match = /^##\s+(.*)$/.exec(line);
      if (!match) return;
      if (PART_LABEL_RE.test(match[1].trim())) return;
      count++;
    });
    return count;
  }

  function paintChapterCount(number) {
    var item = document.querySelector(
      '.chapter-item[data-chapter="' + number + '"]');
    var tab = item && item.querySelector(".chapter-tab");
    var count = state.secCounts[number];
    if (!tab || count == null) return;
    var badge = tab.querySelector(".chapter-tab-count");
    if (!badge) {
      badge = el("span", "chapter-tab-count");
      tab.appendChild(badge);
    }
    badge.textContent = count;
    badge.title = count + " 节";
  }

  function loadSectionCounts() {
    state.chapters.forEach(function (chapter) {
      fetch("md/" + chapter.file, { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) {
            /* 只有 404 才当作「md 不存在」；其它错误（如临时断网）不锁死菜单 */
            if (response.status === 404) {
              chapter.available = false;
              markChapterMissing(chapter.number);
            }
            throw new Error("HTTP " + response.status);
          }
          chapter.available = true;
          return response.text();
        })
        .then(function (markdown) {
          state.secCounts[chapter.number] = countSections(markdown);
          indexSections(chapter.number, markdown);
          paintChapterCount(chapter.number);
          upgradeSecRefs();
        })
        .catch(function () { /* 取不到就保持隐藏徽标；缺失判定已在 404 分支完成 */ });
    });
  }

  function renderChapterNav() {
    var nav = $("chapterNav");
    nav.innerHTML = "";
    var activeItem = null;
    var lastPart = "";

    state.chapters.forEach(function (chapter) {
      if (chapter.part !== lastPart) {
        lastPart = chapter.part;
        if (PART_LABEL_RE.test(chapter.part)) {
          nav.appendChild(makePartLink(chapter));
        } else {
          nav.appendChild(el("div", "toc-part", esc(chapter.part)));
        }
      }
      var active = state.active && chapter.number === state.active.number;
      var item = el("div", "chapter-item");
      item.setAttribute("data-chapter", chapter.number);

      var title = chapter.title
        .replace(/^第\s*\d+\s*章\s*/, "")
        .replace(/^附录\s*[A-Z]\s*/, "");
      var number = chapter.number;

      var cachedCount = state.secCounts[chapter.number];
      var missing = chapter.available === false;
      var button = el("button", "chapter-tab",
        '<span class="chapter-tab-no">' + esc(number) + "</span>" +
        '<span class="chapter-tab-title">' + esc(title) + "</span>" +
        (cachedCount != null
          ? '<span class="chapter-tab-count" title="' + cachedCount + ' 节">' +
          cachedCount + "</span>"
          : ""));
      button.type = "button";
      button.setAttribute("data-chapter", chapter.number);
      button.setAttribute("aria-current", active ? "page" : "false");
      if (missing) {
        disableChapterTab(button);
      } else {
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-controls", "chapterSecs-" + chapter.number);
        button.addEventListener("click", function () {
          if (state.active && chapter.number === state.active.number) {
            setChapterOpen(item, !item.classList.contains("is-open"));
            return;
          }
          selectChapter(chapter, true);
        });
      }

      var secs = el("div", "chapter-secs");
      secs.id = "chapterSecs-" + chapter.number;
      var chips = el("nav", "chips");
      chips.setAttribute("aria-label", "小节");
      secs.appendChild(chips);
      item.appendChild(button);
      item.appendChild(secs);
      nav.appendChild(item);
      if (active) activeItem = item;
    });

    if (activeItem) {
      void activeItem.offsetHeight;
      setChapterOpen(activeItem, true);
    }
  }

  function selectChapter(chapter, scrollToTop, restore, autoFallback, sectionId) {
    if (!chapter) return;
    if (chapter.available === false) chapter = nextAvailableChapter(chapter);
    if (!chapter) return;
    if (state.active && state.active.number !== chapter.number) capturePosition();
    state.active = chapter;
    state.headings = [];
    $("chapterName").textContent = chapter.title;
    document.title = chapter.title + " · C++ Primer 交互读本";
    renderChapterNav();
    renderChips();
    try { localStorage.setItem(STORAGE.chapter, chapter.number); } catch (e) { }

    var wrap = $("sections");
    wrap.innerHTML = '<p class="out-placeholder">正在加载本地原文…</p>';
    var token = ++state.token;

    fetch("md/" + chapter.file, { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          var error = new Error("HTTP " + response.status);
          error.status = response.status;
          throw error;
        }
        chapter.available = true;
        return response.text();
      })
      .then(function (markdown) {
        if (token !== state.token) return;
        wrap.innerHTML = window.CPP_NOTES.render(markdown, "md/");
        wrap.classList.add("md-content");
        prepareContent(wrap);
        upgradeSecRefs();
        state.headings = collectHeadings(wrap);
        renderChips();
        setupSpy();
        updateReadingProgress();
        if (scrollToTop) {
          wrap.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
        } else if (restore) {
          restorePosition(restore);
        }
        /* 跨章「X.X 节」引用：等本章渲染完成后滚到目标小节 */
        if (sectionId) {
          var sectionNode = document.getElementById(sectionId);
          if (sectionNode) {
            sectionNode.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
          }
        }
        if (pendingPartScroll) {
          pendingPartScroll = false;
          if (!scrollToPartHeading() && scrollToTop) {
            wrap.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
          }
        }
      })
      .catch(function (error) {
        if (token !== state.token) return;
        var missing = !!(error && error.status === 404);
        if (missing) {
          chapter.available = false;
          markChapterMissing(chapter.number);
        }
        /* 启动时的默认章（或部分导言）恰好缺失：退到下一个存在的章 */
        var fallback = missing && autoFallback ? nextAvailableChapter(chapter) : null;
        if (fallback) {
          selectChapter(fallback, false, null, true);
          return;
        }
        wrap.innerHTML =
          '<div class="notes-empty"><h2>无法加载本章</h2><p>' +
          esc(error.message || error) + "</p></div>";
      });
  }

  /* ============================== 滚动高亮 ============================== */

  function setupSpy() {
    if (setupSpy.observer) setupSpy.observer.disconnect();
    if (setupSpy.onScroll) window.removeEventListener("scroll", setupSpy.onScroll);
    setupSpy.pinned = null;

    var map = {};
    document.querySelectorAll(".chip[data-outline-topic]").forEach(function (chip) {
      map[chip.getAttribute("data-outline-topic")] = chip;
    });
    var topics = Array.prototype.slice.call(
      document.querySelectorAll("#sections [data-outline-topic]"));

    function highlight(topic) {
      var chip = map[topic];
      if (!chip || chip.classList.contains("current")) return;
      document.querySelectorAll(".chip").forEach(function (item) {
        item.classList.remove("current");
      });
      chip.classList.add("current");
      var group = chip.closest ? chip.closest(".chip-group") : null;
      if (group) setGroupOpen(group, true);
      else closeGroupsExcept(null);
    }

    function pickCurrent() {
      /* 点击小节后短暂保持，随后交给滚动位置决定 */
      if (setupSpy.pinned) {
        if (setupSpy.pinnedUntil && Date.now() > setupSpy.pinnedUntil) {
          setupSpy.pinned = null;
        } else {
          return;
        }
      }
      var line = window.innerHeight * 0.25;
      var winner = null;
      for (var i = 0; i < topics.length; i++) {
        if (topics[i].getBoundingClientRect().top <= line) winner = topics[i];
      }
      if (winner) highlight(winner.getAttribute("data-outline-topic"));
    }

    var scheduled = false;
    function schedule() {
      /* 后台标签页里 rAF 不执行，直接同步更新，避免高亮卡住 */
      if (document.hidden) {
        pickCurrent();
        return;
      }
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(function () { scheduled = false; pickCurrent(); });
    }

    /* 滚动事件兜底：不依赖 IntersectionObserver 的回调时机 */
    setupSpy.onScroll = schedule;
    window.addEventListener("scroll", schedule, { passive: true });

    if ("IntersectionObserver" in window) {
      var observer = new IntersectionObserver(schedule, { rootMargin: "-15% 0px -70% 0px" });
      topics.forEach(function (topic) { observer.observe(topic); });
      setupSpy.observer = observer;
    }

    if (!setupSpy._unpinArmed) {
      setupSpy._unpinArmed = true;
      ["wheel", "touchmove", "keydown"].forEach(function (event) {
        window.addEventListener(event, function () { setupSpy.pinned = null; }, { passive: true });
      });
    }

    pickCurrent();
  }

  /* ============================== 阅读位置记忆 ============================== */

  function pageScrollY() {
    return window.pageYOffset ||
      (document.documentElement && document.documentElement.scrollTop) || 0;
  }

  function documentTop(node) {
    return node.getBoundingClientRect().top + pageScrollY();
  }

  function loadPositions() {
    var data = null;
    try { data = JSON.parse(localStorage.getItem(STORAGE.position) || "null"); } catch (e) { }
    positionMap = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    return positionMap;
  }

  function savePositions() {
    try { localStorage.setItem(STORAGE.position, JSON.stringify(positionMap)); } catch (e) { }
  }

  function capturePosition() {
    if (restoringPosition || !state.active) return;
    var top = pageScrollY();
    var anchor = null;
    var anchorTop = 0;
    state.headings.forEach(function (heading) {
      var node = document.getElementById(heading.id);
      if (!node) return;
      var nodeTop = documentTop(node);
      if (nodeTop <= top + 8) { anchor = heading.id; anchorTop = nodeTop; }
    });
    /* 同时保存绝对位置：章节内容变动导致锚点失效时仍可回退 */
    positionMap[state.active.number] = {
      anchor: anchor,
      offset: anchor ? Math.round(top - anchorTop) : 0,
      y: Math.round(top)
    };
    savePositions();
  }

  function schedulePositionSave() {
    if (restoringPosition || positionTimer) return;
    positionTimer = window.setTimeout(function () {
      positionTimer = 0;
      capturePosition();
    }, POSITION_SAVE_DELAY);
  }

  function restorePosition(saved) {
    if (!saved || (typeof saved.y !== "number" && !saved.anchor)) return;

    var stopped = false;
    restoringPosition = true;

    function target() {
      if (saved.anchor) {
        var node = document.getElementById(saved.anchor);
        if (node) return documentTop(node) + (saved.offset || 0);
      }
      return typeof saved.y === "number" ? saved.y : null;
    }
    function apply() {
      if (stopped) return;
      var value = target();
      if (value == null) return;
      value = Math.max(0, Math.round(value));
      if (Math.abs(pageScrollY() - value) > 1) window.scrollTo(0, value);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      restoringPosition = false;
      ["wheel", "touchmove", "keydown"].forEach(function (event) {
        window.removeEventListener(event, stop);
      });
      capturePosition();
    }

    /* 用户一旦主动滚动，就把当前位置交还给页面 */
    ["wheel", "touchmove", "keydown"].forEach(function (event) {
      window.addEventListener(event, stop, { passive: true });
    });

    apply();
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(apply);
    });

    /* 上方图片加载完成会移动锚点，加载一个就再对一次 */
    var wrap = $("sections");
    if (wrap) {
      Array.prototype.forEach.call(wrap.querySelectorAll("img"), function (img) {
        if (img.complete) return;
        img.addEventListener("load", apply);
        img.addEventListener("error", apply);
      });
    }

    window.setTimeout(function () {
      apply();
      stop();
    }, 800);
  }

  function setupPositionMemory() {
    window.addEventListener("scroll", schedulePositionSave, { passive: true });
    window.addEventListener("pagehide", capturePosition);
    window.addEventListener("beforeunload", capturePosition);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) capturePosition();
    });
  }

  /* ============================== 阅读工具 ============================== */

  function updateReadingProgress() {
    var sections = $("sections");
    var track = $("readingProgress");
    if (!sections || !track) return;

    var rect = sections.getBoundingClientRect();
    var height = rect.height;
    var value = 0;
    if (height > 0) {
      var maxScroll = height - (window.innerHeight || document.documentElement.clientHeight);
      if (maxScroll <= 0) {
        value = rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) ? 100 : 0;
      } else {
        var start = rect.top + window.pageYOffset;
        value = Math.round(((window.pageYOffset - start) / maxScroll) * 100);
      }
    }
    value = Math.max(0, Math.min(100, value));
    track.setAttribute("aria-valuenow", String(value));
    track.setAttribute("aria-valuetext", value + "%");
    $("readingProgressFill").style.width = value + "%";
    $("readingProgressValue").textContent = value + "%";
  }

  function scheduleReadingProgress() {
    if (document.hidden) {
      updateReadingProgress();
      return;
    }
    if (readingProgressFrame) return;
    readingProgressFrame = window.requestAnimationFrame(function () {
      readingProgressFrame = 0;
      updateReadingProgress();
    });
  }

  function applyReadingFontSize(size, persist) {
    var value = Math.max(READING_FONT_MIN, Math.min(READING_FONT_MAX, size));
    document.documentElement.style.setProperty("--reading-font-size", value + "px");
    $("fontSizeValue").textContent = value + "px";
    $("fontDecrease").disabled = value <= READING_FONT_MIN;
    $("fontIncrease").disabled = value >= READING_FONT_MAX;
    if (persist) {
      try { localStorage.setItem(STORAGE.fontSize, String(value)); } catch (e) { }
    }
  }

  function applyReadingTheme(theme, persist) {
    var isDark = theme === "dark";
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    $("themeToggle").setAttribute("aria-label",
      isDark ? "切换到浅色主题" : "切换到深色主题");
    $("themeIcon").textContent = isDark ? "☀" : "☾";
    if (persist) {
      try { localStorage.setItem(STORAGE.theme, isDark ? "dark" : "light"); } catch (e) { }
    }
  }

  function setupReadingControls() {
    var current = parseInt(
      window.getComputedStyle(document.documentElement)
        .getPropertyValue("--reading-font-size"), 10);
    if (isNaN(current) || current < READING_FONT_MIN || current > READING_FONT_MAX) {
      current = 16;
    }
    applyReadingFontSize(current, false);
    applyReadingTheme(
      document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
      false
    );

    $("fontDecrease").addEventListener("click", function () {
      applyReadingFontSize(current = current - READING_FONT_STEP, true);
    });
    $("fontIncrease").addEventListener("click", function () {
      applyReadingFontSize(current = current + READING_FONT_STEP, true);
    });
    $("themeToggle").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark"
        ? "light" : "dark";
      applyReadingTheme(next, true);
    });

    window.addEventListener("scroll", scheduleReadingProgress, { passive: true });
    window.addEventListener("resize", scheduleReadingProgress);
    updateReadingProgress();
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function setupFullscreenToggle() {
    var button = $("fullscreenToggle");
    var root = document.documentElement;
    var request = root.requestFullscreen || root.webkitRequestFullscreen;
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!button || !request || !exit) {
      if (button) button.hidden = true;
      return;
    }
    function sync() {
      var active = !!fullscreenElement();
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.setAttribute("aria-label", active ? "退出全屏" : "进入全屏");
      $("fullscreenIcon").textContent = active ? "⤡" : "⤢";
    }
    button.addEventListener("click", function () {
      var action = fullscreenElement()
        ? exit.call(document)
        : request.call(root);
      if (action && typeof action.catch === "function") {
        action.catch(function (error) {
          if (window.console && console.warn) console.warn("全屏切换失败:", error);
        });
      }
    });
    ["fullscreenchange", "webkitfullscreenchange"].forEach(function (event) {
      document.addEventListener(event, sync);
    });
    sync();
  }

  function setupTocToggle() {
    var narrow = window.matchMedia("(max-width: 1080px)");

    function apply(collapsed) {
      document.documentElement.classList.toggle("toc-collapsed", collapsed);
      var button = $("tocToggle");
      if (!button) return;
      button.setAttribute("aria-expanded", collapsed ? "false" : "true");
      button.setAttribute("aria-label", collapsed ? "展开目录" : "收起目录");
      button.setAttribute("title", collapsed ? "展开目录" : "收起目录");
      $("tocToggleIcon").textContent = collapsed ? "»" : "«";
    }

    function persist(collapsed) {
      try { localStorage.setItem(STORAGE.toc, collapsed ? "1" : "0"); } catch (e) { }
    }

    function setCollapsed(collapsed) {
      apply(collapsed);
      persist(collapsed);
    }

    apply(document.documentElement.classList.contains("toc-collapsed"));

    var toggle = $("tocToggle");
    if (toggle) toggle.addEventListener("click", function () {
      setCollapsed(!document.documentElement.classList.contains("toc-collapsed"));
    });
    var close = $("tocClose");
    if (close) close.addEventListener("click", function () { setCollapsed(true); });

    var toc = $("toc");
    if (toc) toc.addEventListener("click", function (event) {
      if (!narrow.matches) return;
      var hit = event.target.closest ? event.target.closest(".chip") : null;
      if (hit && !hit.classList.contains("has-subs")) setCollapsed(true);
    });
  }

  /* ============================== 编辑器 ============================== */

  function renderEditor() {
    var code = codeEl.value;
    hlEl.innerHTML = highlight(code) + "\n";
    var lines = code.split("\n").length;
    var gutter = "";
    for (var i = 1; i <= lines; i++) gutter += i + "\n";
    gutterEl.textContent = gutter;
    syncScroll();
  }


  function addStringUsingPrefix() {
    var code = codeEl.value;
    var prefix = "#include <string>\nusing std::string;\n\n";
    if (code.indexOf(prefix) >= 0) return;
    codeEl.value = prefix + code;
    renderEditor();
  }
  function addIostreamUsingPrefix() {
    var code = codeEl.value;
    var prefix = "#include <iostream>\nusing std::cin;\nusing std::cout;\nusing std::endl;\n\n";
    if (code.indexOf(prefix) >= 0) return;
    codeEl.value = prefix + code;
    renderEditor();
  }
  function addVectorUsingPrefix() {
    var code = codeEl.value;
    var prefix = "#include <vector>\nusing std::vector;\n\n";
    if (code.indexOf(prefix) >= 0) return;
    codeEl.value = prefix + code;
    renderEditor();
  }
  function syncScroll() {
    hlEl.scrollTop = codeEl.scrollTop;
    hlEl.scrollLeft = codeEl.scrollLeft;
    gutterEl.scrollTop = codeEl.scrollTop;
  }

  function setCode(src, stdin) {
    state.loadedCode = src;
    if (workbench.hidden) showWorkbench();
    codeEl.value = src;
    stdinEl.value = stdin || "";
    renderEditor();
    codeEl.focus();
    codeEl.setSelectionRange(0, 0);
    setMeta("已载入 · 按 Ctrl+⏎ 运行", "");
  }

  function handleTab(event) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    var start = codeEl.selectionStart;
    var end = codeEl.selectionEnd;
    var value = codeEl.value;
    if (event.shiftKey) {
      var lineStart = value.lastIndexOf("\n", start - 1) + 1;
      if (value.slice(lineStart, lineStart + 4) === "    ") {
        codeEl.value = value.slice(0, lineStart) + value.slice(lineStart + 4);
        codeEl.setSelectionRange(Math.max(lineStart, start - 4), Math.max(lineStart, end - 4));
      }
    } else {
      codeEl.value = value.slice(0, start) + "    " + value.slice(end);
      codeEl.setSelectionRange(start + 4, start + 4);
    }
    renderEditor();
  }

  function setWindowPosition(left, top) {
    var rect = workbench.getBoundingClientRect();
    var maxLeft = Math.max(12, window.innerWidth - rect.width - 12);
    var maxTop = Math.max(12, window.innerHeight - rect.height - 12);
    workbench.style.left = Math.max(12, Math.min(left, maxLeft)) + "px";
    workbench.style.top = Math.max(12, Math.min(top, maxTop)) + "px";
    workbench.style.right = "auto";
    workbench.style.bottom = "auto";
  }

  function showWorkbench() {
    $("workbenchLauncher").hidden = true;
    workbench.hidden = false;
  }

  function hideWorkbench() {
    workbench.hidden = true;
    $("workbenchLauncher").hidden = false;
  }

  function setupWorkbench() {
    workbench = $("workbench");
    workbenchDrag = $("workbenchDrag");
    workbenchResize = $("workbenchResize");

    $("workbenchClose").addEventListener("click", function () {
      hideWorkbench();
      $("workbenchLauncher").focus();
    });
    $("workbenchLauncher").addEventListener("click", function () {
      showWorkbench();
      workbenchDrag.focus();
    });

    workbenchDrag.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 || event.target.closest(".wb-actions, button, select")) return;
      event.preventDefault();
      var rect = workbench.getBoundingClientRect();
      var startX = event.clientX, startY = event.clientY;
      var left = rect.left, top = rect.top;
      setWindowPosition(left, top);
      workbenchDrag.setPointerCapture(event.pointerId);
      function move(moveEvent) {
        setWindowPosition(left + moveEvent.clientX - startX,
          top + moveEvent.clientY - startY);
      }
      function end() {
        workbenchDrag.removeEventListener("pointermove", move);
        workbenchDrag.removeEventListener("pointerup", end);
        workbenchDrag.removeEventListener("pointercancel", end);
      }
      workbenchDrag.addEventListener("pointermove", move);
      workbenchDrag.addEventListener("pointerup", end);
      workbenchDrag.addEventListener("pointercancel", end);
    });

    workbenchDrag.addEventListener("keydown", function (event) {
      var delta = event.shiftKey ? 40 : 16;
      var rect = workbench.getBoundingClientRect();
      if (event.key === "ArrowLeft") setWindowPosition(rect.left - delta, rect.top);
      else if (event.key === "ArrowRight") setWindowPosition(rect.left + delta, rect.top);
      else if (event.key === "ArrowUp") setWindowPosition(rect.left, rect.top - delta);
      else if (event.key === "ArrowDown") setWindowPosition(rect.left, rect.top + delta);
      else return;
      event.preventDefault();
    });

    workbenchResize.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      var rect = workbench.getBoundingClientRect();
      var startX = event.clientX, startY = event.clientY;
      var startWidth = rect.width, startHeight = rect.height;
      setWindowPosition(rect.left, rect.top);
      workbenchResize.setPointerCapture(event.pointerId);
      function resize(moveEvent) {
        var current = workbench.getBoundingClientRect();
        var minWidth = Math.min(320, window.innerWidth - 24);
        var minHeight = Math.min(280, window.innerHeight - 24);
        var width = Math.max(minWidth, Math.min(startWidth + moveEvent.clientX - startX,
          window.innerWidth - current.left - 12));
        var height = Math.max(minHeight, Math.min(startHeight + moveEvent.clientY - startY,
          window.innerHeight - current.top - 12));
        workbench.style.width = width + "px";
        workbench.style.height = height + "px";
      }
      function end() {
        workbenchResize.removeEventListener("pointermove", resize);
        workbenchResize.removeEventListener("pointerup", end);
        workbenchResize.removeEventListener("pointercancel", end);
      }
      workbenchResize.addEventListener("pointermove", resize);
      workbenchResize.addEventListener("pointerup", end);
      workbenchResize.addEventListener("pointercancel", end);
    });

    workbenchResize.addEventListener("keydown", function (event) {
      if (!/^Arrow(Left|Right|Up|Down)$/.test(event.key)) return;
      var rect = workbench.getBoundingClientRect();
      var delta = event.shiftKey ? 40 : 16;
      var minWidth = Math.min(320, window.innerWidth - 24);
      var minHeight = Math.min(280, window.innerHeight - 24);
      var width = rect.width + (event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0);
      var height = rect.height + (event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0);
      workbench.style.width = Math.max(minWidth, Math.min(width, window.innerWidth - rect.left - 12)) + "px";
      workbench.style.height = Math.max(minHeight, Math.min(height, window.innerHeight - rect.top - 12)) + "px";
      event.preventDefault();
    });

    window.addEventListener("resize", function () {
      if (workbench.hidden) return;
      var rect = workbench.getBoundingClientRect();
      var width = Math.min(rect.width, window.innerWidth - 24);
      var height = Math.min(rect.height, window.innerHeight - 24);
      workbench.style.width = width + "px";
      workbench.style.height = height + "px";
      setWindowPosition(rect.left, rect.top);
    });
  }

  /* ============================== 输出面板 ============================== */

  function setMeta(text, cls) {
    var meta = $("outMeta");
    meta.textContent = text;
    meta.className = "out-meta" + (cls ? " " + cls : "");
  }

  function outHTML(sections) {
    return sections.map(function (section) {
      if (!section.text) return "";
      return '<span class="out-sec"><span class="out-sec-label">' + esc(section.label) +
        '</span><span class="' + (section.cls || "") + '">' + esc(section.text) + "</span></span>";
    }).join("") || '<span class="out-dim">（无输出）</span>';
  }

  function compileErred(result) {
    return !!result && result.status !== "0" &&
      /error:/i.test(result.compiler_message || "");
  }

  /* ============================== 在线编译 ============================== */

  function buildStdOptions(entry) {
    var opts = [{ value: "", label: "编译器默认" }];
    (entry.switches || []).forEach(function (sw) {
      if (sw.type === "select" && /std/i.test(sw.name || "")) {
        (sw.options || []).forEach(function (option) {
          if (/^(gnu)?c\+\+(\d+|[0-9a-z]+)$/i.test(option.name)) {
            var label = option["display-name"] || option.name;
            label = label.replace(/C\+\+2a/gi, "C++20")
              .replace(/C\+\+2b/gi, "C++23")
              .replace(/C\+\+2c/gi, "C++26");
            opts.push({ value: option.name, label: label });
          }
        });
      }
    });
    var seen = {}, unique = [];
    opts.forEach(function (option) {
      if (!seen[option.label]) { seen[option.label] = 1; unique.push(option); }
    });
    return unique;
  }

  function loadCompilers() {
    var select = $("compilerSel");
    select.innerHTML = '<option value="">加载编译器…</option>';

    fetch(WANDBOX_LIST)
      .then(function (response) { return response.json(); })
      .then(function (list) {
        var compilers = list.filter(function (entry) { return entry.language === "C++"; });
        if (!compilers.length) throw new Error("empty C++ list");
        compilers.sort(function (a, b) {
          var ag = /^gcc-/.test(a.name) ? 0 : 1;
          var bg = /^gcc-/.test(b.name) ? 0 : 1;
          return ag - bg;
        });
        state.compilers = compilers.map(function (entry) {
          return { name: entry.name, version: entry.version, stdOpts: buildStdOptions(entry) };
        });
        select.innerHTML = "";
        state.compilers.forEach(function (compiler) {
          var option = document.createElement("option");
          option.value = compiler.name;
          option.textContent = compiler.name + "  (" + compiler.version + ")";
          if (compiler.name === FALLBACK_COMPILER) option.selected = true;
          select.appendChild(option);
        });
        if (!select.value) select.selectedIndex = 0;
        refreshStdSel();
        setMeta("编译器就绪", "ok");
      })
      .catch(function () {
        state.compilers = [{
          name: FALLBACK_COMPILER,
          version: "13.2.0",
          stdOpts: [
            { value: "", label: "编译器默认" },
            { value: "c++17", label: "C++17" },
            { value: "c++20", label: "C++20" },
            { value: "c++23", label: "C++23" }
          ]
        }];
        select.innerHTML = "";
        var option = document.createElement("option");
        option.value = FALLBACK_COMPILER;
        option.textContent = FALLBACK_COMPILER + "（占位配置）";
        select.appendChild(option);
        refreshStdSel();
        setMeta("无法获取编译器列表，已用占位配置", "bad");
      });
  }

  function currentCompiler() {
    var name = $("compilerSel").value || FALLBACK_COMPILER;
    for (var i = 0; i < state.compilers.length; i++) {
      if (state.compilers[i].name === name) return state.compilers[i];
    }
    return { name: name, version: "", stdOpts: [{ value: "", label: "编译器默认" }] };
  }

  function refreshStdSel() {
    var select = $("stdSel");
    var compiler = currentCompiler();
    select.innerHTML = "";
    compiler.stdOpts.forEach(function (option) {
      var node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    });
    select.value = DEFAULT_STD;
    if (select.selectedIndex < 0) {
      var preferred = -1;
      for (var i = 0; i < select.options.length; i++) {
        if (/C\+\+20/i.test(select.options[i].textContent)) { preferred = i; break; }
      }
      select.selectedIndex = preferred >= 0 ? preferred : 0;
    }
  }

  function compileRequest(code, stdin) {
    var body = {
      compiler: $("compilerSel").value || FALLBACK_COMPILER,
      code: code,
      stdin: stdin || ""
    };
    var std = $("stdSel").value;
    if (std) body.options = std;
    return fetch(WANDBOX_RUN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
  }

  function headerResolutionError(message) {
    var error = new Error(message);
    error.name = "HeaderResolutionError";
    return error;
  }

  function resolveLocalIncludes(code) {
    var headers = Object.create(null);
    var includePattern = /^[ \t]*#[ \t]*include[ \t]*"([^"\r\n]+)"[ \t]*(?:\/\/.*)?$/;

    function readHeader(name) {
      if (!name || name === "." || name === ".." ||
        name.indexOf("/") !== -1 || name.indexOf("\\") !== -1) {
        return Promise.reject(headerResolutionError(
          '不支持的本地头文件路径: "' + name + '"'));
      }
      if (!Object.prototype.hasOwnProperty.call(headers, name)) {
        headers[name] = fetch(LOCAL_HEADER_DIR + encodeURIComponent(name), {
          cache: "no-store"
        }).then(function (response) {
          if (!response.ok) {
            throw headerResolutionError(
              '找不到本地头文件 "' + name + '"（HTTP ' + response.status + "）");
          }
          return response.text();
        });
      }
      return headers[name];
    }

    function expand(source, ancestors) {
      return String(source).split(/\r?\n/).reduce(function (pending, line) {
        return pending.then(function (expanded) {
          var match = includePattern.exec(line);
          if (!match) {
            expanded.push(line);
            return expanded;
          }
          var name = match[1];
          if (ancestors.indexOf(name) !== -1) {
            throw headerResolutionError(
              '本地头文件存在循环引用: ' + ancestors.concat(name).join(" → "));
          }
          return readHeader(name).then(function (header) {
            return expand(header, ancestors.concat(name));
          }).then(function (header) {
            expanded.push(header);
            return expanded;
          });
        });
      }, Promise.resolve([])).then(function (lines) {
        return lines.join("\n");
      });
    }

    return expand(code, []);
  }

  function run() {
    if (state.running) return null;
    state.running = true;
    var button = $("runBtn");
    button.disabled = true;
    $("out").innerHTML = '<span class="out-placeholder">正在编译并运行…</span>';
    setMeta("编译运行中…", "");

    return resolveLocalIncludes(codeEl.value)
      .then(function (code) { return compileRequest(code, stdinEl.value); })
      .then(function (result) { finishRun(result, null); return result; })
      .catch(function (error) { finishRun(null, error); return null; })
      .then(function (result) {
        state.running = false;
        button.disabled = false;
        return result;
      });
  }

  function finishRun(result, error) {
    if (error) {
      $("out").innerHTML = outHTML([
        {
          label: error.name === "HeaderResolutionError" ? "头文件错误" : "网络 / 服务错误",
          text: String(error.message || error),
          cls: "out-err"
        }
      ]);
      setMeta("失败", "bad");
      return;
    }
    var failed = compileErred(result);
    var sections = [];
    if (result.compiler_message) {
      sections.push({
        label: failed ? "编译错误" : "编译器消息（警告）",
        text: result.compiler_message,
        cls: failed ? "out-err" : "out-warn"
      });
    }
    var label = "程序输出";
    if (result.signal) label += "（被信号 " + result.signal + " 终止）";
    else if (result.status !== "0" && !failed) label += "（退出码 " + result.status + "）";
    sections.push({ label: label, text: result.program_message || "", cls: "" });
    $("out").innerHTML = outHTML(sections);

    if (failed) { setMeta("编译失败", "bad"); return; }
    if (result.signal) { setMeta("运行异常 · signal " + result.signal, "bad"); return; }
    setMeta("运行成功 · exit " + result.status, "ok");
  }

  /* ============================== 初始化 ============================== */

  function showNotesError(error) {
    state.chapters = [];
    state.active = null;
    state.headings = [];
    $("chapterNav").innerHTML = "";
    $("chapterName").textContent = "本地原文";
    document.title = "本地原文 · C++ Primer 交互读本";

    var wrap = $("sections");
    wrap.className = "md-content";
    wrap.innerHTML =
      '<div class="notes-empty">' +
      "<h2>还没有本地原文</h2>" +
      "<p>请把本机 PDF 转换得到的 Markdown 放入 <code>md/</code>，" +
      "并确认其中包含 <code>manifest.json</code>。</p>" +
      (error ? "<p class=\"notes-error-detail\">" + esc(error.message || error) + "</p>" : "") +
      "</div>";
    updateReadingProgress();
    if (window.console && console.warn) console.warn("md:", error);
  }

  function loadManifest() {
    fetch("md/manifest.json", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("md/manifest.json 不存在（HTTP " + response.status + "）");
        return response.json();
      })
      .then(function (manifest) {
        state.chapters = normChapters(manifest);
        if (!state.chapters.length) throw new Error("md/manifest.json 没有章节");
        loadSectionCounts();
        var saved = null;
        try { saved = localStorage.getItem(STORAGE.chapter); } catch (e) { }
        var chapter = null;
        state.chapters.forEach(function (item) {
          if (item.number === saved) chapter = item;
        });
        loadPositions();
        var target = chapter || state.chapters[0];
        selectChapter(target, false, positionMap[target.number] || null, true);
      })
      .catch(showNotesError);
  }

  function init() {
    codeEl = $("code");
    hlEl = $("hl");
    gutterEl = $("gutter");
    stdinEl = $("stdin");
    setupWorkbench();
    setupTocToggle();
    setupReadingControls();
    setupPositionMemory();
    setupFullscreenToggle();

    codeEl.addEventListener("input", renderEditor);
    codeEl.addEventListener("scroll", syncScroll);
    codeEl.addEventListener("keydown", function (event) {
      handleTab(event);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        run();
      }
    });

    $("runBtn").addEventListener("click", function () { run(); });
    $("resetBtn").addEventListener("click", function () {
      if (state.loadedCode != null) {
        setCode(state.loadedCode, stdinEl.value);
        setMeta("已重置为载入时的代码", "");
      }
    });

    $("addStringBtn").addEventListener("click", addStringUsingPrefix);
    $("addIostreamBtn").addEventListener("click", addIostreamUsingPrefix);
    $("addVectorBtn").addEventListener("click", addVectorUsingPrefix);

    $("compilerSel").addEventListener("change", refreshStdSel);

    setCode(STARTER_CODE, "");
    hideWorkbench();
    setMeta("就绪 · 已载入起始代码", "");

    loadCompilers();
    loadManifest();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

})();
