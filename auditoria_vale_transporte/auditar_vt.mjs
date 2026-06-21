import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

process.on("beforeExit", () => {
  process.exitCode = 0;
});

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const runDate = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const inputDir = path.resolve(args.input || path.join(projectRoot, "entradas"));
const outputDir = path.resolve(args.output || path.join(projectRoot, "outputs", `auditoria_vt_${runDate}`));
const defaultCompetence = clean(args.competencia || "");
const outputFile = path.join(outputDir, `relatorio_auditoria_vale_transporte_${defaultCompetence || "sem_competencia"}.xlsx`);

const fileConfig = await loadConfig(path.join(projectRoot, "config", "arquivos.csv"), "arquivo");
const tariffs = await loadTariffs(path.join(projectRoot, "config", "tarifas.csv"));
const paymentInputs = await loadPayments(path.join(projectRoot, "config", "pagamentos.csv"));
const inputFiles = (await walk(inputDir))
  .filter((file) => /\.csv(?:\.crdownload)?$/i.test(file))
  .sort((a, b) => a.localeCompare(b, "pt-BR"));

if (inputFiles.length === 0) {
  throw new Error(`Nenhum CSV encontrado em ${inputDir}`);
}

const records = [];
const sources = [];
const sourceHashGroups = new Map();

for (const filePath of inputFiles) {
  const fileName = path.basename(filePath);
  const config = fileConfig.get(normalizeKey(fileName)) || {};
  const bytes = await fs.readFile(filePath);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!sourceHashGroups.has(hash)) sourceHashGroups.set(hash, []);
  sourceHashGroups.get(hash).push(fileName);

  const { text, encoding } = decodeText(bytes);
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const parsed = parseCsv(text, delimiter);
  const metadata = parseSourceMetadata(text, delimiter);
  const ignored = yes(config.ignorar);
  const sourceRows = [];
  let system = "Formato não reconhecido";

  if (!ignored) {
    for (let index = 0; index < parsed.length; index += 1) {
      const raw = parsed[index];
      const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [normalizeKey(key), clean(value)]));
      let record;

      if ("EMPREGADO" in row && "VALOR" in row) {
        system = "Exportação de cartões";
        const value = parseMoney(row.VALOR);
        const rawDays = parseNumber(row.DIAS);
        const dayAudit = computeRoundTripDays(clean(row.PRODUTO), rawDays, value);
        record = {
          sourceFile: fileName,
          sourceRow: index + 2,
          system,
          company: clean(config.empresa) || "NÃO INFORMADA",
          competence: clean(config.competencia) || defaultCompetence || "NÃO INFORMADA",
          employee: normalizeName(row.EMPREGADO),
          identifier: clean(row.CARTAO),
          product: clean(row.PRODUTO) || "NÃO INFORMADO",
          days: dayAudit.days,
          value,
          observation: joinNotes(clean(config.observacao), dayAudit.observation),
        };
        record.dayStatus = dayAudit.status;
      } else if ("USUARIO" in row && "TOTAL" in row) {
        system = "ViaNova Benefícios";
        record = {
          sourceFile: fileName,
          sourceRow: index + 2,
          system,
          company: clean(config.empresa) || clean(row.FILIAL) || "NÃO INFORMADA",
          competence: clean(config.competencia) || defaultCompetence || "NÃO INFORMADA",
          employee: normalizeName(row.USUARIO),
          identifier: clean(row.CPF),
          product: clean(row.PRODUTO) || "NÃO INFORMADO",
          days: null,
          value: parseMoney(row.TOTAL),
          observation: clean(config.observacao),
        };
      } else if ("NOME COMPLETO" in row && "TOTAL" in row && clean(row["NOME COMPLETO"])) {
        system = "Pedido de benefícios";
        const valeTransporte = parseMoney(row["VALOR FIXO EM VALE TRANSPORTE"]);
        const mobilidade = parseMoney(row.MOBILIDADE) + parseMoney(row["VALOR FIXO EM MOBILIDADE"]);
        record = {
          sourceFile: fileName,
          sourceRow: index + 2,
          system,
          company: clean(config.empresa) || metadata.empresa || "NÃO INFORMADA",
          competence: clean(config.competencia) || defaultCompetence || "NÃO INFORMADA",
          employee: normalizeName(row["NOME COMPLETO"]),
          identifier: clean(row.CPF),
          product: valeTransporte > 0 ? "Vale Transporte" : mobilidade > 0 ? "Mobilidade" : "Total do pedido",
          days: null,
          value: parseMoney(row.TOTAL),
          observation: joinNotes(clean(config.observacao), metadata.status ? `Status do pedido: ${metadata.status}` : "", metadata.id ? `Pedido: ${metadata.id}` : "", metadata.data ? `Data do pedido: ${metadata.data}` : ""),
        };
      } else {
        continue;
      }

      if (!record.value) continue;

      if (record.days === null) {
        const tariff = findTariff(tariffs, record.product, record.competence);
        if (tariff && tariff.valuePerDay > 0) {
          const calculated = Math.round(record.value / tariff.valuePerDay);
          const difference = Math.abs(record.value - calculated * tariff.valuePerDay);
          if (calculated > 0 && difference <= 0.02) {
            record.days = calculated;
            record.dayStatus = "CALCULADO POR TARIFA";
            record.observation = joinNotes(record.observation, tariff.observation);
          }
        }
      }
      record.dayStatus ||= record.days === null ? "DIAS NÃO INFORMADOS" : "DIAS IDA E VOLTA";
      record.exactDuplicateStatus = "MANTER";
      record.possibleDuplicateStatus = "SEM ALERTA";
      records.push(record);
      sourceRows.push(record);
    }
  }

  sources.push({
    fileName,
    ignored,
    rows: sourceRows.length,
    value: sum(sourceRows, "value"),
    knownDays: sum(sourceRows.filter((row) => row.days !== null), "days"),
    missingDaysRows: sourceRows.filter((row) => row.days === null).length,
    encoding,
    delimiter: delimiter === ";" ? "ponto e vírgula" : "vírgula",
    system,
    configuredCompany: clean(config.empresa),
    configuredCompetence: clean(config.competencia) || defaultCompetence,
    detectedCompanies: unique(sourceRows.map((row) => row.company)).join(" | "),
    observation: ignored ? "Arquivo ignorado pela configuração" : clean(config.observacao),
    paidValue: parseMoney(metadata.valor_total),
    paymentStatus: metadata.status,
    paymentDate: metadata.data,
    paymentId: metadata.id,
    provider: system === "Pedido de benefícios" ? "Pedido de benefícios" : "",
  });
}

const sourcesByFile = new Map(sources.map((source) => [normalizeKey(source.fileName), source]));
const manualPayments = paymentInputs.filter((payment) => sourcesByFile.has(normalizeKey(payment.relatedFile))).map((payment) => {
  const source = sourcesByFile.get(normalizeKey(payment.relatedFile));
  const sourceValue = source?.value ?? 0;
  const fee = roundMoney(payment.paidValue - payment.creditValue);
  return {
    ...payment,
    sourceValue,
    fee,
    feePercent: payment.creditValue > 0 ? fee / payment.creditValue : 0,
    difference: roundMoney(payment.creditValue - sourceValue),
    status: Math.abs(payment.creditValue - sourceValue) <= 0.01 ? "OK" : "DIVERGÊNCIA",
  };
});
const manualPaymentFiles = new Set(manualPayments.map((payment) => normalizeKey(payment.relatedFile)));
const sourcePayments = sources
  .filter((source) => !manualPaymentFiles.has(normalizeKey(source.fileName)))
  .filter((source) => normalizeKey(source.paymentStatus) === "PAGO" && source.paidValue > 0)
  .map((source) => {
    const fee = roundMoney(source.paidValue - source.value);
    return {
      provider: source.provider || "Pedido pago",
      competence: source.configuredCompetence || "NÃO INFORMADA",
      relatedFile: source.fileName,
      creditValue: source.value,
      paidValue: source.paidValue,
      paymentDate: source.paymentDate,
      observation: joinNotes(source.paymentId ? `Pedido: ${source.paymentId}` : "", source.paymentStatus ? `Status: ${source.paymentStatus}` : ""),
      sourceValue: source.value,
      fee,
      feePercent: source.value > 0 ? fee / source.value : 0,
      difference: roundMoney(source.value - source.value),
      status: Math.abs(source.paidValue - source.value) <= 0.01 ? "OK" : "DIVERGÊNCIA",
    };
  });
const payments = [...manualPayments, ...sourcePayments];

markDuplicates(records);

const companySummary = summarize(records, (row) => [row.company, row.competence], ([company, competence], rows) => ({
  company,
  competence,
  employees: unique(rows.map((row) => row.employee)).length,
  entries: rows.length,
  grossValue: sum(rows, "value"),
  valueWithoutExactDuplicates: sum(rows.filter((row) => row.exactDuplicateStatus === "MANTER"), "value"),
  knownDays: sum(rows.filter((row) => row.days !== null && row.exactDuplicateStatus === "MANTER"), "days"),
  missingDaysRows: rows.filter((row) => row.days === null).length,
  valueWithoutDays: sum(rows.filter((row) => row.days === null), "value"),
  possibleDuplicateValue: sum(rows.filter((row) => row.possibleDuplicateStatus === "POSSÍVEL DUPLICIDADE"), "value"),
}));

const employeeSummary = summarize(records, (row) => [row.company, row.competence, row.employee], ([company, competence, employee], rows) => ({
  company,
  competence,
  employee,
  identifiers: unique(rows.map((row) => row.identifier)).join(" | "),
  products: unique(rows.map((row) => row.product)).join(" | "),
  entries: rows.length,
  grossValue: sum(rows, "value"),
  valueWithoutExactDuplicates: sum(rows.filter((row) => row.exactDuplicateStatus === "MANTER"), "value"),
  knownDays: sum(rows.filter((row) => row.days !== null && row.exactDuplicateStatus === "MANTER"), "days"),
  missingDaysRows: rows.filter((row) => row.days === null).length,
  valueWithoutDays: sum(rows.filter((row) => row.days === null), "value"),
  possibleDuplicateValue: sum(rows.filter((row) => row.possibleDuplicateStatus === "POSSÍVEL DUPLICIDADE"), "value"),
})).sort((a, b) => a.company.localeCompare(b.company, "pt-BR") || a.employee.localeCompare(b.employee, "pt-BR"));

const inconsistencies = buildInconsistencies(records, sources, sourceHashGroups, payments);
const totalGross = sum(records, "value");
const totalWithoutExactDuplicates = sum(records.filter((row) => row.exactDuplicateStatus === "MANTER"), "value");
const possibleDuplicateValue = sum(records.filter((row) => row.possibleDuplicateStatus === "POSSÍVEL DUPLICIDADE"), "value");
const knownDays = sum(records.filter((row) => row.days !== null && row.exactDuplicateStatus === "MANTER"), "days");
const valueWithoutDays = sum(records.filter((row) => row.days === null), "value");
const exactDuplicateRows = records.filter((row) => row.exactDuplicateStatus === "DUPLICIDADE EXATA").length;
const possibleDuplicateRows = records.filter((row) => row.possibleDuplicateStatus === "POSSÍVEL DUPLICIDADE").length;
const missingCompanySources = sources.filter((source) => source.detectedCompanies.includes("NÃO INFORMADA")).length;
const missingCompetenceSources = sources.filter((source) => !source.configuredCompetence).length;
const totalPaid = sum(payments, "paidValue");
const totalPaymentCredits = sum(payments, "creditValue");
const totalPaymentFees = sum(payments, "fee");

const workbook = Workbook.create();
const summarySheet = workbook.worksheets.add("Resumo Executivo");
const paymentSheet = workbook.worksheets.add("Pagamentos Fornecedor");
const companySheet = workbook.worksheets.add("Por Empresa");
const employeeSheet = workbook.worksheets.add("Por Funcionário");
const baseSheet = workbook.worksheets.add("Base Consolidada");
const issueSheet = workbook.worksheets.add("Inconsistências");
const sourceSheet = workbook.worksheets.add("Fontes e Regras");
const checkSheet = workbook.worksheets.add("Checagens");

for (const sheet of [summarySheet, paymentSheet, companySheet, employeeSheet, baseSheet, issueSheet, sourceSheet, checkSheet]) {
  sheet.showGridLines = false;
}

buildSummarySheet(summarySheet, {
  totalGross,
  totalWithoutExactDuplicates,
  possibleDuplicateValue,
  knownDays,
  valueWithoutDays,
  employeeCount: unique(records.map((row) => `${row.company}|${row.competence}|${row.employee}`)).length,
  informedCompanies: unique(records.filter((row) => row.company !== "NÃO INFORMADA").map((row) => row.company)).length,
  exactDuplicateRows,
  possibleDuplicateRows,
  missingCompanySources,
  missingCompetenceSources,
  missingDaysRows: records.filter((row) => row.days === null).length,
  crdownloadSources: sources.filter((source) => source.fileName.toLowerCase().endsWith(".crdownload")).length,
  companySummary,
  totalPaid,
  totalPaymentCredits,
  totalPaymentFees,
  paymentCompetences: unique(payments.map((payment) => payment.competence)).join(" | "),
});

writeReportTable(paymentSheet, "Pagamentos aos Fornecedores", [
  "Fornecedor", "Competência", "Arquivo relacionado", "Créditos do pagamento", "Créditos no arquivo",
  "Valor pago", "Taxa", "Taxa %", "Diferença créditos", "Status", "Data do pagamento", "Observação",
], payments.map((payment) => [
  payment.provider, payment.competence, payment.relatedFile, payment.creditValue, payment.sourceValue,
  payment.paidValue, payment.fee, payment.feePercent, payment.difference, payment.status, payment.paymentDate, payment.observation,
]), "PaymentTable", [18, 14, 30, 22, 20, 18, 16, 14, 20, 16, 18, 42], [3, 4, 5, 6, 8]);
if (payments.length > 0) {
  paymentSheet.getRangeByIndexes(3, 7, payments.length, 1).setNumberFormat("0.00%");
}

writeReportTable(companySheet, "Auditoria por Empresa", [
  "Empresa", "Competência", "Funcionários", "Lançamentos", "Valor bruto", "Valor sem duplicidade exata",
  "Dias conhecidos", "Lançamentos sem dias", "Valor sem dias", "Possível duplicidade",
], companySummary.map((row) => [
  row.company, row.competence, row.employees, row.entries, row.grossValue, row.valueWithoutExactDuplicates,
  row.knownDays, row.missingDaysRows, row.valueWithoutDays, row.possibleDuplicateValue,
]), "CompanyTable", [34, 15, 14, 14, 18, 24, 16, 22, 18, 20], [4, 5, 8, 9]);

writeReportTable(employeeSheet, "Auditoria por Funcionário", [
  "Empresa", "Competência", "Funcionário", "Identificador(es)", "Produto(s)", "Lançamentos", "Valor bruto",
  "Valor sem duplicidade exata", "Dias conhecidos", "Lançamentos sem dias", "Valor sem dias", "Possível duplicidade",
], employeeSummary.map((row) => [
  row.company, row.competence, row.employee, row.identifiers, row.products, row.entries, row.grossValue,
  row.valueWithoutExactDuplicates, row.knownDays, row.missingDaysRows, row.valueWithoutDays, row.possibleDuplicateValue,
]), "EmployeeTable", [32, 14, 36, 20, 42, 14, 18, 24, 16, 22, 18, 20], [6, 7, 10, 11]);

writeReportTable(baseSheet, "Base Consolidada de Pagamentos", [
  "Arquivo fonte", "Linha", "Sistema", "Empresa", "Competência", "Funcionário", "Identificador", "Produto",
  "Dias", "Valor", "Valor por dia", "Status dos dias", "Duplicidade exata", "Possível duplicidade", "Observação",
], records.map((row) => [
  row.sourceFile, row.sourceRow, row.system, row.company, row.competence, row.employee, row.identifier, row.product,
  row.days, row.value, null, row.dayStatus, row.exactDuplicateStatus, row.possibleDuplicateStatus, row.observation,
]), "BaseTable", [28, 10, 24, 34, 14, 38, 20, 42, 10, 16, 16, 24, 22, 24, 42], [9, 10]);

if (records.length > 0) {
  const firstDataRow = 4;
  const lastDataRow = firstDataRow + records.length - 1;
  baseSheet.getRange(`K${firstDataRow}`).formulas = [[`=IF(I${firstDataRow}>0,ROUND(J${firstDataRow}/I${firstDataRow},2),"")`]];
  baseSheet.getRange(`K${firstDataRow}:K${lastDataRow}`).fillDown();
  baseSheet.getRange(`K${firstDataRow}:K${lastDataRow}`).setNumberFormat("R$ #,##0.00");
}

writeReportTable(issueSheet, "Inconsistências e Pendências", [
  "Severidade", "Tipo", "Arquivo fonte", "Funcionário", "Empresa", "Valor relacionado", "Detalhe / ação necessária",
], inconsistencies.map((row) => [
  row.severity, row.type, row.sourceFile, row.employee, row.company, row.value, row.detail,
]), "IssueTable", [14, 28, 30, 36, 34, 20, 64], [5]);

buildSourcesSheet(sourceSheet, sources);
buildChecksSheet(checkSheet, {
  totalGross,
  companyGross: sum(companySummary, "grossValue"),
  employeeGross: sum(employeeSummary, "grossValue"),
  baseRows: records.length,
  sourceRows: sum(sources, "rows"),
  exactDuplicateValue: roundMoney(totalGross - totalWithoutExactDuplicates),
  expectedExactDuplicateValue: sum(records.filter((row) => row.exactDuplicateStatus === "DUPLICIDADE EXATA"), "value"),
  paymentCredits: totalPaymentCredits,
  paymentSourceValues: sum(payments, "sourceValue"),
  status: inconsistencies.some((row) => row.severity === "ALTA") ? "ATENÇÃO" : "OK",
});

await fs.mkdir(outputDir, { recursive: true });
const previewDir = path.join(outputDir, "_previews");
await fs.mkdir(previewDir, { recursive: true });

const summaryInspect = await workbook.inspect({
  kind: "table",
  range: "Resumo Executivo!A1:K34",
  include: "values,formulas",
  tableMaxRows: 34,
  tableMaxCols: 11,
});
console.log(summaryInspect.ndjson);

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "varredura final de erros",
});
console.log(formulaErrors.ndjson);

for (const sheet of [summarySheet, paymentSheet, companySheet, employeeSheet, baseSheet, issueSheet, sourceSheet, checkSheet]) {
  const preview = await workbook.render({ sheetName: sheet.name, autoCrop: "all", scale: sheet === baseSheet ? 0.45 : 0.7, format: "png" });
  await fs.writeFile(path.join(previewDir, `${safeFileName(sheet.name)}.png`), new Uint8Array(await preview.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputFile);

console.log(JSON.stringify({
  outputFile,
  inputFiles: inputFiles.length,
  records: records.length,
  totalGross,
  totalWithoutExactDuplicates,
  possibleDuplicateValue,
  knownDays,
  valueWithoutDays,
  exactDuplicateRows,
  possibleDuplicateRows,
  inconsistencies: inconsistencies.length,
  totalPaid,
  totalPaymentCredits,
  totalPaymentFees,
}, null, 2));
process.exitCode = 0;

function buildSummarySheet(sheet, metrics) {
  titleBand(sheet, "A1:H1", "AUDITORIA MENSAL DE VALE-TRANSPORTE");
  sheet.getRange("A2:H2").merge();
  sheet.getRange("A2").values = [["Consolidação por empresa e funcionário, com dias pagos e alertas de auditoria"]];
  sheet.getRange("A2:H2").format = { fill: "#E8F0F7", font: { color: "#334155", italic: true }, horizontalAlignment: "center" };

  sheet.getRange("A4:B4").values = [["Indicador", "Resultado"]];
  sheet.getRange("A5:B16").values = [
    [`Valor pago a fornecedores (${metrics.paymentCompetences || "N/D"})`, metrics.totalPaid],
    ["Créditos vinculados aos pagamentos", metrics.totalPaymentCredits],
    ["Taxas dos pagamentos", metrics.totalPaymentFees],
    ["Valor bruto de benefícios no lote", metrics.totalGross],
    ["Valor sem duplicidade exata", metrics.totalWithoutExactDuplicates],
    ["Valor sob possível duplicidade", metrics.possibleDuplicateValue],
    ["Dias conhecidos", metrics.knownDays],
    ["Valor sem número de dias", metrics.valueWithoutDays],
    ["Funcionários por empresa", metrics.employeeCount],
    ["Empresas informadas", metrics.informedCompanies],
    ["Linhas duplicadas exatas", metrics.exactDuplicateRows],
    ["Status da auditoria", "ATENÇÃO"],
  ];
  styleTableRange(sheet.getRange("A4:B16"));
  sheet.getRange("B5:B10").setNumberFormat("R$ #,##0.00");
  sheet.getRange("B11").setNumberFormat("#,##0.0");
  sheet.getRange("B12").setNumberFormat("R$ #,##0.00");
  sheet.getRange("B13:B15").setNumberFormat("#,##0");
  sheet.getRange("B16").format = { fill: "#FDE68A", font: { bold: true, color: "#92400E" }, horizontalAlignment: "center" };
  setWidths(sheet, [30, 24], 0);

  sectionBand(sheet, "A19:H19", "Conclusão executiva");
  const conclusion = `Os pagamentos identificados de ${metrics.paymentCompetences || "competência não informada"} somam ${formatBRL(metrics.totalPaid)}, ` +
    `sendo ${formatBRL(metrics.totalPaymentCredits)} em créditos e ${formatBRL(metrics.totalPaymentFees)} em taxas. ` +
    `O lote completo soma ${formatBRL(metrics.totalGross)} em ${metrics.knownDays.toLocaleString("pt-BR")} dias conhecidos. ` +
    `Após retirar somente duplicidades exatas, o valor é ${formatBRL(metrics.totalWithoutExactDuplicates)}. ` +
    `${formatBRL(metrics.possibleDuplicateValue)} permanecem sob revisão por possível duplicidade. ` +
    `${formatBRL(metrics.valueWithoutDays)} não possuem número de dias calculável com os dados atuais.`;
  sheet.getRange("A20:H22").merge();
  sheet.getRange("A20").values = [[conclusion]];
  sheet.getRange("A20:H22").format = { fill: "#F8FAFC", wrapText: true, verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: "#CBD5E1" } };

  sectionBand(sheet, "A24:H24", "Principais pendências");
  sheet.getRange("A25:C31").values = [
    ["Pendência", "Quantidade", "Impacto"],
    ["Arquivos sem empresa informada", metrics.missingCompanySources, "Impede fechar o total por empresa"],
    ["Arquivos sem competência informada", metrics.missingCompetenceSources, "Impede fechar o mês correto"],
    ["Lançamentos sem dias", metrics.missingDaysRows, "Dias ficam como N/D"],
    ["Linhas duplicadas exatas", metrics.exactDuplicateRows, "Excluídas apenas do valor auditado"],
    ["Linhas sob possível duplicidade", metrics.possibleDuplicateRows, "Precisam de confirmação"],
    ["Arquivos com extensão .crdownload", metrics.crdownloadSources, "Confirmar conclusão dos downloads"],
  ];
  styleTableRange(sheet.getRange("A25:C31"));
  setWidths(sheet, [30, 24, 44], 0);

  const helper = [["Empresa", "Valor bruto"], ...metrics.companySummary.map((row) => [row.company, row.grossValue])];
  writeMatrix(sheet, 3, 9, helper);
  sheet.getRangeByIndexes(3, 9, helper.length, 2).format.borders = { preset: "all", style: "thin", color: "#D7DEE8" };
  sheet.getRangeByIndexes(4, 10, Math.max(helper.length - 1, 1), 1).setNumberFormat("R$ #,##0.00");
  const chart = sheet.charts.add("bar", sheet.getRangeByIndexes(3, 9, helper.length, 2));
  chart.title = "Valor bruto por empresa";
  chart.hasLegend = false;
  chart.yAxis = { numberFormatCode: "R$ #,##0" };
  chart.setPosition("D4", "H14");
  sheet.freezePanes.freezeRows(3);
}

function writeReportTable(sheet, title, headers, rows, tableName, widths, currencyColumns) {
  titleBand(sheet, `A1:${columnLetter(headers.length)}1`, title.toUpperCase());
  writeMatrix(sheet, 2, 0, [headers, ...rows]);
  const range = sheet.getRangeByIndexes(2, 0, rows.length + 1, headers.length);
  styleTableRange(range);
  if (rows.length > 0) {
    const table = sheet.tables.add(range, true, tableName);
    table.style = "TableStyleMedium2";
    for (const columnIndex of currencyColumns) {
      sheet.getRangeByIndexes(3, columnIndex, rows.length, 1).setNumberFormat("R$ #,##0.00");
    }
    headers.forEach((header, columnIndex) => {
      if (normalizeKey(header).includes("DIAS")) {
        sheet.getRangeByIndexes(3, columnIndex, rows.length, 1).setNumberFormat("#,##0.0");
      }
    });
  }
  setWidths(sheet, widths, 0);
  sheet.freezePanes.freezeRows(3);
}

function buildSourcesSheet(sheet, sources) {
  titleBand(sheet, "A1:J1", "FONTES, REGRAS E LIMITAÇÕES");
  sectionBand(sheet, "A3:J3", "Regras da auditoria");
  const rules = [
    ["Regra", "Aplicação"],
    ["Dias pagos", "Usar DIAS do arquivo; calcular somente com tarifa cadastrada e fechamento exato."],
    ["Duplicidade exata", "Mostrar no bruto e retirar apenas do valor sem duplicidade exata."],
    ["Possível duplicidade", "Mesmo identificador, dias e valor em mais de um lançamento; não excluir automaticamente."],
    ["Empresa e competência", "Usar arquivo/configuração; ausências ficam como NÃO INFORMADA."],
    ["Arquivos .crdownload", "Ler o conteúdo disponível e sinalizar para confirmação."],
  ];
  sheet.getRange("A4:A9").values = rules.map((row) => [row[0]]);
  for (let index = 0; index < rules.length; index += 1) {
    const rowNumber = index + 4;
    sheet.getRange(`B${rowNumber}:J${rowNumber}`).merge();
    sheet.getRange(`B${rowNumber}`).values = [[rules[index][1]]];
  }
  styleTableRange(sheet.getRange("A4:J9"));
  sheet.getRange("B4:J9").format.wrapText = true;
  sheet.getRange("A5:J9").format.rowHeight = 30;

  sectionBand(sheet, "A12:J12", "Arquivos processados");
  const headers = ["Arquivo", "Ignorado", "Linhas", "Valor", "Dias conhecidos", "Linhas sem dias", "Codificação", "Separador", "Sistema", "Empresa detectada"];
  const rows = sources.map((source) => [
    source.fileName, source.ignored ? "SIM" : "NÃO", source.rows, source.value, source.knownDays, source.missingDaysRows,
    source.encoding, source.delimiter, source.system, source.detectedCompanies || "N/D",
  ]);
  writeMatrix(sheet, 12, 0, [headers, ...rows]);
  const range = sheet.getRangeByIndexes(12, 0, rows.length + 1, headers.length);
  styleTableRange(range);
  const table = sheet.tables.add(range, true, "SourceTable");
  table.style = "TableStyleMedium2";
  sheet.getRangeByIndexes(13, 3, rows.length, 1).setNumberFormat("R$ #,##0.00");
  setWidths(sheet, [32, 12, 12, 18, 18, 18, 16, 18, 26, 38], 0);
  sheet.freezePanes.freezeRows(13);
}

function buildChecksSheet(sheet, checks) {
  titleBand(sheet, "A1:F1", "CHECAGENS DE RECONCILIAÇÃO");
  const rows = [
    ["Valor bruto: base x empresa", checks.totalGross, checks.companyGross, checks.totalGross - checks.companyGross, 0.01, Math.abs(checks.totalGross - checks.companyGross) <= 0.01 ? "OK" : "ERRO"],
    ["Valor bruto: base x funcionário", checks.totalGross, checks.employeeGross, checks.totalGross - checks.employeeGross, 0.01, Math.abs(checks.totalGross - checks.employeeGross) <= 0.01 ? "OK" : "ERRO"],
    ["Linhas: base x fontes", checks.baseRows, checks.sourceRows, checks.baseRows - checks.sourceRows, 0, checks.baseRows === checks.sourceRows ? "OK" : "ERRO"],
    ["Duplicidade exata", checks.exactDuplicateValue, checks.expectedExactDuplicateValue, checks.exactDuplicateValue - checks.expectedExactDuplicateValue, 0.01, Math.abs(checks.exactDuplicateValue - checks.expectedExactDuplicateValue) <= 0.01 ? "OK" : "ERRO"],
    ["Créditos pagos x arquivos relacionados", checks.paymentCredits, checks.paymentSourceValues, checks.paymentCredits - checks.paymentSourceValues, 0.01, Math.abs(checks.paymentCredits - checks.paymentSourceValues) <= 0.01 ? "OK" : "ERRO"],
    ["Status geral dos dados", null, null, null, null, checks.status],
  ];
  writeMatrix(sheet, 2, 0, [["Checagem", "Esperado", "Apurado", "Diferença", "Tolerância", "Status"], ...rows]);
  styleTableRange(sheet.getRange("A3:F9"));
  sheet.getRange("B4:E8").setNumberFormat("R$ #,##0.00");
  setWidths(sheet, [34, 18, 18, 18, 18, 16], 0);
  sheet.freezePanes.freezeRows(3);
}

function buildInconsistencies(records, sources, hashGroups, payments) {
  const issues = [];
  for (const source of sources) {
    if (source.fileName.toLowerCase().endsWith(".crdownload")) {
      issues.push(issue("MÉDIA", "Arquivo .crdownload", source.fileName, "", source.detectedCompanies, source.value, "Confirmar se o download foi concluído e substituir pelo CSV final."));
    }
    if (source.detectedCompanies.includes("NÃO INFORMADA")) {
      issues.push(issue("ALTA", "Empresa não informada", source.fileName, "", "NÃO INFORMADA", source.value, "Preencher a empresa em config/arquivos.csv."));
    }
    if (!source.configuredCompetence) {
      issues.push(issue("ALTA", "Competência não informada", source.fileName, "", source.detectedCompanies, source.value, "Preencher a competência AAAA-MM em config/arquivos.csv ou executar com -Competencia."));
    }
  }
  for (const files of hashGroups.values()) {
    if (files.length > 1) {
      issues.push(issue("ALTA", "Arquivos idênticos", files.join(" | "), "", "", 0, "Os arquivos possuem conteúdo binário idêntico. Confirmar e ignorar a cópia indevida."));
    }
  }
  for (const payment of payments) {
    if (payment.status !== "OK") {
      issues.push(issue("ALTA", "Pagamento não reconciliado", payment.relatedFile, "", "", payment.paidValue, `Créditos informados ${formatBRL(payment.creditValue)}; arquivo relacionado ${formatBRL(payment.sourceValue)}.`));
    }
  }
  for (const row of records) {
    if (row.days === null) {
      issues.push(issue("ALTA", "Dias não informados", row.sourceFile, row.employee, row.company, row.value, "Cadastrar tarifa diária confiável ou obter relatório com número de dias."));
    }
    if (row.exactDuplicateStatus === "DUPLICIDADE EXATA") {
      issues.push(issue("ALTA", "Duplicidade exata", row.sourceFile, row.employee, row.company, row.value, "Linha retirada somente do valor sem duplicidade exata."));
    } else if (row.possibleDuplicateStatus === "POSSÍVEL DUPLICIDADE") {
      issues.push(issue("MÉDIA", "Possível duplicidade", row.sourceFile, row.employee, row.company, row.value, "Mesmo identificador, dias e valor em outro lançamento; confirmar se é pagamento distinto."));
    }
  }
  const employeeIds = groupBy(records, (row) => `${row.company}|${row.competence}|${row.employee}`);
  for (const rows of employeeIds.values()) {
    const identifiers = unique(rows.map((row) => row.identifier));
    if (identifiers.length > 1) {
      issues.push(issue("MÉDIA", "Funcionário com múltiplos identificadores", unique(rows.map((row) => row.sourceFile)).join(" | "), rows[0].employee, rows[0].company, sum(rows, "value"), `Identificadores encontrados: ${identifiers.join(" | ")}.`));
    }
  }
  return issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.type.localeCompare(b.type, "pt-BR"));
}

function markDuplicates(records) {
  const exact = groupBy(records, (row) => [
    row.company, row.competence, row.identifier, row.employee, row.product, row.days ?? "N/D", row.value.toFixed(2),
  ].join("|"));
  for (const rows of exact.values()) {
    rows.sort(sourceOrder);
    for (let index = 1; index < rows.length; index += 1) rows[index].exactDuplicateStatus = "DUPLICIDADE EXATA";
  }

  const possible = groupBy(records, (row) => [
    row.company, row.competence, row.identifier, row.employee, row.days ?? "N/D", row.value.toFixed(2),
  ].join("|"));
  for (const rows of possible.values()) {
    rows.sort(sourceOrder);
    for (let index = 1; index < rows.length; index += 1) rows[index].possibleDuplicateStatus = "POSSÍVEL DUPLICIDADE";
  }
}

function titleBand(sheet, rangeAddress, text) {
  const range = sheet.getRange(rangeAddress);
  range.merge();
  range.values = [[text]];
  range.format = {
    fill: "#17365D",
    font: { bold: true, color: "#FFFFFF", size: 16 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
  range.format.rowHeight = 30;
}

function sectionBand(sheet, rangeAddress, text) {
  const range = sheet.getRange(rangeAddress);
  range.merge();
  range.values = [[text]];
  range.format = {
    fill: "#D9EAF7",
    font: { bold: true, color: "#17365D" },
    horizontalAlignment: "left",
    borders: { preset: "outside", style: "thin", color: "#9FBAD0" },
  };
}

function styleTableRange(range) {
  range.format.borders = { preset: "all", style: "thin", color: "#D7DEE8" };
  range.getRow(0).format = {
    fill: "#2F75B5",
    font: { bold: true, color: "#FFFFFF" },
    wrapText: true,
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: "#D7DEE8" },
  };
}

function setWidths(sheet, widths, startColumn) {
  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, startColumn + index, 1, 1).format.columnWidth = width;
  });
}

function writeMatrix(sheet, startRow, startColumn, matrix) {
  if (!matrix.length || !matrix[0].length) return;
  sheet.getRangeByIndexes(startRow, startColumn, matrix.length, matrix[0].length).values = matrix;
}

function issue(severity, type, sourceFile, employee, company, value, detail) {
  return { severity, type, sourceFile, employee, company, value, detail };
}

function summarize(rows, keyFunction, resultFunction) {
  return [...groupBy(rows, (row) => JSON.stringify(keyFunction(row))).entries()]
    .map(([key, groupedRows]) => resultFunction(JSON.parse(key), groupedRows))
    .sort((a, b) => (a.company || "").localeCompare(b.company || "", "pt-BR") || (a.competence || "").localeCompare(b.competence || "", "pt-BR"));
}

function groupBy(rows, keyFunction) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFunction(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

async function loadConfig(filePath, keyColumn) {
  try {
    const bytes = await fs.readFile(filePath);
    const { text } = decodeText(bytes);
    const rows = parseCsv(text, ";");
    const map = new Map();
    for (const raw of rows) {
      const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [normalizeKey(key).toLowerCase(), clean(value)]));
      const key = row[normalizeKey(keyColumn).toLowerCase()];
      if (key) map.set(normalizeKey(key), row);
    }
    return map;
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
}

async function loadTariffs(filePath) {
  const config = await loadConfig(filePath, "produto");
  return [...config.values()].map((row) => ({
    product: normalizeKey(row.produto),
    valuePerDay: parseMoney(row.valor_dia),
    start: clean(row.vigencia_inicio),
    end: clean(row.vigencia_fim),
    observation: clean(row.observacao),
  })).filter((row) => row.product && row.valuePerDay > 0);
}

async function loadPayments(filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    const { text } = decodeText(bytes);
    return parseCsv(text, ";").map((raw) => {
      const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [normalizeKey(key), clean(value)]));
      return {
        provider: row.FORNECEDOR || "NÃO INFORMADO",
        competence: row.COMPETENCIA || "NÃO INFORMADA",
        relatedFile: row.ARQUIVO_RELACIONADO,
        creditValue: parseMoney(row.VALOR_CREDITOS),
        paidValue: parseMoney(row.VALOR_PAGO),
        paymentDate: row.DATA_PAGAMENTO,
        observation: row.OBSERVACAO,
      };
    }).filter((row) => row.relatedFile && row.paidValue > 0);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function findTariff(tariffRows, product, competence) {
  const normalized = normalizeKey(product);
  return tariffRows.find((row) => row.product === normalized
    && (!row.start || competence === "NÃO INFORMADA" || competence >= row.start)
    && (!row.end || competence === "NÃO INFORMADA" || competence <= row.end));
}

function computeRoundTripDays(product, rawDays, value) {
  if (!rawDays || rawDays <= 0 || !value) {
    return { days: null, status: "DIAS NÃO INFORMADOS", observation: "" };
  }

  const perUnit = roundMoney(value / rawDays);
  const tariff = inferRoundTripTariff(product, perUnit);
  if (!tariff) {
    return {
      days: null,
      status: "DIAS NÃO COMPUTÁVEIS",
      observation: `Qtd original ${formatNumber(rawDays)} sem tarifa ida/volta reconhecida`,
    };
  }

  const days = roundDays(value / tariff);
  const adjusted = Math.abs(days - rawDays) > 0.001;
  return {
    days,
    status: adjusted ? "DIAS COMPUTADOS IDA/VOLTA" : "DIAS IDA E VOLTA",
    observation: adjusted
      ? `Qtd original ${formatNumber(rawDays)}; tarifa ida/volta ${formatBRL(tariff)}`
      : `Tarifa ida/volta ${formatBRL(tariff)}`,
  };
}

function inferRoundTripTariff(product, perUnit) {
  const normalizedProduct = normalizeKey(product);
  if (normalizedProduct === "ONIBUS MUNICIPAL") return 10.6;
  if (normalizedProduct === "INT.ONIBUS + METRO") return 18.76;
  if (["METRO", "TREM CPTM"].includes(normalizedProduct)) return 10.8;

  if (isNear(perUnit, 5.3) || isNear(perUnit, 10.6)) return 10.6;
  if (isNear(perUnit, 5.4) || isNear(perUnit, 10.8)) return 10.8;
  if (isNear(perUnit, 9.38) || isNear(perUnit, 18.76)) return 18.76;
  return null;
}

function roundDays(value) {
  return Math.round(value * 2) / 2;
}

function isNear(value, target) {
  return Math.abs(Number(value) - target) <= 0.02;
}

async function walk(directory) {
  const output = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(fullPath));
    else output.push(fullPath);
  }
  return output;
}

function parseCsv(text, delimiter) {
  const cleanedText = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < cleanedText.length; index += 1) {
    const character = cleanedText[index];
    if (quoted) {
      if (character === '"' && cleanedText[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const nonEmptyRows = rows.filter((current) => current.some((value) => clean(value)));
  if (nonEmptyRows.length < 2) return [];
  const headers = nonEmptyRows[0];
  return nonEmptyRows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function parseSourceMetadata(text, delimiter) {
  const metadata = {};
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(delimiter).map((part) => clean(part).replace(/^"|"$/g, ""));
    if (parts.length < 2) continue;
    const key = normalizeKey(parts[0]);
    const value = clean(parts[1]);
    if (key === "ID PEDIDO") metadata.id = value;
    if (key === "EMPRESA") metadata.empresa = value;
    if (key === "STATUS DO PEDIDO") metadata.status = value;
    if (key === "VALOR TOTAL") metadata.valor_total = value;
    if (key === "DATA DO PEDIDO") metadata.data = value;
  }
  return metadata;
}

function decodeText(bytes) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index].startsWith("--")) {
      parsed[values[index].slice(2)] = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}

function parseMoney(value) {
  if (typeof value === "number") return value;
  const text = clean(value);
  if (!text) return 0;
  const normalized = text.includes(",") ? text.replaceAll(".", "").replace(",", ".") : text;
  return Number(normalized) || 0;
}

function parseInteger(value) {
  const number = Number(clean(value));
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function parseNumber(value) {
  const text = clean(value);
  if (!text) return null;
  const normalized = text.includes(",") ? text.replaceAll(".", "").replace(",", ".") : text;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeKey(value) {
  return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function normalizeName(value) {
  return clean(value).replace(/\s+/g, " ").toLocaleUpperCase("pt-BR");
}

function clean(value) {
  return String(value ?? "").trim();
}

function yes(value) {
  return ["SIM", "S", "YES", "Y", "TRUE", "1"].includes(normalizeKey(value));
}

function unique(values) {
  return [...new Set(values.filter((value) => clean(value)))];
}

function sum(rows, key) {
  const total = rows.reduce((current, row) => current + (Number(row[key]) || 0), 0);
  return roundMoney(total);
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function sourceOrder(a, b) {
  return a.sourceFile.localeCompare(b.sourceFile, "pt-BR") || a.sourceRow - b.sourceRow;
}

function joinNotes(...notes) {
  return notes.map(clean).filter(Boolean).join(" | ");
}

function severityRank(severity) {
  return { ALTA: 0, MÉDIA: 1, BAIXA: 2 }[severity] ?? 9;
}

function columnLetter(count) {
  let value = count;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function safeFileName(value) {
  return normalizeKey(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function formatBRL(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value);
}
