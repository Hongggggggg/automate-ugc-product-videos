# 成片验收与持久化记录

`downloaded` / 批次 `completed` 仅表示传输完成。内容验收状态独立保存，未检查的成片是 `pending`，不能以下载数代替合格数。

## 技术检查

先通过运行时工具清单或本机命令查询发现真实的 ffprobe、ffmpeg 路径，不猜路径、不自动安装。运行：

```powershell
& '<node>' '<skill>/scripts/workflow.mjs' qa --manifest '<batch.manifest.json>' --node-modules '<node_modules>' --ffprobe '<ffprobe>' --ffmpeg '<ffmpeg>'
```

检查视频和音轨完整解码、30秒（容差1秒）、720×1280、24fps（容差0.5fps）、音轨存在，保存每3秒与首尾帧、联系表和技术报告。音轨存在不等于口播正确或可听清。失败的文件保留；不得自动付费重做。

## 内容检查

打开 `qa_report_file` 中的 contact_sheet、首尾帧和必要的中间帧，并听取/核对英文口播。检查同一创作者的出镜、亲自实操、产品与道具一致性、音画及口播、可见AI缺陷。必须实际检查后记录，新增 home_visual_quality 检查：家居维护良好且有少量日常陈设，无残破柜体、脏乱或空置感；自然窗光、真实肤色与手机中近景符合批准提示词。背景陈设可存在，但不得参与未经事实支持的卖点证明。不能仅根据提示词、文件头或已生成图片路径填写“通过”。无法确认的项目保持pending，不伪造验收证据。

内容review可只包含本次已检查的任务；每个记录必须绑定实际视频SHA-256，并引用技术报告生成的证据文件路径。示例结构（说明文字须替换成具体观察）：

```json
{
  "schema_version": "1.0",
  "batch_id": "复制批次ID",
  "tasks": [{
    "task_key": "复制任务key",
    "artifact_sha256": "复制技术报告的完整SHA256",
    "reviewer": "实际检查者ID",
    "reviewed_at": "2026-09-05T12:00:00.000Z",
    "verdict": "passed",
    "checks": {
      "creator_visibility": {"ok": true, "notes": "逐段描述人物连续性、露脸时长与首尾帧的实际观察"},
      "product_fidelity": {"ok": true, "notes": "描述与参考图核对的颜色、形状、结构和使用状态"},
      "prop_fidelity": {"ok": true, "notes": "逐项核对画面道具与已批准产品事实"},
      "dialogue_audio": {"ok": true, "notes": "描述听取口播、台词准确性、可听性与口型同步结果"},
      "home_visual_quality": {"ok": true, "notes": "描述实际家居维护状态、日常背景物和自然手机拍摄质感"},
      "ai_defects": {"ok": true, "notes": "描述手、脸、产品、衣物及物理运动检查结果"}
    },
    "evidence_files": ["技术报告中联系表或抽帧的绝对路径"]
  }]
}
```

所有检查通过才填 passed；如果发现问题，verdict填failed、对应ok填false并描述缺陷位置。已经保存但未复核的技术报告可直接复用：

```powershell
& '<node>' '<skill>/scripts/workflow.mjs' qa --manifest '<batch.manifest.json>' --node-modules '<node_modules>' --review '<content-review.json>'
```

视频字节改变后旧review失效。需重新技术检查时传 `--refresh-technical` 并提供ffprobe/ffmpeg；新的技术检查将内容重置为待审。数据库、表格和批次摘要分别记录运输进度和QA结果。返回 `qa_complete: true` 才表示每条视频内容验收通过。
