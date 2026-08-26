[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$WorkspaceId,

    [Parameter(Mandatory)]
    [string]$LakehouseId,

    [Parameter(Mandatory)]
    [string]$LakehouseName,

    [Parameter(Mandatory)]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [string]$ClientId,

    [string]$GraphConnectionId,

    [string]$GraphDataSourceId,

    [string]$SubscriptionId,

    [switch]$IncludePriceMaster,

    [switch]$SkipNotebookRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$fabricBaseUrl = 'https://api.fabric.microsoft.com/v1'
$repoRoot = Split-Path -Parent $PSScriptRoot
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Get-FabricToken {
    $tokenArguments = @(
        'account',
        'get-access-token',
        '--resource',
        'https://api.fabric.microsoft.com',
        '--query',
        'accessToken',
        '--output',
        'tsv'
    )
    if ($SubscriptionId) {
        $tokenArguments += @('--subscription', $SubscriptionId)
    }

    $token = & az @tokenArguments
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
        throw 'Could not acquire a Microsoft Fabric access token with Azure CLI.'
    }
    return $token.Trim()
}

$token = Get-FabricToken
$headers = @{ Authorization = "Bearer $token" }

function Resolve-GraphDataSourceId {
    if (-not [string]::IsNullOrWhiteSpace($GraphDataSourceId)) {
        return $GraphDataSourceId
    }

    $connectionName = 'M365 FinOps Microsoft Graph'
    $connections = Invoke-RestMethod `
        -Method Get `
        -Uri "$fabricBaseUrl/connections" `
        -Headers $headers
    $matches = @($connections.value | Where-Object {
            $_.displayName -eq $connectionName -and
            $_.connectionDetails.type -eq 'Web'
        })
    if ($matches.Count -eq 1) {
        Write-Host "Using Fabric connection '$connectionName'."
        return $matches[0].id
    }
    if ($matches.Count -gt 1) {
        throw "Multiple Fabric connections named '$connectionName' exist. Pass -GraphDataSourceId explicitly."
    }

    Write-Host "Creating Fabric connection '$connectionName'..."
    $secureSecret = Read-Host 'Enter the Graph application client secret' -AsSecureString
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    try {
        $clientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
        $connectionBody = @{
            connectivityType = 'ShareableCloud'
            displayName = $connectionName
            connectionDetails = @{
                type = 'Web'
                creationMethod = 'Web'
                parameters = @(
                    @{
                        dataType = 'Text'
                        name = 'url'
                        value = 'https://graph.microsoft.com/v1.0'
                    }
                )
            }
            privacyLevel = 'Organizational'
            credentialDetails = @{
                singleSignOnType = 'None'
                connectionEncryption = 'NotEncrypted'
                skipTestConnection = $true
                credentials = @{
                    credentialType = 'ServicePrincipal'
                    servicePrincipalClientId = $ClientId
                    servicePrincipalSecret = $clientSecret
                    tenantId = $TenantId
                }
            }
            allowUsageInUserControlledCode = $true
        } | ConvertTo-Json -Depth 20 -Compress
        $connection = Invoke-RestMethod `
            -Method Post `
            -Uri "$fabricBaseUrl/connections" `
            -Headers $headers `
            -ContentType 'application/json; charset=utf-8' `
            -Body $utf8NoBom.GetBytes($connectionBody)
        return $connection.id
    }
    finally {
        if ($secretPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
        }
        $clientSecret = $null
        $secureSecret = $null
        $connectionBody = $null
    }
}

$GraphDataSourceId = Resolve-GraphDataSourceId

function Wait-FabricOperation {
    param([Parameter(Mandatory)][string]$Location)

    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $operation = Invoke-RestMethod -Method Get -Uri $Location -Headers $headers
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
        [Parameter(Mandatory)][ValidateSet('Post')][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][hashtable]$Body
    )

    $json = $Body | ConvertTo-Json -Depth 30 -Compress
    $response = Invoke-WebRequest `
        -Method $Method `
        -Uri $Uri `
        -Headers $headers `
        -ContentType 'application/json; charset=utf-8' `
        -Body $utf8NoBom.GetBytes($json)

    if ($response.StatusCode -eq 202) {
        $location = @($response.Headers.Location)[0]
        if ([string]::IsNullOrWhiteSpace($location)) {
            throw "Fabric returned 202 without an operation URL: $Uri"
        }
        Wait-FabricOperation -Location $location
    }
}

function Get-FabricItem {
    param(
        [Parameter(Mandatory)][string]$Type,
        [Parameter(Mandatory)][string]$DisplayName
    )

    $items = @(
        (Invoke-RestMethod `
            -Method Get `
            -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/items" `
            -Headers $headers).value |
            Where-Object { $_.type -eq $Type -and $_.displayName -eq $DisplayName }
    )
    if ($items.Count -gt 1) {
        throw "More than one $Type item is named '$DisplayName'. Rename or remove duplicates."
    }
    if ($items.Count -eq 1) {
        return $items[0]
    }
    return $null
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
        $content = [IO.File]::ReadAllText($_.FullName)
        if ($Transform) {
            $content = & $Transform $relativePath $content
        }
        $parts += ConvertTo-DefinitionPart -Path $relativePath -Content $content
    }
    return $parts
}

function Set-FabricItem {
    param(
        [Parameter(Mandatory)][string]$Type,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][array]$Parts,
        [string]$Description
    )

    $item = Get-FabricItem -Type $Type -DisplayName $DisplayName
    if ($null -eq $item) {
        Write-Host "Creating $Type '$DisplayName'..."
        $createBody = @{
            displayName = $DisplayName
            type = $Type
            definition = @{ parts = $Parts }
        }
        if ($Description) {
            $createBody.description = $Description
        }
        Invoke-FabricDefinitionRequest `
            -Method Post `
            -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/items" `
            -Body $createBody

        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $item = Get-FabricItem -Type $Type -DisplayName $DisplayName
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
            -Method Post `
            -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/items/$($item.id)/updateDefinition" `
            -Body @{ definition = @{ parts = $Parts } }
    }

    if ($Description) {
        $metadataJson = @{
            displayName = $DisplayName
            description = $Description
        } | ConvertTo-Json -Compress
        Invoke-RestMethod `
            -Method Patch `
            -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/items/$($item.id)" `
            -Headers $headers `
            -ContentType 'application/json; charset=utf-8' `
            -Body $utf8NoBom.GetBytes($metadataJson) |
            Out-Null
    }

    return $item
}

function Start-FabricNotebook {
    param([Parameter(Mandatory)][string]$NotebookId)

    Write-Host 'Running SyncM365LicenseUsage to create or refresh Lakehouse tables...'
    $response = Invoke-WebRequest `
        -Method Post `
        -Uri "$fabricBaseUrl/workspaces/$WorkspaceId/items/$NotebookId/jobs/instances?jobType=RunNotebook" `
        -Headers $headers `
        -ContentType 'application/json' `
        -Body '{}'
    $location = @($response.Headers.Location)[0]
    if ([string]::IsNullOrWhiteSpace($location)) {
        throw 'Fabric returned no job instance URL for the notebook run.'
    }

    for ($attempt = 0; $attempt -lt 180; $attempt++) {
        $job = Invoke-RestMethod -Method Get -Uri $location -Headers $headers
        if ($job.status -eq 'Completed') {
            return
        }
        if ($job.status -in @('Failed', 'Cancelled', 'Deduped')) {
            $message = if ($job.failureReason.message) {
                $job.failureReason.message
            }
            else {
                'Unknown error'
            }
            throw "Notebook run ended with status '$($job.status)': $message"
        }
        Start-Sleep -Seconds 5
    }
    throw "Notebook run did not complete within 15 minutes: $location"
}

function Convert-NotebookContent {
    param([Parameter(Mandatory)][string]$Content)

    $result = $Content
    $result = $result -replace '"default_lakehouse": "[^"]+"', "`"default_lakehouse`": `"$LakehouseId`""
    $result = $result -replace '"default_lakehouse_name": "[^"]+"', "`"default_lakehouse_name`": `"$LakehouseName`""
    $result = $result -replace '"default_lakehouse_workspace_id": "[^"]+"', "`"default_lakehouse_workspace_id`": `"$WorkspaceId`""
    $result = $result -replace '"id": "[0-9a-fA-F-]{36}"', "`"id`": `"$LakehouseId`""
    if (-not [string]::IsNullOrWhiteSpace($GraphConnectionId)) {
        $result = $result -replace 'GRAPH_CONNECTION_ID = "[^"]+"', "GRAPH_CONNECTION_ID = `"$GraphConnectionId`""
    }
    return $result
}

$usageNotebookContent = [IO.File]::ReadAllText(
    (Join-Path $repoRoot 'demo/SyncM365LicenseUsage.py')
)
$usageNotebook = Get-FabricItem -Type 'Notebook' -DisplayName 'SyncM365LicenseUsage'
$isNewUsageNotebook = $null -eq $usageNotebook
if ($isNewUsageNotebook -or -not [string]::IsNullOrWhiteSpace($GraphConnectionId)) {
    $usageNotebook = Set-FabricItem `
        -Type 'Notebook' `
        -DisplayName 'SyncM365LicenseUsage' `
        -Parts @(
            ConvertTo-DefinitionPart `
                -Path 'notebook-content.py' `
                -Content (Convert-NotebookContent -Content $usageNotebookContent)
        )
}
else {
    Write-Warning 'SyncM365LicenseUsage was left unchanged because -GraphConnectionId was not supplied.'
}

$isGraphConnectionReady = -not [string]::IsNullOrWhiteSpace($GraphConnectionId)
if (-not $SkipNotebookRun -and $isGraphConnectionReady) {
    Start-FabricNotebook -NotebookId $usageNotebook.id
}
elseif (-not $isGraphConnectionReady) {
    Write-Warning 'The notebook run was skipped because its Fabric Web connection must be bound once in the Fabric portal.'
    Write-Warning "Open SyncM365LicenseUsage and connect data source '$GraphDataSourceId' from Global permissions."
    Write-Warning 'Copy the ID shown under Current Notebook, then rerun this script with -GraphConnectionId <notebook-connection-id>.'
}

if ($IncludePriceMaster) {
    $priceNotebookContent = [IO.File]::ReadAllText(
        (Join-Path $repoRoot 'demo/SyncM365PriceMaster.py')
    )
    [void](Set-FabricItem `
        -Type 'Notebook' `
        -DisplayName 'SyncM365PriceMaster' `
        -Parts @(
            ConvertTo-DefinitionPart `
                -Path 'notebook-content.py' `
                -Content (Convert-NotebookContent -Content $priceNotebookContent)
        ))
}

$semanticModelRoot = Join-Path $repoRoot 'demo/M365LicenseFinOps.SemanticModel'
$semanticModelParts = Get-DirectoryDefinitionParts `
    -Root $semanticModelRoot `
    -Transform {
        param($relativePath, $content)
        if ($relativePath -eq 'definition/expressions.tmdl') {
            return $content -replace `
                'https://onelake\.dfs\.fabric\.microsoft\.com/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}', `
                "https://onelake.dfs.fabric.microsoft.com/$WorkspaceId/$LakehouseId"
        }
        return $content
    }
$semanticModel = Set-FabricItem `
    -Type 'SemanticModel' `
    -DisplayName 'M365 License FinOps Model' `
    -Parts $semanticModelParts

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
[void](Set-FabricItem `
    -Type 'Report' `
    -DisplayName 'M365 License FinOps Report' `
    -Parts $reportParts)

$dataAgentRoot = Join-Path $repoRoot 'demo/M365LicenseFinOps.DataAgent'
$dataAgentParts = Get-DirectoryDefinitionParts `
    -Root $dataAgentRoot `
    -Transform {
        param($relativePath, $content)
        if ($relativePath.EndsWith('/datasource.json')) {
            $dataSource = $content | ConvertFrom-Json
            $dataSource.artifactId = $semanticModel.id
            $dataSource.workspaceId = $WorkspaceId
            return $dataSource | ConvertTo-Json -Depth 50
        }
        return $content
    }
$dataAgent = Set-FabricItem `
    -Type 'DataAgent' `
    -DisplayName 'M365LicenseFinOpsAgent' `
    -Description 'Microsoft 365 license inventory, assignments, utilization, cost, price source, Copilot activity, and E5 capability configuration.' `
    -Parts $dataAgentParts

$pipelineContent = [IO.File]::ReadAllText(
    (Join-Path $repoRoot 'demo/pipeline-content.json')
)
$pipelineContent = $pipelineContent -replace `
    '"notebookId": "[0-9a-fA-F-]{36}"', `
    "`"notebookId`": `"$($usageNotebook.id)`""
$pipelineContent = $pipelineContent -replace `
    '"workspaceId": "[0-9a-fA-F-]{36}"', `
    "`"workspaceId`": `"$WorkspaceId`""
[void](Set-FabricItem `
    -Type 'DataPipeline' `
    -DisplayName 'DailyM365LicenseSync' `
    -Parts @(
        ConvertTo-DefinitionPart -Path 'pipeline-content.json' -Content $pipelineContent
    ))

Write-Host ''
Write-Host 'Deployment completed.'
Write-Host "Workspace:       $WorkspaceId"
Write-Host "Graph data source: $GraphDataSourceId"
if ($isGraphConnectionReady) {
    Write-Host "Notebook connection: $GraphConnectionId"
}
Write-Host "Usage notebook:  $($usageNotebook.id)"
Write-Host "Semantic model:  $($semanticModel.id)"
Write-Host "Data Agent:      $($dataAgent.id)"
Write-Host 'Configure the DailyM365LicenseSync schedule in the Fabric portal.'

$token = $null
