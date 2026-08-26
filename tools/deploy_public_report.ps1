[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$WorkspaceId,

    [Parameter(Mandatory)]
    [string]$SqlServer,

    [Parameter(Mandatory)]
    [string]$SqlDatabase,

    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$SqlConnectionId,

    [string]$SqlConnectionName = 'M365 FinOps Lakehouse SQL Public',

    [string]$SemanticModelName = 'M365 License FinOps Public Model',

    [string]$ReportName = 'M365 License FinOps Public Report',

    [switch]$ValidateOnly,

    [switch]$SkipRefresh,

    [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
    [string]$RefreshTime = '03:00',

    [string]$RefreshTimeZoneId = 'Tokyo Standard Time',

    [switch]$SkipRefreshSchedule
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$fabricBaseUrl = 'https://api.fabric.microsoft.com/v1'
$powerBiBaseUrl = 'https://api.powerbi.com/v1.0/myorg'
$repoRoot = Split-Path -Parent $PSScriptRoot
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function ConvertTo-PowerQueryText {
    param([Parameter(Mandatory)][string]$Value)

    return $Value.Replace('"', '""')
}

function ConvertTo-PublicModelContent {
    param(
        [Parameter(Mandatory)][string]$RelativePath,
        [Parameter(Mandatory)][string]$Content
    )

    if ($RelativePath -eq 'definition/expressions.tmdl') {
        $server = ConvertTo-PowerQueryText -Value $SqlServer
        $database = ConvertTo-PowerQueryText -Value $SqlDatabase
        return @(
            "expression 'SQL Server' = `"$server`" meta [IsParameterQuery=true, Type=`"Text`", IsParameterQueryRequired=true]"
            ''
            "expression 'SQL Database' = `"$database`" meta [IsParameterQuery=true, Type=`"Text`", IsParameterQueryRequired=true]"
            ''
        ) -join [Environment]::NewLine
    }

    if ($RelativePath -notlike 'definition/tables/*.tmdl') {
        return $Content
    }

    $partitionPattern = '(?ms)^\tpartition (?<partitionName>[^\r\n]+) = entity\r?\n\t\tmode: directLake\r?\n\t\tsource\r?\n\t\t\tentityName: (?<entityName>[^\r\n]+)\r?\n(?:\t\t\tschemaName: (?<schemaName>[^\r\n]+)\r?\n)?\t\t\texpressionSource: [^\r\n]+\s*$'
    $partitionMatch = [regex]::Match($Content, $partitionPattern)
    if (-not $partitionMatch.Success) {
        throw "Could not find a Direct Lake partition in '$RelativePath'."
    }

    $partitionName = $partitionMatch.Groups['partitionName'].Value.Trim()
    $entityName = $partitionMatch.Groups['entityName'].Value.Trim()
    $schemaName = if ($partitionMatch.Groups['schemaName'].Success) {
        $partitionMatch.Groups['schemaName'].Value.Trim()
    }
    else {
        'dbo'
    }
    $replacement = @(
        "`tpartition $partitionName = m"
        "`t`tmode: import"
        "`t`tsource ="
        "`t`t`tlet"
        "`t`t`t`tSource = Sql.Database(#`"SQL Server`", #`"SQL Database`"),"
        "`t`t`t`tData = Source{[Schema=`"$schemaName`", Item=`"$entityName`"]}[Data]"
        "`t`t`tin"
        "`t`t`t`tData"
    ) -join [Environment]::NewLine

    return [regex]::Replace($Content, $partitionPattern, $replacement)
}

function Test-PublicModelTransform {
    param([Parameter(Mandatory)][string]$Root)

    $tableFiles = @(Get-ChildItem -Path (Join-Path $Root 'definition/tables') -Filter '*.tmdl' -File)
    if ($tableFiles.Count -ne 9) {
        throw "Expected 9 semantic model tables, but found $($tableFiles.Count)."
    }

    foreach ($file in $tableFiles) {
        $relativePath = [IO.Path]::GetRelativePath($Root, $file.FullName).Replace('\', '/')
        $content = [IO.File]::ReadAllText($file.FullName)
        $converted = ConvertTo-PublicModelContent -RelativePath $relativePath -Content $content
        if ($converted -match 'mode:\s*directLake' -or $converted -notmatch 'mode:\s*import') {
            throw "Import conversion failed for '$relativePath'."
        }
        if ($converted -notmatch 'Sql\.Database\(#"SQL Server", #"SQL Database"\)') {
            throw "SQL source conversion failed for '$relativePath'."
        }
    }

    $expressionsPath = Join-Path $Root 'definition/expressions.tmdl'
    $expressions = ConvertTo-PublicModelContent `
        -RelativePath 'definition/expressions.tmdl' `
        -Content ([IO.File]::ReadAllText($expressionsPath))
    if ($expressions -match 'AzureStorage\.DataLake' -or $expressions -notmatch "expression 'SQL Server'") {
        throw 'SQL parameter conversion failed for definition/expressions.tmdl.'
    }

    Write-Host "Validated Import conversion for $($tableFiles.Count) tables."
}

function ConvertTo-DefinitionPart {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )

    return @{
        path = $Path.Replace('\', '/')
        payload = [Convert]::ToBase64String($utf8NoBom.GetBytes($Content))
        payloadType = 'InlineBase64'
    }
}

function Get-DirectoryDefinitionParts {
    param(
        [Parameter(Mandatory)][string]$Root,
        [scriptblock]$Transform
    )

    $resolvedRoot = (Resolve-Path $Root).Path
    $parts = @()
    Get-ChildItem -Path $resolvedRoot -Recurse -File | ForEach-Object {
        $relativePath = [IO.Path]::GetRelativePath($resolvedRoot, $_.FullName).Replace('\', '/')
        if ($relativePath -eq '.platform') {
            return
        }
        $content = [IO.File]::ReadAllText($_.FullName)
        if ($Transform) {
            $content = & $Transform $relativePath $content
        }
        $parts += ConvertTo-DefinitionPart -Path $relativePath -Content $content
    }
    return $parts
}

function Get-AccessToken {
    param([Parameter(Mandatory)][string]$Resource)

    $token = & az account get-access-token `
        --subscription $SubscriptionId `
        --resource $Resource `
        --query accessToken `
        --output tsv
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
        throw "Could not acquire an access token for '$Resource'."
    }
    return $token.Trim()
}

function Wait-FabricOperation {
    param(
        [Parameter(Mandatory)][string]$Location,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $operation = Invoke-RestMethod -Method Get -Uri $Location -Headers $Headers
        if ($operation.status -eq 'Succeeded') {
            return
        }
        if ($operation.status -eq 'Failed') {
            $message = if ($operation.error.message) { $operation.error.message } else { 'Unknown error' }
            throw "Fabric operation failed: $message"
        }
        Start-Sleep -Seconds 2
    }
    throw "Fabric operation did not complete within three minutes: $Location"
}

function Invoke-FabricDefinitionRequest {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][hashtable]$Body,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $json = $Body | ConvertTo-Json -Depth 40 -Compress
    $response = Invoke-WebRequest `
        -Method Post `
        -Uri $Uri `
        -Headers $Headers `
        -ContentType 'application/json; charset=utf-8' `
        -Body $utf8NoBom.GetBytes($json)
    if ($response.StatusCode -eq 202) {
        $location = @($response.Headers.Location)[0]
        if ([string]::IsNullOrWhiteSpace($location)) {
            throw "Fabric returned 202 without an operation URL: $Uri"
        }
        Wait-FabricOperation -Location $location -Headers $Headers
    }
}

function Get-FabricItem {
    param(
        [Parameter(Mandatory)][string]$Type,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $items = @(
        (Invoke-RestMethod `
            -Method Get `
            -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/items" `
            -Headers $Headers).value |
            Where-Object { $_.type -eq $Type -and $_.displayName -eq $DisplayName }
    )
    if ($items.Count -gt 1) {
        throw "More than one $Type item is named '$DisplayName'."
    }
    if ($items.Count -eq 1) {
        return $items[0]
    }
    return $null
}

function Set-FabricItem {
    param(
        [Parameter(Mandatory)][string]$Type,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][array]$Parts,
        [Parameter(Mandatory)][hashtable]$Headers,
        [string]$DefinitionFormat,
        [string]$Description
    )

    $item = Get-FabricItem -Type $Type -DisplayName $DisplayName -Headers $Headers
    $definition = @{ parts = $Parts }
    if (-not [string]::IsNullOrWhiteSpace($DefinitionFormat)) {
        $definition.format = $DefinitionFormat
    }

    if ($null -eq $item) {
        Write-Host "Creating $Type '$DisplayName'..."
        Invoke-FabricDefinitionRequest `
            -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/items" `
            -Headers $Headers `
            -Body @{
                displayName = $DisplayName
                type = $Type
                definition = $definition
                description = $Description
            }
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $item = Get-FabricItem -Type $Type -DisplayName $DisplayName -Headers $Headers
            if ($null -ne $item) {
                break
            }
            Start-Sleep -Seconds 2
        }
        if ($null -eq $item) {
            throw "Created $Type '$DisplayName', but its item ID could not be resolved."
        }
    }
    else {
        Write-Host "Updating $Type '$DisplayName'..."
        Invoke-FabricDefinitionRequest `
            -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/items/$($item.id)/updateDefinition" `
            -Headers $Headers `
            -Body @{ definition = $definition }
    }

    return $item
}

function Resolve-SqlConnection {
    param([Parameter(Mandatory)][hashtable]$Headers)

    $connections = @(
        (Invoke-RestMethod `
            -Method Get `
            -Uri "$fabricBaseUrl/connections" `
            -Headers $Headers).value
    )
    if (-not [string]::IsNullOrWhiteSpace($SqlConnectionId)) {
        $matches = @($connections | Where-Object { $_.id -eq $SqlConnectionId })
    }
    else {
        $expectedPath = "$SqlServer;$SqlDatabase"
        $matches = @($connections | Where-Object {
                $_.displayName -eq $SqlConnectionName -and
                $_.connectionDetails.type -eq 'SQL' -and
                $_.connectionDetails.path -ieq $expectedPath
            })
    }

    if ($matches.Count -eq 0) {
        throw "No OAuth SQL connection was found for '$SqlServer;$SqlDatabase'. Create '$SqlConnectionName' in Fabric Manage connections and gateways, or pass -SqlConnectionId."
    }
    if ($matches.Count -gt 1) {
        throw "Multiple matching SQL connections were found. Pass -SqlConnectionId explicitly."
    }
    if ($matches[0].connectivityType -ne 'ShareableCloud' -or
        $matches[0].credentialDetails.credentialType -ne 'OAuth2') {
        throw "Connection '$($matches[0].displayName)' must be a ShareableCloud SQL connection with OAuth2 credentials."
    }
    return $matches[0]
}

function Set-ModelConnection {
    param(
        [Parameter(Mandatory)][string]$SemanticModelId,
        [Parameter(Mandatory)][string]$ConnectionId,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $response = Invoke-RestMethod `
        -Method Get `
        -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/items/$SemanticModelId/connections" `
        -Headers $Headers
    $references = @($response.value)
    if ($references.Count -eq 0) {
        Write-Warning 'The semantic model exposed no data source references to bind.'
        return
    }

    foreach ($reference in $references) {
        $details = $reference.connectionDetails
        $body = @{
            connectionBinding = @{
                id = $ConnectionId
                connectivityType = 'ShareableCloud'
                connectionDetails = @{
                    type = $details.type
                    path = $details.path
                }
            }
        } | ConvertTo-Json -Depth 10 -Compress
        Invoke-RestMethod `
            -Method Post `
            -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/semanticModels/$SemanticModelId/bindConnection" `
            -Headers $Headers `
            -ContentType 'application/json; charset=utf-8' `
            -Body $utf8NoBom.GetBytes($body) |
            Out-Null
    }
}

function Invoke-SemanticModelRefresh {
    param(
        [Parameter(Mandatory)][string]$SemanticModelId,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $refreshStarted = [DateTimeOffset]::UtcNow.AddMinutes(-1)
    Invoke-RestMethod `
        -Method Post `
        -Uri "$powerBiBaseUrl/groups/$WorkspaceId/datasets/$SemanticModelId/refreshes" `
        -Headers $Headers `
        -ContentType 'application/json; charset=utf-8' `
        -Body '{"notifyOption":"NoNotification"}' |
        Out-Null

    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $history = Invoke-RestMethod `
            -Method Get `
            -Uri "$powerBiBaseUrl/groups/$WorkspaceId/datasets/$SemanticModelId/refreshes?`$top=5" `
            -Headers $Headers
        $refresh = @($history.value | Where-Object {
                [DateTimeOffset]$_.startTime -ge $refreshStarted
            } | Select-Object -First 1)
        if ($refresh.Count -eq 1 -and $refresh[0].status -eq 'Completed') {
            return
        }
        if ($refresh.Count -eq 1 -and $refresh[0].status -in @('Failed', 'Cancelled', 'Disabled')) {
            throw "Semantic model refresh ended with status '$($refresh[0].status)': $($refresh[0].serviceExceptionJson)"
        }
        Start-Sleep -Seconds 5
    }
    throw 'Semantic model refresh did not complete within eight minutes.'
}

function Set-SemanticModelRefreshSchedule {
    param(
        [Parameter(Mandatory)][string]$SemanticModelId,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $body = @{
        value = @{
            enabled = $true
            days = @(
                'Monday',
                'Tuesday',
                'Wednesday',
                'Thursday',
                'Friday',
                'Saturday',
                'Sunday'
            )
            times = @($RefreshTime)
            localTimeZoneId = $RefreshTimeZoneId
            notifyOption = 'NoNotification'
        }
    } | ConvertTo-Json -Depth 10 -Compress
    Invoke-RestMethod `
        -Method Patch `
        -Uri "$powerBiBaseUrl/groups/$WorkspaceId/datasets/$SemanticModelId/refreshSchedule" `
        -Headers $Headers `
        -ContentType 'application/json; charset=utf-8' `
        -Body $utf8NoBom.GetBytes($body) |
        Out-Null
}

$semanticModelRoot = Join-Path $repoRoot 'demo/M365LicenseFinOps.SemanticModel'
Test-PublicModelTransform -Root $semanticModelRoot
if ($ValidateOnly) {
    return
}

$fabricToken = Get-AccessToken -Resource 'https://api.fabric.microsoft.com'
$powerBiToken = Get-AccessToken -Resource 'https://analysis.windows.net/powerbi/api'
$fabricHeaders = @{
    Authorization = "Bearer $fabricToken"
    'x-ms-fabric-skill' = 'semantic-model-authoring'
}
$powerBiHeaders = @{ Authorization = "Bearer $powerBiToken" }
$sqlConnection = Resolve-SqlConnection -Headers $fabricHeaders

$semanticModelParts = Get-DirectoryDefinitionParts `
    -Root $semanticModelRoot `
    -Transform {
        param($relativePath, $content)
        ConvertTo-PublicModelContent -RelativePath $relativePath -Content $content
    }
$semanticModel = Set-FabricItem `
    -Type 'SemanticModel' `
    -DisplayName $SemanticModelName `
    -Description 'Import-mode copy for anonymous Publish to web. The Direct Lake model remains the internal source of truth.' `
    -DefinitionFormat 'TMDL' `
    -Parts $semanticModelParts `
    -Headers $fabricHeaders

Set-ModelConnection `
    -SemanticModelId $semanticModel.id `
    -ConnectionId $sqlConnection.id `
    -Headers $fabricHeaders

if (-not $SkipRefresh) {
    Write-Host "Refreshing SemanticModel '$SemanticModelName'..."
    Invoke-SemanticModelRefresh `
        -SemanticModelId $semanticModel.id `
        -Headers $powerBiHeaders
}
if (-not $SkipRefreshSchedule) {
    Write-Host "Scheduling SemanticModel refresh at $RefreshTime ($RefreshTimeZoneId)..."
    Set-SemanticModelRefreshSchedule `
        -SemanticModelId $semanticModel.id `
        -Headers $powerBiHeaders
}

$reportRoot = Join-Path $repoRoot 'demo/M365LicenseFinOps.Report'
$reportParts = Get-DirectoryDefinitionParts `
    -Root $reportRoot `
    -Transform {
        param($relativePath, $content)
        if ($relativePath -eq 'definition.pbir') {
            return $content -replace `
                'semanticmodelid=[0-9a-fA-F-]{36}', `
                "semanticmodelid=$($semanticModel.id)"
        }
        return $content
    }
$report = Set-FabricItem `
    -Type 'Report' `
    -DisplayName $ReportName `
    -Description 'Public demo copy backed by an Import semantic model for anonymous Publish to web.' `
    -Parts $reportParts `
    -Headers $fabricHeaders

Write-Host ''
Write-Host 'Public report deployment completed.'
Write-Host "SQL connection: $($sqlConnection.id)"
Write-Host "Semantic model: $($semanticModel.id)"
Write-Host "Report:         $($report.id)"

$fabricToken = $null
$powerBiToken = $null