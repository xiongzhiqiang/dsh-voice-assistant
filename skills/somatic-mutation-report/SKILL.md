---
name: somatic-mutation-report
description: >
  Use when the user asks for a somatic mutation analysis or a clinical variant
  report from sequencing data (tumor-only or tumor-normal, WES or panel). Covers
  VCF/MAF intake, Mutect2 filtering, ANNOVAR annotation (refGene, ClinVar,
  COSMIC, dbNSFP, gnomAD), AMP/ASCO/CAP tier classification, actionability
  lookup (OncoKB, CIViC, FDA labels, NCCN-linked evidence), molecular subtyping,
  therapy matching, and release of an HTML/PDF clinical report.
whenToUse: >
  The user mentions somatic mutation, tumor variant, Mutect2, VCF annotation,
  tier classification, actionable mutation, targeted therapy matching, or asks
  to turn variant calls into a clinical/genomic report.
---

# 体细胞突变临床报告（somatic-mutation-report）

把体细胞变异检出结果（VCF / MAF / 注释表）整理成一份**可交付的临床级
变异报告**：分级清楚、证据可溯、给药建议明确。

## 触发场景

- 「这份 VCF 帮我出一份报告」「肿瘤突变分析结果整理一下」
- 「哪些突变是可靶向的」「按 AMP/ASCO/CAP 分级」
- 「做个分子分型 / 用药匹配」
- 已有 Mutect2 或其它 caller 的输出，需要注释 + 分级 + 出报告

## 输入与前置检查

开始前**必须**确认这四项（缺哪项就问，不要猜）：

| 项 | 说明 | 缺失后果 |
|---|---|---|
| 变异文件 | VCF/MAF/TSV 的**绝对路径** | 无法开始 |
| 样本配对 | tumor-only 还是 tumor-normal | 影响过滤阈值与解释口径 |
| 癌种 / 临床背景 | 如肺腺癌、结直肠癌 | 分级与用药建议会跑偏 |
| 参考基因组 | hg19 还是 hg38 | 注释坐标错位，最隐蔽的致命错误 |

先看文件再动手：`head` 变异文件，确认表头字段（`CHROM/POS/REF/ALT` 或
`Hugo_Symbol/Chromosome/Start_Position`）。**不要凭文件名推断格式**。

## 标准流程

### 1. 变异过滤（质量闸门）

只保留可信变异。默认阈值（可按用户要求调整，但**改了要说**）：

- `FILTER` 为 `PASS`（或 `filter == 'PASS'`）
- 肿瘤样本 `tumor_depth >= 20`（Panel 可放宽到 10）
- `tumor_alt_count >= 5`
- `gnomAD_AF < 0.001`（常见多态位点剔除）
- 排除明确胚系证据（有配对正常样本时 `normal_alt_count == 0`）

记录每步被剔除的变异数，写进报告的「方法」小节 —— 用户需要知道
「一共检出多少、最后留下多少」。

### 2. 功能注释

对每个变异补齐以下字段（缺的字段留空并标注「未检出」，**绝不编造**）：

- **基因与转录本**：Hugo_Symbol、Transcript、HGVSc、HGVSp（用 MANE Select
  转录本，写明转录本号）
- **功能后果**：Variant_Classification（missense / nonsense / frameshift /
  splice_site / inframe_indel）
- **人群频率**：gnomAD AF
- **体细胞证据**：COSMIC ID 与出现次数
- **临床意义**：ClinVar 的 ClinicalSignificance + ReviewStatus
- **致病性预测**：dbNSFP 的 REVEL、CADD、SIFT、Polyphen2（指出用的哪个）

### 3. AMP/ASCO/CAP 四级分类

每个变异落一个 Tier，**判据必须写出来**：

| Tier | 含义 | 典型判据 |
|---|---|---|
| I | 强临床意义 | 该癌种已有获批用药 / 权威指南（NCCN 等）推荐 |
| II | 潜在临床意义 | 有获批药但非本癌种，或有高质量研究支持 |
| III | 意义未明（VUS） | 证据不足或癌种间冲突 |
| IV | 良性 / 可能良性 | 人群频率高、明确胚系良性 |

分级纪律：

- Tier I/II 必须给出**具体证据来源**（药物名、指南、试验号或数据库条目），
  写不出来源就降到 Tier III —— 宁低不高。
- 同一变异在不同癌种可能不同 Tier，报告里指明**以本病例癌种为准**。
- VUS 不要写用药建议。

### 4. 可靶向性查询

对 Tier I/II 变异查可及信息（有联网工具就用，没有就用已知知识并**标注
知识截止**）：

- **OncoKB**：Level of Evidence（1/2/3A/3B/4/R1/R2）与对应药物
- **CIViC**：Evidence Level（A–E）与证据条目
- **FDA 标签**：已获批适应症、是否本癌种
- **临床试验**：ClinicalTrials.gov 上在招募的相关试验（给 NCT 号）
- **耐药提示**：已明确的耐药位点（如 EGFR T790M、EGFR C797S、
  ALK G1202R）必须单独指出

### 5. 分子分型与用药匹配

按癌种给出分型结论与对应策略，例如：

- **肺癌**：EGFR 敏感突变（19del / L858R）→ EGFR-TKI；T790M → 三代 TKI；
  ALK / ROS1 / BRAF V600E / MET ex14 / RET / KRAS G12C 各自对应药物
- **结直肠癌**：KRAS/NRAS/BRAF 状态决定是否用抗 EGFR 单抗；
  MSI-H/dMMR → 免疫检查点抑制剂
- **乳腺癌**：ESR1、ERBB2 扩增/突变、PIK3CA、BRCA1/2（PARP 抑制剂）
- **泛癌种**：NTRK 融合、MSI-H、TMB-H、BRAF V600E 的篮子试验适应症

分型结论要落到**「这位患者现在能考虑什么」**，而不是罗列所有可能。

### 6. 生成报告

产物是**单文件 HTML**（可另存/打印为 PDF），结构固定六节：

1. **概要** — 样本信息、癌种、检出/入选变异数、Tier 分布、一句话结论
2. **可靶向变异** — Tier I/II 表格：基因、变异、频率(VAF)、Tier、证据、药物
3. **其它变异** — Tier III/IV 简表
4. **分子分型与用药建议** — 按上面的分型逻辑写
5. **方法** — 数据来源、参考基因组、过滤阈值、注释库版本与日期
6. **局限与声明** — 该报告的分析范围、未覆盖内容、需临床医生确认

报告纪律：

- **每个结论都能追到来源**；不确定的直接写「证据不足」。
- 频率写两位有效数字（如 `VAF 32%`），坐标写 `chr7:140753336 A>T`。
- 不写「确诊」「必须用药」这类临床断言 —— 报告是决策支持，不是医嘱。
- 有模板时优先套模板；没有就先给用户看 HTML 结构再填充。

## 交付前自检

- [ ] 参考基因组与坐标一致（hg19 vs hg38 没错位）
- [ ] 每个 Tier I/II 都有具体来源
- [ ] 耐药位点已单独提示
- [ ] VUS 没有被写成用药依据
- [ ] 报告里有「方法」与「局限」两节
- [ ] 给用户的语音/文字摘要先说结论、再说路径（不要让用户从长文里找答案）

## 常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 用错参考基因组 | 所有坐标错位，注释全错 | 先确认 hg19/hg38 |
| 不做 gnomAD 过滤 | 报告里一堆常见多态 | 先过滤再分级 |
| VAF 很低也报 Tier I | 假阳性变用药建议 | 看 depth 与 alt count |
| 用错转录本报 HGVSc | 位点名不一致，无法核对 | 统一用 MANE Select |
| Tier I 只写药名不写来源 | 无法审核 | 写清指南/获批/试验号 |
| 把 VUS 说成「有靶向药」 | 误导治疗决策 | VUS 明确写意义未明 |
