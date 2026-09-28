# 構築手順

このリポジトリのファイルを使って、現在の構成を自分のテナントに作る手順です。
Notebook、セマンティックモデル、レポート、Data Agent、Pipeline はスクリプトで配置します。

単価管理が不要なら SharePoint と価格同期 Notebook は省略できます。

## 0. 前提

| 必要なもの | 用途 |
| --- | --- |
| Fabric 容量 (F SKU) | Lakehouse、Notebook、Direct Lake、Data Agent。Data Agent は F2 以上の有料容量が必要で、試用版では使えない |
| Power BI Pro または Premium Per User (PPU) | セマンティックモデルとレポートの作成。F64 未満の容量では閲覧者にも必要 |
| Entra ID の特権ロール管理者または全体管理者 | Graph のアプリケーション権限への管理者の同意 |
| Fabric 管理者 | Data Agent 用テナント設定の確認と変更 |
| Azure CLI | Fabric API の認証 |
| PowerShell 7 | デプロイスクリプトの実行 |
| Python 3.12 と `openpyxl`（任意） | 単価マスタの生成（手順6）、レポート定義の再生成（手順7） |

アプリの登録自体はアプリケーション開発者ロールでもできますが、Microsoft Graph の
アプリケーション権限に同意できるのは特権ロール管理者と全体管理者です。
作業するユーザーには、対象 Fabric ワークスペースの管理者権限も必要です。

Data Agent を動かすため、Fabric 管理ポータルの **テナント設定** で次を確認します。
変更が反映されるまで最大1時間かかります。

- **Users can use Copilot and other features powered by Azure OpenAI** が有効（既定で有効）
- 容量のリージョンが米国と EU データ境界の外（日本など）にある場合は、次の2つも有効（既定で無効）
  - **Data sent to Azure OpenAI can be processed outside your capacity's geographic region, compliance boundary, or national cloud instance**
  - **Data sent to Azure OpenAI can be stored outside your capacity's geographic region, compliance boundary, or national cloud instance**

Microsoft 365 CopilotからData Agentを使う場合は、さらに次が必要です。

- FabricとMicrosoft 365 Copilotが同じテナントにあり、同じアカウントでサインインする
- 利用者がData Agentと接続先セマンティックモデルを読み取れる（ワークスペースへのアクセスは不要）
- Direct Lakeは既定で利用者本人の資格情報（SSO）でOneLakeを読むため、利用者にLakehouseの
  ReadとReadAll権限がある（OneLakeセキュリティを使う場合は、利用者をロールに含める）
- 利用者ごとにMicrosoft 365 Copilotライセンス、または対象となるOffice 365商用サブスクリプションがある
- Microsoft 365管理センターの **Copilot** > **設定** > **データ アクセス** > **エージェント** で、
  利用者がエージェントを使える（Copilotライセンスのあるテナントでは既定で有効）

## 1. Entra ID にアプリを登録する

Graph をアプリケーション権限で呼ぶための登録です。

- Microsoft Entra 管理センター > **Entra ID** > **アプリの登録** > **新規登録** で、
  サポートされているアカウントの種類をシングルテナントにして登録する
- **API のアクセス許可** > **アクセス許可の追加** > **Microsoft Graph** > **アプリケーションの許可** で
  次を追加し、**管理者の同意を与えます** を選ぶ

| 権限 | 種類 | 用途 |
| --- | --- | --- |
| `User.Read.All` | アプリケーション | ユーザー、組織属性、割り当て |
| `LicenseAssignment.Read.All` | アプリケーション | `subscribedSkus`、直接/グループ割り当て、割り当て状態 |
| `Reports.Read.All` | アプリケーション | M365 / Copilot Usage Reports |

`subscribedSkus` の最小権限は `LicenseAssignment.Read.All` なので、`Organization.Read.All` は不要です。
以前の手順で付与済みなら、最小権限にそろえるため外してかまいません。

- **証明書とシークレット** でクライアントシークレットを作成し、値と有効期限を控える
  （値は作成直後にしか表示されない）
- アプリケーション (クライアント) ID とディレクトリ (テナント) ID を控える

## 2. Fabric Web接続を作る

クライアントシークレットをNotebookやGitへ保存せず、Fabric Web接続の資格情報として
暗号化して保管します。Azure Key Vaultは使用しません。

> [!NOTE]
> NotebookからFabric接続を使う機能はプレビューです（2026年9月時点）。テナント設定で
> 無効化されている場合（既定は有効）や、組織でプレビュー機能を許可しない場合は、
> この方式ではなくKey Vaultなどの外部シークレットストアが必要です。

通常は手順4のデプロイスクリプトに任せます。同名の接続がない場合だけ、
PowerShellがクライアントシークレットを非表示で入力するよう求め、次の接続を作成します。

- 接続名: `M365 FinOps Microsoft Graph`
- 接続タイプ: `Web`
- URL: `https://graph.microsoft.com/v1.0`
- 認証: サービスプリンシパル
- **Allow Code-First Artifacts like Notebooks to access this connection**: 有効

接続を手動で作る場合も、このチェックは必ずオンにします。作成後には変更できないため、
オフのまま作った接続はNotebookから使えず、作り直すことになります。

スクリプトは入力値をログやファイルへ出力せず、API送信後に変数参照を解除します。
リポジトリやNotebook定義には残りません。
実行時にNotebookへ渡るのはFabricが取得した短期のAccessTokenで、
クライアントシークレットそのものはNotebookへ渡りません。
既存のグローバル接続を明示する必要がある場合は、接続IDを
`-GraphDataSourceId` で渡せます。

## 3. Fabric ワークスペースと Lakehouse を作る

1. Fabric でワークスペースを作り、F SKU 容量に割り当てる
2. ワークスペース内に Lakehouse を作る（例: `M365LicenseFinOps`）。作成ダイアログでは
   **Lakehouse schemas** のチェックを外す
3. ワークスペース ID と Lakehouse ID を控える

Fabric ポータルでは **Lakehouse schemas** が既定でオンになっています。同梱のセマンティックモデルは
テーブルが `Tables/` 直下に並ぶスキーマなしの Lakehouse を前提にしています。オンのまま作ると
テーブルが `dbo` スキーマの下に入り、セマンティックモデルから参照できません。
作成後には切り替えられないため、その場合は Lakehouse を作り直します。

ID は Fabric のブラウザー URL に含まれる GUID です。

```text
https://app.fabric.microsoft.com/groups/{workspace-id}/lakehouses/{lakehouse-id}
```

## 4. Fabric アイテムを配置する

Azure CLI で対象テナントへサインインします。Azure サブスクリプションのないテナントでは
`--allow-no-subscriptions` を付けます。

```powershell
az login --tenant <tenant-id>

# Azure サブスクリプションのないテナントの場合
az login --tenant <tenant-id> --allow-no-subscriptions
```

リポジトリのルートで次を実行します。

```powershell
pwsh -File .\tools\deploy_fabric_items.ps1 `
   -WorkspaceId <workspace-id> `
   -LakehouseId <lakehouse-id> `
   -LakehouseName M365LicenseFinOps `
   -TenantId <tenant-id> `
   -ClientId <graph-app-client-id>
```

`-SubscriptionId <azure-subscription-id>` は省略できます。Azure CLI に複数テナントの
サブスクリプションを登録している場合に付けると、そのサブスクリプションのテナントで
Fabric API のトークンを取得します。

スクリプトは次を順番に行います。

1. Graph用のFabric Web接続を検索し、なければ安全な対話入力で作成
2. `SyncM365LicenseUsage` Notebook の環境値をメモリ上で置換して作成・更新
3. Notebook専用接続IDが指定されていれば、Notebookを実行して10テーブルを更新
4. TMDL の OneLake 接続先を置換してセマンティックモデルを作成・更新
5. PBIR のセマンティックモデル ID を置換してレポートを作成・更新
6. Data Agent のセマンティックモデル ID を置換して作成・更新
7. Notebook ID を置換して `DailyM365LicenseSync` Pipeline を作成・更新

同名アイテムが既にあれば更新し、なければ作成します。ただし既存の `SyncM365LicenseUsage` は、
`-GraphConnectionId` を指定したときだけ更新します。リポジトリ内のソースファイルは
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
ただし接続を切断して再接続するとIDが変わるため、新しいIDで `-GraphConnectionId` を
指定し直してください。

完了すると Lakehouse に10本のテーブルができます。

```text
dim_user  dim_sku  dim_sku_price  dim_service_plan  bridge_sku_service_plan
fact_license_assignment  fact_service_entitlement  fact_license_utilization
fact_m365_usage  fact_copilot_usage
```

> [!NOTE]
> Microsoft 365 の利用状況レポートは、既定でユーザー名などが匿名化されています。
> 匿名化されたままだとUPNでユーザーと結合できず、ユーザー別の利用実績は空になります。
> 全体管理者が Microsoft 365 管理センター > **設定** > **組織設定** > **サービス** > **レポート** で
> 匿名化の設定（英語 UI では *Display concealed user, group, and site names in all reports*）を
> オフにすると、実名で取得できます。解除はプライバシー要件を確認したうえで行ってください。

## 5. Pipeline のスケジュールを設定する

Fabric ポータルで `DailyM365LicenseSync` を開き、**ホーム** タブの **スケジュール** から
毎日 02:00、タイムゾーン UTC+09:00（大阪、札幌、東京）のスケジュールを追加します。
スケジュールには終了日が必須なので、長く動かすなら 2099年1月1日のような先の日付にします。

手動実行だけでよければスケジュールは不要です。

## 6. 契約単価を使う（任意）

省略すると、`SyncM365LicenseUsage` に定義されたパブリック定価が使われます。
契約単価で計算したい場合だけ設定します。

### 6.1 Excel を作る

スクリプトは `openpyxl` を使います。入っていなければ先にインストールします。

```powershell
py -3.12 -m pip install openpyxl
py -3.12 .\tools\create_price_master.py
```

[sample-data/License-Price-Master.xlsx](../sample-data/License-Price-Master.xlsx) が
出力例です。列仕様は [単価マスタとSPO Shortcut](price-master.md) を参照してください。

### 6.2 SharePoint に配置する

SharePoint サイトのドキュメント ライブラリに単価マスタ用のフォルダーを作り、Excel を置きます。
Notebook は `License-Price-Master.xlsx` というファイル名で読むため、名前は変えません。

### 6.3 OneLake Shortcut を作る

Notebook が読むのは `Files/reference/sharepoint-license-prices/License-Price-Master.xlsx` です。
このパスになるよう、Lakehouse の `Files` に `reference` フォルダーを作り、その中に
6.2 のフォルダーを指すショートカットを置きます。

1. Lakehouse エクスプローラーで `Files/reference` の **...** > **New shortcut** を選ぶ
2. **SharePoint Folder** を選び、サイト URL と認証方法を指定して接続する。認証方法は
   組織アカウント、ワークスペース ID、サービス プリンシパルから選べる
3. 6.2 のフォルダーを選び、**Transform** は **Skip** にする
4. 確認画面でショートカット名を `sharepoint-license-prices` に変えて作成する

### 6.4 価格同期 Notebook を追加する

```powershell
pwsh -File .\tools\deploy_fabric_items.ps1 `
   -WorkspaceId <workspace-id> `
   -LakehouseId <lakehouse-id> `
   -LakehouseName M365LicenseFinOps `
   -TenantId <tenant-id> `
   -ClientId <graph-app-client-id> `
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

`<semantic-model-id>` には、手順4の実行結果で `Semantic model:` の行に出る ID を指定します。
生成後にデプロイスクリプトを `-SkipNotebookRun` 付きで再実行すると、
データ同期を待たずにレポート定義を更新できます。

## 8. Microsoft 365 Copilotへ公開する（任意）

`tools/deploy_fabric_items.ps1` はData Agentのdraft/published定義をFabricへ配置します。
Microsoft 365 CopilotのAgent Storeへの登録はFabricポータルで行います。

> [!NOTE]
> Microsoft 365 CopilotからData Agentを使う機能はプレビューです（2026年9月時点）。
> Microsoft 365 Copilot経由の回答は、Fabricのコンプライアンス境界やリージョンの外へ送られ、
> Microsoft 365側の条件で処理・保存される場合があります。公開前に社内の承認を得てください。

1. Fabricワークスペースで `M365LicenseFinOpsAgent` を開く
2. テストチャットで代表質問が正しく回答されることを確認する
3. **Publish** を選び、表示されたダイアログにエージェントの説明を入力する
4. 同じダイアログで **Publish to Agent Store** を選んで公開する
5. Microsoft 365 CopilotまたはTeamsのAgent Storeで
   `M365LicenseFinOpsAgent` が表示されることを確認する。すぐに出ない場合は、
   画面左の **Expand Navigation** を選んで一覧を更新する

公開時の説明はMicrosoft 365 Copilotの `description_for_model` になり、オーケストレーターが
エージェントの回答をどう扱うかに影響します。回答を要約や言い換えをせずに返してほしい場合は、
その旨を説明に書くと書き換えを減らせます。ただし、完全には防げません。

Agent Storeへ公開された後は、次の2通りで利用できます。

- Agent Storeから `M365LicenseFinOpsAgent` を直接開いて質問する
- Microsoft 365 Copilotのメインチャットで `@M365LicenseFinOpsAgent` と指定する

同僚に使ってもらうときは、Microsoft 365 Copilotでエージェント名を選び、**Share** からリンクを送ります。
共有先のユーザーにもData Agentだけでなく、接続先セマンティックモデルと
Direct Lakeデータへの権限が必要です。RLSやOLSが設定されている場合は、
Microsoft 365 Copilotからの回答にも同じ制御が適用されます。

> [!IMPORTANT]
> Fabric内の「公開」とAgent Storeへの公開は別です。published定義が存在するだけでは、
> Microsoft 365 CopilotのAgent Storeには表示されません。

## 9. 動作確認

- Lakehouse の `Tables` 直下に10本のテーブルがあり、`snapshot_date` が実行日（UTC）になっている
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
| `az login` がサブスクリプションなしで失敗する | Azure サブスクリプションのないテナント。`--allow-no-subscriptions` を付ける |
| Notebook が Graph で 403 | アプリケーション権限の管理者同意が未実施 |
| 動いていた Notebook が接続エラーになる | クライアントシークレットの期限切れ。**接続とゲートウェイの管理** で資格情報を新しいシークレットに更新する |
| 利用実績が全部空 | Usage Reports の匿名化が有効（既定で有効） |
| 月額コストが 0 | SKU コードが単価表と一致していない |
| レポートが「モデルを読み込めません」 | セマンティックモデルの Lakehouse 接続先が違う、または Lakehouse schemas をオンにして Lakehouse を作った |
| Direct Lake がエラー | Fabric 容量が一時停止している |
| Notebookで接続が見つからない | Graph Web接続をNotebookのGlobal permissionsからConnectしていない。Global permissionsにも出なければ、接続作成時にCode-First Artifactsからの使用をオンにしていない（作り直す） |
| Fabric のテストチャットで Data Agent が回答しない | 試用版の容量を使っている、またはCopilotとAzure OpenAIのテナント設定が不足（日本など米国・EU データ境界外のリージョンでは、リージョン外での処理・保存の許可も必要） |
| Agent Storeに表示されない | Publish to Agent Store未実施、Microsoft 365管理センターでエージェントの利用が許可されていない、または権限不足 |
| Agentは開くが回答できない | セマンティックモデルまたはLakehouseへの利用者権限が不足 |

## 公式リファレンス

画面名、既定値、プレビューかどうかは、2026年9月28日時点の Microsoft Learn で確認しています。

- [Understand Microsoft Fabric licenses and capacity](https://learn.microsoft.com/fabric/enterprise/licenses)
- [Configure Fabric data agent tenant settings](https://learn.microsoft.com/fabric/data-science/data-agent-tenant-settings)
- [Grant tenant-wide admin consent to an application](https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent)
- [List subscribedSkus](https://learn.microsoft.com/graph/api/subscribedsku-list)
- [Fabric Connection in notebooks](https://learn.microsoft.com/fabric/data-engineering/fabric-connection-with-notebook)
- [What are lakehouse schemas?](https://learn.microsoft.com/fabric/data-engineering/lakehouse-schemas)
- [Microsoft 365 reports show anonymous user names instead of actual user names](https://learn.microsoft.com/troubleshoot/microsoft-365/admin/miscellaneous/reports-show-anonymous-user-name)
- [Run, schedule, or use events to trigger a pipeline](https://learn.microsoft.com/fabric/data-factory/pipeline-runs)
- [Create a OneDrive or SharePoint shortcut](https://learn.microsoft.com/fabric/onelake/shortcuts/create-onedrive-sharepoint-shortcut)
- [Consume Fabric data agent in Microsoft 365 Copilot](https://learn.microsoft.com/fabric/data-science/data-agent-microsoft-365-copilot)
- [Fabric data agent sharing and permission management](https://learn.microsoft.com/fabric/data-science/data-agent-sharing)
- [Integrate Direct Lake security](https://learn.microsoft.com/fabric/fundamentals/direct-lake-security-integration)
- [Manage Microsoft Copilot settings in the Microsoft 365 admin center](https://learn.microsoft.com/microsoft-365/copilot/microsoft-365-copilot-page)
