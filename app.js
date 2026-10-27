/* PDF Metadata — read and rewritten by pdf-lib (Andrew Dillon, MIT). Everything runs in this tab. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$, h = S3.h;
  var L = PDFLib, PDFDocument = L.PDFDocument, PDFName = L.PDFName, PDFString = L.PDFString, PDFHexString = L.PDFHexString;
  var PDFDict = L.PDFDict, PDFArray = L.PDFArray, PDFRef = L.PDFRef, PDFStream = L.PDFStream;
  var STD = [["Title", "Title"], ["Author", "Author"], ["Subject", "Subject"], ["Keywords", "Keywords"], ["Creator", "Creator (app that made it)"], ["Producer", "Producer (PDF engine)"]];
  var DATES = [["CreationDate", "Created"], ["ModDate", "Modified"]];
  var KNOWN = STD.map(function (x) { return x[0]; }).concat(["CreationDate", "ModDate", "Trapped"]);
  var N = function (k) { return PDFName.of(k); };

  // ---------- core (pure, testable) ----------
  function load(bytes) {
    return PDFDocument.load(bytes, { updateMetadata: false }).catch(function (e) {
      throw new Error(/encrypted/i.test(e && e.message) ? "This PDF is password-protected or encrypted, so its info can't be rewritten here. Remove the protection first." : "This file couldn't be read as a PDF.");
    });
  }
  function text(v) {
    if (!v) return "";
    try { if (v.decodeText) return v.decodeText(); } catch (e) { /* fall through */ }
    var s = String(v); return s.charAt(0) === "/" ? s.slice(1) : s;
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function toInput(d) { return d && !isNaN(d) ? d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) : ""; }
  function tzOf(raw) { // "D:20240303140200+03'00'" -> "UTC+03:00"
    var m = /^D?:?\d{14}([+\-Z])(\d{2})?'?(\d{2})?/.exec(String(raw || "").trim());
    if (!m) return ""; if (m[1] === "Z") return "UTC"; return "UTC" + m[1] + (m[2] || "00") + ":" + (m[3] || "00");
  }
  function readMeta(doc) {
    var info = doc.getInfoDict(), out = { text: {}, dates: {}, custom: [], trapped: !!info.get(N("Trapped")) };
    STD.forEach(function (x) { out.text[x[0]] = text(info.lookup(N(x[0]))).trim(); });
    DATES.forEach(function (x) {
      var v = info.lookup(N(x[0])), raw = text(v), d = null;
      if (v) { try { d = v.decodeDate(); } catch (e) { d = null; } }
      out.dates[x[0]] = { raw: raw, date: d, input: toInput(d) };
    });
    info.keys().forEach(function (k) { var key = k.decodeText ? k.decodeText() : String(k).slice(1); if (KNOWN.indexOf(key) < 0) out.custom.push([key, text(info.lookup(k))]); });
    var x = doc.catalog.lookup(N("Metadata"));
    out.xmp = x instanceof PDFStream ? { stream: x, size: x.getContents().length } : null;
    out.pageXmp = doc.getPages().filter(function (p) { return p.node.get(N("Metadata")) || p.node.get(N("PieceInfo")); }).length + (doc.catalog.get(N("PieceInfo")) ? 1 : 0);
    out.id = !!doc.context.trailerInfo.ID;
    out.pages = doc.getPageCount();
    return out;
  }
  function xmpText(stream) { // decoded XML (Flate handled with the browser's DecompressionStream)
    var raw = stream.getContents(), f = String(stream.dict.get(N("Filter")) || "");
    var dec = function (b) { return new TextDecoder("utf-8").decode(b); };
    if (!f) return Promise.resolve(dec(raw));
    if (/FlateDecode/.test(f) && typeof DecompressionStream === "function") {
      return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer().then(function (a) { return dec(new Uint8Array(a)); }, function () { return null; });
    }
    return Promise.resolve(null);
  }
  // keep only objects reachable from the trailer: drops orphaned old Info dicts, XMP streams, earlier revisions
  function gc(doc) {
    var ctx = doc.context, seen = {}, stack = [], t = ctx.trailerInfo, removed = 0;
    [t.Root, t.Info, t.Encrypt].forEach(function (x) { if (x) stack.push(x); });
    while (stack.length) {
      var o = stack.pop();
      if (o instanceof PDFRef) { if (seen[o.tag]) continue; seen[o.tag] = 1; var v = ctx.lookup(o); if (v) stack.push(v); }
      else if (o instanceof PDFDict) o.entries().forEach(function (e) { stack.push(e[1]); });
      else if (o instanceof PDFArray) o.asArray().forEach(function (e) { stack.push(e); });
      else if (o instanceof PDFStream) stack.push(o.dict);
    }
    ctx.enumerateIndirectObjects().forEach(function (e) { if (!seen[e[0].tag]) { ctx.delete(e[0]); removed++; } });
    return removed;
  }
  // next: {strip} or {text:{}, dates:{key: input string}, custom:{key: value|null}, rmXmp, rmId}
  function apply(doc, orig, next) {
    var info = doc.getInfoDict(), cat = doc.catalog;
    if (next.strip) {
      info.keys().forEach(function (k) { info.delete(k); });
    } else {
      STD.forEach(function (x) {
        var k = x[0], v = String(next.text[k] == null ? orig.text[k] : next.text[k]).trim();
        if (v === orig.text[k]) return;
        if (v) info.set(N(k), PDFHexString.fromText(v)); else info.delete(N(k));
      });
      DATES.forEach(function (x) {
        var k = x[0], v = next.dates[k] == null ? orig.dates[k].input : next.dates[k];
        if (v === orig.dates[k].input) return;
        var d = new Date(v);
        if (v && !isNaN(d)) info.set(N(k), PDFString.fromDate(d)); else info.delete(N(k));
      });
      orig.custom.forEach(function (c) {
        var nv = next.custom ? next.custom[c[0]] : undefined;
        if (nv === null) info.delete(N(c[0])); else if (nv != null && nv !== c[1]) info.set(N(c[0]), PDFHexString.fromText(nv));
      });
    }
    if (next.strip || next.rmXmp) {
      ["Metadata", "PieceInfo"].forEach(function (k) { cat.delete(N(k)); doc.getPages().forEach(function (p) { p.node.delete(N(k)); }); });
    }
    if (next.strip || next.rmId) doc.context.trailerInfo.ID = undefined;
    return gc(doc);
  }

  // ---------- UI ----------
  var st = { name: "", base: "", bytes: null, meta: null };
  function field(k, label, value, type) {
    var input = h("input", { "class": "input", id: "f-" + k, type: type || "text", dir: type ? null : "auto", step: type ? "1" : null, placeholder: "(empty)", spellcheck: "false" });
    input.value = value || "";
    var wide = /Title|Keywords/.test(k);
    return h("label", { "class": "field" + (wide ? " md-wide" : "") }, [label, input]);
  }
  function show(m, bytes) {
    var f = $("#fields"); f.innerHTML = "";
    STD.forEach(function (x) { f.appendChild(field(x[0], x[1], m.text[x[0]])); });
    DATES.forEach(function (x) {
      var d = m.dates[x[0]], lab = h("span", {}, [x[1] + " ", h("span", { "class": "faint", text: d.raw ? (tzOf(d.raw) ? "(" + tzOf(d.raw) + ")" : "") : "" })]);
      f.appendChild(field(x[0], lab, d.input, "datetime-local"));
    });
    var c = $("#custom"); c.innerHTML = "";
    $("#customBox").hidden = !m.custom.length;
    m.custom.forEach(function (kv) {
      var input = h("input", { "class": "input", dir: "auto", "aria-label": kv[0], "data-key": kv[0], spellcheck: "false" }); input.value = kv[1];
      var row = h("div", { "class": "md-crow" }), btn = h("button", { "class": "btn ghost icon small", type: "button", title: "Remove this field", "aria-label": "Remove " + kv[0], text: "✕" });
      btn.addEventListener("click", function () { var g = row.classList.toggle("gone"); input.disabled = g; btn.textContent = g ? "↶" : "✕"; btn.title = g ? "Keep this field" : "Remove this field"; });
      row.append(h("span", { "class": "md-key", title: kv[0], text: kv[0] }), input, btn); c.appendChild(row);
    });
    $("#rmXmp").checked = false; $("#rmXmp").disabled = !m.xmp && !m.pageXmp;
    $("#xmpInfo").textContent = m.xmp ? "(" + S3.fmtBytes(m.xmp.size) + " in this file" + (m.pageXmp ? ", plus page-level data" : "") + ")" : m.pageXmp ? "(page-level data only)" : "(none in this file)";
    $("#xmpToggle").hidden = !m.xmp; $("#xmpText").hidden = true; $("#xmpToggle").textContent = "Show XML"; st.xml = null;
    if (m.xmp) xmpText(m.xmp.stream).then(function (t) { st.xml = t; reveal(m, bytes); });
    $("#rmId").checked = false; $("#rmId").disabled = !m.id;
    $("#idInfo").textContent = m.id ? "(a fingerprint that can link copies and versions of this file)" : "(none in this file)";
    reveal(m, bytes);
  }
  function reveal(m, bytes) {
    var ul = $("#reveal"), items = [];
    ul.innerHTML = "";
    if (m.text.Author) items.push(["Author", m.text.Author]);
    if (m.text.Creator || m.text.Producer) items.push(["Software", [m.text.Creator, m.text.Producer].filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(" · ")]);
    DATES.forEach(function (x) { var d = m.dates[x[0]]; if (d.date) items.push([x[1], d.date.toLocaleString() + (tzOf(d.raw) ? " · time zone " + tzOf(d.raw) : "")]); });
    if (m.text.Title) items.push(["Title", m.text.Title]);
    if (m.custom.length) items.push(["Custom fields", m.custom.map(function (c) { return c[0] + ": " + c[1]; }).join(" · ")]);
    if (m.xmp) {
      var x = st.xml || "", bits = [S3.fmtBytes(m.xmp.size)];
      if (/History/.test(x)) bits.push("edit history");
      if (/DocumentID|InstanceID/.test(x)) bits.push("IDs linking versions");
      var who = /<dc:creator>[\s\S]*?<rdf:li[^>]*>([^<]{1,80})</.exec(x); if (who) bits.push("creator “" + who[1] + "”");
      items.push(["XMP metadata", bits.join(" · ")]);
    }
    if (m.id) items.push(["Document ID", "present"]);
    if (!items.length) ul.appendChild(h("li", { "class": "clean" }, [h("b", { text: "Clean" }), h("span", { text: "No identifying metadata found in this file." })]));
    items.forEach(function (it) { ul.appendChild(h("li", {}, [h("b", { text: it[0] }), h("span", { text: it[1] })])); });
    var s = $("#stats"); s.innerHTML = "";
    var ver = (/%PDF-(\d\.\d)/.exec(new TextDecoder("latin1").decode(bytes.subarray(0, 1024))) || [])[1] || "?";
    [[String(m.pages), "pages"], [ver, "PDF version"], [S3.fmtBytes(bytes.length), "file size"], [String(items.length), "things revealed"]]
      .forEach(function (p) { s.appendChild(h("div", { "class": "stat" }, [h("b", { text: p[0] }), h("span", { text: p[1] })])); });
  }
  $("#xmpToggle").addEventListener("click", function () {
    var pre = $("#xmpText"), open = pre.hidden;
    pre.hidden = !open; this.textContent = open ? "Hide XML" : "Show XML";
    if (open) pre.textContent = st.xml == null ? "This XMP stream is compressed in a way this browser can't unpack for display. It can still be removed." : st.xml;
  });

  function openBytes(bytes, name) {
    return load(bytes).then(function (doc) {
      st.bytes = bytes; st.meta = readMeta(doc);
      if (name) { st.name = name; st.base = name.replace(/\.pdf$/i, "") || "document"; $("#fname").textContent = name; }
      $("#dropCard").hidden = true; $("#work").hidden = false;
      show(st.meta, bytes);
    });
  }
  var fileInput = S3.drop($("#drop"), function (files) {
    S3.readFile(files[0]).then(function (b) { return openBytes(new Uint8Array(b), files[0].name); }).catch(function (e) { S3.toast(e.message, "error"); });
  }, { accept: ".pdf,application/pdf", multiple: false });
  $("#change").addEventListener("click", function () { fileInput.click(); });

  function collect() {
    var next = { text: {}, dates: {}, custom: {}, rmXmp: $("#rmXmp").checked, rmId: $("#rmId").checked };
    STD.forEach(function (x) { next.text[x[0]] = $("#f-" + x[0]).value; });
    DATES.forEach(function (x) { next.dates[x[0]] = $("#f-" + x[0]).value; });
    $$("#custom .md-crow").forEach(function (r) { var i = $("input", r); next.custom[i.dataset.key] = r.classList.contains("gone") ? null : i.value; });
    return next;
  }
  function run(next, suffix, msg) {
    return load(st.bytes).then(function (doc) {
      apply(doc, st.meta, next);
      return doc.save();
    }).then(function (out) {
      S3.download(new Blob([out], { type: "application/pdf" }), st.base + suffix);
      S3.toast(msg); S3.done();
      return openBytes(out);
    }).catch(function (e) { S3.toast("Couldn't save: " + (e && e.message || e), "error"); });
  }
  $("#save").addEventListener("click", function () { if (st.bytes) run(collect(), "-edited.pdf", "Saved with your changes"); });
  $("#strip").addEventListener("click", function () { if (st.bytes) run({ strip: true }, "-clean.pdf", "Stripped: info fields, XMP and document ID removed"); });

  // ---------- sample + self-test ----------
  function samplePdf(withOrphan) {
    return PDFDocument.create({ updateMetadata: false }).then(function (d) {
      return d.embedFont(L.StandardFonts.Helvetica).then(function (f) {
        var p = d.addPage([595.28, 841.89]);
        p.drawText("Q3 salary review", { x: 56, y: 760, size: 24, font: f });
        var info = d.getInfoDict();
        d.setTitle("Q3 salary review (DRAFT v4)"); d.setAuthor("Sara Haddad"); d.setSubject("Compensation");
        d.setCreator("Microsoft® Word for Microsoft 365"); d.setProducer("Microsoft® Word for Microsoft 365");
        info.set(N("CreationDate"), PDFString.of("D:20260314093012+03'00'")); info.set(N("ModDate"), PDFString.of("D:20260921171544+03'00'"));
        info.set(N("Company"), PDFHexString.fromText("Nour Studio LLC")); info.set(N("SourceModified"), PDFString.of("D:20260921171501"));
        var xml = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
          '<rdf:Description><dc:creator><rdf:Seq><rdf:li>Sara Haddad</rdf:li></rdf:Seq></dc:creator>' +
          "<xmpMM:DocumentID>uuid:5f1c2a9e-0d1b-4a5e-9c61-2f7d3b8e4a10</xmpMM:DocumentID><xmpMM:History><rdf:Seq><rdf:li>saved 2026-09-21 by Sara Haddad</rdf:li></rdf:Seq></xmpMM:History>" +
          '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
        d.catalog.set(N("Metadata"), d.context.register(d.context.stream(xml, { Type: "Metadata", Subtype: "XML" })));
        if (withOrphan) d.context.register(PDFString.of("old revision by Sara Haddad"));
        d.context.trailerInfo.ID = d.context.obj([PDFHexString.of("5F1C2A9E0D1B4A5E"), PDFHexString.of("5F1C2A9E0D1B4A5E")]);
        return d.save({ useObjectStreams: false });
      });
    });
  }
  window.S3_DEMO = function () {
    return samplePdf(false).then(function (b) { return openBytes(b, "Q3 salary review.pdf"); }).then(function () { return new Promise(function (r) { setTimeout(r, 300); }); });
  };
  window.S3_SELFTEST = function () {
    var fails = [], ok = function (c, m) { if (!c) fails.push(m); }, bytes, meta;
    var latin = function (b) { return new TextDecoder("latin1").decode(b); };
    return samplePdf(true).then(function (b) { bytes = b; return load(b); }).then(function (doc) {
      meta = readMeta(doc);
      ok(meta.text.Author === "Sara Haddad" && meta.text.Creator.indexOf("Word") > 0, "reads info fields");
      ok(meta.dates.CreationDate.date && meta.dates.CreationDate.date.toISOString() === "2026-03-14T06:30:12.000Z" && tzOf(meta.dates.CreationDate.raw) === "UTC+03:00", "reads dates + time zone");
      ok(meta.custom.length === 2 && meta.custom[0][0] === "Company" && meta.custom[0][1] === "Nour Studio LLC", "custom fields");
      ok(meta.xmp && meta.xmp.size > 300 && meta.id && meta.pages === 1, "XMP + ID found");
      ok(latin(bytes).indexOf("Sara Haddad") > 0, "test file really contains the name");
      // edit: change title, drop one custom field, keep the rest exactly
      return load(bytes).then(function (d2) {
        apply(d2, meta, { text: { Title: "Final review" }, dates: {}, custom: { SourceModified: null }, rmXmp: false, rmId: false });
        return d2.save();
      });
    }).then(function (out) { return load(out); }).then(function (e) {
      var m = readMeta(e);
      ok(m.text.Title === "Final review" && m.text.Author === "Sara Haddad" && m.custom.length === 1 && m.custom[0][0] === "Company", "edit changes only what changed");
      ok(m.dates.CreationDate.raw === "D:20260314093012+03'00'" && m.xmp && m.id, "untouched date, XMP and ID kept as they were");
      return load(bytes);
    }).then(function (d3) {
      var removed = apply(d3, meta, { strip: true });
      ok(removed >= 2, "orphaned objects removed (" + removed + ")");
      return d3.save({ useObjectStreams: false });
    }).then(function (clean) {
      var s = latin(clean);
      ok(s.indexOf("Sara Haddad") < 0 && s.indexOf("Nour Studio") < 0 && s.indexOf("Word") < 0 && s.indexOf("5F1C2A9E") < 0 && s.indexOf("salary review (DRAFT") < 0, "no trace of the metadata left in the bytes");
      return load(clean).then(function (c) {
        var m = readMeta(c);
        ok(!m.text.Author && !m.text.Title && !m.text.Producer && !m.dates.CreationDate.date && !m.custom.length && !m.xmp && !m.id, "stripped file reads empty");
        ok(m.pages === 1, "pages untouched");
        return c.getPage(0).getSize().width === 595.28;
      });
    }).then(function (sizeOk) {
      ok(sizeOk, "page size untouched");
      return fails.length ? fails : true;
    });
  };
})();
