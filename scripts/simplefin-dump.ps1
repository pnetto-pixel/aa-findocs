<#
.SYNOPSIS
    Dump completo do que a SimpleFin Bridge devolve -- por padrao so a(s)
    conta(s) Fidelity, mas o filtro de instituicao e configuravel.

.DESCRIPTION
    Roda fora do app (PowerShell 5.1 ou 7+), direto contra a SimpleFin Bridge.
    Diferente do sync do app (api/fidelity-pending.js + lib/simplefin-map.js), que
    so extrai o que o portfolio precisa (cash, bank bonds, dividendos, deltas de
    posicao), este script NAO filtra nem interpreta nada: mostra todos os campos
    que a Bridge retorna, inclusive os que o app hoje ignora.

    Saida:
      - tabelas no console (contas, holdings, transactions)
      - CSVs por secao + JSON bruto na pasta de saida
      - inventario de TODAS as chaves vistas em cada nivel do payload
        (e o jeito de descobrir se a Bridge passou a mandar campo novo)

    Por padrao filtra org.name/org.domain contendo "fidelity" -- mesma regra
    mandatoria do mapper (isFidelityOrg em lib/simplefin-map.js). Uma conexao
    SimpleFin devolve TODAS as instituicoes linkadas no Bridge, entao sem esse
    filtro o dump inclui contas bancarias pessoais nao relacionadas.

    O filtro e configuravel para os casos em que voce QUER as outras contas
    (exportar o resto pra outra ferramenta, conferir o que mais esta linkado):
      -Org <texto>   troca o alvo do filtro (default "fidelity")
      -ExcludeOrg    inverte -- pega tudo EXCETO quem casa com -Org
      -AllOrgs       nao filtra nada
    Nenhuma dessas opcoes afeta o app: elas so existem neste script manual, e o
    mapper do sync continua com o filtro Fidelity fixo e obrigatorio.

.PARAMETER AccessUrl
    O SimpleFin access URL, com credenciais embutidas:
    https://usuario:senha@bridge.simplefin.org/simplefin
    E o mesmo valor da env var SIMPLEFIN_ACCESS_URL no Vercel.
    Se omitido, o script usa $env:SIMPLEFIN_ACCESS_URL ou pergunta.

.PARAMETER Days
    Janela de transacoes, em dias (default 90). A Bridge trava em 90 dias no
    maximo, e emite um aviso em payload.errors acima de ~45 dias (aviso, nao
    erro -- o app usa 44 justamente pra nunca ver esse aviso).

.PARAMETER OutDir
    Pasta de saida (default .\simplefin-out).

.PARAMETER Org
    Texto procurado em org.name/org.domain, case-insensitive (default
    "fidelity"). Ignorado quando -AllOrgs esta ligado.

.PARAMETER ExcludeOrg
    Inverte o filtro: dumpa tudo EXCETO as contas que casam com -Org. Com os
    defaults, "-ExcludeOrg" = "todas as instituicoes menos a Fidelity".

.PARAMETER AllOrgs
    Nao filtra nada -- dumpa toda instituicao linkada, Fidelity inclusive.

.PARAMETER NoCsv
    So mostra no console, nao escreve arquivo nenhum.

.EXAMPLE
    .\simplefin-dump.ps1

.EXAMPLE
    .\simplefin-dump.ps1 -AccessUrl "https://user:pass@bridge.simplefin.org/simplefin" -Days 90

.EXAMPLE
    # tudo menos a Fidelity (exportar as contas bancarias pra outra ferramenta)
    .\simplefin-dump.ps1 -ExcludeOrg -OutDir .\simplefin-bancos

.EXAMPLE
    .\simplefin-dump.ps1 -Org chase

.EXAMPLE
    .\simplefin-dump.ps1 -AllOrgs -OutDir C:\temp\sf
#>

[CmdletBinding()]
param(
    [string] $AccessUrl,
    [int]    $Days = 90,
    [string] $OutDir = ".\simplefin-out",
    [string] $Org = "fidelity",
    [switch] $ExcludeOrg,
    [switch] $AllOrgs,
    [switch] $NoCsv
)

$ErrorActionPreference = 'Stop'

# PS 5.1 no Windows ainda negocia TLS 1.0 por padrao em algumas maquinas.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

# ---------------------------------------------------------------- helpers ---

# Le uma propriedade aceitando as duas convencoes que a Bridge mistura:
# snake_case nos holdings (market_value, cost_basis) e kebab-case na conta
# (available-balance, balance-date). Retorna $null se nenhuma existir.
function Get-Prop {
    param([object] $Obj, [string[]] $Names)
    if ($null -eq $Obj) { return $null }
    foreach ($n in $Names) {
        $p = $Obj.PSObject.Properties[$n]
        if ($p -and $null -ne $p.Value -and "$($p.Value)" -ne '') { return $p.Value }
    }
    return $null
}

# Unix seconds -> "yyyy-MM-dd HH:mm". Devolve o valor cru se nao for numero.
function ConvertFrom-UnixSeconds {
    param($Value)
    if ($null -eq $Value -or "$Value" -eq '') { return $null }
    $n = 0L
    if (-not [Int64]::TryParse("$Value", [ref] $n)) { return "$Value" }
    try { return [DateTimeOffset]::FromUnixTimeSeconds($n).ToLocalTime().ToString('yyyy-MM-dd HH:mm') }
    catch { return "$Value" }
}

function ConvertTo-Decimal {
    param($Value)
    if ($null -eq $Value -or "$Value" -eq '') { return $null }
    $d = 0.0
    if ([double]::TryParse("$Value", [Globalization.NumberStyles]::Any, [Globalization.CultureInfo]::InvariantCulture, [ref] $d)) { return $d }
    return $null
}

# Todas as chaves distintas vistas numa colecao de objetos, com quantas vezes
# apareceram preenchidas. E como se descobre campo novo que a Bridge comecou a
# mandar e o app ainda nao le.
function Get-KeyInventory {
    param([object[]] $Items, [string] $Level)
    $counts = @{}
    $total  = 0
    foreach ($it in $Items) {
        if ($null -eq $it) { continue }
        $total++
        foreach ($p in $it.PSObject.Properties) {
            $filled = ($null -ne $p.Value) -and ("$($p.Value)" -ne '')
            if (-not $counts.ContainsKey($p.Name)) { $counts[$p.Name] = 0 }
            if ($filled) { $counts[$p.Name]++ }
        }
    }
    $counts.Keys | Sort-Object | ForEach-Object {
        [pscustomobject]@{
            Level    = $Level
            Field    = $_
            Filled   = $counts[$_]
            OfTotal  = $total
        }
    }
}

function Write-Section {
    param([string] $Title)
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor DarkGray
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor DarkGray
}

# ------------------------------------------------------------------ input ---

if (-not $AccessUrl) { $AccessUrl = $env:SIMPLEFIN_ACCESS_URL }
if (-not $AccessUrl) {
    Write-Host 'Cole o SimpleFin access URL (o mesmo valor da env SIMPLEFIN_ACCESS_URL no Vercel).' -ForegroundColor Yellow
    $secure = Read-Host -Prompt 'Access URL' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $AccessUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
$AccessUrl = $AccessUrl.Trim().Trim('"').Trim("'")
if (-not $AccessUrl) { throw 'Access URL vazio.' }

# O access URL carrega Basic Auth no userinfo. Nem todo cliente HTTP repassa
# userinfo automaticamente, entao extraimos e mandamos header explicito contra a
# URL sem credenciais (mesma abordagem de parseSimplefinUrl em api/fidelity-pending.js).
try {
    $ub   = New-Object System.UriBuilder $AccessUrl
    $user = [uri]::UnescapeDataString($ub.UserName)
    $pass = [uri]::UnescapeDataString($ub.Password)
    $ub.UserName = ''
    $ub.Password = ''
    $baseUrl = $ub.Uri.AbsoluteUri.TrimEnd('/')
} catch {
    throw "Access URL malformado: $($_.Exception.Message)"
}
if (-not $user -or -not $pass) {
    throw 'O access URL nao tem usuario:senha embutidos -- confira se copiou o valor completo.'
}

$authHeader = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(('{0}:{1}' -f $user, $pass)))

if ($Days -lt 1)  { $Days = 1 }
if ($Days -gt 90) {
    Write-Host "A Bridge trava em 90 dias; reduzindo $Days -> 90." -ForegroundColor Yellow
    $Days = 90
}

$startDate  = [DateTimeOffset]::UtcNow.AddDays(-$Days).ToUnixTimeSeconds()
# pending=1 pede transacoes ainda nao liquidadas (o app nao usa; aqui queremos tudo).
$requestUrl = "$baseUrl/accounts?start-date=$startDate&pending=1"

Write-Host ''
Write-Host "GET $baseUrl/accounts  (janela: $Days dias, desde $([DateTimeOffset]::FromUnixTimeSeconds($startDate).ToLocalTime().ToString('yyyy-MM-dd')))" -ForegroundColor DarkGray

# ------------------------------------------------------------------ fetch ---

try {
    $resp = Invoke-WebRequest -Uri $requestUrl -Headers @{ Authorization = $authHeader } -Method Get -UseBasicParsing -TimeoutSec 120
} catch {
    $status = $null
    try { $status = $_.Exception.Response.StatusCode.value__ } catch { }
    if ($status -eq 403) { throw "SimpleFin devolveu HTTP 403 -- access URL invalido ou revogado." }
    if ($status) { throw "SimpleFin devolveu HTTP $status." }
    throw "Falha na chamada a SimpleFin: $($_.Exception.Message)"
}

$rawJson = $resp.Content
$payload = $rawJson | ConvertFrom-Json

$allAccounts = @()
if ($payload.PSObject.Properties['accounts'] -and $payload.accounts) { $allAccounts = @($payload.accounts) }

$orgPattern = "*$($Org.ToLowerInvariant())*"
$accounts = $allAccounts
if (-not $AllOrgs) {
    $accounts = @($allAccounts | Where-Object {
        $hay = (("$($_.org.name) $($_.org.domain)")).ToLowerInvariant()
        if ($ExcludeOrg) { $hay -notlike $orgPattern } else { $hay -like $orgPattern }
    })
}

$filterNote =
    if ($AllOrgs)       { ' (sem filtro, -AllOrgs)' }
    elseif ($ExcludeOrg) { " (tudo menos '$Org')" }
    else                 { " (so '$Org')" }
Write-Host ("Contas no payload: {0}   |   apos filtro: {1}{2}" -f $allAccounts.Count, $accounts.Count, $filterNote) -ForegroundColor DarkGray

if ($payload.PSObject.Properties['errors'] -and $payload.errors -and @($payload.errors).Count -gt 0) {
    Write-Host ''
    Write-Host 'Avisos/erros retornados pela Bridge (payload.errors):' -ForegroundColor Yellow
    @($payload.errors) | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}

if ($accounts.Count -eq 0) {
    Write-Host ''
    Write-Host "Nenhuma conta sobrou depois do filtro$filterNote. Rode com -AllOrgs pra ver que instituicoes vieram." -ForegroundColor Yellow
    if (-not $AllOrgs -and $allAccounts.Count -gt 0) {
        $allAccounts | ForEach-Object { [pscustomobject]@{ Org = $_.org.name; Domain = $_.org.domain; Account = $_.name } } |
            Format-Table -AutoSize | Out-Host
    }
    return
}

# ------------------------------------------------------- montagem das linhas ---

$accountRows     = @()
$holdingRows     = @()
$transactionRows = @()
$rawHoldings     = @()
$rawTransactions = @()

foreach ($a in $accounts) {
    $rawHoldings     += @($a.holdings)
    $rawTransactions += @($a.transactions)

    $accountRows += [pscustomobject]@{
        Org              = $a.org.name
        OrgDomain        = $a.org.domain
        AccountId        = $a.id
        Account          = $a.name
        Currency         = $a.currency
        Balance          = ConvertTo-Decimal $a.balance
        AvailableBalance = ConvertTo-Decimal (Get-Prop $a @('available-balance','available_balance'))
        BalanceDate      = ConvertFrom-UnixSeconds (Get-Prop $a @('balance-date','balance_date'))
        Holdings         = @($a.holdings).Count
        Transactions     = @($a.transactions).Count
    }

    foreach ($h in @($a.holdings)) {
        if ($null -eq $h) { continue }
        $shares    = ConvertTo-Decimal $h.shares
        $marketVal = ConvertTo-Decimal (Get-Prop $h @('market_value','market-value'))
        $costBasis = ConvertTo-Decimal (Get-Prop $h @('cost_basis','cost-basis'))
        $purchase  = ConvertTo-Decimal (Get-Prop $h @('purchase_price','purchase-price'))
        $symbol    = "$($h.symbol)".Trim()
        $desc      = "$($h.description)".Trim()

        # Mesma classificacao que lib/simplefin-map.js usa: holdings sem symbol
        # sao bank bonds/CDs, EXCETO a linha sintetica "CASH" (que tambem vem
        # sem symbol e representa o cash sweep).
        $kind = if ($symbol) { 'stock/etf' }
                elseif ($desc.ToUpperInvariant() -eq 'CASH') { 'cash (sintetico)' }
                else { 'bank bond/CD' }

        # cost_basis as vezes vem total, as vezes ausente; purchase_price e por
        # unidade. Derivar o custo total ajuda a comparar com market_value.
        $totalCost = if ($null -ne $costBasis) { $costBasis }
                     elseif ($null -ne $purchase -and $null -ne $shares) { $purchase * $shares }
                     else { $null }
        $gain = if ($null -ne $marketVal -and $null -ne $totalCost) { $marketVal - $totalCost } else { $null }

        $holdingRows += [pscustomobject]@{
            Account       = $a.name
            Kind          = $kind
            Symbol        = $symbol
            Description   = $desc
            Shares        = $shares
            MarketValue   = $marketVal
            PurchasePrice = $purchase
            CostBasis     = $costBasis
            TotalCost     = $totalCost
            GainLoss      = $gain
            Currency      = $h.currency
            HoldingId     = $h.id
            Created       = ConvertFrom-UnixSeconds $h.created
        }
    }

    foreach ($t in @($a.transactions)) {
        if ($null -eq $t) { continue }
        $transactionRows += [pscustomobject]@{
            Account      = $a.name
            Posted       = ConvertFrom-UnixSeconds $t.posted
            TransactedAt = ConvertFrom-UnixSeconds (Get-Prop $t @('transacted_at','transacted-at'))
            Amount       = ConvertTo-Decimal $t.amount
            Description  = "$($t.description)".Trim()
            Payee        = $t.payee
            Memo         = $t.memo
            Pending      = $t.pending
            TransactionId = $t.id
        }
    }
}

$transactionRows = @($transactionRows | Sort-Object Posted -Descending)
$holdingRows     = @($holdingRows | Sort-Object Kind, @{ Expression = 'MarketValue'; Descending = $true })

# ----------------------------------------------------------------- console ---

Write-Section 'CONTAS'
$accountRows | Format-Table -AutoSize | Out-Host

Write-Section "HOLDINGS ($($holdingRows.Count))"
$holdingRows | Format-Table Kind, Symbol, Description, Shares, MarketValue, PurchasePrice, TotalCost, GainLoss -AutoSize | Out-Host

$byKind = $holdingRows | Group-Object Kind | ForEach-Object {
    # Holdings sem market_value utilizavel sao excluidos da soma (Measure-Object
    # engasga com $null em PS 5.1) — a contagem Positions ainda inclui todos.
    $sum = ($_.Group | Where-Object { $null -ne $_.MarketValue } | Measure-Object MarketValue -Sum).Sum
    [pscustomobject]@{
        Kind        = $_.Name
        Positions   = $_.Count
        MarketValue = if ($null -eq $sum) { 0 } else { [math]::Round($sum, 2) }
    }
}
Write-Host 'Totais por tipo:' -ForegroundColor DarkGray
$byKind | Format-Table -AutoSize | Out-Host

Write-Section "TRANSACOES ($($transactionRows.Count), ultimos $Days dias)"
$transactionRows | Format-Table Posted, Amount, Description, Pending -AutoSize | Out-Host

Write-Section 'CAMPOS DISPONIVEIS NO PAYLOAD'
Write-Host 'Todas as chaves que a Bridge retornou, com quantos itens vieram preenchidos.' -ForegroundColor DarkGray
Write-Host 'Chave que aparece aqui e nao aparece nas tabelas acima = dado que o app ainda nao le.' -ForegroundColor DarkGray
$inventory = @()
$inventory += Get-KeyInventory -Items $accounts        -Level 'account'
$inventory += Get-KeyInventory -Items $rawHoldings     -Level 'holding'
$inventory += Get-KeyInventory -Items $rawTransactions -Level 'transaction'
$inventory | Format-Table -AutoSize | Out-Host

# ------------------------------------------------------------------ arquivos ---

if (-not $NoCsv) {
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    # [IO.File]::WriteAllText resolve caminho relativo contra o CWD do processo,
    # nao contra a location do PowerShell (podem divergir) — resolver antes.
    $OutDir = (Resolve-Path -LiteralPath $OutDir).ProviderPath
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

    $rawPath = Join-Path $OutDir "simplefin-raw-$stamp.json"
    # Reserializa so o subconjunto filtrado, senao o arquivo bruto carrega de
    # volta exatamente as contas que o filtro acabou de excluir.
    $rawOut = if ($AllOrgs) {
        $rawJson
    } else {
        [pscustomobject]@{ errors = $payload.errors; accounts = $accounts } | ConvertTo-Json -Depth 100
    }
    # Out-File -Encoding utf8 grava BOM no PS 5.1, e BOM quebra varios parsers de
    # JSON — escrever direto com UTF8Encoding($false) evita isso. Os CSVs abaixo
    # mantem BOM de proposito (e o que faz o Excel abrir acentuacao correta).
    [IO.File]::WriteAllText($rawPath, $rawOut, (New-Object System.Text.UTF8Encoding($false)))

    $accPath  = Join-Path $OutDir "accounts-$stamp.csv"
    $holdPath = Join-Path $OutDir "holdings-$stamp.csv"
    $txPath   = Join-Path $OutDir "transactions-$stamp.csv"
    $invPath  = Join-Path $OutDir "fields-$stamp.csv"

    $accountRows     | Export-Csv -Path $accPath  -NoTypeInformation -Encoding UTF8
    $holdingRows     | Export-Csv -Path $holdPath -NoTypeInformation -Encoding UTF8
    $transactionRows | Export-Csv -Path $txPath   -NoTypeInformation -Encoding UTF8
    $inventory       | Export-Csv -Path $invPath  -NoTypeInformation -Encoding UTF8

    Write-Section 'ARQUIVOS GERADOS'
    @($rawPath, $accPath, $holdPath, $txPath, $invPath) | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
    Write-Host ''
    Write-Host 'Os CSVs abrem direto no Excel/Numbers. O JSON bruto tem tudo, sem perda.' -ForegroundColor DarkGray
    Write-Host 'Atencao: esses arquivos tem dados financeiros reais -- nao commitar.' -ForegroundColor Yellow
}
