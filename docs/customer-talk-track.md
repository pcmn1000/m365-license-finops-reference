# お客様説明用トークトラック

## 30秒で説明する場合

Microsoft 365 License FinOpsは単一製品ではなく、Microsoft純正機能を組み合わせた
管理・分析構成です。Microsoft Graphからライセンス在庫、ユーザー割り当て、利用実績を
日次で取得し、契約単価は財務管理者がSharePoint上のExcelで管理します。Fabricは
OneLakeへ履歴を蓄積して利用率とコストを計算し、Power BIとData Agentから確認します。

## 製品ごとの役割

| 製品/機能 | 担当すること | 担当しないこと |
| --- | --- | --- |
| Microsoft Graph | SKU、購入/消費数、ユーザー、割り当て、サービスプラン、Usage Reports | 顧客契約単価、請求書、長期履歴 |
| Microsoft Entra ID | 現在のユーザー、組織属性、グループライセンス | 過去の部門履歴、契約単価 |
| SharePoint Online | 契約単価Excel、承認、版管理、補正マスタ | 大量データ分析、履歴計算 |
| OneLake Shortcut | SPOフォルダーをコピーせずFabricから参照 | Excelの型検証やDelta変換 |
| Fabric Notebook/Pipeline | API取得、検証、正規化、履歴、日次処理、例外通知 | 業務上の承認判断 |
| Fabric Lakehouse | 原本、マスタ、履歴、Gold指標をDeltaで保持 | 人事/財務の正本 |
| Direct Lake | OneLakeのGoldテーブルをPower BIモデルへ公開 | 元データ収集 |
| Power BI | KPI、部門/拠点比較、ドリルダウン、RLS | マスタ直接編集 |
| Fabric Data Agent | 自然言語で管理データを検索 | 自動解約や無承認のライセンス変更 |
| Microsoft Purview | カタログ、所有者、分類、リネージ、品質 | ETL実行 |
| Power Automate/Teams | 承認、単価更新起動、異常通知 | 大規模変換 |

## 5分で説明する流れ

### 1. 数量はMicrosoft Graphから取得する

Microsoft 365で購入しているSKU、購入数、割り当て数、空き数、SKUに含まれる
サービスプランをGraphから取得します。ユーザー側は、誰に何を直接またはグループで
割り当てたか、サービスプランを有効/無効にしているかを取得します。

### 2. 利用実績もGraphから取得するが、リアルタイムではない

Teams、Exchange、OneDrive、SharePoint、Officeアプリ、Copilotの利用実績は
Usage Reportsから日次取得します。Microsoft側で生成される集計レポートなので、
画面には必ずレポート更新日を表示します。

### 3. 単価は契約固有なのでSharePointで管理する

Graphは顧客の値引き後単価を返しません。財務/調達がSPO上のExcelへSKU、通貨、
月額単価、有効期間、根拠資料、承認者を登録します。SharePointのバージョン履歴と
承認を使うため、NotebookやPower BIへ価格を直書きしません。

### 4. Shortcutはコピーではなく参照である

OneLake ShortcutはSPOの管理フォルダーをFabricのFiles配下に見せます。Excelを更新しても
Shortcutの再作成は不要です。ただしExcelが自動的に分析テーブルへ変わるわけではなく、
Notebookが必須列、重複、有効期間、承認状態を検証してDeltaへ反映します。

### 5. Fabricで履歴と判断根拠を作る

Entraの部門や拠点は現在値なので、異動前のコストを正しく説明するためFabricで履歴を
保持します。利用率、重複SKU、未利用候補、E3/E5の右サイジング候補を作りますが、
自動解約ではなく根拠付きの要確認候補として提示します。

### 6. Power BIとData Agentで利用する

Power BIでは経営KPIからユーザー/E5差分の業務機能までドリルダウンします。Graphの
内部コードは監査用に保持し、利用者には用途が分かる日本語名、一般的なMicrosoft製品名、
有効/無効ユーザー数を表示します。
Data Agentでは
「E5固有サービスを使っていない部門はどこか」のような質問を自然言語で行えます。
どちらも同じDirect Lakeセマンティックモデルを利用します。

## よくある質問

### リアルタイムにできますか

契約単価はSPO承認後のイベント起動で準リアルタイムにできます。ライセンス在庫、割り当て、
部門、拠点、Usageはお客様要件に合わせて日次です。Usage Reports自体はMicrosoft側の
更新周期に依存するため、リアルタイムとは表現しません。

### Excelを更新すればPower BIも自動更新されますか

Shortcutには最新版が見えます。その後、価格専用Notebookが検証してDeltaへ反映すると、
Direct Lake経由でPower BIに反映されます。誤ったExcelで本番価格を壊さないため、この
検証ステップは省略しません。

### E5からE3へ自動的に変更できますか

技術的にライセンス変更APIはありますが、この構成では自動変更しません。利用実績、
サービス有効化、Purview/Defenderポリシー、特権ロール、例外、契約条件を確認して、
責任者が承認した後に別ワークフローで変更します。

Power BIの`E5機能チェック`ページで表示する有効/無効はライセンス設定です。「全員に有効」は
「全員が利用中」を意味しないため、それだけを理由にE5継続を判断しません。

### 部門情報はFabricで管理しますか

正本はHRIS、現在値の配布先はEntra、分析履歴はFabricです。Fabricだけを正本にはしません。
コストセンターはERP/財務MDMを正本とし、Entraの`employeeOrgData.costCenter`へ同期するか、
Fabricで承認済みマスタと結合します。

### Azure Cost Managementと同じですか

別です。Azure Cost ManagementはAzure利用料を管理します。この構成はMicrosoft 365の
ユーザーライセンスを対象にします。全社FinOps画面では両者を別ファクトとして統合できます。
