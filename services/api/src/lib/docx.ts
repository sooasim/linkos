// F-125 Word DOCX export — minimal OOXML (document + table) built with JSZip. Korean-safe (eastAsia font).
import JSZip from "jszip";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// strip characters that are illegal in XML 1.0
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function run(text: string, bold = false) {
  return `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/>${bold ? "<w:b/>" : ""}<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${esc(clean(text))}</w:t></w:r>`;
}
function cell(text: string, header: boolean) {
  return `<w:tc><w:tcPr>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="E8F0C8"/>' : ""}</w:tcPr><w:p>${run(text, header)}</w:p></w:tc>`;
}

export async function buildDocx(title: string, header: string[], rows: string[][]): Promise<Buffer> {
  const border = '<w:tblBorders>' + ["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join("") + "</w:tblBorders>";
  const table = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>${[header, ...rows]
    .map((r, i) => `<w:tr>${r.map((c) => cell(c, i === 0)).join("")}</w:tr>`)
    .join("")}</w:tbl>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:spacing w:after="200"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:b/><w:sz w:val="36"/></w:rPr><w:t xml:space="preserve">${esc(clean(title))}</w:t></w:r></w:p>
${table}
<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr>
</w:body></w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", doc);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
