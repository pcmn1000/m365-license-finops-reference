# 構築手順

このリポジトリのファイルを使って、現在の構成を自分のテナントに作る手順です。
Notebook、セマンティックモデル、レポート、Data Agent、Pipeline はスクリプトで配置します。

単価管理が不要なら SharePoint と価格同期 Notebook は省略できます。

## 0. 前提

| 必要なもの | 用途 |
| --- | --- |
| Fabric 容量 (F SKU) | Lakehouse、Notebook、Direct Lake |
| Microsoft 365 テナントの全体管理者 | Entra アプリ登録、Graph 権限の同意 |
| Azure CLI | Fabric API の認証 |
| PowerShell 7 | デプロイスクリプトの実行 |

作業するユーザーには、対象 Fabric ワークスペースの管理者権限が必要です。

Microsoft 365 CopilotからData Agentを使う場合は、さらに次が必要です。

- FabricとMicrosoft 365 Copilotが同じテナントにある
- 利用者がData Agentと接続先セマンティックモデルを読み取れる
- Direct LakeのSSOで必要となるLakehouseの読み取り権限がある
- Microsoft 365 Copilotまたは対象となるOffice 365商用サブスクリプションがある
- Microsoft 365管理センターでCopilotのエージェント拡張が許可されている
- テナント要件に応じて、FabricのAIクロスリージョン処理・保存設定が許可されている

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

## 2. Fabric Web接続を作る

クライアントシークレットをNotebookやGitへ保存せず、Fabric Web接続の資格情報として
暗号化して保管します。Azure Key Vaultは使用しません。

> [!NOTE]
> NotebookからFabric接続を使う機能はプレビューです。組織でプレビュー機能を
> 許可しない場合は、この方式ではなくKey Vaultなどの外部シークレットストアが必要です。

通常は手順4のデプロイスクリプトに任せます。同名の接続がない場合だけ、
PowerShellがクライアントシークレットを非表示で入力するよう求め、次の接続を作成します。

- 接続名: `M365 FinOps Microsoft Graph`
- 接続タイプ: `Web`
- URL: `https://graph.microsoft.com/v1.0`
- 認証: サービスプリンシパル
- Code-First Artifactsからの使用: 有効

スクリプトは入力値をログやファイルへ出力せず、API送信後に変数参照を解除します。
リポジトリやNotebook定義には残りません。
実行時にNotebookへ渡るのはFabricが取得した短期のAccessTokenで、
クライアントシークレットそのものはNotebookへ渡りません。
既存のグローバル接続を明示する必要がある場合は、接続IDを
`-GraphDataSourceId` で渡せます。

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
   -SubscriptionId <azure-subscription-id>
```

スクリプトは次を順番に行います。

1. Graph用のFabric Web接続を検索し、なければ安全な対話入力で作成
2. `SyncM365LicenseUsage` Notebook の環境値をメモリ上で置換して作成・更新
3. Notebook専用接続IDが指定されていれば、Notebookを実行して10テーブルを更新
4. TMDL の OneLake 接続先を置換してセマンティックモデルを作成・更新
5. PBIR のセマンティックモデル ID を置換してレポートを作成・更新
6. Data Agent のセマンティックモデル ID を置換して作成・更新
7. Notebook ID を置換して `DailyM365LicenseSync` Pipeline を作成・更新

同名アイテムが既にあれば更新し、なければ作成します。リポジトリ内のソースファイルは
書き換えません。初回はNotebook専用接続IDがないため、自動実行を保留します。

### 初回だけGraph接続をNotebookへ関連付ける

Fabricではグローバル接続をNotebookへConnectすると、Notebook専用の別IDが発行されます。
初回は次の手順でそのIDを取得します。

1. Fabricポータルで `SyncM365LicenseUsage` を開く
2. **Connections** > **Global permissions** を開く
3. `M365 FinOps Microsoft Graph` のメニューから **Connect** を選ぶ
4. 接続が **Current Notebook** に表示されたことを確認する
5. 接続のメニューから **Copy ID** を選び、Notebook専用接続IDを控える
6. 手順4と同じコマンドへ次を追加して、デプロイスクリプトを再実行する

```powershell
   -GraphConnectionId <notebook-connection-id>
```

2回目の実行でNotebook定義へ専用IDを設定し、Lakehouseを同期します。
関連付けはNotebookごとに1回だけ必要です。Notebookの定義更新後も接続は維持されます。

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

## 8. Microsoft 365 Copilotへ公開する（任意）

`tools/deploy_fabric_items.ps1` はData Agentのdraft/published定義をFabricへ配置します。
Microsoft 365 CopilotのAgent Storeへの登録はFabricポータルで行います。

1. Fabricワークスペースで `M365LicenseFinOpsAgent` を開く
2. テストチャットで代表質問が正しく回答されることを確認する
3. 公開メニューを開く
4. **Publish to Agent Store** を選択する
5. Microsoft 365 CopilotまたはTeamsのAgent Storeで
   `M365LicenseFinOpsAgent` が表示されることを確認する

Agent Storeへ公開された後は、次の2通りで利用できます。

- Agent Storeから `M365LicenseFinOpsAgent` を直接開いて質問する
- Microsoft 365 Copilotのメインチャットで `@M365LicenseFinOpsAgent` と指定する

共有先のユーザーにもData Agentだけでなく、接続先セマンティックモデルと
Direct Lakeデータへの権限が必要です。RLSやOLSが設定されている場合は、
Microsoft 365 Copilotからの回答にも同じ制御が適用されます。

> [!IMPORTANT]
> Fabric内の「公開」とAgent Storeへの公開は別です。published定義が存在するだけでは、
> Microsoft 365 CopilotのAgent Storeには表示されません。

## 9. 動作確認

- Lakehouse に10本のテーブルがあり、`snapshot_date` が当日になっている
- Power BI レポートの4ページがすべて表示される
- `割当ユーザー一覧` に実在のユーザーが並ぶ
- `E5機能チェック` の機能名を展開すると品番が出る
- 月額コストが 0 になっていない（単価が引けている）
- Data Agentで「E5の機能名とサービスプラン品番の対応を見せて」と質問できる
- Data Agentが機能の有効化を実利用と断定しない
- Agent Storeへ公開した場合、Microsoft 365 CopilotでAgent名を検索または`@`指定できる

## つまずきやすいところ

| 症状 | 原因 |
| --- | --- |
| Notebook が Graph で 403 | アプリケーション権限の管理者同意が未実施 |
| 利用実績が全部空 | Usage Reports の匿名化が有効 |
| 月額コストが 0 | SKU コードが単価表と一致していない |
| レポートが「モデルを読み込めません」 | セマンティックモデルの Lakehouse 接続先が違う |
| Direct Lake がエラー | Fabric 容量が一時停止している |
| Notebookで接続が見つからない | Graph Web接続をNotebookのGlobal permissionsからConnectしていない |
| Agent Storeに表示されない | Publish to Agent Store未実施、Copilot拡張が無効、または権限不足 |
| Agentは開くが回答できない | セマンティックモデルまたはLakehouseへの利用者権限が不足 |

## 公式リファレンス

- [Consume Fabric data agent in Microsoft 365 Copilot](https://learn.microsoft.com/fabric/data-science/data-agent-microsoft-365-copilot)
- [Fabric data agent sharing and permission management](https://learn.microsoft.com/fabric/data-science/data-agent-sharing)
- [Fabric Connection in notebooks](https://learn.microsoft.com/fabric/data-engineering/fabric-connection-with-notebook)
