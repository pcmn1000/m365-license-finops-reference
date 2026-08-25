# 構築手順

このリポジトリのファイルを使って、現在の構成を自分のテナントに作る手順です。
Notebook、セマンティックモデル、レポート、Data Agent、Pipeline はスクリプトで配置します。

単価管理が不要なら SharePoint と価格同期 Notebook は省略できます。

## 0. 前提

| 必要なもの | 用途 |
| --- | --- |
| Fabric 容量 (F SKU) | Lakehouse、Notebook、Direct Lake |
| Microsoft 365 テナントの全体管理者 | Entra アプリ登録、Graph 権限の同意 |
| Azure サブスクリプション | Key Vault |
| Azure CLI | Fabric API の認証 |
| PowerShell 7 | デプロイスクリプトの実行 |

作業するユーザーには、対象 Fabric ワークスペースの管理者権限が必要です。

## 1. Entra ID にアプリを登録する

Graph をアプリケーション権限で呼ぶための登録です。

- Entra 管理センター > アプリの登録 > 新規登録
- API のアクセス許可で次を追加し、管理者の同意を与える

| 権限 | 種類 | 用途 |
| --- | --- | --- |
| `User.Read.All` | アプリケーション | ユーザー、組織属性、割り当て |
| `LicenseAssignment.Read.All` | アプリケーション | 直接/グループ割り当て、割り当て状態 |
| `Organization.Read.All` | アプリケーション | `subscribedSkus` |
| `Reports.Read.All` | アプリケーション | M365 / Copilot Usage Reports |

- 証明書とシークレット > クライアントシークレットを作成し、値を控える
- アプリケーション (クライアント) ID とディレクトリ (テナント) ID を控える

## 2. Key Vault にシークレットを入れる

クライアントシークレットを Notebook に直書きしないため、Key Vault を使います。

1. Key Vault を作成する
2. シークレット名 `graph-client-secret` で手順 1 の値を登録する
3. Notebook と Pipeline を実行するユーザーに `Key Vault シークレット ユーザー` を付与する

Key Vault のファイアウォールで Fabric からのアクセスを遮断していないことも確認します。

## 3. Fabric ワークスペースと Lakehouse を作る

1. Fabric でワークスペースを作り、F SKU 容量に割り当てる
2. ワークスペース内に Lakehouse を作る（例: `M365LicenseFinOps`）
3. ワークスペース ID と Lakehouse ID を控える

ID は Fabric のブラウザー URL に含まれる GUID です。

```text
https://app.fabric.microsoft.com/groups/{workspace-id}/lakehouses/{lakehouse-id}
```

## 4. Fabric アイテムを配置する

Azure CLI で対象テナントへサインインします。

```powershell
az login --tenant <tenant-id>
```

リポジトリのルートで次を実行します。

```powershell
pwsh -File .\tools\deploy_fabric_items.ps1 `
   -WorkspaceId <workspace-id> `
   -LakehouseId <lakehouse-id> `
   -LakehouseName M365LicenseFinOps `
   -TenantId <tenant-id> `
   -ClientId <graph-app-client-id> `
   -KeyVaultUrl https://<your-vault>.vault.azure.net/ `
   -SubscriptionId <azure-subscription-id>
```

スクリプトは次を順番に行います。

1. `SyncM365LicenseUsage` Notebook の環境値をメモリ上で置換して作成・更新
2. Notebook を実行して Lakehouse の10テーブルを作成・更新
3. TMDL の OneLake 接続先を置換してセマンティックモデルを作成・更新
4. PBIR のセマンティックモデル ID を置換してレポートを作成・更新
5. Data Agent のセマンティックモデル ID を置換して作成・更新
6. Notebook ID を置換して `DailyM365LicenseSync` Pipeline を作成・更新

同名アイテムが既にあれば更新し、なければ作成します。リポジトリ内のソースファイルは
書き換えません。初回の Notebook 実行を省略する場合だけ `-SkipNotebookRun` を付けます。

完了すると Lakehouse に10本のテーブルができます。

```text
dim_user  dim_sku  dim_sku_price  dim_service_plan  bridge_sku_service_plan
fact_license_assignment  fact_service_entitlement  fact_license_utilization
fact_m365_usage  fact_copilot_usage
```

> [!NOTE]
> Usage Reports がテナント設定で匿名化されていると、ユーザー別の利用実績は空になります。
> Microsoft 365 管理センター > 設定 > 組織設定 > レポート で変更できます。
> 解除はプライバシー要件を確認したうえで行ってください。

## 5. Pipeline のスケジュールを設定する

Fabric ポータルで `DailyM365LicenseSync` を開き、毎日 02:00、
`Tokyo Standard Time` のスケジュールを設定します。

手動実行だけでよければスケジュールは不要です。

## 6. 契約単価を使う（任意）

省略すると、`SyncM365LicenseUsage` に定義されたパブリック定価が使われます。
契約単価で計算したい場合だけ設定します。

### 6.1 Excel を作る

```powershell
py -3.12 .\tools\create_price_master.py
```

[sample-data/License-Price-Master.xlsx](../sample-data/License-Price-Master.xlsx) が
出力例です。列仕様は [単価マスタとSPO Shortcut](price-master.md) を参照してください。

### 6.2 SharePoint に配置する

SharePoint サイトのドキュメント ライブラリへ Excel を置きます。

### 6.3 OneLake Shortcut を作る

Lakehouse の `Files/reference/sharepoint-license-prices` から
SharePoint のフォルダーを参照します。

### 6.4 価格同期 Notebook を追加する

```powershell
pwsh -File .\tools\deploy_fabric_items.ps1 `
   -WorkspaceId <workspace-id> `
   -LakehouseId <lakehouse-id> `
   -LakehouseName M365LicenseFinOps `
   -TenantId <tenant-id> `
   -ClientId <graph-app-client-id> `
   -KeyVaultUrl https://<your-vault>.vault.azure.net/ `
   -SubscriptionId <azure-subscription-id> `
   -IncludePriceMaster `
   -SkipNotebookRun
```

### 6.5 価格同期 Notebook を実行する

Fabric ポータルで `SyncM365PriceMaster` を実行します。

`Approved` 行だけが `dim_sku_price` へ反映されます。

## 7. レポートを変更する

ビジュアルの位置、列幅、色、表示項目は
[demo/BuildM365LicenseFinOpsReport.py](../demo/BuildM365LicenseFinOpsReport.py) にあります。

```powershell
py -3.12 .\demo\BuildM365LicenseFinOpsReport.py <semantic-model-id>
```

生成後にデプロイスクリプトを `-SkipNotebookRun` 付きで再実行すると、
データ同期を待たずにレポート定義を更新できます。

## 8. 動作確認

- Lakehouse に10本のテーブルがあり、`snapshot_date` が当日になっている
- Power BI レポートの4ページがすべて表示される
- `割当ユーザー一覧` に実在のユーザーが並ぶ
- `E5機能チェック` の機能名を展開すると品番が出る
- 月額コストが 0 になっていない（単価が引けている）
- Data Agentで「E5の機能名とサービスプラン品番の対応を見せて」と質問できる
- Data Agentが機能の有効化を実利用と断定しない

## つまずきやすいところ

| 症状 | 原因 |
| --- | --- |
| Notebook が Graph で 403 | アプリケーション権限の管理者同意が未実施 |
| 利用実績が全部空 | Usage Reports の匿名化が有効 |
| 月額コストが 0 | SKU コードが単価表と一致していない |
| レポートが「モデルを読み込めません」 | セマンティックモデルの Lakehouse 接続先が違う |
| Direct Lake がエラー | Fabric 容量が一時停止している |
