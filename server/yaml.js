'use strict';
/*
 * Kleiner YAML-Leser für genau die Teilmenge, die das Ludusavi-Verzeichnis benutzt (von serde_yaml geschrieben):
 * Block-Abbildungen und -Listen mit Einrückung, „- key: wert“ in Listen, Zeichenketten in "…" und '…', einfache Werte
 * (Zahl, true/false, null), leere Flusswerte {} und [], einfache Fluss-Listen [a, b] und Blocktext (| und >).
 * Keine Anker, keine Tags, keine mehrzeiligen Flusswerte – die kommen dort nicht vor. Lieber ein eigener kleiner Leser
 * als eine gebündelte Bibliothek: das Verzeichnis ist 17 MB groß und wird zeilenweise gefiltert (ludusavi.js).
 */

function unquote(s) {
  const t = s.trim();
  if (t.startsWith('"')) {
    let out = '';
    for (let i = 1; i < t.length; i++) {
      const c = t[i];
      if (c === '\\') {
        const e = t[++i];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'u') { out += String.fromCharCode(parseInt(t.slice(i + 1, i + 5), 16)); i += 4; } else if (e === 'x') { out += String.fromCharCode(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else out += e;
        continue;
      }
      if (c === '"') break;
      out += c;
    }
    return out;
  }
  if (t.startsWith("'")) return t.slice(1, t.lastIndexOf("'") > 0 ? t.lastIndexOf("'") : undefined).replace(/''/g, "'");
  return t;
}

function scalar(raw) {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === '{}') return {};
  if (t === '[]') return [];
  if (t.startsWith('"') || t.startsWith("'")) return unquote(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== null);
  return t.replace(/\s+#.*$/, '');
}

/** „key: rest“ trennen – der Schlüssel kann in Anführungszeichen stehen und selbst „:“ enthalten. */
function splitKey(s) {
  let i = 0;
  if (s[0] === '"') {
    i = 1;
    while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
    i++;
  } else if (s[0] === "'") {
    i = 1;
    while (i < s.length) { if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue; } if (s[i] === "'") break; i++; }
    i++;
  }
  for (; i < s.length; i++) {
    if (s[i] === ':' && (i + 1 === s.length || s[i + 1] === ' ')) return { key: unquote(s.slice(0, i)), rest: s.slice(i + 1) };
  }
  return null;
}

/** YAML-Text → Wert. Zeilen mit Fehlern werden übersprungen statt abzubrechen. */
function parse(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(raw) || raw === '---' || raw === '...') { lines.push(null); continue; }
    lines.push(raw);
  }
  let i = 0;
  const indentOf = (l) => l.length - l.trimStart().length;
  const skip = () => { while (i < lines.length && lines[i] === null) i++; };

  function block(ind) {
    skip();
    if (i >= lines.length) return null;
    const first = lines[i].trimStart();
    return first.startsWith('- ') || first === '-' ? seq(indentOf(lines[i])) : map(indentOf(lines[i]));
  }

  function blockScalar(parentInd, style) {
    const parts = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l === null) { parts.push(''); i++; continue; }
      if (indentOf(l) <= parentInd) break;
      parts.push(l.trim());
      i++;
    }
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    return style.startsWith('>') ? parts.join(' ') : parts.join('\n');
  }

  function value(rest, ind) {
    const r = rest.trim();
    if (r === '') {
      skip();
      if (i < lines.length && (indentOf(lines[i]) > ind || (indentOf(lines[i]) === ind && lines[i].trimStart().startsWith('- ')))) return block(ind);
      return null;
    }
    if (/^[|>][-+]?$/.test(r)) return blockScalar(ind, r);
    return scalar(r);
  }

  function map(ind) {
    const obj = {};
    while (i < lines.length) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) { i++; continue; } // unerwartet tief – überspringen
      const s = l.trim();
      if (s.startsWith('- ')) break;
      const kv = splitKey(s);
      i++;
      if (!kv) continue;
      obj[kv.key] = value(kv.rest, li);
    }
    return obj;
  }

  function seq(ind) {
    const arr = [];
    while (i < lines.length) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      const li = indentOf(l);
      if (li < ind || !l.trimStart().startsWith('-')) break;
      if (li > ind) { i++; continue; }
      const after = l.trimStart().slice(1);
      const content = after.trimStart();
      i++;
      if (content === '') { arr.push(block(li)); continue; }
      const kv = splitKey(content);
      if (kv) {
        // „- key: wert“ öffnet eine Abbildung, deren weitere Schlüssel auf Höhe des ersten stehen
        const inner = li + 1 + (after.length - content.length);
        const obj = {};
        obj[kv.key] = value(kv.rest, inner);
        Object.assign(obj, map(inner));
        arr.push(obj);
      } else arr.push(scalar(content));
    }
    return arr;
  }

  return block(0);
}

module.exports = { parse, scalar, splitKey, unquote };
