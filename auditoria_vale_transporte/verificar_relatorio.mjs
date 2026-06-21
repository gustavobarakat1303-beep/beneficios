import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

process.on("beforeExit", () => {
  process.exitCode = 0;
});

const filePath = process.argv[2];
if (!filePath) throw new Error("Informe o caminho do relatório XLSX.");

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
console.log((await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 3000 })).ndjson);
console.log((await workbook.inspect({
  kind: "table",
  range: "Checagens!A3:F9",
  include: "values,formulas",
  tableMaxRows: 10,
  tableMaxCols: 8,
})).ndjson);
console.log((await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "erros finais",
})).ndjson);
