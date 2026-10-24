/*
 * highlight.js — C++ 源码语法高亮（纯文本 → 带 tok-* 类的 HTML）
 *
 * 供 reader.js（浏览器）与 tools/test_highlight.js（Node）共用，保证编辑器高亮层、
 * 正文代码框与回归测试使用同一份着色规则。不依赖 DOM。
 *
 * 单趟正则按「注释 → 原始字符串 → 字符串/字符 → 预处理行 → 数字 → 标识符」
 * 的优先级交替匹配，每段先转义再包 span，因此注释与字面量内部的词不会被后续
 * 分组重复着色：
 *   · 注释 tok-cm：块注释可跨行，行注释到行尾为止
 *   · 原始字符串 tok-str：R"delim( ... )delim"，允许跨行
 *   · 字符串 tok-str：普通字符串在本行内闭合；C++23 之前字符串字面量不跨行
 *   · 字符 tok-str：必须同行闭合，避免正文中的英文撇号被当成字面量
 *   · 预处理行 tok-pp（#include 等，不跨行）
 *   · 数字 tok-num（含十六进制、二进制、数字分隔符与后缀）
 *   · 关键字 tok-kw / 标准库类型 tok-ty / 调用 tok-fn
 *
 * 返回值不带尾换行：正文代码框回填后与原文行数一致；编辑器高亮层需与行号列
 * 对齐，由 reader.js 的 renderEditor() 自行补一个换行。
 *
 * 浏览器：window.CPP_HIGHLIGHT.highlight(code)；Node：require("./highlight.js").highlight
 */
/* UMD 包装：浏览器挂到 window.CPP_HIGHLIGHT，Node 下走 module.exports，
   使页面与测试共用同一份着色逻辑 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CPP_HIGHLIGHT = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* HTML 转义：每段文本先转义再包 span，防止源码里的 < & 被当成标签解析 */
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* C++20 关键字与常用替代记号 */
  var KEYWORDS = (
    "alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t " +
    "char16_t char32_t class compl concept const consteval constexpr constinit const_cast " +
    "continue co_await co_return co_yield decltype default delete do double dynamic_cast " +
    "else enum explicit export extern false float for friend goto if inline int long mutable " +
    "namespace new noexcept not not_eq nullptr operator or or_eq private protected public " +
    "register reinterpret_cast requires return short signed sizeof static static_assert " +
    "static_cast struct switch template this thread_local throw true try typedef typeid " +
    "typename union unsigned using virtual void volatile wchar_t while xor xor_eq"
  ).split(/\s+/);

  /* 标准库常用名字（单独着色，便于区分类型与普通标识符） */
  var TYPES = (
    "std string wstring u8string u16string u32string string_view vector array deque list " +
    "forward_list map multimap set multiset unordered_map unordered_multimap unordered_set " +
    "unordered_multiset stack queue priority_queue pair tuple unique_ptr shared_ptr weak_ptr " +
    "function ostream istream iostream ifstream ofstream fstream stringstream istringstream " +
    "ostringstream optional variant any bitset regex thread mutex ratio chrono size_t ssize_t " +
    "ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t intptr_t " +
    "uintptr_t nullptr_t byte monostate exception runtime_error logic_error invalid_argument " +
    "out_of_range length_error domain_error range_error overflow_error underflow_error"
  ).split(/\s+/);

  /* 词表转哈希集合，便于逐词 O(1) 查询 */
  var KW_SET = {}, TY_SET = {};
  KEYWORDS.forEach(function (k) { KW_SET[k] = 1; });
  TYPES.forEach(function (t) { TY_SET[t] = 1; });

  /* 分组依次为: 注释 | 原始字符串(含分隔符) | 字符串 | 字符 | 预处理行 | 数字 | 标识符。
     m 标志让 ^ 能匹配每一行的行首（预处理指令）。
     原始字符串用 \3 回引分隔符，要求首尾一致且最多 16 个字符。 */
  var TOKEN_RE = new RegExp(
    "(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)" +                              // 1 注释
    "|(R\"([^()\\\\\\s]{0,16})\\([\\s\\S]*?\\)\\3\")" +                     // 2 原始字符串
    "|(\"(?:\\\\.|[^\"\\\\\\n])*\"?)" +                                     // 4 字符串
    "|('(?:\\\\.|[^'\\\\\\n])*')" +                                         // 5 字符
    "|(^[ \\t]*#[ \\t]*[A-Za-z_]+)" +                                       // 6 预处理行
    "|(\\b(?:0[xX][0-9a-fA-F']+|0[bB][01']+|\\d[\\d']*(?:\\.\\d*)?(?:[eE][+-]?\\d+)?)[uUlLfFzZ]*\\b)" + // 7 数字
    "|([A-Za-z_]\\w*)",                                                     // 8 标识符
    "gm");

  /*
   * 把 C++ 源码转换为带 tok-* 类的高亮 HTML（每段先 esc 再包 span，避免二次解析）。
   * 返回值末尾不补换行，正文代码框与编辑器各自决定如何对齐行数。
   */
  function highlight(code) {
    var out = "", last = 0, m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(code)) !== null) {
      out += esc(code.slice(last, m.index));
      if (m[1] != null)      out += '<span class="tok-cm">'  + esc(m[1]) + "</span>";
      else if (m[2] != null) out += '<span class="tok-str">' + esc(m[2]) + "</span>";
      else if (m[4] != null) out += '<span class="tok-str">' + esc(m[4]) + "</span>";
      else if (m[5] != null) out += '<span class="tok-str">' + esc(m[5]) + "</span>";
      else if (m[6] != null) out += '<span class="tok-pp">'  + esc(m[6]) + "</span>";
      else if (m[7] != null) out += '<span class="tok-num">' + esc(m[7]) + "</span>";
      else {
        var w = m[8];
        if (KW_SET[w])      out += '<span class="tok-kw">' + esc(w) + "</span>";
        else if (TY_SET[w]) out += '<span class="tok-ty">' + esc(w) + "</span>";
        else if (isCall(code, m.index + w.length)) {
          out += '<span class="tok-fn">' + esc(w) + "</span>";
        } else {
          out += esc(w);
        }
      }
      last = m.index + m[0].length;
    }
    out += esc(code.slice(last));
    /* 空的源码也要返回空串（调用方负责补换行） */
    return out;
  }

  /* 标识符后（跳过空格/制表符）紧跟 "(" 时视为函数调用/定义 */
  function isCall(code, from) {
    for (var i = from; i < code.length; i++) {
      var c = code.charAt(i);
      if (c === " " || c === "\t") continue;
      return c === "(";
    }
    return false;
  }

  return { highlight: highlight, keywords: KEYWORDS, types: TYPES };
});
