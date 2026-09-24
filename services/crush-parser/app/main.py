from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .engine import AnalysisLimits, LimitExceeded, analyze_to_bundle, limits_from_env
from .protocol import clean_filename, configure_tempdir, parse_positive_header

app = FastAPI(title="CloudDFIR Crush Parser", version="1")
scratch_root = Path(os.environ.get("CRUSH_SCRATCH_DIR", "/scratch"))
configure_tempdir(scratch_root)


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/analyze")
async def analyze(
    request: Request,
    x_source_filename: str = Header(default="import.bin"),
    x_max_preview_rows: str | None = Header(default=None),
) -> FileResponse:
    base = limits_from_env()
    try:
        preview_rows = parse_positive_header(
            x_max_preview_rows, "X-Max-Preview-Rows", base.max_preview_rows
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    work = Path(tempfile.mkdtemp(prefix="request-", dir=scratch_root))
    source = work / clean_filename(x_source_filename)
    bundle = work / "result.tar"
    max_input = int(os.environ.get("CRUSH_MAX_INPUT_BYTES", str(10 * 1024**3)))
    seen = 0
    try:
        with source.open("wb") as output:
            async for chunk in request.stream():
                seen += len(chunk)
                if seen > max_input:
                    raise HTTPException(status_code=413, detail="source exceeds input byte limit")
                output.write(chunk)
        if seen == 0:
            raise HTTPException(status_code=400, detail="source body is empty")
        limits = AnalysisLimits(
            max_entries=base.max_entries,
            max_total_bytes=base.max_total_bytes,
            max_expansion_ratio=base.max_expansion_ratio,
            max_depth=base.max_depth,
            max_preview_rows=preview_rows,
            max_preview_bytes=base.max_preview_bytes,
            max_text_chars=base.max_text_chars,
        )
        analyze_to_bundle(source, bundle, limits)
    except LimitExceeded as exc:
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except HTTPException:
        shutil.rmtree(work, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(status_code=422, detail=f"analysis failed: {str(exc)[:500]}") from exc

    return FileResponse(
        bundle,
        media_type="application/x-tar",
        filename="analysis.tar",
        headers={"X-Crush-Contract-Version": "1"},
        background=BackgroundTask(shutil.rmtree, work, ignore_errors=True),
    )
