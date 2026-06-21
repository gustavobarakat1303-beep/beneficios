# Auditoria Mensal de Vale-Transporte

Projeto reutilizavel para consolidar pagamentos de vale-transporte por empresa e funcionario.

## O que o relatorio entrega

- quanto foi pago por empresa e por funcionario;
- quantidade de dias pagos quando o arquivo informa `DIAS`;
- dias calculados somente quando existe tarifa confiavel cadastrada;
- total bruto recebido e total sem duplicidade exata;
- pagamentos possivelmente duplicados para revisao;
- inconsistencias de empresa, competencia, dias e arquivos;
- trilha de fontes e checagens de reconciliacao.

## Fluxo mensal

1. Coloque os novos CSVs em uma subpasta de `entradas`.
2. Preencha `config/arquivos.csv` para arquivos que nao informam empresa ou competencia.
3. Se um arquivo nao trouxer dias, cadastre a tarifa diaria em `config/tarifas.csv`.
4. Registre os pagamentos efetivos aos fornecedores em `config/pagamentos.csv`.
5. Execute:

```powershell
.\executar_auditoria.ps1 -Competencia "2026-06"
```

O Excel sera criado em `outputs/auditoria_vt_AAAAMMDD`.

Os arquivos reais de `entradas/`, `outputs/` e `config/*.csv` ficam fora do Git por conterem dados operacionais e de funcionarios. Para iniciar em outro ambiente, copie:

- `config/arquivos.example.csv` para `config/arquivos.csv`
- `config/pagamentos.example.csv` para `config/pagamentos.csv`
- `config/tarifas.example.csv` para `config/tarifas.csv`

Para verificar novamente um arquivo exportado:

```powershell
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  .\verificar_relatorio.mjs ".\outputs\auditoria_vt_AAAAMMDD\relatorio.xlsx"
```

## Regras importantes

- Nenhum dia e estimado sem campo `DIAS` ou tarifa cadastrada que feche exatamente com o valor.
- O valor pago ao fornecedor fica separado do valor creditado aos funcionários e das taxas.
- A quantidade de dias deve representar dia completo de ida e volta. Quando o arquivo vier em trechos/viagens, o relatório converte para dias de ida e volta usando a tarifa reconhecida.
- Duplicidades exatas sao retiradas apenas da coluna `Valor sem duplicidade exata`; o total bruto permanece visivel.
- Possiveis duplicidades nao sao excluidas automaticamente.
- Arquivos `.crdownload` sao lidos, mas ficam sinalizados para confirmacao.
- Quando empresa ou competencia nao estiverem nos arquivos/configuracao, o relatorio usa `NAO INFORMADA`.

## Configuracao de arquivos

Campos de `config/arquivos.csv`:

- `arquivo`: nome exato do arquivo;
- `empresa`: empresa a atribuir ao arquivo;
- `competencia`: mes no formato `AAAA-MM`;
- `ignorar`: use `sim` para nao incluir o arquivo;
- `observacao`: nota livre para auditoria.

## Configuracao de tarifas

Campos de `config/tarifas.csv`:

- `produto`: nome exato ou normalizado do produto;
- `valor_dia`: tarifa total diaria;
- `vigencia_inicio` e `vigencia_fim`: opcionais, no formato `AAAA-MM`;
- `observacao`: fonte ou justificativa da tarifa.
