[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$WorkspaceId,

    [Parameter(Mandatory)]
    [string]$SemanticModelId,

    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$OutputPath = 'docs/static-demo/data.js'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedOutputPath = if ([IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath
}
else {
    Join-Path $repoRoot $OutputPath
}
$outputDirectory = Split-Path -Parent $resolvedOutputPath
if (-not (Test-Path $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$token = & az account get-access-token `
    --subscription $SubscriptionId `
    --resource 'https://analysis.windows.net/powerbi/api' `
    --query accessToken `
    --output tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    throw 'Could not acquire a Power BI access token with Azure CLI.'
}
$headers = @{ Authorization = "Bearer $($token.Trim())" }
$queryEndpoint = "https://api.powerbi.com/v1.0/myorg/groups/$WorkspaceId/datasets/$SemanticModelId/executeQueries"

function ConvertTo-NormalizedRow {
    param([Parameter(Mandatory)][psobject]$Row)

    $normalized = [ordered]@{}
    foreach ($property in $Row.PSObject.Properties) {
        $name = $property.Name
        if ($name.StartsWith('[') -and $name.EndsWith(']')) {
            $name = $name.Substring(1, $name.Length - 2)
        }
        elseif ($name -match '^.+\[(.+)\]$') {
            $name = $Matches[1]
        }
        $normalized[$name] = $property.Value
    }
    return [pscustomobject]$normalized
}

function Invoke-DaxTableQuery {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Query
    )

    Write-Host "Exporting $Name..."
    $body = @{
        queries = @(@{ query = $Query })
        serializerSettings = @{ includeNulls = $true }
    } | ConvertTo-Json -Depth 10 -Compress
    $response = Invoke-RestMethod `
        -Method Post `
        -Uri $queryEndpoint `
        -Headers $headers `
        -ContentType 'application/json; charset=utf-8' `
        -Body $body
    $errorProperty = $response.results[0].PSObject.Properties['error']
    $errorMessage = if ($null -ne $errorProperty) {
        $errorProperty.Value.message
    }
    else {
        $null
    }
    if (-not [string]::IsNullOrWhiteSpace($errorMessage)) {
        throw "DAX export failed for '$Name': $errorMessage"
    }
    return @(
        $response.results[0].tables[0].rows |
            ForEach-Object { ConvertTo-NormalizedRow -Row $_ }
    )
}

$queries = [ordered]@{
    users = @'
EVALUATE
SELECTCOLUMNS(
    'User',
    "userId", 'User'[User ID],
    "userPrincipalName", 'User'[User Principal Name],
    "displayName", 'User'[Display Name],
    "department", 'User'[Department],
    "jobTitle", 'User'[Job Title],
    "company", 'User'[Company],
    "officeLocation", 'User'[Office Location],
    "country", 'User'[Country],
    "city", 'User'[City],
    "employeeId", 'User'[Employee ID],
    "division", 'User'[Division],
    "costCenter", 'User'[Cost Center],
    "accountEnabled", 'User'[Account Enabled],
    "userType", 'User'[User Type],
    "snapshotDate", 'User'[Snapshot Date]
)
'@
    skus = @'
EVALUATE
SELECTCOLUMNS(
    'License SKU',
    "skuId", 'License SKU'[SKU ID],
    "skuPartNumber", 'License SKU'[SKU Part Number],
    "licenseName", 'License SKU'[License Name],
    "capabilityStatus", 'License SKU'[Capability Status],
    "purchasedUnits", 'License SKU'[Purchased Units],
    "assignedUnits", 'License SKU'[Assigned Units],
    "availableUnits", 'License SKU'[Available Units],
    "snapshotDate", 'License SKU'[Snapshot Date]
)
'@
    prices = @'
EVALUATE
SELECTCOLUMNS(
    'SKU Price',
    "skuId", 'SKU Price'[SKU ID],
    "monthlyUnitPrice", 'SKU Price'[Monthly Unit Price],
    "currency", 'SKU Price'[Currency],
    "priceSource", 'SKU Price'[Price Source],
    "effectiveFrom", 'SKU Price'[Effective From]
)
'@
    utilization = @'
EVALUATE
VAR LatestDate = CALCULATE(MAX('License Utilization'[Snapshot Date]), ALL('License Utilization'))
RETURN
SELECTCOLUMNS(
    FILTER('License Utilization', 'License Utilization'[Snapshot Date] = LatestDate),
    "snapshotDate", 'License Utilization'[Snapshot Date],
    "userId", 'License Utilization'[User ID],
    "skuId", 'License Utilization'[SKU ID],
    "lastActivityDate", 'License Utilization'[Last Activity Date],
    "inactiveDays", 'License Utilization'[Inactive Days],
    "utilizationStatus", 'License Utilization'[Utilization Status]
)
'@
    assignments = @'
EVALUATE
VAR LatestDate = CALCULATE(MAX('License Assignment'[Snapshot Date]), ALL('License Assignment'))
RETURN
SELECTCOLUMNS(
    FILTER('License Assignment', 'License Assignment'[Snapshot Date] = LatestDate),
    "snapshotDate", 'License Assignment'[Snapshot Date],
    "userId", 'License Assignment'[User ID],
    "skuId", 'License Assignment'[SKU ID],
    "assignmentState", 'License Assignment'[Assignment State],
    "assignmentSource", 'License Assignment'[Assignment Source],
    "assignedByGroupId", 'License Assignment'[Assigned by Group ID],
    "lastUpdatedDateTime", 'License Assignment'[Last Updated Date Time]
)
'@
    m365Usage = @'
EVALUATE
VAR LatestDate = CALCULATE(MAX('M365 Usage'[Snapshot Date]), ALL('M365 Usage'))
RETURN
SELECTCOLUMNS(
    FILTER('M365 Usage', 'M365 Usage'[Snapshot Date] = LatestDate),
    "snapshotDate", 'M365 Usage'[Snapshot Date],
    "reportRefreshDate", 'M365 Usage'[Report Refresh Date],
    "userId", 'M365 Usage'[User ID],
    "userPrincipalName", 'M365 Usage'[User Principal Name],
    "overallLastActivityDate", 'M365 Usage'[Overall Last Activity Date],
    "exchangeLastActivityDate", 'M365 Usage'[Exchange Last Activity Date],
    "oneDriveLastActivityDate", 'M365 Usage'[OneDrive Last Activity Date],
    "sharePointLastActivityDate", 'M365 Usage'[SharePoint Last Activity Date],
    "teamsLastActivityDate", 'M365 Usage'[Teams Last Activity Date],
    "assignedProducts", 'M365 Usage'[Assigned Products],
    "reportPeriodDays", 'M365 Usage'[Report Period Days]
)
'@
    copilotUsage = @'
EVALUATE
VAR LatestDate = CALCULATE(MAX('Copilot Usage'[Snapshot Date]), ALL('Copilot Usage'))
RETURN
SELECTCOLUMNS(
    FILTER('Copilot Usage', 'Copilot Usage'[Snapshot Date] = LatestDate),
    "snapshotDate", 'Copilot Usage'[Snapshot Date],
    "reportRefreshDate", 'Copilot Usage'[Report Refresh Date],
    "userId", 'Copilot Usage'[User ID],
    "userPrincipalName", 'Copilot Usage'[User Principal Name],
    "lastActivityDate", 'Copilot Usage'[Last Activity Date],
    "promptsAnyApp", 'Copilot Usage'[Prompts Any App],
    "promptsWork", 'Copilot Usage'[Prompts Work],
    "promptsWeb", 'Copilot Usage'[Prompts Web],
    "activeUsageDays", 'Copilot Usage'[Active Usage Days],
    "reportPeriodDays", 'Copilot Usage'[Report Period Days]
)
'@
    entitlements = @'
EVALUATE
VAR LatestDate = CALCULATE(MAX('Service Entitlement'[Snapshot Date]), ALL('Service Entitlement'))
RETURN
SELECTCOLUMNS(
    FILTER('Service Entitlement', 'Service Entitlement'[Snapshot Date] = LatestDate),
    "snapshotDate", 'Service Entitlement'[Snapshot Date],
    "userId", 'Service Entitlement'[User ID],
    "skuId", 'Service Entitlement'[SKU ID],
    "servicePlanId", 'Service Entitlement'[Service Plan ID],
    "isEnabled", 'Service Entitlement'[Is Enabled],
    "skuProvisioningStatus", 'Service Entitlement'[SKU Provisioning Status]
)
'@
    servicePlans = @'
EVALUATE
SELECTCOLUMNS(
    'Service Plan',
    "servicePlanId", 'Service Plan'[Service Plan ID],
    "servicePlanName", 'Service Plan'[サービスプラン品番],
    "featureName", 'Service Plan'[機能名],
    "category", 'Service Plan'[カテゴリ],
    "decisionScope", 'Service Plan'[判断区分],
    "decisionNote", 'Service Plan'[確認ポイント],
    "isReportable", 'Service Plan'[レポート表示対象],
    "appliesTo", 'Service Plan'[Applies To]
)
'@
}

$data = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    source = [ordered]@{
        workspaceId = $WorkspaceId
        semanticModelId = $SemanticModelId
        mode = 'Fixed demo snapshot'
    }
}
foreach ($entry in $queries.GetEnumerator()) {
    $data[$entry.Key] = Invoke-DaxTableQuery -Name $entry.Key -Query $entry.Value
}

$json = $data | ConvertTo-Json -Depth 20 -Compress
$content = "window.STATIC_DEMO_DATA = $json;`n"
[IO.File]::WriteAllText($resolvedOutputPath, $content, [Text.UTF8Encoding]::new($false))

Write-Host ''
Write-Host "Static demo data written to $resolvedOutputPath"
foreach ($name in $queries.Keys) {
    Write-Host ("{0,-16} {1,6}" -f $name, @($data[$name]).Count)
}

$token = $null