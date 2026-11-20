(function (global) {
  "use strict";
  const DIG = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const SPECIAL = { "120": "一二零", "110": "一一零", "119": "一一九" };

  function section(n) {
    const units = ["", "十", "百", "千"];
    let out = "", zero = false, started = false;
    for (let i = 3; i >= 0; i--) {
      const base = Math.pow(10, i);
      const d = Math.floor(n / base) % 10;
      if (d === 0) {
        if (started) zero = true;
        continue;
      }
      if (zero) { out += "零"; zero = false; }
      if (i === 1 && d === 1 && out === "") { out += "十"; started = true; continue; }
      out += DIG[d] + units[i];
      started = true;
    }
    return out || "零";
  }

  function numberToCantonese(value) {
    let n = Number(value);
    if (!isFinite(n)) return String(value);
    n = Math.floor(Math.abs(n));
    if (n === 0) return "零";
    if (n > 9999) return String(n).split("").map(d => DIG[Number(d)]).join("");
    return section(n);
  }

  function decimalToCantonese(value) {
    const s = String(value);
    const parts = s.split(".");
    if (parts.length === 1) return numberToCantonese(parts[0]);
    return numberToCantonese(parts[0]) + "点" + parts[1].split("").map(d => DIG[Number(d)]).join("");
  }

  function dateToCantonese(y, m, d) {
    const year = String(y).split("").map(x => DIG[Number(x)]).join("");
    return year + "年" + numberToCantonese(m) + "月" + numberToCantonese(d) + "日";
  }

  function normalizeSpeechText(text) {
    let t = String(text || "");
    t = t.replace(/mmHg/gi, "毫米汞柱");
    t = t.replace(/mmol\s*\/\s*L/gi, "毫摩尔每升");
    t = t.replace(/℃/g, "度");
    t = t.replace(/(\d+(?:\.\d+)?)\s*mg\b/gi, (_, n) => decimalToCantonese(n) + "毫克");
    t = t.replace(/(\d{4})-(\d{1,2})-(\d{1,2})/g, (_, y, m, d) => dateToCantonese(y, m, d));
    t = t.replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/g, (_, y, m, d) => dateToCantonese(y, m, d));
    t = t.replace(/(\d{2,3})\s*\/\s*(\d{2,3})/g, (_, a, b) => numberToCantonese(a) + "，" + numberToCantonese(b));
    t = t.replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n) => "百分之" + decimalToCantonese(n));
    t = t.replace(/(\d+\.\d+)/g, (_, n) => decimalToCantonese(n));
    t = t.replace(/\b(120|110|119)\b/g, (m) => SPECIAL[m] || m);
    return t;
  }

  global.CareSpeech = { numberToCantonese, decimalToCantonese, normalizeSpeechText };
})(typeof window !== "undefined" ? window : globalThis);
