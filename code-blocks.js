/*
 * code-blocks.js — 正文代码块的「可在线编译」判定（C++）
 *
 * 供 reader.js（浏览器）与 tools/test_code_blocks.js（Node）共用，保证页面按钮与
 * 回归测试使用同一份规则。只做纯文本判定，不依赖 DOM。
 *
 * 判定「带 main 的完整程序」：
 *   1. 出现 main 定义：行首的 main(，允许 int / void / signed / auto 返回类型
 *   2. 去掉注释、字符/字符串/原始字符串字面量后，花括号配平
 *   3. 排除书中省略写法 `main() { ... }`
 *   4. 排除「代码 + 中文旁注」排版块（注释与字面量之外还有非 ASCII 字符）
 *
 * 浏览器：window.CPP_CODE_BLOCKS；Node：require("./code-blocks.js")
 */
/* UMD 包装：浏览器挂到 window.CPP_CODE_BLOCKS，Node 下走 module.exports，
   使页面与测试共用同一份判定逻辑 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CPP_CODE_BLOCKS = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* main 定义：行首的 main(，允许 int / void / signed / auto 返回类型 */
  var MAIN_DEF_RE = /(^|\n)[ \t]*(?:int|void|signed|auto)[ \t]+main[ \t]*\(/;
  /* 省略写法：main() { ... } */
  var ELLIPSIS_BODY_RE = /\{\s*\.\.\.\s*\}/;
  /* 注释与字面量以外的非 ASCII 字符：正文「代码 + 中文旁注」排版块，不是可编译代码 */
  var NON_ASCII_RE = /[^\x00-\x7F]/;

  /* 去掉注释：注释里的花括号、省略号不参与判定 */
  function stripComments(src) {
    return String(src)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
  }

  /* 去掉字符串、字符与原始字符串字面量：字面量里的 { } " ' 不参与判定 */
  function stripLiterals(src) {
    return src
      .replace(/R"([^()\\\s]{0,16})\([\s\S]*?\)\1"/g, '""')
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
  }

  /* 花括号净深度归零且中途不为负（中途为负说明是从函数体中截取的片段） */
  function bracesBalanced(src) {
    var depth = 0;
    for (var i = 0; i < src.length; i++) {
      if (src.charAt(i) === "{") {
        depth++;
      } else if (src.charAt(i) === "}") {
        depth--;
        if (depth < 0) return false;
      }
    }
    return depth === 0;
  }

  /* code: 代码纯文本（HTML 实体需先反转义，浏览器中 pre.textContent 已是纯文本） */
  /* 去掉注释与字面量后依次做四项判定，全部通过才算「可在线编译」 */
  function isRunnableProgram(code) {
    if (typeof code !== "string" || !MAIN_DEF_RE.test(code)) return false;
    var body = stripLiterals(stripComments(code));
    if (ELLIPSIS_BODY_RE.test(body)) return false;
    if (NON_ASCII_RE.test(body)) return false;
    return bracesBalanced(body);
  }

  return { isRunnableProgram: isRunnableProgram };
});
