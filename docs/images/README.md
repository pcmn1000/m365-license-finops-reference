# ドキュメント画像の生成元

## architecture-overview.png

Microsoft 365 ライセンス FinOpsの現行構成を説明する1920 x 1080のPNGです。

### 作成方法

1. Microsoft Foundryにデプロイ済みの `flux2-pro`（`FLUX.2-pro`）で、
   文字・ロゴ・人物を含まない明るい16:9の背景を生成
2. 4層の枠、接続線、日本語ラベルを後処理で描画
3. Microsoft公式配布の製品アイコンを縦横比を維持して合成
4. カード本文の描画幅を測定し、枠内に収まるフォントサイズへ自動調整
5. 文字の重なり、アイコンの変形、画像サイズを目視・プログラムで確認

生成AIには製品名やロゴを描かせていません。誤った文字や変形したブランドマークが
混入しないよう、正確さが必要な要素はすべて後処理で追加しています。

### 公式アイコンの出典

- [Azure architecture icons](https://learn.microsoft.com/azure/architecture/icons/)
  - Azure Key Vault
- [Microsoft Entra architecture icons](https://learn.microsoft.com/entra/architecture/architecture-icons)
  - Microsoft Entra ID
- [Microsoft Fabric product, workload, and item icons](https://learn.microsoft.com/fabric/fundamentals/icons)
  - Microsoft Fabric
  - Fabric Pipeline
  - Fabric Notebook
  - Fabric Lakehouse
  - Semantic model
  - Power BI
  - Fabric Data Agent
  - Microsoft Copilot
- [Microsoft Graph developer portal](https://developer.microsoft.com/en-us/graph)
  - 公式サイト配信のDevPortalアイコンフォントにある `GraphSymbol`
- [Microsoft Office product icon CDN](https://res.cdn.office.net/files/fabric-cdn-prod_20230815.002/assets/brand-icons/product/svg/excel_48x1.svg)
  - Microsoft Excel

各アイコンは、アーキテクチャ図・トレーニング資料・ドキュメントでの利用を認める
配布条件に従って使用しています。トリミング、回転、形状変更は行っていません。

### 更新方法

構成変更時は、[詳細アーキテクチャ](../architecture.md)のMermaidを先に更新してください。
Mermaidを編集可能な構成ソース、PNGを説明・共有用のスナップショットとして扱います。
PNGを再生成した場合は、このファイルにモデル、生成日、アイコン出典の変更を記録します。

| 項目 | 値 |
| --- | --- |
| 生成日 | 2026-08-26 |
| 背景モデル | Microsoft Foundry `FLUX.2-pro` |
| 背景デプロイ名 | `flux2-pro` |
| 画像サイズ | 1920 x 1080 |
| SHA-256 | `7003FFE908DA86F6A4730CCB5B2B5A873BA5FF8DBF03BAEE12F1FFC5CE98E1E5` |
