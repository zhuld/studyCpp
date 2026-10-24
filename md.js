/*
 * md.js — 本地原文 Markdown 渲染器
 *
 * 仅服务于 `md/` 中、已被 .gitignore 排除的本地个人笔记。
 * 站点在检测不到 md/manifest.json 时不会显示「原文」入口，
 * 因此发布到 GitHub Pages 的版本不会包含或暴露教材内容。
 *
 * 实现一个够用的 Markdown 子集（标题、段落、列表、引用、围栏代码、行内代码、
 * 粗体/斜体、链接、图片、分隔线），先转义 HTML 再生成标签，避免内容注入。
 *
 * 浏览器：window.CPP_NOTES.render(markdown, imageBase)；
 * Node：require("./md.js").render(markdown, imageBase)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CPP_NOTES = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function safeUrl(url, imageBase) {
    var value = String(url || "").trim();
    if (/^(?:https?:|data:image\/)/i.test(value)) return value;
    if (/^(?:javascript|vbscript):/i.test(value)) return "#";
    if (value.charAt(0) === "#" || value.charAt(0) === "/") return value;
    return (imageBase || "") + value.replace(/^\.\//, "");
  }

  function isCjk(char) {
    return /[\u3000-\u9fff\uff00-\uffef]/.test(char || "");
  }

  function joinProse(lines) {
    var out = "";
    lines.forEach(function (line) {
      var text = line.trim();
      if (!text) return;
      if (!out) {
        out = text;
        return;
      }
      out += (isCjk(out.slice(-1)) || isCjk(text.charAt(0))) ? text : " " + text;
    });
    return out;
  }

  /* ---------- 小节锚点与「X.X 节」引用 ---------- */

  var SECTION_ID_PREFIX = "sec-";

  /* 标题开头的编号，如「2.1.1 算术类型」 -> 2.1.1 */
  function sectionNumberOf(text) {
    var match = /^(\d+(?:\.\d+)*)(?=\s|$)/.exec(String(text == null ? "" : text).trim());
    return match ? match[1] : "";
  }

  function collectSections(lines) {
    var sections = {};
    var inFence = false;
    lines.forEach(function (line) {
      if (inFence) {
        if (/^```\s*$/.test(line)) inFence = false;
        return;
      }
      if (/^```[A-Za-z0-9_+-]*\s*$/.test(line)) {
        inFence = true;
        return;
      }
      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (!heading) return;
      var number = sectionNumberOf(heading[2]);
      if (number) sections[number] = true;
    });
    return sections;
  }

  /* 本章存在的目标直接生成本页锚点；其余交给阅读器按全书索引补全 */
  function sectionReference(number, content, sections) {
    if (sections && sections[number]) {
      return '<a class="md-sec-link" href="#' + SECTION_ID_PREFIX + number + '">' +
        content + "</a>";
    }
    return '<span class="md-sec-ref" data-sec-ref="' + number + '">' + content + "</span>";
  }

  function linkSectionRefs(source, codes, sections) {
    /* 形如 `2.5.2`节：编号在行内代码里，此时仍是占位符 */
    source = source.replace(/\u0000(\d+)\u0000(\s*)节/g, function (all, index, space) {
      var code = codes[Number(index)];
      if (!/^\d+(?:\.\d+)+$/.test(code)) return all;
      return sectionReference(code, "<code>" + code + "</code>", sections) + space + "节";
    });
    /* 形如 2.5.2 节：编号直接写在正文里 */
    return source.replace(/(^|[^\d.])(\d+(?:\.\d+)+)(\s*)节/g,
      function (all, lead, number, space) {
        return lead + sectionReference(number, number, sections) + space + "节";
      });
  }

  function inline(text, imageBase, sections) {
    var source = escapeHtml(text);
    var codes = [];

    /* 行内代码先摘出，避免其中的 * 或 [] 被后续规则误处理 */
    source = source.replace(/`([^`]+)`/g, function (_, code) {
      codes.push(code);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });

    source = linkSectionRefs(source, codes, sections);

    source = source.replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      function (_, alt, url, title) {
        return '<img src="' + escapeHtml(safeUrl(url.replace(/&amp;/g, "&"), imageBase)) +
          '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : "") + ">";
      }
    );

    source = source.replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
      function (_, label, url, title) {
        var href = safeUrl(url.replace(/&amp;/g, "&"), imageBase);
        var external = /^https?:/i.test(href);
        return '<a href="' + escapeHtml(href) + '"' +
          (title ? ' title="' + title + '"' : "") +
          (external ? ' target="_blank" rel="noopener"' : "") + ">" + label + "</a>";
      }
    );

    source = source
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    return source.replace(/\u0000(\d+)\u0000/g, function (_, index) {
      return "<code>" + codes[Number(index)] + "</code>";
    });
  }

  function isSpecialLine(line) {
    return /^(?:#{1,6}\s|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+|---+\s*$|<!--|!\[|\s*\|)/.test(line);
  }

  /* ---------- 管道表格 ---------- */

  function splitTableRow(line) {
    var body = String(line).trim();
    if (body.charAt(0) === "|") body = body.slice(1);
    if (body.slice(-1) === "|" && body.slice(-2) !== "\\|") body = body.slice(0, -1);
    var cells = [];
    var current = "";
    for (var i = 0; i < body.length; i++) {
      var ch = body.charAt(i);
      if (ch === "\\" && body.charAt(i + 1) === "|") {
        current += "|";
        i++;
        continue;
      }
      if (ch === "|") {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    cells.push(current.trim());
    return cells;
  }

  function isTableStart(lines, index) {
    if (!/^\s*\|/.test(lines[index] || "")) return false;
    var next = lines[index + 1] || "";
    return /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(next) && /^\s*\|/.test(next);
  }

  function renderTable(rows, imageBase, sections) {
    var header = rows[0];
    var body = rows.slice(2);
    var html = ['<div class="table-scroll"><table><thead><tr>'];
    header.forEach(function (cell) {
      html.push("<th>" + inline(cell, imageBase, sections) + "</th>");
    });
    html.push("</tr></thead><tbody>");
    body.forEach(function (cells) {
      html.push("<tr>");
      for (var i = 0; i < header.length; i++) {
        html.push("<td>" + inline(cells[i] == null ? "" : cells[i], imageBase, sections) + "</td>");
      }
      html.push("</tr>");
    });
    html.push("</tbody></table></div>");
    return html.join("");
  }

  function render(markdown, imageBase) {
    var lines = String(markdown == null ? "" : markdown)
      .replace(/\r\n?/g, "\n")
      .split("\n");
    var out = [];
    var index = 0;
    var sections = collectSections(lines);

    while (index < lines.length) {
      var line = lines[index];

      if (!line.trim()) {
        index++;
        continue;
      }

      /* 兼容旧转换结果：忽略残留的 HTML 注释（如页码锚点） */
      if (/^<!--/.test(line)) {
        index++;
        continue;
      }

      var fence = /^```([A-Za-z0-9_+-]*)\s*$/.exec(line);
      if (fence) {
        index++;
        var code = [];
        while (index < lines.length && !/^```\s*$/.test(lines[index])) {
          code.push(lines[index]);
          index++;
        }
        if (index < lines.length) index++;
        out.push(
          '<pre class="src-code"' +
          (fence[1] ? ' data-lang="' + escapeHtml(fence[1]) + '"' : "") +
          "><code>" + escapeHtml(code.join("\n")) + "</code></pre>"
        );
        continue;
      }

      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        var level = heading[1].length;
        var sectionNumber = sectionNumberOf(heading[2]);
        out.push("<h" + level +
          (sectionNumber ? ' id="' + SECTION_ID_PREFIX + sectionNumber + '"' : "") +
          ">" + inline(heading[2], imageBase, sections) + "</h" + level + ">");
        index++;
        continue;
      }

      if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
        out.push("<hr>");
        index++;
        continue;
      }

      if (/^>\s?/.test(line)) {
        var quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^>\s?/, ""));
          index++;
        }
        out.push(
          "<blockquote>" +
          quote.map(function (part) { return "<p>" + inline(part, imageBase, sections) + "</p>"; }).join("") +
          "</blockquote>"
        );
        continue;
      }

      if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) {
        out.push('<figure class="src-figure">' + inline(line, imageBase, sections) + "</figure>");
        index++;
        continue;
      }

      if (isTableStart(lines, index)) {
        var rows = [];
        while (index < lines.length && /^\s*\|/.test(lines[index])) {
          rows.push(splitTableRow(lines[index]));
          index++;
        }
        if (rows.length > 2) out.push(renderTable(rows, imageBase, sections));
        continue;
      }

      if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        var ordered = /^\s*\d+\.\s+/.test(line);
        var items = [];
        while (index < lines.length) {
          var bullet = /^\s*[-*]\s+(.*)$/.exec(lines[index]);
          var number = /^\s*\d+\.\s+(.*)$/.exec(lines[index]);
          if (ordered && number) {
            items.push(number[1]);
          } else if (!ordered && bullet) {
            items.push(bullet[1]);
          } else {
            break;
          }
          index++;
        }
        out.push(
          (ordered ? "<ol>" : "<ul>") +
          items.map(function (item) { return "<li>" + inline(item, imageBase, sections) + "</li>"; }).join("") +
          (ordered ? "</ol>" : "</ul>")
        );
        continue;
      }

      var paragraph = [line];
      index++;
      while (index < lines.length && lines[index].trim() && !isSpecialLine(lines[index])) {
        paragraph.push(lines[index]);
        index++;
      }
      out.push("<p>" + inline(joinProse(paragraph), imageBase, sections) + "</p>");
    }

    return out.join("\n");
  }

  return { render: render, escapeHtml: escapeHtml, inline: inline };
});
