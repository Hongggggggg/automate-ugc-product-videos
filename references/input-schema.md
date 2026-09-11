# XLSX input contract

Use `.xlsx` only. Reject `.xls`, `.xlsm`, CSV, and TSV so workbook images and direct status write-back remain predictable.

## Product sheet selection

Inspect the first ten rows of every visible sheet. Normalize headers by trimming, lowercasing Latin text, and removing spaces, underscores, and punctuation. Select the sheet with the greatest number of recognized fields. If the best score is tied, stop and list the candidate sheets.

Required logical fields and recognized headers:

| Logical field | Accepted headers |
|---|---|
| `product_id` | `product_id`, `productid`, `sku`, `产品id`, `产品编号`, `商品id`, `商品编号` |
| `product_name` | `product_name`, `productname`, `name`, `产品名称`, `商品名称`, `品名` |
| `product_images` | `product_images`, `product_image`, `images`, `image`, `产品图片`, `商品图片`, `图片` |
| `product_info` | `product_info`, `product_description`, `description`, `产品信息`, `商品信息`, `产品描述`, `商品描述` |
| `selling_points` | `selling_points`, `sellingpoints`, `benefits`, `卖点`, `核心卖点`, `产品卖点` |
| `video_count` | `video_count`, `videocount`, `videos`, `视频数量`, `生成数量`, `视频数` |

All fields except `product_id` are required. If the ID column is absent, add `product_id`; if a row ID is blank, write a stable `ROW-000001`-style ID before external work. Reject duplicate IDs and non-positive or non-integer video counts.

Skip completely empty rows. Preserve absolute original Excel row and column numbers in the normalized batch, including when the table begins after blank rows or columns. Header detection is limited to the worksheet's actual first ten rows.

New drafts store `source_product_id` and `source_row_fingerprint` for both valid and invalid rows. The fingerprint covers the original normalized values of product name, image cell, product information, selling points, and video count, excluding generated IDs and progress columns. It allows a previously blank ID to be written only to one unchanged, unambiguous source row.

## Images

Combine and deduplicate, in order:

1. Cell values: one path or URL per line, or a JSON string array.
2. Embedded images whose top-left anchor is in the recognized product-image column on the same product row.

Resolve relative paths from the workbook directory. Accept local `.png`, `.jpg`, `.jpeg`, and `.webp` files and HTTP/HTTPS URLs. Each local or embedded file must be at most 50 MiB. A product may contain at most 9 combined references. Prefer at least 3 coherent white-background angles when creating a synthetic product test. Extract embedded files under the batch directory; never alter the source image.

For new paid tasks, every reference must be a reviewed local snapshot with a matching SHA-256. URL syntax is accepted during intake, but unresolved URLs cannot be submitted; resolve them before final draft preparation. Follow [reference-image-review.md](reference-image-review.md) for local, embedded and remote-image visual inspection and per-task skip behavior.

## Workbook write-back

Before the first mutation for a batch, create `<name>.backup-YYYYMMDD-HHMMSS.xlsx`. Refuse to write while a sibling `~$<name>.xlsx` lock file exists.

Before every write-back, rediscover the current product headers and ID column. Locate products by their current unique ID and verify the source fingerprint when present; row sorting, inserted rows, and moved columns must not change the association. When an ID was originally blank, assign it only after a unique fingerprint match to an unchanged blank-ID row. Never overwrite a nonblank product ID and never locate a product by an old `workbook_row` alone. Reject changed, missing, or ambiguous product rows before mutating the workbook. Reuse an existing ID column on every sync.

Legacy manifests without fingerprints may sync only when each product already has one matching unique ID in the current workbook. If an ID is absent, prepare a new draft; historical row numbers are not sufficient evidence for writing an ID.

Preserve original product cells, headers, formulas, formatting, images, and other worksheets. Append or update these columns on the product sheet:

- `AI视频批次`
- `AI视频目标数`
- `AI视频已完成`
- `AI视频总体状态`
- `AI视频输出目录`
- `AI视频更新时间`
- `AI视频验收通过数`
- `AI视频内容验收状态`

`AI视频已完成` counts downloaded files. `AI视频总体状态=completed` means all transport jobs were downloaded; it does not mean content QA passed. `AI视频验收通过数` counts downloaded tasks with `qa_status=passed`; content QA remains `pending` until recorded, becomes `failed` if a task fails QA, and becomes `passed` only when every task is downloaded and has passed QA.

Upsert task rows in `AI视频任务` by `task_key`. One row represents one video. Task rows include `qa_status`, `qa_report_file`, and `qa_checked_at` separately from `run_status`; missing legacy QA is `pending`. Write the safe `api_key_slot` (for example `key-2`) beside each task status, but never store API key values, authorization headers, base64, or signed download URLs.
